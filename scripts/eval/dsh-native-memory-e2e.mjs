// Real installed DSH Headless lifecycle + real MCP/worker/SQLite; only model I/O is stubbed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const launch = promisify(execFile);
const { DSH_NODE_EXECUTABLE: harness, DSH_INSTALL_DIR: install } = process.env;
if (!harness || !install) throw Error('Set DSH_NODE_EXECUTABLE and DSH_INSTALL_DIR for the installed DSH CLI');
const fixture = await mkdtemp(path.join(tmpdir(), 'lm-dsh-native-'));
const dshHome = path.join(fixture, '.dsh');
const memory = path.join(dshHome, 'memory');
const workspace = path.join(fixture, 'workspace');
const repository = fileURLToPath(new URL('../../', import.meta.url));
const bundle = path.join(repository, 'cordis.patch.yml');
const basePatch = path.join(fixture, 'test-overrides.yml');
const mcpPatch = path.join(fixture, 'test-stdio-env.yml');
const facts = [
  { prompt: 'I confirm the ORCHID-VAULT rollout color is Cobalt-17.', value: 'Cobalt-17' },
  { prompt: 'I confirm the ORCHID-VAULT release window is Thursday-29.', value: 'Thursday-29' },
];
const excluded = 'NATIVE_DROP_351';
const assistantOnly = 'NATIVE_ASSISTANT_NOT_INGESTED';
let providerCalls = 0;
const extractCalls = [];
const recallPackets = [];
const diagnostics = [];
let mode = 'teach';
let callsInReader = 0;
let sourceSession;
let sourceRequested = false;
let sourceProof = false;
let crashHandshake;
const phaseHits = new Map();

