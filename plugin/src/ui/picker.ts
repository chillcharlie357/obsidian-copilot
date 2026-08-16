/**
 * 行内选择器（Codex 风格）：嵌在侧边栏输入框上方的下拉列表，
 * 不使用 Obsidian 全局搜索弹窗。支持键盘导航与鼠标点击。
 */
import { setIcon } from "obsidian";

export interface PickerItem {
  key: string;
  /** 主文本 */
  label: string;
  /** 副文本（描述/路径） */
  hint?: string;
  /** lucide 图标名 */
  icon?: string;
  meta?: unknown;
}

export class InlinePicker {
  readonly el: HTMLElement;
  private listEl!: HTMLElement;
  private kindLabelEl!: HTMLElement;
  private items: PickerItem[] = [];
  private filtered: PickerItem[] = [];
  private query = "";
  private selected = 0;
  private kindLabel = "";
  visible = false;
  /** 选择回调（点击 / 回车） */
  onSelect: ((item: PickerItem) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.el = parent.createDiv({ cls: "dsh-picker" });
    this.el.hide();
    const header = this.el.createDiv({ cls: "dsh-picker-header" });
    this.kindLabelEl = header.createSpan({ cls: "dsh-picker-kind" });
    this.listEl = this.el.createDiv({ cls: "dsh-picker-list" });

    this.el.addEventListener("mousedown", (ev: Event) => {
      // 防止点击列表时输入框失焦
      ev.preventDefault();
    });
    this.el.addEventListener("click", (ev: Event) => {
      const target = (ev.target as HTMLElement).closest(".dsh-picker-item") as HTMLElement | null;
      if (!target) return;
      const index = Number(target.dataset.index);
      if (Number.isFinite(index)) {
        this.selected = index;
        const item = this.filtered[index];
        if (item) this.choose(item);
      }
    });
  }

  open(kindLabel: string, items: PickerItem[], query: string): void {
    this.kindLabel = kindLabel;
    this.items = items;
    this.kindLabelEl.setText(kindLabel);
    this.query = query;
    this.selected = 0;
    this.applyFilter();
    this.el.show();
    this.visible = true;
  }

  updateQuery(query: string): void {
    this.query = query;
    this.selected = 0;
    this.applyFilter();
  }

  move(delta: number): void {
    if (!this.visible || this.filtered.length === 0) return;
    this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + delta));
    this.render();
  }

  selectCurrent(): PickerItem | null {
    if (!this.visible) return null;
    const item = this.filtered[this.selected];
    if (item) this.choose(item);
    return item ?? null;
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.hide();
  }

  private choose(item: PickerItem): void {
    this.close();
    this.onSelect?.(item);
  }

  private applyFilter(): void {
    const query = this.query.toLowerCase().trim();
    if (query === "") {
      this.filtered = [...this.items];
    } else {
      const starts: PickerItem[] = [];
      const contains: PickerItem[] = [];
      for (const item of this.items) {
        const hay = `${item.label} ${item.hint ?? ""}`.toLowerCase();
        if (item.label.toLowerCase().startsWith(query)) starts.push(item);
        else if (hay.includes(query)) contains.push(item);
      }
      this.filtered = [...starts, ...contains];
    }
    this.render();
  }

  private render(): void {
    this.listEl.empty();
    if (this.filtered.length === 0) {
      this.listEl.createDiv({ cls: "dsh-picker-empty", text: `没有匹配的${this.kindLabel}` });
      return;
    }
    this.filtered.forEach((item, index) => {
      const row = this.listEl.createDiv({
        cls: `dsh-picker-item${index === this.selected ? " dsh-picker-selected" : ""}`,
        attr: { "data-index": String(index) },
      });
      if (item.icon) {
        const icon = row.createSpan({ cls: "dsh-picker-icon" });
        setIcon(icon, item.icon);
      }
      const text = row.createDiv({ cls: "dsh-picker-text" });
      text.createDiv({ cls: "dsh-picker-label", text: item.label });
      if (item.hint) text.createDiv({ cls: "dsh-picker-hint", text: item.hint });
    });
    // 选中项滚动到可视区
    const selectedEl = this.listEl.querySelector(".dsh-picker-selected");
    selectedEl?.scrollIntoView({ block: "nearest" });
  }
}
