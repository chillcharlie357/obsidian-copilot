/**
 * 二进制解析：Obsidian 从 Finder/Dock 启动时 PATH 只有系统目录，
 * 找不到 Homebrew 的 node/dsh。这里按常见安装位置逐级探测，
 * 并在设置里提供手动覆盖。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function exists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** 从一组候选路径里取第一个存在的可执行文件。 */
export function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** 从版本目录中找最新版本的 bin/<name>（nvm/fnm/asdf 布局）。 */
function latestVersionedBin(dirs: string[], name: string): string | null {
  const versions: Array<{ path: string; mtime: number }> = [];
  for (const dir of dirs) {
    try {
      for (const entry of readdirSync(dir)) {
        const bin = join(dir, entry, "bin", name);
        if (exists(bin)) {
          try {
            versions.push({ path: bin, mtime: statSync(bin).mtimeMs });
          } catch {
            versions.push({ path: bin, mtime: 0 });
          }
        }
      }
    } catch {
      /* 目录不存在则跳过 */
    }
  }
  versions.sort((a, b) => b.mtime - a.mtime);
  return versions[0]?.path ?? null;
}

export function resolveNodeBin(override?: string): string | null {
  if (override && exists(override)) return override;
  const home = homedir();
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/opt/local/bin/node",
    "/usr/bin/node",
    latestVersionedBin([join(home, ".nvm", "versions", "node")], "node"),
    latestVersionedBin(
      [join(home, "Library", "Application Support", "fnm", "node-versions")],
      "node"
    ),
    latestVersionedBin([join(home, ".asdf", "installs", "nodejs")], "node"),
    latestVersionedBin([join(home, ".volta", "tools", "image", "node")], "node"),
  ].filter((candidate): candidate is string => candidate !== null);
  return firstExisting(candidates);
}

export function resolveDshBin(override?: string): string | null {
  if (override && exists(override)) return override;
  const home = homedir();
  const candidates = [
    "/opt/homebrew/bin/dsh",
    "/usr/local/bin/dsh",
    "/opt/local/bin/dsh",
    "/usr/bin/dsh",
    join(home, ".local", "bin", "dsh"),
    join(home, "Library", "pnpm", "dsh"),
  ];
  return firstExisting(candidates);
}

/**
 * 兜底：用 Electron 二进制以 Node 模式运行（ELECTRON_RUN_AS_NODE）。
 * 任何环境下都能拿到一个 Node 运行时。
 */
export function electronNodeFallback(): { command: string; env: NodeJS.ProcessEnv } {
  return {
    command: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}
