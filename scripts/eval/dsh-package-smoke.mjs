// Verifies the packed artifact, not the source tree: unpack a tarball and use
// that copy as the plugin the installed DSH loads. One project-mode round trip
// through a real Git repo; the model is a loopback protocol fixture.
// Usage: node scripts/eval/dsh-package-smoke.mjs <dsh-lm-memory-0.18.0.tgz>
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const { DSH_NODE_EXECUTABLE: node, DSH_INSTALL_DIR: install } = process.env;
const tarball = process.argv[2];
assert.ok(node && install, 'run from an installed DSH environment');
assert.ok(tarball, 'usage: node scripts/eval/dsh-package-smoke.mjs <package.tgz>');
const run = promisify(execFile);

const temp = await mkdtemp(path.join(tmpdir(), 'lm-pkg-smoke-'));
const home = path.join(temp, '.dsh');
const project = path.join(temp, 'repo');
const pkgRoot = path.join(temp, 'pkg');
const calls = [];
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const last = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'tool_result').at(-1);
    calls.push({ tools: (body.tools ?? []).map(t => t.name), result: last?.content });
    const step = calls.length;
    const name = step === 1 ? 'mcp__lm_project__memory_remember' : step === 2 ? 'mcp__lm_project__memory_recall' : null;
    assert.ok((body.tools ?? []).some(t => t.name.startsWith('mcp__lm_personal__')), 'personal tools absent');
    if (name) assert.ok((body.tools ?? []).some(t => t.name === name), `missing ${name} from the packaged plugin`);
    const input = step === 1 ? { kind: 'fact', content: 'Packaged plugin marker PKG-MARKER-77' } : { query: 'PKG-MARKER-77' };
    const item = name ? { type: 'tool_use', id: `toolu_pkg_${step}`, name, input } : { type: 'text', text: '' };
    const delta = name ? { type: 'input_json_delta', partial_json: JSON.stringify(input) }
      : { type: 'text_delta', text: 'PKG_OK' };
    const events = [
      { type: 'message_start', message: { id: `msg_pkg_${calls.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: item },
      { type: 'content_block_delta', index: 0, delta },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  } catch (error) { calls.push({ error: String(error.message) }); res.writeHead(400).end(); }
});

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await mkdir(pkgRoot, { recursive: true });
  await run('tar', ['xzf', path.resolve(tarball), '-C', pkgRoot]);
  const pluginDir = path.join(pkgRoot, 'package');
  const manifest = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'));
  for (const required of ['plugin/lib/index.js', 'plugin/lib/project-tools.mjs', 'plugin/lib/project-tool-catalog.json',
    'plugin/lib/confirmed-outcomes.mjs', 'server/memory-server.mjs', 'cordis.patch.yml',
    'docs/project-memory.md', 'scripts/migrate-to-personal.mjs']) {
    assert.ok(await readFile(path.join(pluginDir, required)).then(() => true, () => false), `packaged file missing: ${required}`);
  }
  assert.ok(!(await readdir(pluginDir)).includes('tests'), 'tests must not ship');

  await mkdir(project, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const mods = path.join(home, 'profiles', 'headless', 'node_modules');
  await mkdir(mods, { recursive: true });
  // A real copy inside the profile's node_modules, so the package's own
  // dependency imports resolve the way they do after a real install.
  await cp(pluginDir, path.join(mods, 'dsh-lm-memory'), { recursive: true });
  // The package declares its own dependencies; the smoke borrows the checkout's
  // installed copies so it stays offline.
  for (const dep of ['@modelcontextprotocol/sdk', 'zod']) {
    const target = path.join(mods, dep);
    await mkdir(path.dirname(target), { recursive: true });
    try { await symlink(path.join(import.meta.dirname, '..', '..', 'node_modules', dep), target, 'dir'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const patch = path.join(temp, 'patch.json');
  await writeFile(patch, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${server.address().port}` } },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'dsh-lm-memory', config: { projectMemory: true, memoryDir: path.join(home, 'memory') } },
  ]));
  const bundle = path.join(pluginDir, 'cordis.patch.yml');
  const { stdout } = await run(node, [path.join(install, 'lib/bin.js'), '--profile', 'headless', '--patch', bundle,
    '--patch', patch, '--json', 'Package smoke round trip.'], {
    cwd: project, timeout: 60_000,
    env: { HOME: temp, USERPROFILE: temp, DSH_HOME: home, PATH: process.env.PATH,
      ELECTRON_RUN_AS_NODE: '1', DSH_NODE: process.execPath, DEEPSEEK_API_KEY: 'test-only-fixture-key' },
  });
  assert.match(stdout, /PKG_OK/);
  assert.ok(calls.length >= 3, `expected three model calls, saw ${calls.length}`);
  assert.match(JSON.stringify(calls[1].result), /OK: id=1/);
  assert.match(JSON.stringify(calls[2].result), /PKG-MARKER-77/);
  await assert.rejects(readFile(path.join(home, 'memory', 'memory.db')), { code: 'ENOENT' });
  console.log(`PASS packaged plugin ${manifest.version}: project tools present, write+recall round trip, no legacy database`);
} finally {
  server.close();
  server.closeAllConnections();
  await rm(temp, { recursive: true, force: true });
}
