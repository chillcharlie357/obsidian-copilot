/** 通用小工具（插件侧） */

export function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = ((...args: never[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }) as T & { cancel: () => void };
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[截断 ${text.length - max} 字符]`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 把绝对路径规范化（用于比较/去重） */
export function normalizePathAbs(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

/** 绝对路径是否位于某个根之下 */
export function isPathInside(path: string, root: string): boolean {
  const p = normalizePathAbs(path);
  const r = normalizePathAbs(root);
  return p === r || p.startsWith(`${r}/`);
}

/** 求绝对路径相对根路径的相对形式 */
export function relativeTo(path: string, root: string): string {
  const p = normalizePathAbs(path);
  const r = normalizePathAbs(root);
  if (p === r) return "";
  if (p.startsWith(`${r}/`)) return p.slice(r.length + 1);
  return p;
}
