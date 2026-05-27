import type { RemoteFolderNode } from "./types";

type MegaFile = any;
type MegaStorage = any;

let _Storage: any = null;
async function loadMega(): Promise<any> {
  if (_Storage) return _Storage;
  const mod: any = await import("megajs");
  _Storage = mod.Storage || mod.default?.Storage || mod.default;
  if (!_Storage) throw new Error("Failed to load MEGA library");
  return _Storage;
}

export class MegaClient {
  private storage: MegaStorage | null = null;
  private email: string | null = null;

  async login(email: string, password: string): Promise<void> {
    const Storage = await loadMega();
    const storage = new Storage({ email, password, userAgent: null });
    await storage.ready;
    this.storage = storage;
    this.email = email;
  }

  isLoggedIn(): boolean {
    return this.storage !== null;
  }

  getEmail(): string | null {
    return this.email;
  }

  async logout(): Promise<void> {
    if (this.storage && typeof this.storage.close === "function") {
      try {
        await this.storage.close();
      } catch (_) {
        // ignore
      }
    }
    this.storage = null;
    this.email = null;
  }

  private requireStorage(): MegaStorage {
    if (!this.storage) throw new Error("Not logged in to MEGA");
    return this.storage;
  }

  /** List top-level folders inside the Cloud Drive root, recursively (one level deep). */
  listTopLevelFolders(): RemoteFolderNode[] {
    const storage = this.requireStorage();
    const root = storage.root;
    if (!root || !root.children) return [];
    const folders: RemoteFolderNode[] = [];
    for (const child of root.children) {
      if (child.directory) {
        folders.push({
          name: child.name,
          path: `/${child.name}`,
          handle: child.nodeId || child.handle,
        });
      }
    }
    return folders;
  }

  /** List all folders recursively under root, with their full path. */
  listAllFolders(): RemoteFolderNode[] {
    const storage = this.requireStorage();
    const root = storage.root;
    if (!root) return [];
    const out: RemoteFolderNode[] = [];
    const walk = (node: MegaFile, prefix: string) => {
      if (!node.children) return;
      for (const child of node.children) {
        if (child.directory) {
          const path = `${prefix}/${child.name}`;
          out.push({
            name: child.name,
            path,
            handle: child.nodeId || child.handle,
          });
          walk(child, path);
        }
      }
    };
    walk(root, "");
    return out;
  }

  findFolderByHandle(handle: string): MegaFile | null {
    const storage = this.requireStorage();
    if (storage.files && storage.files[handle]) return storage.files[handle];
    // fallback: walk
    const walk = (node: MegaFile): MegaFile | null => {
      if ((node.nodeId || node.handle) === handle) return node;
      if (!node.children) return null;
      for (const c of node.children) {
        const found = walk(c);
        if (found) return found;
      }
      return null;
    };
    return walk(storage.root);
  }

  /** Walk a remote folder and yield every file and folder (relative path). */
  async walkFolder(
    handle: string,
  ): Promise<{ files: { relPath: string; node: MegaFile }[]; folders: { relPath: string; node: MegaFile }[] }> {
    const root = this.findFolderByHandle(handle);
    if (!root) throw new Error(`Remote folder ${handle} not found`);
    const files: { relPath: string; node: MegaFile }[] = [];
    const folders: { relPath: string; node: MegaFile }[] = [];
    const walk = (node: MegaFile, prefix: string) => {
      if (!node.children) return;
      for (const c of node.children) {
        const path = prefix ? `${prefix}/${c.name}` : c.name;
        if (c.directory) {
          folders.push({ relPath: path, node: c });
          walk(c, path);
        } else {
          files.push({ relPath: path, node: c });
        }
      }
    };
    walk(root, "");
    return { files, folders };
  }

  async downloadFile(node: MegaFile): Promise<Uint8Array> {
    return await new Promise<Uint8Array>((resolve, reject) => {
      node.downloadBuffer((err: any, data: any) => {
        if (err) return reject(err);
        resolve(data instanceof Uint8Array ? data : new Uint8Array(data));
      });
    });
  }

  /** Resolve or create the sub-folder chain inside `parentHandle`. Returns the leaf folder node. */
  async ensureFolderPath(parentHandle: string, relPath: string): Promise<MegaFile> {
    let current = this.findFolderByHandle(parentHandle);
    if (!current) throw new Error("Parent folder not found");
    if (!relPath) return current;
    const parts = relPath.split("/").filter(Boolean);
    for (const part of parts) {
      const existing = (current.children || []).find(
        (c: MegaFile) => c.directory && c.name === part,
      );
      if (existing) {
        current = existing;
      } else {
        current = await new Promise<MegaFile>((resolve, reject) => {
          current.mkdir({ name: part }, (err: any, folder: MegaFile) => {
            if (err) return reject(err);
            resolve(folder);
          });
        });
      }
    }
    return current;
  }

  async uploadFile(
    parentHandle: string,
    relPath: string,
    data: Uint8Array,
  ): Promise<void> {
    const lastSlash = relPath.lastIndexOf("/");
    const dirPath = lastSlash >= 0 ? relPath.substring(0, lastSlash) : "";
    const name = lastSlash >= 0 ? relPath.substring(lastSlash + 1) : relPath;
    const parent = await this.ensureFolderPath(parentHandle, dirPath);

    // Replace any existing node with the same name first
    const existing = (parent.children || []).find(
      (c: MegaFile) => !c.directory && c.name === name,
    );
    if (existing) {
      await this.deleteNode(existing);
    }

    await new Promise<void>((resolve, reject) => {
      const stream = parent.upload({ name, size: data.byteLength }, data);
      stream.on("complete", () => resolve());
      stream.on("error", (err: any) => reject(err));
    });
  }

  async deleteNode(node: MegaFile): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      node.delete(true, (err: any) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async deletePath(parentHandle: string, relPath: string): Promise<void> {
    const parent = this.findFolderByHandle(parentHandle);
    if (!parent) return;
    const parts = relPath.split("/").filter(Boolean);
    let current: MegaFile = parent;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const child = (current.children || []).find((c: MegaFile) => c.name === part);
      if (!child) return;
      if (i === parts.length - 1) {
        await this.deleteNode(child);
        return;
      }
      current = child;
    }
  }

  async movePath(parentHandle: string, oldRel: string, newRel: string): Promise<void> {
    // Simplest reliable cross-platform behavior: delete old, ensure new path created on next upload.
    await this.deletePath(parentHandle, oldRel);
  }
}
