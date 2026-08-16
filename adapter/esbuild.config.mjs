import esbuild from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/dsh-acp-adapter.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["bufferutil", "utf-8-validate"],
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});

console.log("built adapter/dist/dsh-acp-adapter.cjs");
