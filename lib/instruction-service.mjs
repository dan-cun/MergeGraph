/**
 * Project-local AGENTS.md discovery and scope resolution.
 *
 * The instruction service intentionally keeps the source document alongside
 * its parsed, scope-aware representation.  Consumers can show the exact
 * files used for a task and can re-compute the effective context when a
 * document changes.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
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

const COLLECTION = 'project_instructions';
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.mergegraph', 'dist', 'build']);

function isoNow() {
  return new Date().toISOString();
}

async function now() {
  const c = await core();
  return typeof c.now === 'function' ? c.now() : isoNow();
}

async function makeId(prefix) {
  const c = await core();
  return typeof c.id === 'function' ? c.id(prefix) : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function storeList(collection) {
  const c = await core();
  if (!c.store?.list) return [];
  const result = c.store.list(collection);
  return result instanceof Promise ? result : result;
}

async function storePut(collection, value) {
  const c = await core();
  if (!c.store?.put) return value;
  const result = c.store.put(collection, value);
  return result instanceof Promise ? result : result;
}

async function storeRemove(collection, id) {
  const c = await core();
  if (!c.store?.remove) return;
  const result = c.store.remove(collection, id);
  return result instanceof Promise ? result : result;
}

async function emit(type, payload) {
  const c = await core();
  try {
    if (typeof c.emit === 'function') c.emit(payload?.workspaceId || '', type, payload);
  } catch {
    // Event delivery must not prevent an instruction scan from completing.
  }
}

async function workspaceFor(workspaceId) {
  const w = await workspaceService();
  if (typeof w.getWorkspace !== 'function') throw new Error('workspace-service.getWorkspace is unavailable');
  const value = await w.getWorkspace(workspaceId);
  if (!value) throw new Error(`Workspace ${workspaceId} was not found`);
  return value;
}

function workspaceRoot(workspace) {
  const root = workspace.rootPath || workspace.root_path || workspace.path || workspace.directory;
  if (!root || typeof root !== 'string') throw new Error('Workspace has no root path');
  return path.resolve(root);
}

function posixRelative(root, target) {
  const relative = path.relative(root, target).replaceAll(path.sep, '/');
  return relative || '.';
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseRules(content) {
  const rules = {
    required: [],
    forbidden: [],
    checks: [],
    style: [],
    raw: content,
  };
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*+]\s+/, '').trim();
    if (!line) continue;
    if (/^(?:禁止|不得|不要|avoid\b|do not\b|never\b)/i.test(line)) rules.forbidden.push(line);
    else if (/^(?:必须|务必|要求|应当|must\b|required\b|always\b)/i.test(line)) rules.required.push(line);
    else if (/^(?:测试|检查|验证|test\b|check\b|verify\b)/i.test(line)) rules.checks.push(line);
    else if (/^(?:风格|格式|style\b|format\b)/i.test(line)) rules.style.push(line);
  }
  return rules;
}

async function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function collectAgents(root, directory = root, output = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectAgents(root, full, output);
    } else if (entry.isFile() && entry.name.toLowerCase() === 'agents.md') {
      output.push(full);
    }
  }
  return output;
}

/** Find all AGENTS.md files in a workspace and persist their hashes. */
export async function discoverInstructions(workspaceId) {
  const workspace = await workspaceFor(workspaceId);
  const root = workspaceRoot(workspace);
  const files = (await collectAgents(root)).sort((a, b) => a.localeCompare(b));
  const timestamp = await now();
  const records = [];
  for (const filePath of files) {
    let content;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    const scopePath = posixRelative(root, path.dirname(filePath));
    records.push({
      id: await makeId('instruction'),
      workspaceId,
      projectId: workspace.projectId || workspace.project_id || workspaceId,
      filePath,
      relativePath: posixRelative(root, filePath),
      scopePath,
      priority: scopePath === '.' ? 0 : scopePath.split('/').length,
      contentHash: await sha256(content),
      content,
      parsedRules: parseRules(content),
      updatedAt: timestamp,
    });
  }

  const previous = await storeList(COLLECTION);
  for (const item of previous.filter((item) => item.workspaceId === workspaceId || item.workspace_id === workspaceId)) {
    if (!records.some((record) => record.relativePath === (item.relativePath || item.relative_path))) await storeRemove(COLLECTION, item.id);
  }
  for (const record of records) {
    const old = previous.find((item) => (item.workspaceId === workspaceId || item.workspace_id === workspaceId) && (item.relativePath || item.relative_path) === record.relativePath);
    await storePut(COLLECTION, old ? { ...old, ...record, id: old.id } : record);
  }
  await emit('instructions.discovered', { workspaceId, count: records.length, files: records.map((item) => item.relativePath) });
  return records;
}

function targetRelative(root, targetPath) {
  const target = path.resolve(root, targetPath || root);
  if (!isInside(root, target)) throw new Error('Target path is outside the workspace');
  return posixRelative(root, target);
}

/**
 * Resolve instructions from root to leaf.  Parent documents are included
 * first, so an AI prompt can explain precedence while child rules are applied
 * last by the consumer.
 */
export async function effectiveInstructions(workspaceId, targetPath = '.') {
  const workspace = await workspaceFor(workspaceId);
  const root = workspaceRoot(workspace);
  const target = targetRelative(root, targetPath);
  let records = await discoverInstructions(workspaceId);
  records = records
    .filter((record) => {
      const scope = record.scopePath || '.';
      return scope === '.' || target === scope || target.startsWith(`${scope}/`) || (target === '.' && scope === '.');
    })
    .sort((a, b) => (a.priority || 0) - (b.priority || 0) || String(a.relativePath).localeCompare(String(b.relativePath)));
  const effectiveRules = { required: [], forbidden: [], checks: [], style: [] };
  const seen = new Set();
  for (const record of records) {
    const parsed = record.parsedRules || parseRules(record.content || '');
    for (const key of Object.keys(effectiveRules)) {
      for (const rule of parsed[key] || []) {
        const fingerprint = `${key}:${rule}`;
        if (!seen.has(fingerprint)) {
          seen.add(fingerprint);
          effectiveRules[key].push(rule);
        }
      }
    }
  }
  return {
    workspaceId,
    targetPath: target,
    sources: records.map((record) => ({
      id: record.id,
      path: record.relativePath,
      scopePath: record.scopePath || '.',
      priority: record.priority || 0,
      contentHash: record.contentHash,
    })),
    instructions: records.map((record) => record.content || '').filter(Boolean),
    text: records.map((record) => `# ${record.relativePath}\n${record.content || ''}`).join('\n\n'),
    effectiveRules,
  };
}

export { parseRules };
