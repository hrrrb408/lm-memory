// Explicit, offline macOS acceptance probe against an installed DSH CLI.
// Never uses the active profile, production credentials, or memory database.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const launch = promisify(execFile);
const harness = process.env.DSH_NODE_EXECUTABLE;
const install = process.env.DSH_INSTALL_DIR;
if (!harness || !install) throw new Error('Run with DSH_NODE_EXECUTABLE and DSH_INSTALL_DIR from the installed Desktop runtime');
const temp = await mkdtemp(path.join(tmpdir(), 'lm-dsh-headless-'));
const dshHome = path.join(temp, '.dsh');
const memoryDir = temp;
const patch = path.join(temp, 'fixture.yml');
const code = fileURLToPath(new URL('../../plugin/lib/index.js', import.meta.url));
const requests = [];
const captured = 'local-fixture-answer';
const offline = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/messages')) { res.writeHead(404).end(); return; }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    requests.push(payload.messages);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: captured } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  } catch { res.writeHead(400).end(); }
});
function run(...args) {
  return launch(harness, [path.join(install, 'lib/bin.js'), '--profile', 'headless', '--patch', patch, ...args], {
    cwd: temp, timeout: 20000, maxBuffer: 2 * 1024 * 1024,
    env: { HOME: temp, USERPROFILE: temp, DSH_HOME: dshHome, PATH: process.env.PATH,
      ELECTRON_RUN_AS_NODE: '1', DSH_NODE: process.execPath, DEEPSEEK_API_KEY: 'local-fixture-only' },
  });
}
try {
  await new Promise((resolve, reject) => { offline.once('error', reject); offline.listen(0, '127.0.0.1', resolve); });
  const baseURL = `http://127.0.0.1:${offline.address().port}`;
  async function configure(sessionId) {
    await writeFile(patch, JSON.stringify([
      { id: 'llm-deepseek', config: { baseURL } },
      { id: 'llm-deepseek-account', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { insert: [{ id: 'lm-memory-fixture', name: code, config: { memoryDir, viewer: 0, extract: false, refresh: false, minUserMessages: 1,
        ...(sessionId ? { taskRecall: { enabled: true, sessionIds: [sessionId] } } : {}) } }] },
    ]));
  }
  const filename = path.join(memoryDir, 'memory.db');
  const db = new DatabaseSync(filename);
  try {
    db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, tags TEXT, status TEXT, kind TEXT, used_count INTEGER DEFAULT 0);
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content='memories', content_rowid='id', tokenize='trigram');
      INSERT INTO memories(id,content,status,kind) VALUES (46,'部署验收仅有一个特定答案','active','procedure');
      INSERT INTO memories_fts(rowid,content) SELECT id, content FROM memories;`);
    await configure();
    const first = await run('--json', '上次「部署验收」怎么做？');
    assert.match(first.stderr, /\[lm-capture\] plugin loaded/);
    assert.match(first.stdout, new RegExp(captured));
    const sessionId = first.stdout.match(/session-[0-9a-f-]{36}/i)?.[0];
    assert.ok(sessionId, 'Headless JSON did not expose its Session id');
    assert.equal(requests.length, 1);
    assert.doesNotMatch(JSON.stringify(requests[0]), /候选指针/);
    await configure(sessionId);
    const resumed = await run('--session-id', sessionId, '上次「部署验收」怎么做？');
    assert.match(resumed.stdout, new RegExp(captured));
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]), /候选指针.*#46/);
    assert.doesNotMatch(JSON.stringify(requests[1]), /仅有一个特定答案/);
    assert.equal(db.prepare('SELECT used_count FROM memories WHERE id=46').get().used_count, 0);
    const capture = (await readFile(path.join(memoryDir, 'pending-episodes.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(capture.length, 2);
    assert.ok(capture.every(item => item.sessionId === sessionId && !item.content.includes('候选指针')));
    assert.match(capture[0].content, /1 条用户输入/);
    assert.match(capture[1].content, /2 条用户输入/);
    const other = await run('上次「部署验收」怎么做？');
    assert.match(other.stdout, new RegExp(captured));
    assert.equal(requests.length, 3);
    assert.doesNotMatch(JSON.stringify(requests[2]), /候选指针/);
    console.log('PASS installed DSH Headless: default OFF, resume with one scoped pointer, new session excluded, no body or renewal');
  } finally { db.close(); }
} finally {
  offline.close();
  offline.closeAllConnections();
  await rm(temp, { recursive: true, force: true });
}
