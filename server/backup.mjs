import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
// SQLite online backup includes committed WAL state. Destination must be new.
export async function backupMemory(source, destination) {
  if (path.resolve(source) === path.resolve(destination) || fs.existsSync(destination)) throw new Error('Backup destination must be new');
  const src = new DatabaseSync(source, {readOnly:true});
  try { await backup(src,destination); }
  finally { src.close(); }
  const copy = new DatabaseSync(destination,{readOnly:true});
  try {
    const result = Object.values(copy.prepare('PRAGMA integrity_check').get())[0];
    if(result !== 'ok') throw new Error('Backup integrity check failed: '+result);
    return {path:destination, memories:copy.prepare('SELECT count(*) n FROM memories').get().n, integrity:result};
  } finally {copy.close();}
}
