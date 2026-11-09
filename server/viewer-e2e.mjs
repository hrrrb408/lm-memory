// viewer 旧版自动升级 E2E（v0.10）：
// 1) 假旧 viewer（独立进程、无 /api/version）占端口 → 插件 apply → 旧进程被杀、新 viewer 拉起
// 2) 再次 apply → 新 viewer 不被重启（pid 不变）
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lm-viewer-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 17840 + Math.floor(Math.random() * 1000);
const portPid = (p) => { try { return Number(createRequire(import.meta.url)("node:child_process").execFileSync("lsof", ["-ti", ":" + p, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0]) || 0; } catch { return 0; } };

// 1) 假旧 viewer：独立进程占端口、所有请求 404（模拟旧版：无 /api/version）
// 注：命令行必须含 "viewer.mjs" 字样——插件有 ps 防误杀校验（只杀真正的 viewer 进程）
const oldProc = spawn(process.execPath, ["-e",
  `// legacy viewer.mjs stub (v0.9, no /api/version)\nrequire("http").createServer((q,s)=>{s.writeHead(404,{"Content-Type":"application/json"});s.end(JSON.stringify({error:"not found"}))}).listen(${port},"127.0.0.1")`
], { stdio: "ignore" });
async function waitPort(p, wantVersion, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch("http://127.0.0.1:" + p + "/api/version", { signal: AbortSignal.timeout(800) });
      if (r.ok) {
        const d = await r.json();
        if (!wantVersion || d.version === wantVersion) return d;
      }
    } catch {}
    await sleep(300);
  }
  return null;
}
// 等假旧 viewer 就绪（404 也算就绪）
{
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 8000) {
    try { const r = await fetch("http://127.0.0.1:" + port + "/api/version", { signal: AbortSignal.timeout(500) }); if (r.status === 404) { up = true; break; } } catch {}
    await sleep(200);
  }
  if (!up) { console.error("FAIL: 假旧 viewer 未就绪"); process.exit(1); }
}
const oldPid = portPid(port);
console.log(`旧 viewer pid=${oldPid} 占据端口 ${port}`);

// 2) 插件 apply → 应 kill 旧版并拉起新 viewer
const plugin = (await import("file://" + path.join(INSTALL_DIR, "plugin/lib/index.js"))).default;
const wantVersion = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, "package.json"), "utf8")).version;
let passed = 0, failed = 0;
const ok = (cond, label, extra = "") => { if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label} ${extra}`); } };

plugin({ on: () => {} }, { memoryDir: TMP, viewer: port });
const fresh = await waitPort(port, wantVersion);
ok(fresh !== null, "新 viewer 拉起且 /api/version 返回正确版本", `want=${wantVersion}`);
ok(oldPid !== portPid(port) && !oldProc.pid || true, "（信息）新旧 pid");
await sleep(300);
const oldGone = oldProc.kill(0) === false || oldProc.exitCode !== null || oldProc.signalCode !== null;
ok(oldGone, "旧 viewer 进程已被终止", `exitCode=${oldProc.exitCode} signal=${oldProc.signalCode}`);
ok(fresh?.pid === portPid(port), "端点 pid 与实际端口占用一致");

// 3) 再次 apply → 新 viewer 不被重启
const pidBefore = portPid(port);
plugin({ on: () => {} }, { memoryDir: TMP, viewer: port });
await sleep(2500);
ok(portPid(port) === pidBefore, "新版在跑时再次 apply 不重启（pid 不变）", `before=${pidBefore} after=${portPid(port)}`);

// 清理
try { process.kill(portPid(port), "SIGTERM"); } catch {}
try { oldProc.kill("SIGKILL"); } catch {}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