const routeOf = req => new URL(req.url, 'http://127.0.0.1').pathname;
function sse(res, payload, response, id) {
  const isTool = typeof response === 'object';
  const content = isTool ? { type: 'tool_use', id: `toolu_fixture_${id}`, name: response.name, input: {} } : { type: 'text', text: '' };
  const events = [
    { type: 'message_start', message: { id: `msg_fixture_${id}`, type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: content },
    { type: 'content_block_delta', index: 0, delta: isTool ? { type: 'input_json_delta', partial_json: JSON.stringify(response.input) } : { type: 'text_delta', text: response } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
function hasFact(rows, value) { return rows.some(row => row.kind === 'fact' && typeof row.content === 'string' && row.content.includes(value)); }
function findHitList(content) {
  if (typeof content === 'string') {
    if (content.startsWith('[]（')) return [];
    try { return findHitList(JSON.parse(content)); } catch { return null; }
  }
  if (Array.isArray(content)) {
    if (content.length === 0 || content.every(row => typeof row?.id === 'number' && typeof row?.content === 'string')) return content;
    for (const x of content) {
      const result = findHitList(x);
      if (result) return result;
    }
  } else if (content && typeof content === 'object') {
    if (Array.isArray(content.hits)) return findHitList(content.hits);
    for (const key of ['text','content','result']) {
      const result = findHitList(content[key]);
      if (result) return result;
    }
  }
  return null;
}
const offline = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    const route = routeOf(req);
    if (route.endsWith('/chat/completions')) {
      const body = JSON.stringify(payload.messages);
      assert.ok(!body.includes(excluded) && !body.includes(assistantOnly), 'injected or opted-out input reached extraction');
      const selected = facts.find(f => body.includes(f.prompt));
      const prompt = payload.messages.find(m => m.role === 'user')?.content ?? '';
      const atomic = prompt.includes('从中提炼') && prompt.includes('JSON');
      const label = selected?.value ?? 'unmatched';
      extractCalls.push({ label, atomic });
      const content = atomic ? JSON.stringify(selected ? [{ kind: 'fact', content: selected.prompt.replace('I confirm the ', ''), tags: 'native-e2e' }] : [])
        : selected ? `Synthetic session summary about the ORCHID-VAULT ${label} record.` : '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
      return;
    }
    if (!route.endsWith('/messages')) { res.writeHead(404).end(); return; }
    const id = ++providerCalls;
    if (mode === 'teach') return sse(res, payload, assistantOnly, id);
    const tool = payload.tools?.find(t => t.name.endsWith('memory_recall'));
    assert.ok(tool, 'MCP memory_recall not mounted: ' + JSON.stringify(payload.tools?.map(t => t.name) ?? []).slice(0, 1000));
    if (mode === 'crash') {
      crashHandshake?.();
      return; // The isolated CLI is still in its request when the probe kills it.
    }
    const results = payload.messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(c => c.type === 'tool_result');
    if (results.length) {
      const latest = results.at(-1);
      if (mode === 'read' && sourceRequested) {
        const proof = JSON.stringify(latest.content);
        assert.ok(!latest.is_error && proof.includes(sourceSession) && proof.includes(facts[0].prompt), 'memory_source did not return session provenance and quoted text');
        sourceProof = true;
        return sse(res,payload,sourceRequested.answer,id);
      }
      const list = findHitList(latest.content);
      if (list) {
        recallPackets.push({ mode, rows: list });
        if (facts.every(f => hasFact(list,f.value))) {
          const codes = facts.map(f => list.find(row => row.content.includes(f.value)).content.match(/(?:Cobalt|Thursday)-\d+/)?.[0]);
          assert.ok(codes.every(Boolean));
          const answer = `FIXTURE_RESULT ${codes.join(' + ')}`;
          if (mode === 'read') {
            const sourceTool = payload.tools?.find(t => t.name.endsWith('memory_source'));
            assert.ok(sourceTool, 'MCP memory_source not mounted');
            sourceRequested = { answer };
            return sse(res,payload,{ name: sourceTool.name, input: { id: list.find(row => row.content.includes(facts[0].value)).id } },id);
          }
          return sse(res,payload,answer,id);
        }
      } else if (latest.is_error) throw Error('memory_recall tool returned an error');
      if (++callsInReader >= 16) throw Error('Timed out awaiting both facts via real MCP in ' + mode);
      await delay(180);
    } else {
      assert.ok(!JSON.stringify(payload.messages).includes(facts[0].value) && !JSON.stringify(payload.messages).includes(facts[1].value),
        'new reader got the facts in the input before tool use');
    }
    return sse(res,payload,{name:tool.name,input:{query:'ORCHID-VAULT',kind:'fact',limit:10}},id);
  } catch (error) {
    diagnostics.push(String(error?.message ?? error));
    res.writeHead(400).end('fixture request failed');
  }
});

function launchHarness(...args) {
  return launch(harness, [path.join(install, 'lib/bin.js'), '--profile', 'headless', '--patch', bundle,
    '--patch', basePatch, '--patch', mcpPatch, ...args], {
    cwd: workspace, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { HOME: fixture, USERPROFILE: fixture, DSH_HOME: dshHome, PATH: process.env.PATH,
      ELECTRON_RUN_AS_NODE: '1', DSH_NODE: process.execPath, DEEPSEEK_API_KEY: 'local-fixture-key-only' },
  });
}
function run(label, ...args) {
  return launchHarness(...args).catch(error => { throw new Error(`${label}: failed (${error.signal ?? error.code ?? 'unknown'})\n${String(error.stderr ?? '').slice(-9000)}\nExtraction calls: ${JSON.stringify(extractCalls)}\nFixture diagnostics: ${diagnostics.join(' | ')}`); });
}
async function killIsolatedHeadless() {
  mode = 'crash';
  const started = new Promise(resolve => { crashHandshake = resolve; });
  const pending = launchHarness('Hold the isolated test process in its next model request.');
  const outcome = pending.then(() => ({signal:null}),error => ({signal:error.signal, stderr:error.stderr}));
  try {
    const entered = await Promise.race([started.then(() => true), outcome.then(() => false), delay(8000,false,{ref:false})]);
    assert.ok(entered && pending.child.pid && pending.child.exitCode === null, 'isolated Headless did not reach the crash checkpoint');
  } finally {
    // Only this never-reused child handle, never a PID inferred from a log or port.
    if (pending.child.exitCode === null && pending.child.signalCode === null) pending.child.kill('SIGKILL');
  }
  assert.equal((await outcome).signal,'SIGKILL');
}
async function capture(fact, optOut = false) {
  const first = await run('source first turn','--json',fact.prompt);
  assert.match(first.stderr,/\[lm-capture\] plugin loaded/);
  const sid = first.stdout.match(/session-[0-9a-f-]{36}/i)?.[0];
  assert.ok(sid, 'no DSH session id');
  if (optOut) await run('source excluded turn','--session-id',sid,`别记 ${excluded}，只用于本轮。`);
  await run('source confirmed turn','--session-id',sid,'The previously stated rollout detail is confirmed; please remember it.');
  const filenames = await readdir(path.join(memory,'extraction-jobs'));
  const jobs = filenames.filter(n => n.startsWith(sid + '-') && n.endsWith('.json'));
  // A live MCP may already consume a job, so accept the same input in the actual stub request.
  const job = jobs.length ? await readFile(path.join(memory,'extraction-jobs',jobs[0]),'utf8')
    .then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }) : null;
  if (job) {
    assert.equal(job.sessionId,sid);
    assert.ok(job.texts.some(t => t.includes(fact.prompt)));
    assert.ok(!JSON.stringify(job.texts).includes(excluded) && !JSON.stringify(job.texts).includes(assistantOnly));
  } else assert.ok(extractCalls.some(e => e.label === fact.value), 'dispatch missing for ' + fact.value);
  phaseHits.set(sid, fact.value);
  return sid;
}

