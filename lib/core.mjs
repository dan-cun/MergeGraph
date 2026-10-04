import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(process.env.MERGEGRAPH_DATA_DIR || path.join(ROOT, '..', 'data'));
const DB_PATH = path.join(DATA_DIR, 'mergegraph-workspace.sqlite');
await mkdir(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS entities (
    type TEXT NOT NULL,
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL DEFAULT '',
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(type, id)
  );
  CREATE INDEX IF NOT EXISTS idx_entities_workspace ON entities(workspace_id, type, updated_at);
  CREATE TABLE IF NOT EXISTS event_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_event_log_workspace ON event_log(workspace_id, seq);
`);

export const now = () => new Date().toISOString();
export const id = (prefix = 'id') => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

const parse = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

const fromRow = (row) => row ? ({ ...parse(row.json, {}), id: row.id, updatedAt: row.updated_at, workspaceId: row.workspace_id || undefined }) : null;

export const store = {
  get(type, entityId) {
    return fromRow(db.prepare('SELECT * FROM entities WHERE type = ? AND id = ?').get(String(type), String(entityId)));
  },
  list(type, predicate) {
    const rows = db.prepare('SELECT * FROM entities WHERE type = ? ORDER BY updated_at DESC').all(String(type));
    const values = rows.map(fromRow);
    return typeof predicate === 'function' ? values.filter(predicate) : values;
  },
  put(type, entity) {
    const value = { ...entity };
    if (!value.id) value.id = id(type);
    const timestamp = now();
    value.updatedAt = timestamp;
    const workspaceId = String(value.workspaceId || value.workspace_id || '');
    db.prepare(`INSERT INTO entities(type,id,workspace_id,json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(type,id) DO UPDATE SET workspace_id=excluded.workspace_id,json=excluded.json,updated_at=excluded.updated_at`)
      .run(String(type), String(value.id), workspaceId, JSON.stringify(value), timestamp);
    return value;
  },
  remove(type, entityId) {
    db.prepare('DELETE FROM entities WHERE type = ? AND id = ?').run(String(type), String(entityId));
  },
  clear(type, workspaceId = '') {
    if (workspaceId) db.prepare('DELETE FROM entities WHERE type = ? AND workspace_id = ?').run(String(type), String(workspaceId));
    else db.prepare('DELETE FROM entities WHERE type = ?').run(String(type));
  }
};

const listeners = [];
export function emit(workspaceId, type, payload) {
  // Services created before the workspace event bus used emit(type, payload).
  // Keep that form working while the HTTP layer uses emit(workspaceId, type, payload).
  let eventType = type;
  let eventWorkspace = workspaceId;
  let eventPayload = payload;
  if (payload === undefined && type && typeof type === 'object') {
    eventType = workspaceId;
    eventWorkspace = type.workspaceId || type.task?.workspaceId || type.data?.workspaceId || '';
    eventPayload = type;
  }
  const event = { id: id('evt'), workspaceId: String(eventWorkspace || ''), type: String(eventType || 'event'), payload: eventPayload || {}, createdAt: now() };
  const result = db.prepare('INSERT INTO event_log(workspace_id,type,json,created_at) VALUES(?,?,?,?)').run(event.workspaceId, event.type, JSON.stringify(event), event.createdAt);
  event.seq = Number(result.lastInsertRowid);
  for (const listener of listeners.slice()) {
    if ((listener.workspaceId && listener.workspaceId !== event.workspaceId) || (listener.eventType && listener.eventType !== event.type)) continue;
    try { listener.callback(event); } catch { /* subscriber errors cannot stop a task */ }
  }
  return event;
}
export function subscribe(scope, callback) {
  const value = String(scope || '');
  const listener = value.startsWith('ws_') || value === '' ? { workspaceId: value, eventType: '', callback } : { workspaceId: '', eventType: value, callback };
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}
export function recentEvents(workspaceId, after = 0, limit = 100) {
  return db.prepare('SELECT * FROM event_log WHERE workspace_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    .all(String(workspaceId || ''), Number(after || 0), Math.min(500, Math.max(1, Number(limit || 100))))
    .map((row) => ({ ...parse(row.json, {}), seq: row.seq }));
}

export function dataPath(...parts) { return path.join(DATA_DIR, ...parts); }
export function database() { return db; }

export async function readJsonFile(filePath, fallback = {}) {
  try { return parse(await readFile(filePath, 'utf8'), fallback); } catch { return fallback; }
}
