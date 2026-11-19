import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

// The child must be a real, standalone Node with SQLite, not just an existing GUI shim.
const PROBE = `let sqlite = false;
try { sqlite = typeof require('node:sqlite').DatabaseSync === 'function' } catch {}
console.log(JSON.stringify({ version: process.versions.node, execPath: process.execPath, sqlite, electron: process.versions.electron }));`;

export function resolveNode({ env = process.env, execPath = process.execPath, platform = process.platform, log = () => {} } = {}) {
  const candidates = new Set([
    env.DSH_NODE,
    /[\\/]node(?:\.exe)?$/i.test(execPath) ? execPath : null,
    ...(platform === "darwin" ? ["/opt/homebrew/bin/node", "/usr/local/bin/node"] : []),
    ...(platform === "win32" ? [...new Set([env.ProgramW6432, env.ProgramFiles, "C:\\Program Files"])]
      .filter(Boolean).map((dir) => path.win32.join(dir, "nodejs", "node.exe")) : []),
    "node",
  ].filter(Boolean));
  // DSH's stdio transport can scrub DSH_* variables, so return the discovered absolute
  // executable rather than a shim that would still need those variables in the child.
  const tried = [];
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ["-e", PROBE], { env, encoding: "utf8", timeout: 1500, maxBuffer: 8192, windowsHide: true });
      const info = result.status === 0 ? JSON.parse(result.stdout.trim()) : null;
      const [major, minor] = /^\d+\.\d+\.\d+$/.test(info?.version) ? info.version.split(".").map(Number) : [];
      if (info?.sqlite === true && !info.electron && (major > 22 || (major === 22 && minor >= 16)) && path.isAbsolute(info.execPath)) return info.execPath;
      tried.push(`${candidate} (${info?.version ?? result.error?.code ?? "probe failed"})`);
    } catch { tried.push(`${candidate} (invalid probe response)`); }
  }
  log(`no usable Node.js ≥22.16 with node:sqlite; set DSH_NODE to its executable and restart DSH. Tried: ${tried.join(", ")}`);
  return null;
}

export function viewerPort(configured) {
  const port = typeof configured === "string" && /^\d+$/.test(configured) ? Number(configured) : configured;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export const viewerArgs = (viewerPath, port) => [viewerPath, String(port), "--lm-memory-managed"];

export function spawnViewer(node, viewerPath, port, env, log) {
  try {
    const child = spawn(node, viewerArgs(viewerPath, port), { detached: true, stdio: "ignore", env, windowsHide: true });
    // Synchronous try/catch does not handle ENOENT/EACCES emitted on ChildProcess.
    child.on("error", (error) => log(`viewer spawn error on ${port}: ${error.code ?? error.message}`));
    child.once("spawn", () => log(`viewer process started on ${port}`));
    child.once("exit", (code) => { if (code) log(`viewer on ${port} exited (${code})`); });
    child.unref();
  } catch (error) { log(`viewer spawn error on ${port}: ${error?.message ?? error}`); }
}
