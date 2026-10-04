/** File snapshots, hash re-checks, and debounced workspace watching. */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';

let corePromise;
let workspacePromise;
async function core() {
  if (!corePromise) corePromise = import('./core.mjs').catch(() => ({}));
  return corePromise;
}
async function workspaceService() {
  if (!workspacePromise) workspacePromise = import('./workspace-service.mjs').catch(() => ({}));
  return workspacePromise;
}

const COLLECTION = 'file_change_events';
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.mergegraph', 'dist', 'build']);
const watchers = new Map();

function fallbackId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
async function id(prefix) {
  const c = await core();
  return typeof c.id === 'function' ? c.id(prefix) : fallbackId(prefix);
}
async function now() {
  const c = await core();
  return typeof c.now === 'function' ? c.now() : new Date().toISOString();
}
async function put(value) {
  const c = await core();
  if (c.store?.put) return c.store.put(COLLECTION, value);
  return value;
}
async function emit(type, payload) {
  const c = await core();
  try { if (typeof c.emit === 'function') c.emit(payload?.workspaceId || '', type, payload); } catch { /* observers are best effort */ }
}
async function getWorkspace(workspaceId) {
  const w = await workspaceService();
  if (typeof w.getWorkspace !== 'function') throw new Error('workspace-service.getWorkspace is unavailable');
  const workspace = await w.getWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} was not found`);
  return workspace;
}
function rootOf(workspace) {
  const root = workspace.rootPath || workspace.root_path || workspace.path || workspace.directory;
  if (!root) throw new Error('Workspace has no root path');
  return path.resolve(root);
}
function inside(root, fullPath) {
  const relative = path.relative(root, fullPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
function rel(root, fullPath) { return path.relative(root, fullPath).replaceAll(path.sep, '/'); }

export async function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}
export async function hashFile(filePath) {
  try { return await hashContent(await readFile(filePath)); } catch { return null; }
}

async function walk(root, directory = root, output = {}) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, full, output);
    else if (entry.isFile()) {
      const relative = rel(root, full);
      try {
        const info = await stat(full);
        output[relative] = { path: relative, hash: await hashFile(full), size: info.size, mtimeMs: info.mtimeMs };
      } catch { /* file may disappear during a scan */ }
    }
  }
  return output;
}

/** Return a path -> hash snapshot. */
export async function captureSnapshot(workspaceId) {
  const workspace = await getWorkspace(workspaceId);
  const root = rootOf(workspace);
  const service = await workspaceService();
  if (typeof service.getFiles === 'function') {
    try {
      const files = await service.getFiles(workspaceId);
      if (Array.isArray(files) && files.length) {
        const snapshot = {};
        for (const file of files) {
          const relative = String(file.relativePath || file.relative_path || file.path || '').replaceAll('\\', '/');
          const full = path.resolve(root, relative);
          if (!relative || !inside(root, full)) continue;
          snapshot[relative] = { path: relative, hash: file.hash || file.contentHash || await hashFile(full), size: file.size };
        }
        return snapshot;
      }
    } catch { /* fall back to an independent filesystem walk */ }
  }
  return walk(root);
}

function normalizeSnapshot(snapshot) {
  if (!snapshot) return {};
  if (Array.isArray(snapshot)) return Object.fromEntries(snapshot.map((item) => [item.path || item.relativePath, item]));
  return snapshot;
}

export function diffSnapshots(before, after) {
  const left = normalizeSnapshot(before);
  const right = normalizeSnapshot(after);
  const paths = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...paths].sort().map((filePath) => {
    const a = left[filePath];
    const b = right[filePath];
    const oldHash = a?.hash || a?.contentHash || null;
    const newHash = b?.hash || b?.contentHash || null;
    if (!a && b) return { path: filePath, operation: 'create', preHash: null, postHash: newHash };
    if (a && !b) return { path: filePath, operation: 'delete', preHash: oldHash, postHash: null };
    if (oldHash !== newHash) return { path: filePath, operation: 'modify', preHash: oldHash, postHash: newHash };
    return null;
  }).filter(Boolean);
}

/** Persist file changes and publish one event for each changed path. */
export async function recordChanges(workspaceId, changes, options = {}) {
  const timestamp = await now();
  const events = [];
  for (const change of changes || []) {
    const event = {
      id: await id('change'),
      workspaceId,
      projectId: options.projectId,
      taskId: options.taskId,
      stepId: options.stepId,
      path: String(change.path || change.relativePath || '').replaceAll('\\', '/'),
      operation: change.operation || change.type || 'modify',
      state: options.origin === 'ai' || options.origin === 'external' ? 'modified' : null,
      preHash: change.preHash || null,
      postHash: change.postHash || null,
      origin: options.origin || change.origin || 'scan',
      observedAt: timestamp,
      source: options.source || 'snapshot',
    };
    if (!event.path) continue;
    await put(event);
    await emit('file.changed', event);
    events.push(event);
  }
  if (events.length) await emit('files.changed', { workspaceId, events });
  return events;
}

export async function diffAndRecord(workspaceId, before, after, options = {}) {
  return recordChanges(workspaceId, diffSnapshots(before, after), options);
}

function eventPath(root, filename) {
  if (!filename) return null;
  const full = path.resolve(root, filename);
  return inside(root, full) ? full : null;
}

async function observePath(workspaceId, root, filename, options) {
  const full = eventPath(root, filename);
  if (!full || full === root) return;
  const relative = rel(root, full);
  if (!relative || relative.startsWith('.mergegraph/') || relative.split('/').some((segment) => SKIP_DIRS.has(segment))) return;
  const postHash = await hashFile(full);
  const operation = postHash ? (options.lastHashes.get(relative) ? 'modify' : 'create') : 'delete';
  const preHash = options.lastHashes.get(relative) || null;
  if (postHash && preHash === postHash) return;
  if (postHash) options.lastHashes.set(relative, postHash); else options.lastHashes.delete(relative);
  await recordChanges(workspaceId, [{ path: relative, operation, preHash, postHash }], {
    ...options,
    origin: options.origin || 'external',
    source: 'fs.watch',
  });
}

/** Start a debounced fs.watch tracker for a workspace. */
export async function startWatcher(workspaceId, options = {}) {
  stopWatcher(workspaceId);
  const workspace = await getWorkspace(workspaceId);
  const root = rootOf(workspace);
  const lastHashes = new Map(Object.entries(await captureSnapshot(workspaceId)).map(([key, value]) => [key, value.hash]));
  const state = { watcher: null, timers: new Map(), lastHashes, root };
  const delay = Math.max(25, Number(options.debounceMs || 200));
  state.watcher = fsWatch(root, { recursive: true }, (_eventType, filename) => {
    const name = filename ? String(filename) : '';
    if (!name) return;
    clearTimeout(state.timers.get(name));
    state.timers.set(name, setTimeout(() => {
      state.timers.delete(name);
      observePath(workspaceId, root, name, { ...options, lastHashes }).catch((error) => emit('file.watcher-error', { workspaceId, error: error.message }));
    }, delay));
  });
  state.watcher.on('error', (error) => emit('file.watcher-error', { workspaceId, error: error.message }));
  watchers.set(workspaceId, state);
  await emit('file.watcher-started', { workspaceId, root });
  return { workspaceId, root, watching: true };
}

export function stopWatcher(workspaceId) {
  const state = watchers.get(workspaceId);
  if (!state) return false;
  for (const timer of state.timers.values()) clearTimeout(timer);
  state.timers.clear();
  state.watcher?.close();
  watchers.delete(workspaceId);
  emit('file.watcher-stopped', { workspaceId }).catch(() => {});
  return true;
}

export function getWatcher(workspaceId) { return watchers.get(workspaceId) || null; }
