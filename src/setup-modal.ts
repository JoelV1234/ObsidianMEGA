import { Modal, App, Notice, Setting } from "obsidian";
import { MegaClient } from "./mega-client";
import type { RemoteFolderNode } from "./types";

type SetupResult = {
  email: string;
  password: string;
  folder: RemoteFolderNode;
};

export class SetupModal extends Modal {
  private email = "";
  private password = "";
  private client = new MegaClient();
  private step: "credentials" | "folder" = "credentials";
  private folders: RemoteFolderNode[] = [];
  private selectedFolderHandle: string | null = null;

  constructor(
    app: App,
    private onComplete: (r: SetupResult) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mega-setup-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.client.logout().catch(() => undefined);
  }

  private render(): void {
    this.contentEl.empty();
    if (this.step === "credentials") this.renderCredentials();
    else this.renderFolder();
  }

  private renderCredentials(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "MEGA Sync — Setup" });
    contentEl.createEl("p", {
      text:
        "Sign in to your MEGA account. Your credentials are stored locally and encrypted on this device only.",
      cls: "mega-setup-help",
    });

    new Setting(contentEl)
      .setName("Email")
      .addText((t) => {
        t.setPlaceholder("you@example.com");
        t.setValue(this.email);
        t.onChange((v) => (this.email = v.trim()));
        t.inputEl.type = "email";
        t.inputEl.autocomplete = "email";
      });

    new Setting(contentEl)
      .setName("Password")
      .addText((t) => {
        t.setPlaceholder("Password");
        t.setValue(this.password);
        t.onChange((v) => (this.password = v));
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "current-password";
      });

    const buttonRow = contentEl.createDiv({ cls: "mega-setup-actions" });
    const loginBtn = buttonRow.createEl("button", {
      text: "Sign in",
      cls: "mod-cta",
    });
    loginBtn.onclick = () => this.handleLogin(loginBtn);
  }

  private async handleLogin(button: HTMLButtonElement): Promise<void> {
    if (!this.email || !this.password) {
      new Notice("Email and password are required");
      return;
    }
    button.disabled = true;
    button.setText("Signing in…");
    try {
      await this.client.login(this.email, this.password);
      this.folders = this.client.listAllFolders();
      this.step = "folder";
      this.render();
    } catch (e: any) {
      const msg = e?.message || String(e);
      new Notice(`Sign-in failed: ${msg}`);
      button.disabled = false;
      button.setText("Sign in");
    }
  }

  private renderFolder(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Select MEGA sync folder" });
    contentEl.createEl("p", {
      text:
        "Pick the MEGA folder whose contents should mirror this vault. This choice cannot be changed later.",
      cls: "mega-setup-help",
    });

    const listWrap = contentEl.createDiv({ cls: "mega-folder-list" });
    if (this.folders.length === 0) {
      listWrap.createEl("p", {
        text: "No folders found in your MEGA Cloud Drive.",
        cls: "mega-setup-help",
      });
    } else {
      for (const folder of this.folders) {
        const item = listWrap.createDiv({ cls: "mega-folder-item" });
        const radio = item.createEl("input", {
          type: "radio",
          attr: { name: "mega-folder", value: folder.handle },
        }) as HTMLInputElement;
        item.createEl("label", { text: folder.path });
        radio.onchange = () => {
          if (radio.checked) this.selectedFolderHandle = folder.handle;
        };
      }
    }

    const buttonRow = contentEl.createDiv({ cls: "mega-setup-actions" });
    const backBtn = buttonRow.createEl("button", { text: "Back" });
    backBtn.onclick = () => {
      this.step = "credentials";
      this.client.logout().catch(() => undefined);
      this.render();
    };
    const confirmBtn = buttonRow.createEl("button", {
      text: "Confirm and start sync",
      cls: "mod-cta",
    });
    confirmBtn.onclick = () => this.handleConfirm(confirmBtn);
  }

  private async handleConfirm(button: HTMLButtonElement): Promise<void> {
    if (!this.selectedFolderHandle) {
      new Notice("Select a folder to continue");
      return;
    }
    const folder = this.folders.find((f) => f.handle === this.selectedFolderHandle);
    if (!folder) return;
    button.disabled = true;
    button.setText("Saving…");
    try {
      await this.onComplete({
        email: this.email,
        password: this.password,
        folder,
      });
      this.close();
    } catch (e: any) {
      new Notice(`Setup failed: ${e?.message || String(e)}`);
      button.disabled = false;
      button.setText("Confirm and start sync");
    }
  }
}
