import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const git = promisify(execFile);

// Resolve the physical checkout root, not a repo name, remote URL or path
// mentioned by the model. Worktrees and separate clones remain separate.
export async function resolveProjectIdentity(cwd, { signal } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || signal?.aborted) return null;
  try {
    const physical = await realpath(cwd);
    if (!(await stat(physical)).isDirectory()) return null;
    // Ambient Git overrides must not redirect project memory to another checkout.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const { stdout } = await git('git', ['rev-parse', '--show-toplevel'], {
      cwd: physical, env, signal, timeout: 1200, maxBuffer: 8192, windowsHide: true, encoding: 'utf8',
    });
    const rawRoot = stdout.replace(/\r?\n$/, '');
    if (!path.isAbsolute(rawRoot) || /[\r\n]/.test(rawRoot)) return null;
    const root = await realpath(rawRoot);
    const relative = path.relative(root, physical);
    if (signal?.aborted || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return { root, id: createHash('sha256').update('lm-memory-project-v1\0').update(root).digest('hex') };
  } catch {
    return null;
  }
}
