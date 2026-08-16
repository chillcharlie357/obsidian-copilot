/**
 * 项目（vault）自定义 slash 命令：
 * 目录 `.obsidian-copilot/commands/*.md`，每个文件是一个命令。
 * 文件名即命令名；description 取 frontmatter 或首行；正文为 prompt 模板，
 * `$ARGUMENTS` 会被用户输入替换。
 */
import type { Vault } from "obsidian";

export const COMMANDS_DIR = ".obsidian-copilot/commands";

export interface CustomCommand {
  name: string;
  description: string;
  path: string;
}

/** 解析命令文件：剥离 frontmatter，取 description 与正文模板。 */
export function parseCommandMeta(content: string): { description: string; body: string } {
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const descMatch = fm[1]?.match(/^description:\s*(.+)$/m);
    const body = content.slice(fm[0].length).trim();
    return { description: descMatch?.[1]?.trim() ?? "", body };
  }
  const body = content.trim();
  const firstLine = body.split("\n")[0] ?? "";
  const description = firstLine.replace(/^#+\s*/, "").trim().slice(0, 80);
  return { description, body };
}

/** 模板展开：$ARGUMENTS 替换为用户输入；无占位符时把输入追加为段落。 */
export function expandTemplate(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", args);
  return args.trim() !== "" ? `${body}\n\n${args}` : body;
}

export async function listCustomCommands(vault: Vault): Promise<CustomCommand[]> {
  try {
    if (!(await vault.adapter.exists(COMMANDS_DIR))) return [];
    const list = await vault.adapter.list(COMMANDS_DIR);
    const result: CustomCommand[] = [];
    for (const file of list.files) {
      if (!file.endsWith(".md")) continue;
      const name = file.split("/").pop()?.replace(/\.md$/, "") ?? file;
      if (!name) continue;
      try {
        const content = await vault.adapter.read(file);
        const { description } = parseCommandMeta(content);
        result.push({ name, description, path: file });
      } catch {
        /* 单个文件读取失败则跳过 */
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
