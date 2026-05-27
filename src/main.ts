import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, MegaSyncSettings, SyncProgress } from "./types";
import { encryptString, decryptString, clearLocalKey } from "./crypto";
import { MegaClient, prefetchMega } from "./mega-client";
import { SyncEngine, vaultIsEmptyExceptObsidian } from "./sync-engine";
import { SetupModal } from "./setup-modal";
import { SyncOverlay } from "./sync-overlay";
import { MegaSyncSettingTab } from "./settings-tab";
import { confirmModal } from "./confirm-modal";

export default class MegaSyncPlugin extends Plugin {
  settings: MegaSyncSettings = { ...DEFAULT_SETTINGS };
  private client = new MegaClient();
  private engine: SyncEngine | null = null;
  private overlay = new SyncOverlay();
  private statusBarItem: HTMLElement | null = null;
  private stopWatching: (() => void) | null = null;
  private currentProgress: SyncProgress = { status: "idle", message: "Idle" };
  private readOnlyLocked = false;
  private settingsTab: MegaSyncSettingTab | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Begin parsing the megajs bundle in the background so the first login
    // doesn't pay for it on the critical path.
    prefetchMega();

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("mega-sync-status");
    this.renderStatusBar();

    this.settingsTab = new MegaSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    if (this.settings.setupComplete) {
      // Defer post-layout so vault events are stable
      this.app.workspace.onLayoutReady(() => {
        void this.resumeAfterSetup();
      });
    }
  }

  onunload(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.overlay.hide();
    this.unlockReadOnly();
    void this.client.logout();
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  canRunSetup(): boolean {
    return vaultIsEmptyExceptObsidian(this.app.vault);
  }

  getProgress(): SyncProgress {
    return this.currentProgress;
  }

  async computeVaultSize(): Promise<number> {
    if (!this.engine) {
      // create a temporary engine just for size
      const tmp = new SyncEngine(this.app, this.client, "", {});
      return tmp.computeVaultSize();
    }
    return this.engine.computeVaultSize();
  }

  startSetup(): void {
    if (this.settings.setupComplete) {
      new Notice("MEGA Sync is already configured for this vault.");
      return;
    }
    if (!this.canRunSetup()) {
      new Notice("Vault must be empty (besides .obsidian) before setup.");
      return;
    }
    const modal = new SetupModal(this.app, async ({ email, password, folder }) => {
      this.settings = {
        ...DEFAULT_SETTINGS,
        setupComplete: true,
        email,
        encryptedPassword: await encryptString(password),
        remoteFolderPath: folder.path,
        remoteFolderHandle: folder.handle,
        initialSyncComplete: false,
      };
      await this.saveSettings();
      // Close the Obsidian Settings dialog so the sync overlay is unobstructed.
      (this.app as any).setting?.close?.();
      // Kick off initial sync immediately
      void this.runInitialFlow(email, password);
    });
    modal.open();
  }

  private async connectToMega(email: string, password: string): Promise<void> {
    if (this.settings.encryptedSession) {
      try {
        const session = await decryptString(this.settings.encryptedSession);
        this.overlay.update({ status: "syncing", message: "Resuming MEGA session…" });
        await this.client.loginWithSession(session);
        // Refresh stored session in case megajs rotated anything.
        await this.persistSession();
        return;
      } catch (e: any) {
        // Cached session was rejected (revoked, password change, corrupt blob, etc.).
        // Drop it and fall back to password login.
        console.warn("MEGA Sync: cached session rejected, falling back to password login.", e);
        this.settings.encryptedSession = null;
        await this.saveSettings();
      }
    }
    this.overlay.update({ status: "syncing", message: "Signing in to MEGA…" });
    await this.client.login(email, password);
    await this.persistSession();
  }

  private async persistSession(): Promise<void> {
    const session = this.client.exportSession();
    if (!session) return;
    this.settings.encryptedSession = await encryptString(session);
    await this.saveSettings();
  }

  private async resumeAfterSetup(): Promise<void> {
    if (!this.settings.encryptedPassword || !this.settings.email) {
      this.updateProgress({
        status: "error",
        message: "Missing stored credentials",
        errorDetail: "Reset MEGA Sync to reconfigure.",
      });
      return;
    }
    let password: string;
    try {
      password = await decryptString(this.settings.encryptedPassword);
    } catch (e: any) {
      this.updateProgress({
        status: "error",
        message: "Could not decrypt credentials",
        errorDetail: e?.message || String(e),
      });
      return;
    }
    await this.runInitialFlow(this.settings.email, password);
  }

  private async runInitialFlow(email: string, password: string): Promise<void> {
    if (!this.settings.remoteFolderHandle) return;

    this.lockReadOnly();
    this.overlay.setActions({
      onRetry: () => void this.resumeAfterSetup(),
      onReset: () => void this.handleResetFromOverlay(),
    });
    this.overlay.show({ status: "syncing", message: "Connecting to MEGA…" });

    const timings: Record<string, number> = {};
    const tStart = performance.now();

    try {
      const tConnect = performance.now();
      await this.connectToMega(email, password);
      timings.connect = performance.now() - tConnect;
    } catch (e: any) {
      const msg = e?.message || String(e);
      this.updateProgress({ status: "error", message: "Sign-in failed", errorDetail: msg });
      this.overlay.update({ status: "error", message: "Sign-in failed", errorDetail: msg });
      return;
    }

    this.engine = new SyncEngine(
      this.app,
      this.client,
      this.settings.remoteFolderHandle,
      this.settings.syncIndex,
    );
    this.engine.onProgress((p) => {
      this.updateProgress(p);
      this.overlay.update(p);
    });

    try {
      const tSync = performance.now();
      await this.engine.runInitialSync();
      timings.sync = performance.now() - tSync;
      this.settings.initialSyncComplete = true;
      await this.saveSettings();
      this.overlay.hide();
      this.unlockReadOnly();
      const total = performance.now() - tStart;
      const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
      const sub = this.client.lastTimings;
      const subParts: string[] = [];
      if (sub.megajsLoad !== undefined) subParts.push(`lib ${fmt(sub.megajsLoad)}`);
      if (sub.treeFetch !== undefined) subParts.push(`tree ${fmt(sub.treeFetch)}`);
      const subStr = subParts.length ? ` (${subParts.join(", ")})` : "";
      new Notice(
        `MEGA Sync ready. connect ${fmt(timings.connect)}${subStr} · sync ${fmt(timings.sync)} · total ${fmt(total)}`,
        15000,
      );
    } catch (e: any) {
      const msg = e?.message || String(e);
      this.updateProgress({
        status: "error",
        message: "Initial sync failed",
        errorDetail: msg,
      });
      this.overlay.update({
        status: "error",
        message: "Initial sync failed",
        errorDetail: msg,
      });
      return;
    }

    // Grace period: let Obsidian's file scanner settle so the events caused by
    // initial-sync writes don't get reflected back as uploads.
    window.setTimeout(() => this.startWatcher(), 3000);
    this.updateProgress({ status: "up-to-date", message: "Up to date" });
  }

  private async handleResetFromOverlay(): Promise<void> {
    const ok = await confirmModal(this.app, {
      title: "Reset MEGA Sync?",
      body: "Stop the failed setup and clear stored credentials. Local files stay untouched.",
      confirmText: "Reset",
      destructive: true,
    });
    if (!ok) return;
    await this.purgeAllPluginData();
    this.overlay.hide();
    new Notice("MEGA Sync configuration cleared.");
  }

  private startWatcher(): void {
    if (!this.engine) return;
    this.stopWatching?.();
    this.stopWatching = this.engine.startWatching();
  }

  private updateProgress(p: SyncProgress): void {
    this.currentProgress = p;
    this.renderStatusBar();
    if (this.settingsTab) {
      // Settings tab redraws when reopened; nothing to push live.
    }
  }

  private renderStatusBar(): void {
    if (!this.statusBarItem) return;
    const p = this.currentProgress;
    let icon = "○";
    let text = p.message;
    switch (p.status) {
      case "syncing":
      case "downloading":
      case "uploading":
        icon = "⟳";
        text = p.total ? `${p.message} (${p.current ?? 0}/${p.total})` : p.message;
        break;
      case "up-to-date":
        icon = "✓";
        text = "MEGA: up to date";
        break;
      case "error":
        icon = "!";
        text = `MEGA error: ${p.errorDetail || p.message}`;
        break;
      case "idle":
      default:
        icon = "○";
        text = "MEGA: idle";
    }
    this.statusBarItem.setText(`${icon} ${text}`);
  }

  // --- read-only lock during initial sync ---
  private lockReadOnly(): void {
    if (this.readOnlyLocked) return;
    this.readOnlyLocked = true;
    // We can't truly freeze vault writes, but we block keyboard/click events at the overlay
    // and prevent the user from interacting with workspace.
    document.body.addClass("mega-sync-locked");
  }

  private unlockReadOnly(): void {
    if (!this.readOnlyLocked) return;
    this.readOnlyLocked = false;
    document.body.removeClass("mega-sync-locked");
  }

  /** Reset all plugin state: settings, credentials, encryption key. */
  async purgeAllPluginData(): Promise<void> {
    this.stopWatching?.();
    this.stopWatching = null;
    this.overlay.hide();
    this.unlockReadOnly();
    await this.client.logout();
    this.engine = null;

    this.settings = { ...DEFAULT_SETTINGS };
    await this.saveData(this.settings);
    try {
      // Wipe persisted data.json content entirely.
      await this.saveData({});
    } catch (_) {
      // ignore
    }
    clearLocalKey();
    this.currentProgress = { status: "idle", message: "Idle" };
    this.renderStatusBar();
  }
}
