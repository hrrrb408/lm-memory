import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveNode, spawnViewer, viewerPort } from "../plugin/lib/startup.mjs";
import apply from "../plugin/lib/index.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-startup-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("runtime resolution: missing or old candidates are not treated as usable", { skip: process.platform === "win32" && "POSIX fixture" }, (t) => {
  const dir = tempDir(t);
  const old = path.join(dir, "old-node");
  const missing = path.join(dir, "missing");
  fs.writeFileSync(old, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ version: "22.15.9", execPath: old, sqlite: true })}'\n`, { mode: 0o700 });
  const messages = [];
  const fallback = { env: { PATH: dir }, execPath: "/not/a/standalone/Host", platform: "linux", log: (msg) => messages.push(msg) };
  assert.equal(resolveNode({ ...fallback, env: { ...fallback.env, DSH_NODE: missing } }), null);
  assert.match(messages.pop(), /no usable Node.*ENOENT/);
  assert.equal(resolveNode({ ...fallback, env: { ...fallback.env, DSH_NODE: old } }), null);
  assert.match(messages.pop(), /22\.15\.9/);
  assert.equal(resolveNode({ ...fallback, execPath: process.execPath, env: { ...fallback.env, DSH_NODE: old } }), process.execPath);
  assert.equal(resolveNode({ ...fallback, env: { ...fallback.env, DSH_NODE: process.execPath } }), process.execPath);
});

test("an asynchronous viewer spawn ENOENT is logged instead of crashing the Host", async (t) => {
  const dir = tempDir(t);
  const messages = [];
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("spawn failure not reported")), 3000);
    spawnViewer(path.join(dir, "missing-node"), "viewer.mjs", 17445, process.env, (msg) => {
      messages.push(msg);
      clearTimeout(timeout);
      resolve();
    });
  });
  assert.match(messages.join("\n"), /viewer spawn error on 17445: ENOENT/);
  assert.doesNotMatch(messages.join("\n"), /started/);
});

