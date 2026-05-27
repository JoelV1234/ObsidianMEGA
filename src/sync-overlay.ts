import type { SyncProgress } from "./types";

export class SyncOverlay {
  private root: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  private actionRow: HTMLElement | null = null;
  private onRetry: (() => void) | null = null;
  private onReset: (() => void) | null = null;

  setActions(opts: { onRetry?: () => void; onReset?: () => void }): void {
    this.onRetry = opts.onRetry ?? null;
    this.onReset = opts.onReset ?? null;
  }

  show(initial: SyncProgress): void {
    if (this.root) {
      this.update(initial);
      return;
    }
    const root = document.body.createDiv({ cls: "mega-sync-overlay" });
    const card = root.createDiv({ cls: "mega-sync-overlay-card" });
    card.createEl("h2", { text: "Syncing your vault" });
    this.statusEl = card.createEl("p", {
      cls: "mega-sync-overlay-status",
      text: initial.message,
    });
    const barWrap = card.createDiv({ cls: "mega-sync-overlay-bar" });
    this.barEl = barWrap.createDiv({ cls: "mega-sync-overlay-bar-fill" });
    this.detailEl = card.createEl("p", { cls: "mega-sync-overlay-detail", text: "" });
    card.createEl("p", {
      cls: "mega-sync-overlay-help",
      text: "Your vault is read-only until the initial sync finishes.",
    });
    this.actionRow = card.createDiv({ cls: "mega-sync-overlay-actions" });
    this.root = root;
    this.update(initial);
  }

  update(progress: SyncProgress): void {
    if (!this.root || !this.statusEl || !this.detailEl || !this.barEl) return;
    this.statusEl.setText(progress.message);
    if (progress.total && progress.total > 0) {
      const current = progress.current ?? 0;
      const pct = Math.min(100, Math.round((current / progress.total) * 100));
      this.barEl.style.width = `${pct}%`;
      this.detailEl.setText(`${current} / ${progress.total} (${pct}%)`);
    } else {
      this.barEl.style.width = `0%`;
      this.detailEl.setText(progress.errorDetail || "");
    }
    if (progress.status === "error") {
      this.root.addClass("mega-sync-overlay-error");
      this.renderActions();
    } else {
      this.root.removeClass("mega-sync-overlay-error");
      if (this.actionRow) this.actionRow.empty();
    }
  }

  private renderActions(): void {
    if (!this.actionRow) return;
    this.actionRow.empty();
    if (this.onRetry) {
      const btn = this.actionRow.createEl("button", { text: "Retry", cls: "mod-cta" });
      btn.onclick = () => this.onRetry?.();
    }
    if (this.onReset) {
      const btn = this.actionRow.createEl("button", {
        text: "Reset configuration",
        cls: "mod-warning",
      });
      btn.onclick = () => this.onReset?.();
    }
  }

  hide(): void {
    if (this.root) {
      this.root.detach();
      this.root = null;
      this.statusEl = null;
      this.detailEl = null;
      this.barEl = null;
    }
  }
}
