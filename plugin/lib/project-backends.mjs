import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

// Only the Host router chooses the directory. No tool parameter can select a backend.
export function createProjectBackends({ command, server, env, maxOpen = 8, idleMs = 30_000 }) {
  const entries = new Map();
  let closed = false;

  function remove(dir, entry) {
    if (entries.get(dir) !== entry) return Promise.resolve();
    entries.delete(dir);
    clearTimeout(entry.timer);
    return entry.client.close().catch(() => {});
  }

  async function use(dir, action, signal) {
    if (!path.isAbsolute(dir)) throw Error('Memory storage is not bound');
    signal?.throwIfAborted();
    if (closed) throw Error('Memory backends closed');
    let entry = entries.get(dir);
    if (!entry) {
      if (entries.size >= maxOpen) {
        const idle = [...entries].find(([, value]) => value.users === 0);
        if (!idle) throw Error('Memory backends busy; retry');
        await remove(...idle);
        return use(dir, action, signal);
      }
      const client = new Client({ name: 'lm-memory-project-router', version: '1' });
      const transport = new StdioClientTransport({ command, args: [server], env: { ...env, LM_MEMORY_DIR: dir }, stderr: 'ignore' });
      entry = { client, users: 0, connected: client.connect(transport, { timeout: 8000 }) };
      entries.set(dir, entry);
      const current = entry;
      client.onclose = () => { void remove(dir, current); };
    }
    clearTimeout(entry.timer);
    entry.users++;
    try {
      try { await entry.connected; }
      catch (error) { await remove(dir, entry); throw error; }
      signal?.throwIfAborted();
      return await action(entry.client);
    } finally {
      if (--entry.users === 0 && entries.get(dir) === entry) {
        entry.timer = setTimeout(() => { void remove(dir, entry); }, idleMs);
        entry.timer.unref();
      }
    }
  }

  return {
    list: (dir, signal) => use(dir, client => client.listTools(undefined, { signal, timeout: 8000 }), signal),
    call: (dir, name, args, signal) => use(dir, client => client.callTool({ name, arguments: args }, undefined, { signal, timeout: 60_000 }), signal),
    close: async () => { closed = true; await Promise.all([...entries].map(([dir, entry]) => remove(dir, entry))); },
  };
}
