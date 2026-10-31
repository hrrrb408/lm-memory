#!/usr/bin/env node
// 用法: node import-current-md.mjs <旧的 current.md> [LM_MEMORY_DIR]
// 解析 "- [YYYY-MM-DD] 内容" 行，kind 按章节标题映射，直接写入 memory.db
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error("用法: node import-current-md.mjs <current.md> [LM_MEMORY_DIR]"); process.exit(1); }
const memDir = process.argv[3] || process.env.LM_MEMORY_DIR || path.join(os.homedir(), ".lm-memory");
fs.mkdirSync(memDir, { recursive: true });
const db = new DatabaseSync(path.join(memDir, "memory.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL CHECK (kind IN ('preference','fact','episode','procedure')),
  content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
  supersedes INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='id', tokenize='trigram')`);
const sectionKind = { "用户": "preference", "偏好": "preference", "设备": "fact", "环境": "fact", "项目": "fact", "事实": "fact", "经验": "procedure", "教训": "procedure", "事件": "episode" };
let kind = "fact", n = 0;
const ins = db.prepare("INSERT INTO memories (kind, content, tags, source, status, created_at, updated_at) VALUES (?,?,'import','active',?,?)");
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  const h = line.match(/^## (.+)/);
  if (h) { for (const [k, v] of Object.entries(sectionKind)) if (h[1].includes(k)) kind = v; continue; }
  const m = line.match(/^- \[(\d{4}-\d{2}-\d{2})\] (.+)$/);
  if (!m) continue;
  const t = new Date(m[1] + "T12:00:00Z").toISOString();
  ins.run(kind, m[2], t, t);
  db.exec("INSERT INTO memories_fts(rowid, content, tags) SELECT id, content, tags FROM memories WHERE id = last_insert_rowid()");
  n++;
}
console.log(`导入 ${n} 条 → ${path.join(memDir, "memory.db")}`);
