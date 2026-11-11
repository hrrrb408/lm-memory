import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
export async function fixture(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lm-contract-'));
  const client = new Client({ name: 'contract-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../server/memory-server.mjs', import.meta.url))],
    env: { ...process.env, ...env, LM_MEMORY_DIR: dir, LM_EMBED: '0' }, stderr: 'pipe' }));
  const db = new DatabaseSync(path.join(dir, 'memory.db'));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  return { dir, db, call, recall: async (args) => {
    const text = await call('memory_recall', args);
    return text.startsWith('[]（') ? [] : JSON.parse(text);
  }, remember: async (content, kind = 'fact', tags = '') => Number((await call('memory_remember', { content, kind, tags })).match(/id=(\d+)/)[1]),
  close: async () => { db.close(); await client.close(); rmSync(dir, { recursive: true, force: true }); } };
}
