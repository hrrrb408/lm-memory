import { DatabaseSync } from 'node:sqlite';
// Read-only fencing check; this module has no mutation statements.
export function assertLease(dbPath,sessionId,revision,owner) {
  if (!owner) return; // standalone recovery/test helper
  const db = new DatabaseSync(dbPath,{readOnly:true});
  try {
    const row = db.prepare("SELECT owner,status,updated_at FROM extract_jobs WHERE session_id=? AND revision=?").get(sessionId,revision);
    if (row?.owner !== owner || row.status !== "running" || Date.now()-Date.parse(row.updated_at)>=10*60*1000) throw new Error("Worker lease lost; publication refused");
  } finally {db.close();}
}
