// Viewer startup owns only the exact detached process it launched; unverified legacy
// listeners must survive, and the settings bridge must not point at their data.
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import apply from "../plugin/lib/index.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lm-viewer-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const oldProc = spawn(process.execPath, ["-e", `// legacy viewer.mjs stub (no /api/version)
  const server = require('node:http').createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.listen(0, '127.0.0.1', () => process.send(server.address().port));`
], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
const oldExited = once(oldProc, "exit");
const observedPids = new Set();
let route;
const ctx = {
  on() {},
  inject(_, register) { register({ connection: { fetch: { register: (r) => { route = r; } } } }); },
};

async function poll(fn, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try { const value = await fn(); if (predicate(value)) return value; } catch {}
    await sleep(100);
  } while (Date.now() < deadline);
  assert.fail("viewer condition not reached before deadline");
}

try {
  const [port] = await once(oldProc, "message");
  const url = `http://127.0.0.1:${port}/api/version`;
  const readVersion = async () => (await fetch(url, { signal: AbortSignal.timeout(1000) })).json();
  const bridge = async () => (await route.fetch()).json();
  const settings = { memoryDir: TMP, viewer: port };

  apply(ctx, settings);
  await sleep(750);
  assert.equal((await fetch(url)).status, 404);
  assert.equal(oldProc.exitCode, null);
  assert.equal(oldProc.signalCode, null);
  assert.deepEqual(await bridge(), { port, status: "offline" });
  console.log("✓ unverified legacy listener stays alive and hidden from settings");

  oldProc.kill("SIGTERM");
  await oldExited;
  apply(ctx, settings);
  const fresh = await poll(readVersion, (data) => data.version === version && typeof data.startupKey === "string");
  assert.ok(Number.isInteger(fresh.pid) && fresh.pid > 1);
  observedPids.add(fresh.pid);
  assert.deepEqual(await bridge(), { port, status: "ready" });
  apply(ctx, settings);
  await sleep(750);
  assert.equal((await readVersion()).pid, fresh.pid);
  console.log("✓ spawned viewer reports matching version and repeated startup preserves it");

  let inspectable = false;
  try {
    const options = { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] };
    const listeners = execFileSync("lsof", ["-a", "-ti4TCP:" + port, "-sTCP:LISTEN"], options).trim().split("\n");
    inspectable = listeners.includes(String(fresh.pid)) && Boolean(execFileSync("ps", ["-ww", "-p", String(fresh.pid), "-o", "command="], options).trim());
  } catch {}
  const noRemote = { ...settings, allowRemote: false, memoryDir: path.join(TMP, "changed") };
  delete process.env.LM_REMOTE_DISABLED;
  apply(ctx, noRemote);
  // The mismatched process must not be offered to settings, even if it cannot be replaced.
  const state = await bridge();
  assert.ok(["offline", "stale"].includes(state.status), JSON.stringify(state));
  if (inspectable) {
    const replaced = await poll(readVersion, (data) => data.pid !== fresh.pid && data.startupKey && data.startupKey !== fresh.startupKey);
    observedPids.delete(fresh.pid);
    observedPids.add(replaced.pid);
    assert.deepEqual(await bridge(), { port, status: "ready" });
    console.log("✓ changed directory/policy replaces only the exact managed viewer");
  } else {
    assert.deepEqual(await bridge(), { port, status: "stale" });
    assert.equal((await readVersion()).pid, fresh.pid);
    console.log("✓ viewer remains hidden and untouched when lsof/ps cannot confirm ownership");
  }
} finally {
  if (oldProc.exitCode === null && oldProc.signalCode === null) oldProc.kill("SIGTERM");
  for (const pid of observedPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
}
