import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// A separate SQLite writer lock covers queue files across all server/helper processes.
// OS/SQLite release ownership on crashes; no stale PID or time-based lock stealing.
export function withFileLock(file, fn, timeoutMs = 2000) {
  const lock = new DatabaseSync(path.join(path.dirname(file), '.queue-lock.sqlite'));
  try {
    lock.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(timeoutMs))}`);
    lock.exec('CREATE TABLE IF NOT EXISTS guard (id INTEGER PRIMARY KEY)');
    lock.exec('BEGIN IMMEDIATE');
    try { const value = fn(); lock.exec('COMMIT'); return value; }
    catch (e) { lock.exec('ROLLBACK'); throw e; }
  } finally { lock.close(); }
}
export const appendQueue = (file, record) => withFileLock(file, () => fs.appendFileSync(file, JSON.stringify(record)+'\n'));
