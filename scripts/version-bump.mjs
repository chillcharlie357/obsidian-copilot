/**
 * 版本号同步（官方 sample 的 version-bump.mjs 的 monorepo 适配版）：
 * 用法：node scripts/version-bump.mjs <new-version>
 * - 更新 plugin/manifest.json 的 version
 * - 把新版本写入 plugin/versions.json（minAppVersion 取 manifest 中的值）
 * - 同步 plugin/package.json 的 version
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const manifestPath = join(root, "plugin", "manifest.json");
const versionsPath = join(root, "plugin", "versions.json");
const packagePath = join(root, "plugin", "package.json");

const targetVersion = process.argv[2];
if (!targetVersion || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
  console.error("usage: node scripts/version-bump.mjs <semver>");
  process.exit(1);
}

// manifest.json：写入新版本
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

// versions.json：追加新版本（保留历史映射）
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
if (!(targetVersion in versions)) {
  versions[targetVersion] = minAppVersion;
}
writeFileSync(versionsPath, `${JSON.stringify(versions, null, "\t")}\n`);

// plugin/package.json：同步版本
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
pkg.version = targetVersion;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`version bumped to ${targetVersion} (minAppVersion ${minAppVersion})`);
console.log("next: git commit && git tag " + targetVersion + " && git push --tags");
