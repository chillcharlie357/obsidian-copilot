/**
 * 持续记忆：vault 根目录 `.obsidian-copilot/memory.md`。
 * - 每个新会话随系统提示一起注入（跨会话记住用户偏好）
 * - `/remember` 命令与 👎 反馈会追加写入
 * - 用户可直接编辑该文件
 */
import type { Vault } from "obsidian";

export const MEMORY_FILE = ".obsidian-copilot/memory.md";
/** 注入进上下文的记忆上限（超出截断，agent 可自行读取完整文件） */
export const MEMORY_INJECT_MAX = 4000;

export async function readMemory(vault: Vault): Promise<string> {
  try {
    if (!(await vault.adapter.exists(MEMORY_FILE))) return "";
    const content = await vault.adapter.read(MEMORY_FILE);
    return content.trim();
  } catch {
    return "";
  }
}

export async function appendMemory(vault: Vault, text: string): Promise<void> {
  const line = text.trim();
  if (!line) return;
  try {
    const adapter = vault.adapter;
    let existing = "";
    if (await adapter.exists(MEMORY_FILE)) {
      existing = await adapter.read(MEMORY_FILE);
    } else {
      const slash = MEMORY_FILE.lastIndexOf("/");
      if (slash > 0) {
        const dir = MEMORY_FILE.slice(0, slash);
        if (!(await adapter.exists(dir))) await vault.createFolder(dir).catch(() => undefined);
      }
    }
    const separator = existing === "" ? "# 持续记忆\n" : existing.endsWith("\n") ? "" : "\n";
    await adapter.write(MEMORY_FILE, `${existing}${separator}${line}\n`);
  } catch (error) {
    console.error("[obsidian-copilot] 写入记忆失败:", error);
  }
}
