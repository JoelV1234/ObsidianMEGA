import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type MegaSyncPlugin from "./main";
import { confirmModal } from "./confirm-modal";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

export class MegaSyncSettingTab extends PluginSettingTab {
  private vaultSizeEl: HTMLInputElement | null = null;
  private statusEl: HTMLInputElement | null = null;
  private refreshTimer: number | null = null;

  constructor(
    app: App,
    private plugin: MegaSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.vaultSizeEl = null;
    this.statusEl = null;
    containerEl.addClass("mega-sync-settings");

    containerEl.createEl("h2", { text: "MEGA Sync" });

    if (!this.plugin.settings.setupComplete) {
      this.renderUnconfigured(containerEl);
    } else {
      this.renderConfigured(containerEl);
      this.scheduleRefresh();
    }
  }

  hide(): void {
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = window.setInterval(() => this.refreshLiveFields(), 1500);
  }

  private refreshLiveFields(): void {
    if (this.statusEl) {
      this.statusEl.value = this.formatStatus();
    }
  }

  private formatStatus(): string {
    const p = this.plugin.getProgress();
    switch (p.status) {
      case "syncing":
      case "downloading":
      case "uploading":
        return `Syncing… (${p.message})`;
      case "error":
        return `Error: ${p.errorDetail || p.message}`;
      case "up-to-date":
        return "Up to date";
      case "idle":
      default:
        return "Idle";
    }
  }

  private renderUnconfigured(containerEl: HTMLElement): void {
    const blocked = !this.plugin.canRunSetup();
    if (blocked) {
      const warn = containerEl.createDiv({ cls: "mega-sync-warn" });
      warn.createEl("h3", { text: "Vault must be empty to set up MEGA Sync" });
      warn.createEl("p", {
        text:
          "MEGA Sync mirrors a remote folder into this vault on first run. To prevent data loss, the vault must contain no files or folders outside of .obsidian/ before setup. Move or remove all other files and reopen this settings tab.",
      });
    } else {
      containerEl.createEl("p", {
        text:
          "Welcome to MEGA Sync. Click Setup to sign in and pick a remote folder to mirror into this vault.",
        cls: "mega-sync-help",
      });
    }

    new Setting(containerEl)
      .setName("Setup")
      .setDesc("Sign in to MEGA and choose a sync folder. This can only be done once per vault.")
      .addButton((b) => {
        b.setButtonText("Setup");
        b.setCta();
        b.setDisabled(blocked);
        b.onClick(() => this.plugin.startSetup());
      });
  }

  private renderConfigured(containerEl: HTMLElement): void {
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("Account")
      .setDesc("Signed in (locked after initial setup).")
      .addText((t) => {
        t.setValue(s.email || "");
        t.setDisabled(true);
      });

    new Setting(containerEl)
      .setName("MEGA folder")
      .setDesc("Remote folder mirrored into this vault (locked after initial setup).")
      .addText((t) => {
        t.setValue(s.remoteFolderPath || "");
        t.setDisabled(true);
      });

    new Setting(containerEl).setName("Vault size").addText((t) => {
      t.setValue("Calculating…");
      t.setDisabled(true);
      this.vaultSizeEl = t.inputEl;
    });
    void this.plugin.computeVaultSize().then((size) => {
      if (this.vaultSizeEl) this.vaultSizeEl.value = formatBytes(size);
    });

    new Setting(containerEl).setName("Sync status").addText((t) => {
      t.setValue(this.formatStatus());
      t.setDisabled(true);
      this.statusEl = t.inputEl;
    });

    containerEl.createEl("hr");
    const danger = containerEl.createDiv({ cls: "mega-sync-danger" });
    danger.createEl("h3", { text: "Danger zone" });
    danger.createEl("p", {
      text:
        "Removing the MEGA Sync configuration deletes locally stored credentials and the encryption key. Your local files are not deleted. The plugin folder itself must be uninstalled from Community Plugins.",
    });
    new Setting(danger)
      .setName("Reset MEGA Sync configuration")
      .addButton((b) => {
        b.setButtonText("Reset");
        b.setWarning();
        b.onClick(async () => {
          const ok = await confirmModal(this.app, {
            title: "Reset MEGA Sync?",
            body:
              "This deletes the stored MEGA credentials and configuration on this device. Your local vault files are not deleted.",
            confirmText: "Reset",
            destructive: true,
          });
          if (!ok) return;
          await this.plugin.purgeAllPluginData();
          new Notice("MEGA Sync configuration cleared.");
          this.display();
        });
      });
  }
}
