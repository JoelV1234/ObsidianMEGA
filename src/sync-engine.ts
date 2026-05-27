import { App, TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import { MegaClient } from "./mega-client";
import type { SyncIndexEntry, SyncProgress, SyncStatus } from "./types";

const IGNORED_PREFIXES = [".obsidian", ".trash"];

function isIgnoredPath(path: string): boolean {
  if (!path) return true;
  for (const p of IGNORED_PREFIXES) {
    if (path === p || path.startsWith(p + "/")) return true;
  }
  return false;
}

export class SyncEngine {
  private uploadQueue: Promise<unknown> = Promise.resolve();
  private listeners: ((p: SyncProgress) => void)[] = [];
  private currentProgress: SyncProgress = { status: "idle", message: "Idle" };
  private pending = 0;

  constructor(
    private app: App,
    private client: MegaClient,
    private remoteFolderHandle: string,
    private index: Record<string, SyncIndexEntry> = {},
  ) {}

  onProgress(cb: (p: SyncProgress) => void): void {
    this.listeners.push(cb);
  }

  getProgress(): SyncProgress {
    return this.currentProgress;
  }

  private emit(progress: SyncProgress): void {
    this.currentProgress = progress;
    for (const l of this.listeners) {
      try {
        l(progress);
      } catch (_) {
        // ignore listener errors
      }
    }
  }

  /** Mirror remote folder into the empty (except .obsidian) local vault. */
  async runInitialSync(onProgress?: (p: SyncProgress) => void): Promise<void> {
    const report = (p: SyncProgress) => {
      onProgress?.(p);
      this.emit(p);
    };
    report({ status: "syncing", message: "Listing remote files…" });

    const { files, folders } = await this.client.walkFolder(this.remoteFolderHandle);

    // Create all folders first
    for (let i = 0; i < folders.length; i++) {
      const f = folders[i];
      if (isIgnoredPath(f.relPath)) continue;
      await this.ensureLocalFolder(f.relPath);
      report({
        status: "downloading",
        message: `Creating folders…`,
        current: i + 1,
        total: folders.length,
      });
    }

    const total = files.length;
    let skipped = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (isIgnoredPath(f.relPath)) continue;
      const remoteNodeId = (f.node.nodeId || f.node.handle) as string;
      const remoteSize = typeof f.node.size === "number" ? f.node.size : -1;

      if (await this.canSkipDownload(f.relPath, remoteNodeId, remoteSize)) {
        skipped += 1;
        report({
          status: "downloading",
          message: `Up-to-date ${f.relPath}`,
          current: i + 1,
          total,
        });
        continue;
      }

      report({
        status: "downloading",
        message: `Downloading ${f.relPath}`,
        current: i,
        total,
      });
      try {
        const data = await this.client.downloadFile(f.node);
        await this.writeLocalBinary(f.relPath, data);
        await this.recordIndex(f.relPath, remoteNodeId, remoteSize);
      } catch (e: any) {
        throw new Error(`Failed to download ${f.relPath}: ${e?.message || e}`);
      }
    }

    // Remove any local file/folder not in remote (excluding .obsidian)
    const remoteSet = new Set(files.map((f) => f.relPath));
    const remoteDirs = new Set(folders.map((f) => f.relPath));
    await this.purgeLocalNotInRemote(remoteSet, remoteDirs);

    // Drop cached entries for files no longer in remote.
    for (const key of Object.keys(this.index)) {
      if (!remoteSet.has(key)) delete this.index[key];
    }

    report({
      status: "up-to-date",
      message: `Initial sync complete (skipped ${skipped}/${total} unchanged)`,
      current: total,
      total,
    });
  }

  private async canSkipDownload(
    relPath: string,
    remoteNodeId: string,
    remoteSize: number,
  ): Promise<boolean> {
    const cached = this.index[relPath];
    if (!cached) return false;
    if (cached.remoteNodeId !== remoteNodeId) return false;
    if (cached.remoteSize !== remoteSize) return false;
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(relPath))) return false;
    const stat = await adapter.stat(relPath);
    if (!stat) return false;
    if (stat.size !== cached.localSize) return false;
    if (stat.mtime !== cached.localMtime) return false;
    return true;
  }

  private async recordIndex(
    relPath: string,
    remoteNodeId: string,
    remoteSize: number,
  ): Promise<void> {
    const stat = await this.app.vault.adapter.stat(relPath);
    this.index[relPath] = {
      remoteNodeId,
      remoteSize,
      localSize: stat?.size ?? 0,
      localMtime: stat?.mtime ?? 0,
    };
  }

  private async ensureLocalFolder(relPath: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(relPath);
    if (!exists) {
      await adapter.mkdir(relPath);
    }
  }

  private async writeLocalBinary(relPath: string, data: Uint8Array): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = relPath.includes("/") ? relPath.substring(0, relPath.lastIndexOf("/")) : "";
    if (dir) await this.ensureLocalFolder(dir);
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    await adapter.writeBinary(relPath, ab);
  }

  private async purgeLocalNotInRemote(
    remoteFiles: Set<string>,
    remoteDirs: Set<string>,
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    const walk = async (relDir: string): Promise<void> => {
      const listing = await adapter.list(relDir || "/");
      for (const filePath of listing.files) {
        const rel = filePath.replace(/^\//, "");
        if (isIgnoredPath(rel)) continue;
        if (!remoteFiles.has(rel)) {
          await adapter.remove(rel);
        }
      }
      for (const folderPath of listing.folders) {
        const rel = folderPath.replace(/^\//, "");
        if (isIgnoredPath(rel)) continue;
        await walk(rel);
        if (!remoteDirs.has(rel)) {
          try {
            await adapter.rmdir(rel, true);
          } catch (_) {
            // ignore — may already be gone
          }
        }
      }
    };
    await walk("");
  }

  /** Begin watching vault events. Call after initial sync completes. */
  startWatching(): () => void {
    const v = this.app.vault;
    const create = (f: TAbstractFile) => this.handleCreate(f);
    const modify = (f: TAbstractFile) => this.handleModify(f);
    const del = (f: TAbstractFile) => this.handleDelete(f);
    const rename = (f: TAbstractFile, oldPath: string) => this.handleRename(f, oldPath);

    v.on("create", create);
    v.on("modify", modify);
    v.on("delete", del);
    v.on("rename", rename);

    return () => {
      v.off("create", create);
      v.off("modify", modify);
      v.off("delete", del);
      v.off("rename", rename);
    };
  }

  private enqueue<T>(label: string, status: SyncStatus, work: () => Promise<T>): Promise<T> {
    this.pending += 1;
    this.emit({
      status,
      message: label,
      current: 0,
      total: this.pending,
    });
    const next = this.uploadQueue.then(() => work()).then(
      (r) => {
        this.pending = Math.max(0, this.pending - 1);
        if (this.pending === 0) {
          this.emit({ status: "up-to-date", message: "Up to date" });
        } else {
          this.emit({ status, message: label, current: 0, total: this.pending });
        }
        return r;
      },
      (err) => {
        this.pending = Math.max(0, this.pending - 1);
        this.emit({
          status: "error",
          message: "Sync error",
          errorDetail: err?.message || String(err),
        });
        throw err;
      },
    );
    this.uploadQueue = next.catch(() => undefined);
    return next;
  }

  private handleCreate(file: TAbstractFile): void {
    if (isIgnoredPath(file.path)) return;
    if (file instanceof TFolder) {
      void this.enqueue(`Creating folder ${file.path}`, "uploading", async () => {
        await this.client.ensureFolderPath(this.remoteFolderHandle, file.path);
      });
    } else if (file instanceof TFile) {
      void this.enqueue(`Uploading ${file.path}`, "uploading", async () => {
        const data = await this.app.vault.adapter.readBinary(file.path);
        await this.client.uploadFile(this.remoteFolderHandle, file.path, new Uint8Array(data));
      });
    }
  }

  private handleModify(file: TAbstractFile): void {
    if (isIgnoredPath(file.path)) return;
    if (!(file instanceof TFile)) return;
    void this.enqueue(`Updating ${file.path}`, "uploading", async () => {
      const data = await this.app.vault.adapter.readBinary(file.path);
      await this.client.uploadFile(this.remoteFolderHandle, file.path, new Uint8Array(data));
    });
  }

  private handleDelete(file: TAbstractFile): void {
    if (isIgnoredPath(file.path)) return;
    void this.enqueue(`Deleting ${file.path}`, "uploading", async () => {
      await this.client.deletePath(this.remoteFolderHandle, file.path);
    });
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    if (isIgnoredPath(oldPath) && isIgnoredPath(file.path)) return;
    void this.enqueue(`Renaming ${oldPath} → ${file.path}`, "uploading", async () => {
      if (!isIgnoredPath(oldPath)) {
        await this.client.deletePath(this.remoteFolderHandle, oldPath);
      }
      if (isIgnoredPath(file.path)) return;
      if (file instanceof TFile) {
        const data = await this.app.vault.adapter.readBinary(file.path);
        await this.client.uploadFile(this.remoteFolderHandle, file.path, new Uint8Array(data));
      } else if (file instanceof TFolder) {
        await this.uploadFolderRecursive(file);
      }
    });
  }

  private async uploadFolderRecursive(folder: TFolder): Promise<void> {
    await this.client.ensureFolderPath(this.remoteFolderHandle, folder.path);
    for (const child of folder.children) {
      if (isIgnoredPath(child.path)) continue;
      if (child instanceof TFolder) {
        await this.uploadFolderRecursive(child);
      } else if (child instanceof TFile) {
        const data = await this.app.vault.adapter.readBinary(child.path);
        await this.client.uploadFile(
          this.remoteFolderHandle,
          child.path,
          new Uint8Array(data),
        );
      }
    }
  }

  /** Walks local vault and returns total byte size, excluding .obsidian. */
  async computeVaultSize(): Promise<number> {
    const adapter = this.app.vault.adapter;
    let total = 0;
    const walk = async (relDir: string): Promise<void> => {
      const listing = await adapter.list(relDir || "/");
      for (const f of listing.files) {
        const rel = f.replace(/^\//, "");
        if (isIgnoredPath(rel)) continue;
        try {
          const stat = await adapter.stat(rel);
          if (stat) total += stat.size;
        } catch (_) {
          // ignore
        }
      }
      for (const d of listing.folders) {
        const rel = d.replace(/^\//, "");
        if (isIgnoredPath(rel)) continue;
        await walk(rel);
      }
    };
    await walk("");
    return total;
  }
}

export function vaultIsEmptyExceptObsidian(vault: Vault): boolean {
  const files = vault.getAllLoadedFiles();
  for (const f of files) {
    if (f.path === "" || f.path === "/") continue;
    if (isIgnoredPath(f.path)) continue;
    return false;
  }
  return true;
}
