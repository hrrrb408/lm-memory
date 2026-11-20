import path from 'node:path';
import { bindProjectSession, personalDirectory } from './project-storage.mjs';
import { resolveProjectIdentity } from './project-identity.mjs';
import catalog from './project-tool-catalog.json' with { type: 'json' };

export function createProjectRouter(base, freshSince = Date.now()) {
  const bindings = new WeakMap();
  return {
    personal: () => personalDirectory(base),
    bind(session) {
      if (!session || typeof session !== 'object') return Promise.resolve(null);
      const meta = session.header ?? session.meta;
      if (!meta || meta.id !== session.id || meta.isSeeded !== false || meta.parentSession || meta.origin ||
          typeof meta.createdAt !== 'number') return Promise.resolve(null);
      if (!bindings.has(session)) bindings.set(session, (async () => {
        const identity = await resolveProjectIdentity(meta.cwd);
        return identity && await bindProjectSession(base, session.id, identity, { create: meta.createdAt >= freshSince });
      })());
      return bindings.get(session);
    },
  };
}

// Personal and project tools have distinct names, so a numeric ID returned by
// one library is not silently used for the other. Neither accepts a path.
export function registerScopedTools(ctx, router, backends, signal) {
  signal.throwIfAborted();
  const disposers = [];
  try {
    for (const tool of catalog) {
      if (!/^memory_[a-z_]+$/.test(tool.name) || tool.inputSchema?.type !== 'object') throw Error('Unsupported memory tool schema');
      for (const scope of ['personal', 'project']) {
        disposers.push(ctx.tools.register({
          name: `mcp__lm_${scope}__${tool.name}`,
          description: `${scope === 'project' ? '当前项目库' : '个人通用库'}（各库编号独立）。${tool.description ?? ''}`,
          parameters: tool.inputSchema,
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: async (args, execution) => {
            if (!execution?.agent?.session) throw Error('Memory requires an active Host session');
            const combined = AbortSignal.any([signal, execution.signal]);
            combined.throwIfAborted();
            const directory = scope === 'personal' ? await router.personal() : await router.bind(execution.agent.session);
            if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('Memory not bound; start a fresh session in this Git project');
            combined.throwIfAborted();
            const result = await backends.call(directory, tool.name, args, combined);
            const text = result.content?.filter(x => x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n');
            if (result.isError || typeof text !== 'string') throw Error('Memory tool failed in the bound store');
            return text;
          },
        }));
      }
    }
    return () => { for (const dispose of disposers) dispose(); };
  } catch (error) {
    for (const dispose of disposers) dispose();
    throw error;
  }
}
