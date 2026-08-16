/**
 * 输入框：chip 风格编辑器（Codex 风格）。
 * - 选中的 @ 引用 / slash 命令渲染为彩色标签（contenteditable=false）
 * - 提交时序列化回 `@[名称](路径)` 语法，下游逻辑不变
 * - @/slash 触发、行内选择器、键盘导航全部在侧边栏内部完成
 */
import { setIcon } from "obsidian";
import type DshCopilotPlugin from "../main.js";
import { InlinePicker, type PickerItem } from "./picker.js";

export interface Mention {
  name: string;
  path: string;
}

export interface ComposerProviders {
  /** @ 引用的候选项（vault 文件/文件夹） */
  files: () => PickerItem[];
  /** slash 命令候选项（agent 命令 + 自定义命令） */
  commands: () => PickerItem[];
}

export interface ComposerOptions {
  onSubmit: (text: string, mentions: Mention[]) => void;
  onStop: () => void;
  onCommandSelected?: (name: string) => void;
  providers: ComposerProviders;
}

const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

const IDLE_HINT = "Enter 发送 · Shift+Enter 换行 · @ 引用 · / 命令";
const BUSY_HINT = "Enter 继续发送（排队）· 点击「停止」中断";

export function parseMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  let match: RegExpExecArray | null;
  while ((match = MENTION_RE.exec(text)) !== null) {
    mentions.push({ name: match[1] ?? "", path: match[2] ?? "" });
  }
  return mentions;
}

interface ActiveTrigger {
  kind: "mention" | "command";
  query: string;
}

export class Composer {
  private editor: HTMLElement;
  private sendButton: HTMLButtonElement;
  private hintEl: HTMLElement;
  private picker: InlinePicker;
  private busy = false;
  private active: ActiveTrigger | null = null;