test("an unavailable node:sqlite in Host does not prevent startup registration using an external Node", { skip: process.platform === "win32" && "POSIX PATH fixture" }, (t) => {
  const memoryDir = tempDir(t);
  const plugin = new URL("../plugin/lib/index.js", import.meta.url).href;
  const code = `const apply = (await import(${JSON.stringify(plugin)})).default;
    const hooks = []; let startup;
    apply({on: (name) => hooks.push(name), provide: (_name, value) => { startup = value }}, {memoryDir: ${JSON.stringify(memoryDir)}});
    console.log(JSON.stringify({hooks, startup}));`;
  const out = spawnSync(process.execPath, ["--no-experimental-sqlite", "--input-type=module", "-e", code], {
    env: { ...process.env, DSH_NODE: process.execPath, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 8000,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stderr, /queue capture unavailable in Host/);
  const { hooks, startup } = JSON.parse(out.stdout);
  assert.ok(hooks.includes("agent/pre-step"));
  assert.equal(startup.node, process.execPath);
  assert.equal(startup.memoryDir, memoryDir);
});

test("a shim failure leaves MCP unpublished and does not skip capture hooks", (t) => {
  const dir = tempDir(t);
  const invalid = path.join(dir, "file-not-directory");
  fs.writeFileSync(invalid, "");
  const hooks = [];
  const services = [];
  apply({ on: (name) => hooks.push(name), provide: (name) => services.push(name) }, { memoryDir: invalid });
  assert.ok(hooks.includes("agent/pre-step"));
  assert.deepEqual(services, []);
});

test("the generated stdio shim advertises the manifest version and documented tool count", async (t) => {
  const memoryDir = tempDir(t);
  let startup;
  apply({ on() {}, provide: (name, value) => { assert.equal(name, "lmMemoryStartup"); startup = value; } }, { memoryDir, allowRemote: false });
  assert.ok(startup);
  assert.equal(startup.shimPath, path.join(memoryDir, "bin", "lm-memory-server.mjs"));
  assert.match(fs.readFileSync(startup.shimPath, "utf8"), /LM_REMOTE_DISABLED = "1"/);
  const client = new Client({ name: "startup-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: startup.node, args: [startup.shimPath],
    env: { ...process.env, LM_MEMORY_DIR: startup.memoryDir, LM_EMBED: "0" }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(client.getServerVersion().version, manifest.version);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);
    const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
    assert.match(readme, new RegExp(`${tools.length} 个记忆工具`));
    assert.ok(readme.includes(`dsh-lm-memory-${manifest.version}.tgz`));
    for (const { name } of tools) assert.ok(readme.includes(`| \`${name}\` |`), name);
  } finally { await client.close(); }
});

function renderClient(fetch, location) {
  let module, section, effect, state;
  const window = { location, __ModuleLoader__: { load: ({ factory }) => { module = factory(() => react); } } };
  const react = {
    useState: (initial) => [state ?? initial, (value) => { state = value; }],
    useEffect: (fn) => { effect = fn; },
    createElement: (type, props, ...children) => ({ type, props, children }),
  };
  vm.runInNewContext(fs.readFileSync(new URL("../plugin/client.js", import.meta.url), "utf8"), { window, fetch, AbortController, AbortSignal });
  module.apply({ slots: { inject: (_, register) => register(), register: (_, render) => { section = render; } } });
  section();
  return { section, effect, state: () => state };
}

test("settings fetch and open use a validated non-default port from the DSH bridge", async () => {
  const calls = [];
  const { effect, section, state } = renderClient(async (url) => {
    calls.push(url);
    if (url === "./api/lm-memory-settings") return Response.json({ settings: { projectMemory: false, confirmedOutcomes: false, allowRemote: false, taskRecall: { enabled: false, sessionIds: [] } }, restartRequired: false });
    return Response.json(url.startsWith("./") ? { port: 17602, status: "ready" } : { total: 1, items: [{ id: 42, content: "test" }] });
  }, { hostname: "app", protocol: "dsh-app:" });
  const dispose = effect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["./api/lm-memory-settings", "./api/lm-memory-viewer", "http://127.0.0.1:17602/api/memories"]);
  assert.equal(state().status, "ok");
  const button = section().children[2].children[0];
  assert.equal(button.props.href, "http://127.0.0.1:17602");
  assert.equal(button.props.rel, "noopener noreferrer");
  assert.match(JSON.stringify(section()), /功能开关/);
  dispose();
});

test("settings do not guess a default or contact local services without a verified bridge", async () => {
  const calls = [];
  const { effect, state } = renderClient(async (url) => {
    calls.push(url);
    if (url === "./api/lm-memory-settings") return Response.json({ settings: { taskRecall: { enabled: false, sessionIds: [] } } });
    return Response.json({ port: "7640@other-host", status: "ready" });
  }, { hostname: "localhost", protocol: "http:" });
  effect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["./api/lm-memory-settings", "./api/lm-memory-viewer"]);
  assert.equal(state().status, "unavailable");
  const remote = renderClient(() => assert.fail("remote GUI must not fetch browser-local services"), { hostname: "host.example", protocol: "https:" });
  remote.effect();
  assert.equal(remote.state().status, "remote");
  const stale = renderClient(async (url) => {
    if (url === "./api/lm-memory-settings") return Response.json({ settings: { taskRecall: { enabled: false, sessionIds: [] } } });
    assert.equal(url, "./api/lm-memory-viewer"); // no direct access to the stale viewer
    return Response.json({ port: 17602, status: "stale" });
  }, { hostname: "localhost", protocol: "http:" });
  stale.effect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stale.state().status, "stale");
  assert.equal(stale.section().children[2], null);
  assert.equal(viewerPort("17602"), 17602);
  for (const bad of [true, "1e4", "65536", 0, -1, 4.5]) assert.equal(viewerPort(bad), null);
});
