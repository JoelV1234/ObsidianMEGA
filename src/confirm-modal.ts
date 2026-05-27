import { App, Modal } from "obsidian";

export class ConfirmModal extends Modal {
  private result = false;

  constructor(
    app: App,
    private title: string,
    private body: string,
    private confirmText: string,
    private destructive: boolean,
    private onClose_: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.body });

    const row = contentEl.createDiv({ cls: "mega-setup-actions" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => {
      this.result = false;
      this.close();
    };
    const confirm = row.createEl("button", {
      text: this.confirmText,
      cls: this.destructive ? "mod-warning" : "mod-cta",
    });
    confirm.onclick = () => {
      this.result = true;
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClose_(this.result);
  }
}

export function confirmModal(
  app: App,
  opts: { title: string; body: string; confirmText?: string; destructive?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(
      app,
      opts.title,
      opts.body,
      opts.confirmText ?? "Confirm",
      opts.destructive ?? false,
      resolve,
    ).open();
  });
}
