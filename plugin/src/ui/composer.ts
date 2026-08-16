/**
 * 输入框：textarea + @ 引用解析 + 发送/停止按钮。
 */
import { setIcon } from "obsidian";
import type DshCopilotPlugin from "../main.js";

export interface Mention {
  name: string;
  path: string;
}

export interface ComposerOptions {
  onSubmit: (text: string, mentions: Mention[]) => void;
  onStop: () => void;
  /** 用户输入 @ 时打开文件选择器 */
  onMention: () => void;
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

export class Composer {
  private textarea: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
  private busy = false;

  constructor(
    container: HTMLElement,
    private readonly plugin: DshCopilotPlugin,
    private readonly options: ComposerOptions
  ) {
    const box = container.createDiv({ cls: "dsh-composer-box" });
    this.textarea = box.createEl("textarea", {
      cls: "dsh-composer-input",
      attr: { placeholder: "输入问题，@ 引用笔记，Enter 发送…" },
    });
    const bar = container.createDiv({ cls: "dsh-composer-bar" });
    const mentionButton = bar.createEl("button", { cls: "dsh-icon-btn", attr: { "aria-label": "@引用文件" } });
    setIcon(mentionButton, "at-sign");
    mentionButton.addEventListener("click", () => this.options.onMention());
    bar.createDiv({ cls: "dsh-composer-hint", text: "Enter 发送 · Shift+Enter 换行 · @ 引用" });
    this.sendButton = bar.createEl("button", { cls: "dsh-send-btn mod-cta" });
    this.sendButton.setText("发送");
    this.sendButton.addEventListener("click", () => this.submit());

    this.textarea.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.submit();
      }
    });
    // 键入 @ 且光标紧跟其后时弹出文件选择器
    this.textarea.addEventListener("keyup", (ev: KeyboardEvent) => {
      if (ev.key !== "@") return;
      const el = this.textarea;
      const pos = el.selectionStart ?? 0;
      if (/@$/.test(el.value.slice(0, pos))) this.options.onMention();
    });
  }

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

  insertMention(name: string, path: string): void {
    const el = this.textarea;
    const token = `@[${name}](${path})`;
    const pos = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, pos);
    // 吃掉光标前刚输入的 @
    const atMatch = /@$/.exec(before);
    const start = atMatch ? pos - 1 : pos;
    el.setRangeText(token, start, el.selectionEnd ?? start, "end");
    el.focus();
    el.dispatchEvent(new Event("input"));
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
