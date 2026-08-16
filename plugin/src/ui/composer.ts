/**
 * 输入框：textarea + 行内选择器（@ 引用 / slash 命令，Codex 风格）+ 发送/停止。
 * 触发与键盘导航都在侧边栏内部完成，不使用 Obsidian 全局搜索弹窗。
 */
import { setIcon } from "obsidian";
import type DshCopilotPlugin from "../main.js";
import { InlinePicker, type PickerItem } from "./picker.js";

export interface Mention {
  name: string;
  path: string;
}

export interface ComposerProviders {
  /** @ 引用的候选项（vault 文件） */
  files: () => PickerItem[];
  /** slash 命令候选项（agent 命令 + 自定义命令） */
  commands: () => PickerItem[];
}

export interface ComposerOptions {
  onSubmit: (text: string, mentions: Mention[]) => void;
  onStop: () => void;
  /** 选中命令后回调（用于展示 input hint 等） */
  onCommandSelected?: (name: string) => void;
  providers: ComposerProviders;
}

const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

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
  private textarea: HTMLTextAreaElement;
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
    this.textarea = box.createEl("textarea", {
      cls: "dsh-composer-input",
      attr: { placeholder: "输入问题，@ 引用笔记，/ 命令，Enter 发送…" },
    });
    const bar = container.createDiv({ cls: "dsh-composer-bar" });
    const mentionButton = bar.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "@引用文件" } });
    setIcon(mentionButton, "at-sign");
    mentionButton.addEventListener("click", () => {
      this.picker.open("引用笔记", this.options.providers.files(), "");
      this.active = { kind: "mention", query: "" };
      // 光标前补一个 @ 标记，选中后整体替换
      const el = this.textarea;
      const pos = el.selectionStart ?? el.value.length;
      el.setRangeText("@", pos, pos, "end");
      el.focus();
    });
    const commandButton = bar.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "Slash 命令" } });
    setIcon(commandButton, "slash");
    commandButton.addEventListener("click", () => {
      this.picker.open("命令", this.options.providers.commands(), "");
      this.active = { kind: "command", query: "" };
      const el = this.textarea;
      const pos = el.selectionStart ?? el.value.length;
      el.setRangeText("/", pos, pos, "end");
      el.focus();
    });
    this.hintEl = bar.createDiv({ cls: "dsh-composer-hint" });
    this.hintEl.setText("Enter 发送 · Shift+Enter 换行 · @ 引用 · / 命令");
    this.sendButton = bar.createEl("button", { cls: "dsh-send-btn mod-cta" });
    this.sendButton.setText("发送");
    this.sendButton.addEventListener("click", () => this.submit());

    this.textarea.addEventListener("input", () => this.onInput());
    this.textarea.addEventListener("keydown", (ev: KeyboardEvent) => this.onKeydown(ev));
    this.textarea.addEventListener("blur", () => {
      // 点击选择器本身时 mousedown 已 preventDefault，不会走到这里
      this.closePicker();
    });
  }

  // -------------------------------------------------------------------------
  // 触发检测与选择器状态
  // -------------------------------------------------------------------------

  private currentTrigger(): ActiveTrigger | null {
    const el = this.textarea;
    const pos = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, pos);
    // @ 引用：@ 后跟普通字符（排除已插入的 @[name](path) token）
    const mention = /@([^\s@[\]()]*)$/.exec(before);
    if (mention) return { kind: "mention", query: mention[1] ?? "" };
    // slash 命令：仅消息开头（允许前导空白）
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
    if (!this.picker.visible) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      this.picker.move(1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      this.picker.move(-1);
    } else if (ev.key === "Enter" && !ev.isComposing) {
      ev.preventDefault();
      ev.stopPropagation();
      const item = this.picker.selectCurrent();
      if (item) this.onPickerSelect(item);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      this.closePicker();
    } else if (ev.key === "Tab") {
      ev.preventDefault();
      this.picker.selectCurrent();
    }
  }

  private closePicker(): void {
    this.picker.close();
    this.active = null;
    if (!this.busy) {
      this.hintEl.setText("Enter 发送 · Shift+Enter 换行 · @ 引用 · / 命令");
    }
  }

  /** 用选择结果替换光标前的触发 token。 */
  private onPickerSelect(item: PickerItem): void {
    const trigger = this.active;
    if (!trigger) return;
    const el = this.textarea;
    const pos = el.selectionStart ?? el.value.length;
    const token = (trigger.kind === "mention" ? "@" : "/") + trigger.query;
    const start = pos - token.length;
    if (start < 0) return;

    let replacement: string;
    if (trigger.kind === "mention") {
      const meta = item.meta as { name: string; path: string } | undefined;
      replacement = meta ? `@[${meta.name}](${meta.path}) ` : item.label + " ";
    } else {
      const meta = item.meta as { name: string; hint?: string } | undefined;
      const name = meta?.name ?? item.label.replace(/^\//, "");
      replacement = `/${name} `;
      if (meta?.hint) this.hintEl.setText(`/${name} — ${meta.hint}`);
      this.options.onCommandSelected?.(name);
    }
    el.setRangeText(replacement, start, el.selectionStart ?? start, "end");
    this.active = null;
    el.focus();
    el.dispatchEvent(new Event("input"));
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
    } else {
      this.sendButton.setText("发送");
      this.sendButton.addClass("mod-cta");
      this.sendButton.removeClass("dsh-stop-btn");
    }
  }

  focus(): void {
    this.textarea.focus();
  }

  setHint(text: string): void {
    this.hintEl.setText(text);
  }

  private submit(): void {
    if (this.busy) {
      this.options.onStop();
      return;
    }
    const text = this.textarea.value.trim();
    if (!text) return;
    this.textarea.value = "";
    const mentions = parseMentions(text);
    this.options.onSubmit(text, mentions);
  }
}
