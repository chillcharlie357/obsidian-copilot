import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

mkdirSync("dist", { recursive: true });

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2020",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  sourcemap: false,
  logLevel: "info",
};

const watch = process.argv.includes("--watch");

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching plugin/src…");
} else {
  await esbuild.build(options);
}

// 将构建好的适配器单文件复制进插件产物，随插件一起分发
try {
  const adapter = join("..", "adapter", "dist", "dsh-acp-adapter.cjs");
  copyFileSync(adapter, join("dist", "adapter.cjs"));
  console.log("copied adapter.cjs into plugin dist");
} catch (error) {
  console.warn("adapter 尚未构建，跳过复制（先运行 pnpm build:adapter）");
}

// 静态资源：dist 即完整可安装的插件目录
for (const file of ["manifest.json", "styles.css", "versions.json"]) {
  copyFileSync(file, join("dist", file));
}
console.log("copied manifest.json / styles.css / versions.json into plugin dist");
