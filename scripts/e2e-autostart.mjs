/**
 * 适配器自动启动 DSH 的 E2E（轻量：不发起模型调用）。
 * 用独立 DSH_HOME（/tmp 下）隔离，避免与正在运行的 Web GUI 共享状态。
 * 用法：node scripts/e2e-autostart.mjs [--port 3456]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { request as httpRequest } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(__dirname, "..", "adapter", "dist", "dsh-acp-adapter.cjs");
const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3456;
const dsn = `http://127.0.0.1:${port}`;

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const fail = (name, detail) => {
  failures++;
  console.error(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
};

function ping(port) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ type: "client-request", rpcId: "ping-1", method: "host.describe", payload: {} });
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/host.describe", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
      }
    );
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
    req.end(body);
  });
}

async function main() {
  console.log(`适配器自动启动测试（dsn=${dsn}）`);
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-e2e-home-"));
  const vault = mkdtempSync(join(tmpdir(), "dsh-e2e-vault-"));
  console.log(`DSH_HOME=${dshHome}`);

  const child = spawn(
    process.execPath,
    [ADAPTER, "--dsn", dsn, "--auto-start-dsh", "true", "--dsh-bin", "dsh", "--kill-dsh-on-exit", "true"],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DSH_HOME: dshHome } }
  );

  let buffer = "";
  let nextId = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.method === undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
      }
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[adapter] ${chunk}`));
  const request = (method, params, timeoutMs = 60_000) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  try {
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } }, 15_000);
    if (init.protocolVersion === 1) ok("initialize");
    else fail("initialize");

    const started = Date.now();
    const created = await request("session/new", { cwd: vault, mcpServers: [] }, 90_000);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (typeof created.sessionId === "string") ok(`session/new 成功（自动启动耗时 ${elapsed}s）`);
    else fail("session/new", JSON.stringify(created));

    if (await ping(port)) ok("自动启动的 dsh web 健康检查通过");
    else fail("健康检查");

    // 关闭适配器 → 应杀掉它启动的 dsh web
    child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const stillUp = await ping(port);
    if (!stillUp) ok("适配器退出后 dsh web 已关闭（killOnExit）");
    else fail("killOnExit", `端口 ${port} 仍可访问`);
  } catch (error) {
    fail("流程异常", error.message);
  } finally {
    child.kill();
    rmSync(dshHome, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\n自动启动测试通过 ✅" : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