  constructor(
    container: HTMLElement,
    private readonly plugin: DshCopilotPlugin,
    private readonly options: ComposerOptions
  ) {
    // 行内选择器（挂在容器上，CSS 定位到输入框上方）
    this.picker = new InlinePicker(container);
    this.picker.onSelect = (item) => this.onPickerSelect(item);

    const box = container.createDiv({ cls: "dsh-composer-box" });
    this.editor = box.createDiv({
      cls: "dsh-composer-input",
      attr: {
        contenteditable: "true",
        role: "textbox",
        "aria-multiline": "true",
        "data-placeholder": "输入问题，@ 引用笔记，/ 命令，Enter 发送…",
      },
    });
    // 发送/停止按钮放在输入框右侧（抬高位置、增大点击面积，避免底边冲突）
    this.sendButton = box.createEl("button", { cls: "dsh-send-btn mod-cta" });
    this.sendButton.setText("发送");
    this.sendButton.addEventListener("click", () => {
      if (this.busy) this.options.onStop();
      else this.submit();
    });

    const bar = container.createDiv({ cls: "dsh-composer-bar" });
    const mentionButton = bar.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "@引用文件" } });
    setIcon(mentionButton, "at-sign");
    mentionButton.addEventListener("click", () => this.openTriggerManually("mention", "@"));
    const commandButton = bar.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "Slash 命令" } });
    setIcon(commandButton, "slash");
    commandButton.addEventListener("click", () => this.openTriggerManually("command", "/"));
    this.hintEl = bar.createDiv({ cls: "dsh-composer-hint" });
    this.hintEl.setText(IDLE_HINT);

    this.editor.addEventListener("input", () => this.onInput());
    this.editor.addEventListener("keydown", (ev: KeyboardEvent) => this.onKeydown(ev));
    this.editor.addEventListener("paste", (ev: ClipboardEvent) => {
      ev.preventDefault();
      const text = ev.clipboardData?.getData("text/plain") ?? "";
      if (text) document.execCommand("insertText", false, text);
    });
    this.editor.addEventListener("blur", () => this.closePicker());
  }

  // -------------------------------------------------------------------------
  // 触发检测与选择器状态
  // -------------------------------------------------------------------------

  private textBeforeCaret(): string {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return "";
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(this.editor);
    pre.setEnd(range.endContainer, range.endOffset);
    return pre.toString();
  }

  private currentTrigger(): ActiveTrigger | null {
    const before = this.textBeforeCaret();
    const mention = /@([^\s@[\]()]*)$/.exec(before);
    if (mention) return { kind: "mention", query: mention[1] ?? "" };
    const command = /^\s*\/([\w-]*)$/.exec(before);
    if (command) return { kind: "command", query: command[1] ?? "" };
    return null;
  }

  private onInput(): void {
    const trigger = this.currentTrigger();
    if (!trigger) {
      this.closePicker();
      return;
    }
    if (!this.picker.visible || this.active?.kind !== trigger.kind) {
      this.picker.open(
        trigger.kind === "mention" ? "引用笔记" : "命令",
        trigger.kind === "mention" ? this.options.providers.files() : this.options.providers.commands(),
        trigger.query
      );
    } else {
      this.picker.updateQuery(trigger.query);
    }
    this.active = trigger;
  }

  private onKeydown(ev: KeyboardEvent): void {
    if (this.picker.visible) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        this.picker.move(1);
        return;
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        this.picker.move(-1);
        return;
      } else if (ev.key === "Enter" && !ev.isComposing) {
        ev.preventDefault();
        ev.stopPropagation();
        const item = this.picker.selectCurrent();
        if (item) this.onPickerSelect(item);
        else this.closePicker(); // 无匹配项时关闭选择器，下一次 Enter 正常发送
        return;
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.closePicker();
        return;
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        this.picker.selectCurrent();
        return;
      }
    }
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      // 忙时 Enter 也发送（排队追加），停止只通过按钮触发，避免无反应
      this.submit();
    }
  }

  private closePicker(): void {
    this.picker.close();
    this.active = null;
    this.hintEl.setText(this.busy ? BUSY_HINT : IDLE_HINT);
  }

  /** 工具栏按钮：在光标处插入触发符并打开选择器。 */
  private openTriggerManually(kind: "mention" | "command", token: string): void {
    this.picker.open(kind === "mention" ? "引用笔记" : "命令", kind === "mention" ? this.options.providers.files() : this.options.providers.commands(), "");
    this.active = { kind, query: "" };
    this.editor.focus();
    document.execCommand("insertText", false, token);
    this.editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** 用选择结果替换光标前的触发 token（chip 插入）。 */
  private onPickerSelect(item: PickerItem): void {
    const trigger = this.active;
    if (!trigger) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;

    const end = range.startOffset;
    const tokenLen = trigger.query.length + 1; // 触发符 + 已输入
    const start = Math.max(0, end - tokenLen);
    const textNode = node as Text;
    textNode.data = textNode.data.slice(0, start);

    let chip: HTMLElement;
    if (trigger.kind === "mention") {
      const meta = item.meta as { name: string; path: string } | undefined;
      chip = this.makeMentionChip(meta?.name ?? item.label, meta?.path ?? "");
    } else {
      const meta = item.meta as { name: string; hint?: string } | undefined;
      const name = meta?.name ?? item.label.replace(/^\//, "");
      chip = this.makeCommandChip(name);
      if (meta?.hint) this.hintEl.setText(`/${name} — ${meta.hint}`);
      this.options.onCommandSelected?.(name);
    }

    this.placeChipAfter(chip, textNode, start);
    this.active = null;
    this.editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // -------------------------------------------------------------------------
  // chip 构造与插入（选择器 / 右键菜单 / 拖拽共用）
  // -------------------------------------------------------------------------

  private makeMentionChip(name: string, path: string): HTMLElement {
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.className = `dsh-chip${path.endsWith("/") ? " dsh-chip-folder" : ""}`;
    chip.dataset.name = name;
    chip.dataset.path = path;
    chip.textContent = `@${name}${path.endsWith("/") ? "/" : ""}`;
    return chip;
  }

  private makeCommandChip(name: string): HTMLElement {
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.className = "dsh-chip";
    chip.dataset.command = name;
    chip.textContent = `/${name}`;
    return chip;
  }

  /** 在指定文本节点 offset 之后插入 chip + 尾随空格，并把光标移到空格后。 */
  private placeChipAfter(chip: HTMLElement, textNode: Text, offset: number): void {
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode, offset);
    range.collapse(true);
    range.insertNode(chip);
    const space = document.createTextNode(" ");
    chip.after(space);
    range.setStart(space, 1);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /** 在编辑器末尾插入 chip（编辑器未聚焦时使用：拖拽/右键菜单）。 */
  private appendChipAtEnd(chip: HTMLElement): void {
    this.editor.appendChild(chip);
    this.editor.appendChild(document.createTextNode(" "));
    this.focus();
  }

  /** 外部入口：追加一个文件/文件夹引用 chip。 */
  insertMentionChip(name: string, path: string): void {
    this.appendChipAtEnd(this.makeMentionChip(name, path));
    this.editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** 当前输入是否已包含某个路径的引用。 */
  containsMention(path: string): boolean {
    return this.serialize().includes(`(${path})`);
  }

  /** 外部入口：追加划选文本上下文（引用块 + 源文件 chip）。 */
  insertSelectionContext(name: string, path: string, selection: string, source: string): void {
    const maxLen = 2000;
    const text = selection.length > maxLen ? `${selection.slice(0, maxLen)}\n…[划选内容过长已截断]` : selection;
    const quote = text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    if (path !== "") this.appendChipAtEnd(this.makeMentionChip(name, path));
    this.editor.appendChild(document.createTextNode(`\n${quote}\n`));
    this.editor.createEl("div", { cls: "dsh-quote-source", text: `（选段来源：${source}）` });
    this.focus();
    this.editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // -------------------------------------------------------------------------
  // 序列化与提交
  // -------------------------------------------------------------------------

  private serialize(): string {
    let out = "";
    const visit = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent ?? "";
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (el.classList.contains("dsh-chip")) {
        if (el.dataset.path !== undefined) {
          out += `@[${el.dataset.name ?? ""}](${el.dataset.path})`;
        } else {
          out += `/${el.dataset.command ?? ""}`;
        }
        return;
      }
      if (el.tagName === "BR") {
        out += "\n";
        return;
      }
      if (el.tagName === "DIV" || el.tagName === "P") out += "\n";
      for (const child of Array.from(node.childNodes)) visit(child);
      if (el.tagName === "DIV" || el.tagName === "P") out += "\n";
    };
    for (const child of Array.from(this.editor.childNodes)) visit(child);
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  private submit(): void {
    const text = this.serialize();
    if (!text) return;
    this.editor.empty();
    const mentions = parseMentions(text);
    this.options.onSubmit(text, mentions);
  }

  // -------------------------------------------------------------------------
  // 对外接口
  // -------------------------------------------------------------------------

  setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    if (busy) {
      this.sendButton.setText("停止");
      this.sendButton.removeClass("mod-cta");
      this.sendButton.addClass("dsh-stop-btn");
      this.hintEl.setText(BUSY_HINT);
    } else {
      this.sendButton.setText("发送");
      this.sendButton.addClass("mod-cta");
      this.sendButton.removeClass("dsh-stop-btn");
      this.hintEl.setText(IDLE_HINT);
    }
  }

  focus(): void {
    this.editor.focus();
    const range = document.createRange();
    range.selectNodeContents(this.editor);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}
