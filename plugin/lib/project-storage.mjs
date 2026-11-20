import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Call only with the Host-owned identity, not a tool argument. Refuse links
// inside our store root so an accidental alias cannot join two projects.
export async function projectDirectory(memoryDir, identity) {
  if (!path.isAbsolute(memoryDir) || !/^[a-f\d]{64}$/.test(identity?.id ?? '')) return null;
  try {
    const base = await realpath(memoryDir);
    return await containedDirectory(await containedDirectory(base, 'projects-v1'), identity.id);
  } catch { return null; }
}

export async function personalDirectory(memoryDir) {
  if (typeof memoryDir !== 'string' || !path.isAbsolute(memoryDir)) return null;
  try { return await containedDirectory(await realpath(memoryDir), 'personal-v1'); }
  catch { return null; }
}

async function containedDirectory(parent, name) {
  const candidate = path.join(parent, name);
  try { await mkdir(candidate, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Untrusted project store entry');
  const actual = await realpath(candidate);
  if (path.relative(parent, actual) !== name) throw Error('Project store escaped its parent');
  return actual;
}

// A resumed conversation cannot be rebound to another project. Only a Host
// caller that establishes fresh-session eligibility may pass create=true.
export async function bindProjectSession(memoryDir, sessionId, identity, { create = false } = {}) {
  if (!path.isAbsolute(memoryDir) || !/^session-[a-f\d-]{36}$/.test(sessionId ?? '') ||
      !/^[a-f\d]{64}$/.test(identity?.id ?? '')) return null;
  try {
    const base = await realpath(memoryDir);
    const registry = await containedDirectory(base, 'project-sessions-v1');
    const binding = path.join(registry, sessionId);
    const expected = `${identity.id}\n`;
    async function matches() {
      const info = await lstat(binding);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.length) return false;
      return await readFile(binding, 'utf8') === expected;
    }
    let accepted;
    try { accepted = await matches(); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) return null;
      try {
        // Exclusive create is atomic on every platform; no hard link needed.
        await writeFile(binding, expected, { flag: 'wx', mode: 0o600 });
      } catch (conflict) { if (conflict.code !== 'EEXIST') throw conflict; }
      accepted = await matches();
    }
    return accepted ? await projectDirectory(base, identity) : null;
  } catch { return null; }
}
