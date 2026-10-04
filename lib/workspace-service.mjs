import { mkdir, readdir, readFile, realpath, stat, lstat } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, emit, hash, id, now, store } from './core.mjs';
import { diffSnapshots, recordChanges } from './change-tracker.mjs';

const excludedDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', '.next', 'target', '__pycache__', '.cache', 'coverage', '.venv', 'venv', '.idea', '.vscode', '.mergegraph']);
const textExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.html', '.css', '.scss', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.md', '.mdx', '.txt', '.py', '.rb', '.php', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.proto', '.xml', '.gradle', '.tf']);
const languageMap = { '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.vue': 'vue', '.svelte': 'svelte', '.py': 'python', '.rb': 'ruby', '.php': 'php', '.java': 'java', '.kt': 'kotlin', '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cs': 'csharp', '.swift': 'swift', '.sh': 'shell', '.ps1': 'powershell', '.sql': 'sql', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.md': 'markdown', '.html': 'html', '.css': 'css' };
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const isInside = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const languageFor = (ext) => languageMap[ext] || '';
const isText = (filePath) => textExtensions.has(path.extname(filePath).toLowerCase()) || ['dockerfile', 'makefile', 'license', 'readme', '.gitignore'].includes(path.basename(filePath).toLowerCase());
const summaryFor = (text, language) => ({ language, imports: [...text.matchAll(/^(?:import\s+.*?\s+from\s+|import\s+|from\s+|require\s*\(\s*["'])([^"'\s)]+)/gm)].map((m) => m[1]).filter(Boolean).slice(0, 60), exports: [...text.matchAll(/^(?:export\s+(?:default\s+)?(?:class|function|const|let|var)\s+|class\s+|func\s+)([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]).filter(Boolean).slice(0, 60) });
const internalDataRoot = path.resolve(DATA_DIR);
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
function isInternalDirectory(root, absolute, relative = '') {
  const normalized = String(relative || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (normalized === '.mergegraph' || normalized.startsWith('.mergegraph/')) return true;
  const candidate = path.resolve(absolute);
  return inside(internalDataRoot, candidate);
}

export async function canonicalWorkspacePath(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.includes('\0')) throw Object.assign(new Error('rootPath is required'), { statusCode: 400 });
  const candidate = path.resolve(raw);
  const root = await realpath(candidate).catch(() => null);
  if (!root || !(await stat(root).catch(() => null))?.isDirectory()) throw Object.assign(new Error('rootPath must be an existing directory'), { statusCode: 400 });
  return root;
}
export function resolveWorkspacePath(workspace, relativePath = '') {
  const root = path.resolve(workspace.rootPath);
  const target = path.resolve(root, String(relativePath || ''));
  if (!isInside(root, target)) throw Object.assign(new Error('Path is outside the workspace'), { statusCode: 400 });
  return target;
}
export function getWorkspace(workspaceId) { return store.get('workspaces', workspaceId); }
export function listWorkspaces() { return store.list('workspaces'); }
export async function createWorkspace({ name, rootPath }) {
  const canonical = await canonicalWorkspacePath(rootPath);
  const existing = store.list('workspaces').find((item) => path.resolve(item.rootPath) === canonical);
  if (existing) return existing;
  const workspace = store.put('workspaces', { id: id('ws'), name: String(name || path.basename(canonical)), rootPath: canonical, status: 'ready', snapshotId: null, createdAt: now() });
  await mkdir(path.join(canonical, '.mergegraph'), { recursive: true }).catch(() => {});
  return workspace;
}
export function updateWorkspace(workspaceId, patch) { const existing = getWorkspace(workspaceId); if (!existing) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 }); return store.put('workspaces', { ...existing, ...patch, id: workspaceId, workspaceId }); }

async function scanEntry(root, absolute, relative, entries) {
  const info = await lstat(absolute).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    if (relative && (excludedDirectories.has(path.basename(relative).toLowerCase()) || isInternalDirectory(root, absolute, relative))) return;
    entries.push({ relativePath: relative, path: relative, kind: 'directory', language: '', size: 0, hash: '', contentHash: '', summary: {} });
    const children = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    children.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const child of children) await scanEntry(root, path.join(absolute, child.name), path.posix.join(relative.replaceAll('\\', '/'), child.name).replace(/^\//, ''), entries);
    return;
  }
  if (!info.isFile() || !relative) return;
  const ext = path.extname(relative).toLowerCase();
  const entry = { relativePath: relative.replaceAll('\\', '/'), path: relative.replaceAll('\\', '/'), kind: isText(relative) ? 'source' : 'binary', language: languageFor(ext), size: Number(info.size), mtimeMs: Number(info.mtimeMs), hash: '', contentHash: '', summary: {}, content: undefined };
  if (entry.size <= MAX_FILE_BYTES) {
    const bytes = await readFile(absolute).catch(() => null);
    if (bytes) {
      entry.hash = crypto.createHash('sha256').update(bytes).digest('hex');
      entry.contentHash = entry.hash;
      if (isText(relative)) {
        const content = bytes.toString('utf8');
        entry.content = content;
        entry.lineCount = content ? content.split(/\r?\n/).length : 0;
        entry.summary = summaryFor(content, entry.language);
      }
    }
  }
  entries.push(entry);
}

async function scanWorkspaceInternal(workspaceId, { origin = 'scan', taskId = null, stepId = null } = {}) {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
  const before = Object.fromEntries(getFiles(workspaceId).map((item) => [item.path, { hash: item.hash || item.contentHash || null }]));
  const entries = [];
  await scanEntry(workspace.rootPath, workspace.rootPath, '', entries);
  const files = entries.filter((item) => item.kind !== 'directory');
  const after = Object.fromEntries(files.map((item) => [item.path, { hash: item.hash || item.contentHash || null }]));
  const changes = diffSnapshots(before, after);
  if (origin === 'external' && changes.length) await recordChanges(workspaceId, changes, { origin: 'external', source: 'fs-watch' });
  const manifest = hash(JSON.stringify(entries.map(({ path: itemPath, hash: itemHash, size }) => [itemPath, itemHash, size])));
  const snapshotId = id('snap');
  store.put('snapshots', { id: snapshotId, workspaceId, manifestHash: manifest, status: 'succeeded', stats: { total: entries.length, files: files.length, bytes: files.reduce((sum, item) => sum + item.size, 0) }, createdAt: now(), origin });
  store.list('files', (item) => item.workspaceId === workspaceId).forEach((item) => store.remove('files', item.id));
  for (const item of entries) store.put('files', { ...item, id: `${snapshotId}:${item.path}`, workspaceId, snapshotId, taskId, stepId, updatedAt: now() });
  const stats = { total: entries.length, files: files.length, bytes: files.reduce((sum, item) => sum + item.size, 0) };
  const updated = updateWorkspace(workspaceId, { snapshotId, status: 'ready', lastScanAt: now(), stats });
  emit(workspaceId, 'FilesChanged', { origin, taskId, stepId, snapshotId, files: files.map((item) => item.path), changes });
  return { workspace: updated, snapshotId, entries, files, changes, stats };
}
const scanPromises = new Map();
export function scanWorkspace(workspaceId, options = {}) {
  const key = String(workspaceId);
  const runningScan = scanPromises.get(key);
  if (runningScan) return runningScan;
  const promise = scanWorkspaceInternal(key, options).finally(() => scanPromises.delete(key));
  scanPromises.set(key, promise);
  return promise;
}
export function getFiles(workspaceId) { return store.list('files', (item) => item.workspaceId === workspaceId && item.kind !== 'directory'); }
export function getEntries(workspaceId) { return store.list('files', (item) => item.workspaceId === workspaceId); }
export function getFileSummaries(workspaceId) {
  return getFiles(workspaceId).map(({ content, ...file }) => file);
}
export async function readWorkspaceFile(workspaceId, relativePath) {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
  const filePath = resolveWorkspacePath(workspace, relativePath);
  return readFile(filePath, 'utf8');
}

const watchers = new Map();
export function startWorkspaceWatcher(workspaceId) {
  if (watchers.has(workspaceId)) return;
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return;
  const watcher = watch(workspace.rootPath, { recursive: true }, (_eventType, filename) => {
    const relative = filename ? String(filename) : '';
    if (isInternalDirectory(workspace.rootPath, path.join(workspace.rootPath, relative), relative)) return;
    clearTimeout(watcher.timer);
    watcher.timer = setTimeout(() => scanWorkspace(workspaceId, { origin: 'external' }).catch(() => {}), 500);
  });
  watchers.set(workspaceId, watcher);
}
export function stopWorkspaceWatcher(workspaceId) { const watcher = watchers.get(workspaceId); if (watcher) watcher.close(); watchers.delete(workspaceId); }