try {
  await new Promise((resolve, reject) => { offline.once('error', reject); offline.listen(0, '127.0.0.1', resolve); });
  const baseURL = `http://127.0.0.1:${offline.address().port}`;
  await mkdir(workspace,{recursive:true});
  const modules = path.join(dshHome,'profiles','headless','node_modules');
  await mkdir(modules,{recursive:true});
  await symlink(repository,path.join(modules,'dsh-lm-memory'),'dir');
  await writeFile(basePatch, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL } },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'dsh-lm-memory', config: { memoryDir: memory, viewer: 0, extract: true, refresh: false, minUserMessages: 2,
      llm: { model: 'native-test-fixture', baseURL: `${baseURL}/v1`, apiKeyEnv: 'LM_NATIVE_TEST_KEY' } } },
  ]));
  // The Loader replaces config wholesale. Preserve the package stdio wiring and explicitly
  // opt the loopback key and embedding disable into the scrubbed child environment.
  const declared = await readFile(bundle,'utf8');
  const stdio = declared.match(/    - id: mcp-lm-memory\n[\s\S]*$/)?.[0];
  assert.ok(stdio && stdio.includes('LM_MEMORY_DIR: !!js ctx.lmMemoryStartup.memoryDir'));
  // An overlay may replace config, not the injected dependency or package identity.
  const configBlock = stdio.slice(stdio.indexOf('      config:')).replace(/^    /gm,'').trimEnd();
  await writeFile(mcpPatch,`- id: mcp-lm-memory\n${configBlock}\n      LM_EMBED: "0"\n      LM_NATIVE_TEST_KEY: "fake-native-key"\n`);
  sourceSession = await capture(facts[0],true);
  const secondSession = await capture(facts[1]);
  assert.notEqual(secondSession,sourceSession);
  mode = 'read';
  const reader = await run('cold reader','--json','What rollout color and release window were confirmed for ORCHID-VAULT?');
  assert.match(reader.stdout,/FIXTURE_RESULT Cobalt-17 \+ Thursday-29/);
  assert.ok(recallPackets.some(r=>r.mode==='read' && facts.every(f=>hasFact(r.rows,f.value))));
  await access(path.join(memory,'memory.db'));
  const db = new DatabaseSync(path.join(memory,'memory.db'),{readOnly:true});
  try {
    const rows = db.prepare("SELECT m.id,m.content,m.source,m.used_count,p.session_id,p.evidence FROM memories m JOIN provenance p ON p.memory_id=m.id WHERE m.kind='fact' AND m.status='active'").all();
    assert.equal(rows.length,2);
    for (const [sid,value] of phaseHits) {
      const row = rows.find(r=>r.session_id===sid);
      assert.ok(row && row.content.includes(value) && row.evidence.includes(value));
      assert.equal(row.source,'auto-extract');
      assert.equal(row.used_count,0);
      assert.ok(!row.evidence.includes(excluded) && !row.evidence.includes(assistantOnly));
      assert.equal(db.prepare("SELECT count(*) n FROM extract_jobs WHERE session_id=? AND status='done'").get(sid).n,1);
    }
  } finally { db.close(); }
  assert.ok(sourceProof, 'no successful provenance result through DSH MCP');
  await killIsolatedHeadless();
  mode = 'restart'; callsInReader=0;
  const restart = await run('post-commit restart','What rollout color and release window were confirmed for ORCHID-VAULT?');
  assert.match(restart.stdout,/FIXTURE_RESULT Cobalt-17 \+ Thursday-29/);
  assert.equal(diagnostics.length,0,diagnostics.join(' | '));
  for (const f of facts) assert.ok(extractCalls.some(e=>e.label===f.value&&e.atomic), `no real extraction job prompt for ${f.value}`);
  console.log(JSON.stringify({ pass: true, sourceSessions: phaseHits.size, facts: facts.length,
    realMcpRoundTrips: recallPackets.length, extractionProtocolRequests: extractCalls.length,
    provenanceViaMcp: true, optedOutTextExcludedFromExtraction: true, extractLedgerSettled: true,
    postCommitHeadlessSIGKILL: true, coldRestartRecall: true, syntheticModelProvider: true }, null, 2));
} finally {
  offline.close();
  offline.closeAllConnections();
  await rm(fixture, { recursive: true, force: true });
}
