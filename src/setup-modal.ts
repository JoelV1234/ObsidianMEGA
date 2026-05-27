import { Modal, App, Notice, Setting } from "obsidian";
import { MegaClient } from "./mega-client";
import type { RemoteFolderNode, RemoteFolderTreeNode } from "./types";

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
  private tree: RemoteFolderTreeNode[] = [];
  private flat: RemoteFolderTreeNode[] = [];
  private expanded = new Set<string>();
  private search = "";
  private selectedFolderHandle: string | null = null;
  private treeContainer: HTMLElement | null = null;

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
      this.tree = this.client.getFolderTree();
      this.flat = this.flattenTree(this.tree);
      this.expanded.clear();
      this.search = "";
      this.selectedFolderHandle = null;
      this.step = "folder";
      this.render();
    } catch (e: any) {
      const msg = e?.message || String(e);
      new Notice(`Sign-in failed: ${msg}`);
      button.disabled = false;
      button.setText("Sign in");
    }
  }

  private flattenTree(nodes: RemoteFolderTreeNode[]): RemoteFolderTreeNode[] {
    const out: RemoteFolderTreeNode[] = [];
    const walk = (ns: RemoteFolderTreeNode[]) => {
      for (const n of ns) {
        out.push(n);
        if (n.children.length) walk(n.children);
      }
    };
    walk(nodes);
    return out;
  }

  private renderFolder(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Select MEGA sync folder" });
    contentEl.createEl("p", {
      text:
        "Pick the MEGA folder whose contents should sync with this vault. This choice cannot be changed later.",
      cls: "mega-setup-help",
    });

    const searchWrap = contentEl.createDiv({ cls: "mega-folder-search" });
    const searchInput = searchWrap.createEl("input", {
      type: "search",
      attr: { placeholder: "Search folders…", "aria-label": "Search folders" },
    }) as HTMLInputElement;
    searchInput.value = this.search;
    searchInput.oninput = () => {
      this.search = searchInput.value;
      this.repaintTree();
    };

    this.treeContainer = contentEl.createDiv({ cls: "mega-folder-tree" });
    this.repaintTree();

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

  private repaintTree(): void {
    const container = this.treeContainer;
    if (!container) return;
    container.empty();

    if (this.tree.length === 0) {
      container.createEl("p", {
        text: "No folders found in your MEGA Cloud Drive.",
        cls: "mega-setup-help",
      });
      return;
    }

    const query = this.search.trim().toLowerCase();
    if (query) {
      const matches = this.flat.filter((n) =>
        n.path.toLowerCase().includes(query),
      );
      if (matches.length === 0) {
        container.createEl("p", {
          text: "No folders match your search.",
          cls: "mega-setup-help",
        });
        return;
      }
      for (const node of matches) {
        this.renderSearchHit(container, node);
      }
      return;
    }

    for (const node of this.tree) {
      this.renderTreeNode(container, node, 0);
    }
  }

  private renderTreeNode(
    parent: HTMLElement,
    node: RemoteFolderTreeNode,
    depth: number,
  ): void {
    const row = parent.createDiv({ cls: "mega-folder-row" });
    row.style.paddingLeft = `${depth * 18 + 6}px`;

    const toggle = row.createSpan({ cls: "mega-folder-toggle" });
    const hasChildren = node.children.length > 0;
    const isOpen = this.expanded.has(node.handle);
    if (hasChildren) {
      toggle.setText(isOpen ? "▾" : "▸");
      toggle.addClass("is-clickable");
      toggle.onclick = (e) => {
        e.stopPropagation();
        if (isOpen) this.expanded.delete(node.handle);
        else this.expanded.add(node.handle);
        this.repaintTree();
      };
    } else {
      toggle.setText("·");
      toggle.addClass("is-leaf");
    }

    const radio = row.createEl("input", {
      type: "radio",
      attr: { name: "mega-folder", value: node.handle },
    }) as HTMLInputElement;
    radio.checked = this.selectedFolderHandle === node.handle;
    radio.onchange = () => {
      if (radio.checked) this.selectedFolderHandle = node.handle;
    };

    const label = row.createEl("span", {
      text: node.name,
      cls: "mega-folder-label",
    });
    label.onclick = () => {
      this.selectedFolderHandle = node.handle;
      radio.checked = true;
      if (hasChildren) {
        if (isOpen) this.expanded.delete(node.handle);
        else this.expanded.add(node.handle);
        this.repaintTree();
      }
    };

    if (isOpen) {
      for (const child of node.children) {
        this.renderTreeNode(parent, child, depth + 1);
      }
    }
  }

  private renderSearchHit(
    parent: HTMLElement,
    node: RemoteFolderTreeNode,
  ): void {
    const row = parent.createDiv({ cls: "mega-folder-row is-search-hit" });

    const radio = row.createEl("input", {
      type: "radio",
      attr: { name: "mega-folder", value: node.handle },
    }) as HTMLInputElement;
    radio.checked = this.selectedFolderHandle === node.handle;
    radio.onchange = () => {
      if (radio.checked) this.selectedFolderHandle = node.handle;
    };

    const text = row.createSpan({ cls: "mega-folder-label" });
    const lastSlash = node.path.lastIndexOf("/");
    if (lastSlash > 0) {
      text.createSpan({
        text: node.path.substring(0, lastSlash + 1),
        cls: "mega-folder-path-prefix",
      });
    }
    text.createSpan({ text: node.name });

    text.onclick = () => {
      this.selectedFolderHandle = node.handle;
      radio.checked = true;
    };
  }

  private async handleConfirm(button: HTMLButtonElement): Promise<void> {
    if (!this.selectedFolderHandle) {
      new Notice("Select a folder to continue");
      return;
    }
    const node = this.flat.find((f) => f.handle === this.selectedFolderHandle);
    if (!node) return;
    button.disabled = true;
    button.setText("Saving…");
    try {
      await this.onComplete({
        email: this.email,
        password: this.password,
        folder: { name: node.name, path: node.path, handle: node.handle },
      });
      this.close();
    } catch (e: any) {
      new Notice(`Setup failed: ${e?.message || String(e)}`);
      button.disabled = false;
      button.setText("Confirm and start sync");
    }
  }
}
