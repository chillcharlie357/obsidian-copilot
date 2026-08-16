/**
 * Agent Profile：把「用哪个 ACP agent」抽象成命名配置。
 * 每个 profile 是一条启动命令（支持占位符），DSH 只是内置预设之一，
 * 任何支持 ACP 的 agent（codex/zed/自定义）都能作为 profile 接入。
 */

export interface AgentProfile {
  id: string;
  name: string;
  /** 启动命令，支持占位符：{adapter} 适配器路径、{vault} vault 根目录 */
  command: string;
  description?: string;
  /** 内置预设（不可删除） */
  builtin?: boolean;
}

export const BUILTIN_DSH_PROFILE_ID = "builtin-dsh";

/** 内置 DSH 预设：随插件分发的 dsh-acp-adapter */
export function builtinDshProfile(): AgentProfile {
  return {
    id: BUILTIN_DSH_PROFILE_ID,
    name: "DeepSeek Harness（DSH）",
    description: "内置预设：dsh-acp-adapter ↔ dsh web（自动启动、vault 为工作目录）",
    builtin: true,
    command:
      'node "{adapter}" --dsn http://127.0.0.1:3080 --auto-start-dsh true --dsh-bin dsh --kill-dsh-on-exit true',
  };
}

/** 把命令行字符串切分为参数（支持双引号/单引号包裹含空格的路径）。 */
export function splitCommand(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

/** 展开占位符并切分命令。 */
export function expandCommand(command: string, vars: Record<string, string>): string[] {
  let expanded = command;
  for (const [key, value] of Object.entries(vars)) {
    expanded = expanded.replaceAll(`{${key}}`, value);
  }
  return splitCommand(expanded);
}

/**
 * 旧版（DSH 硬编码设置）迁移：用旧字段构建等价的 DSH profile 命令。
 */
export function migrateLegacyDshProfile(legacy: {
  dsn?: string;
  autoStartDsh?: boolean;
  dshBin?: string;
  killDshOnExit?: boolean;
}): AgentProfile {
  const dsn = legacy.dsn?.trim() || "http://127.0.0.1:3080";
  const autoStart = legacy.autoStartDsh === false ? "false" : "true";
  const dshBin = legacy.dshBin?.trim() || "dsh";
  const killOnExit = legacy.killDshOnExit === false ? "false" : "true";
  const profile = builtinDshProfile();
  profile.command = `node "{adapter}" --dsn ${dsn} --auto-start-dsh ${autoStart} --dsh-bin ${dshBin} --kill-dsh-on-exit ${killOnExit}`;
  return profile;
}
