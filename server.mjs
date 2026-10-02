import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, lstat, readdir, realpath, unlink, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  assertArchitectureDiagram,
  validateArchitectureDiagram,
  adaptArchitectureToArchify,
  fromArchifyArchitecture,
  ARCHITECTURE_SCHEMA_VERSION
} from './lib/architecture-ir.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.MERGEGRAPH_DATA_DIR || path.join(ROOT, 'data'));
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const SIDECAR_DIR = path.join(DATA_DIR, 'sidecars');
const DB_PATH = path.join(DATA_DIR, 'mergegraph.sqlite');
const PORT = Number(process.env.PORT || 4310);
const now = () => new Date().toISOString();

await Promise.all([mkdir(ASSET_DIR, { recursive: true }), mkdir(SIDECAR_DIR, { recursive: true })]);
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    license TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assets_hash ON assets(content_hash);
  CREATE INDEX IF NOT EXISTS idx_assets_updated ON assets(updated_at);
  CREATE TABLE IF NOT EXISTS canvas_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL NOT NULL DEFAULT 220,
    height REAL NOT NULL DEFAULT 140,
    data_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS canvas_edges (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    request_json TEXT NOT NULL,
    response_json TEXT NOT NULL DEFAULT '{}',
    context_hash TEXT NOT NULL DEFAULT '',
    context_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_links (
    run_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(run_id, asset_id, relation),
    FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '默认 Provider',
    base_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT 'mergegraph-local-mock',
    api_key TEXT NOT NULL DEFAULT '',
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_profiles_default ON provider_profiles(is_default) WHERE is_default = 1;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    root_fingerprint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    policy_json TEXT NOT NULL DEFAULT '{}',
    privacy_mode TEXT NOT NULL DEFAULT 'local_only',
    last_snapshot_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    manifest_hash TEXT NOT NULL DEFAULT '',
    scanner_version TEXT NOT NULL DEFAULT '1.0',
    stats_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_project_snapshots_project ON project_snapshots(project_id, started_at DESC);
  CREATE TABLE IF NOT EXISTS project_files (
    snapshot_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'file',
    language TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ns TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    line_count INTEGER NOT NULL DEFAULT 0,
    included INTEGER NOT NULL DEFAULT 0,
    exclusion_reason TEXT NOT NULL DEFAULT '',
    secret_flags_json TEXT NOT NULL DEFAULT '[]',
    summary_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(snapshot_id, relative_path),
    FOREIGN KEY(snapshot_id) REFERENCES project_snapshots(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_project_files_snapshot_included ON project_files(snapshot_id, included, relative_path);
  CREATE TABLE IF NOT EXISTS architecture_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'architecture',
    status TEXT NOT NULL DEFAULT 'queued',
    prompt TEXT NOT NULL DEFAULT '',
    provider_profile_id TEXT NOT NULL DEFAULT '',
    request_json TEXT NOT NULL DEFAULT '{}',
    response_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    context_hash TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(snapshot_id) REFERENCES project_snapshots(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_architecture_runs_project ON architecture_runs(project_id, started_at DESC);
  CREATE TABLE IF NOT EXISTS architecture_documents (
    id TEXT PRIMARY KEY,
    analysis_id TEXT NOT NULL,
    format_version TEXT NOT NULL,
    ir_json TEXT NOT NULL,
    archify_json TEXT NOT NULL DEFAULT '{}',
    validation_json TEXT NOT NULL DEFAULT '{}',
    artifact_path TEXT NOT NULL DEFAULT '',
    artifact_hash TEXT NOT NULL DEFAULT '',
    is_last_good INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY(analysis_id) REFERENCES architecture_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_architecture_documents_analysis ON architecture_documents(analysis_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS architecture_evidence (
    document_id TEXT NOT NULL,
    node_id TEXT NOT NULL DEFAULT '',
    edge_id TEXT NOT NULL DEFAULT '',
    relative_path TEXT NOT NULL,
    line_start INTEGER NOT NULL DEFAULT 0,
    line_end INTEGER NOT NULL DEFAULT 0,
    label TEXT NOT NULL DEFAULT '',
    verification TEXT NOT NULL DEFAULT 'unverified',
    FOREIGN KEY(document_id) REFERENCES architecture_documents(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_architecture_evidence_document ON architecture_evidence(document_id, relative_path);
`);

for (const statement of [
  'ALTER TABLE runs ADD COLUMN context_hash TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE runs ADD COLUMN context_json TEXT NOT NULL DEFAULT \'{}\''
]) { try { db.exec(statement); } catch { /* column already exists */ } }

// The first release used a table without foreign keys. Rebuild it once so existing
// local databases gain the same constraints as fresh databases.
const runLinkForeignKeys = db.prepare('PRAGMA foreign_key_list(run_links)').all();
const runLinkColumns = db.prepare('PRAGMA table_info(run_links)').all();
const ordinalExpr = runLinkColumns.some((column) => column.name === 'ordinal') ? 'l.ordinal' : '0';
const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const json = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
function normalizeStoragePaths() {
  const rows = db.prepare('SELECT id, storage_path FROM assets').all();
  for (const row of rows) if (!path.isAbsolute(row.storage_path)) db.prepare('UPDATE assets SET storage_path = ? WHERE id = ?').run(path.resolve(DATA_DIR, row.storage_path), row.id);
}
if (!runLinkForeignKeys.length) {
  db.exec(`BEGIN;
    CREATE TABLE IF NOT EXISTS run_links_migrating (
      run_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(run_id, asset_id, relation),
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
    );
    INSERT OR IGNORE INTO run_links_migrating (run_id, asset_id, relation, ordinal)
      SELECT l.run_id, l.asset_id, l.relation, ${ordinalExpr}
      FROM run_links l JOIN runs r ON r.id = l.run_id JOIN assets a ON a.id = l.asset_id;
    DROP TABLE run_links;
    ALTER TABLE run_links_migrating RENAME TO run_links;
    COMMIT;`);
}
normalizeStoragePaths();
async function canonicalizeDuplicateHashes() {
  const groups = db.prepare('SELECT content_hash FROM assets GROUP BY content_hash HAVING COUNT(*) > 1').all();
  for (const group of groups) {
    const rows = db.prepare('SELECT * FROM assets WHERE content_hash = ? ORDER BY created_at, id').all(group.content_hash);
    const canonical = rows[0];
    for (const duplicate of rows.slice(1)) {
      const canonicalTags = new Set(json(canonical.tags_json, []));
      for (const tag of json(duplicate.tags_json, [])) canonicalTags.add(tag);
      const mergedNotes = [canonical.notes, duplicate.notes].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join('\n');
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE assets SET tags_json = ?, notes = ?, prompt = ?, source = ?, license = ?, project = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...canonicalTags]), mergedNotes, canonical.prompt || duplicate.prompt, canonical.source || duplicate.source, canonical.license || duplicate.license, canonical.project || duplicate.project, now(), canonical.id);
        const links = db.prepare('SELECT run_id, relation, ordinal FROM run_links WHERE asset_id = ?').all(duplicate.id);
        for (const link of links) db.prepare('INSERT OR IGNORE INTO run_links (run_id, asset_id, relation, ordinal) VALUES (?, ?, ?, ?)').run(link.run_id, canonical.id, link.relation, link.ordinal);
        db.prepare('DELETE FROM run_links WHERE asset_id = ?').run(duplicate.id);
        db.prepare('DELETE FROM assets WHERE id = ?').run(duplicate.id);
        db.exec('COMMIT');
        canonical.tags_json = JSON.stringify([...canonicalTags]); canonical.notes = mergedNotes; canonical.prompt = canonical.prompt || duplicate.prompt; canonical.source = canonical.source || duplicate.source; canonical.license = canonical.license || duplicate.license; canonical.project = canonical.project || duplicate.project;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      await unlink(duplicate.storage_path).catch(() => {});
      await unlink(path.join(SIDECAR_DIR, `${duplicate.id}.context.json`)).catch(() => {});
    }
  }
}

await canonicalizeDuplicateHashes();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_assets_content_hash ON assets(content_hash);');
db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, now());

// Provider credentials are kept in a dedicated local-only table. The legacy
// settings.provider value is migrated once, then rewritten without the secret.
const defaultProviderId = 'provider_default';
function providerView(row) {
  if (!row) return { id: defaultProviderId, name: '默认 Provider', baseUrl: '', model: 'mergegraph-local-mock', timeoutMs: 30000, hasApiKey: false, isDefault: true };
  return { id: row.id, name: row.name, baseUrl: row.base_url, model: row.model, timeoutMs: row.timeout_ms, hasApiKey: Boolean(row.api_key), isDefault: Boolean(row.is_default), updatedAt: row.updated_at };
}
function providerRow(idValue = defaultProviderId) {
  return db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(idValue) || db.prepare('SELECT * FROM provider_profiles WHERE is_default = 1 LIMIT 1').get();
}
function migrateProviderSettings() {
  const timestamp = now();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('provider');
  const legacy = row ? json(row.value, {}) : {};
  const existing = providerRow();
  const values = {
    baseUrl: String(legacy.baseUrl || existing?.base_url || ''),
    model: String(legacy.model || existing?.model || 'mergegraph-local-mock'),
    timeoutMs: Math.min(120000, Math.max(1000, Number(legacy.timeoutMs || existing?.timeout_ms || 30000))),
    apiKey: String(legacy.apiKey && legacy.apiKey !== '••••••••' ? legacy.apiKey : existing?.api_key || ''),
    name: String(legacy.name || existing?.name || '默认 Provider')
  };
  db.prepare(`INSERT INTO provider_profiles (id,name,base_url,model,api_key,timeout_ms,is_default,created_at,updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, model=excluded.model, api_key=excluded.api_key, timeout_ms=excluded.timeout_ms, is_default=1, updated_at=excluded.updated_at`).run(defaultProviderId, values.name, values.baseUrl, values.model, values.apiKey, values.timeoutMs, existing?.created_at || timestamp, timestamp);
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('provider', JSON.stringify({ profileId: defaultProviderId, name: values.name, baseUrl: values.baseUrl, model: values.model, timeoutMs: values.timeoutMs, hasApiKey: Boolean(values.apiKey) }));
}
migrateProviderSettings();

const DEFAULT_SCAN_POLICY = Object.freeze({
  includeGlobs: [],
  excludeGlobs: [],
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 20000,
  maxDepth: 40,
  maxHashBytes: 8 * 1024 * 1024,
  followSymlinks: false,
  includeBinary: false,
  textExtensions: [],
  secretPatterns: []
});
const DEFAULT_EXCLUDED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', '.next', 'target', '__pycache__', '.cache', 'coverage', '.venv', 'venv', '.idea', '.vscode']);
const TEXT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.html', '.css', '.scss', '.less', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.env', '.md', '.mdx', '.txt', '.rst', '.py', '.rb', '.php', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.proto', '.xml', '.gradle', '.tf', '.dockerfile']);
const SECRET_FILENAME_RE = /(^|[\\/])(?:\.env(?:\..*)?|id_rsa(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks))$/i;
const SECRET_CONTENT_RES = [
  /(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:sk|rk)-[A-Za-z0-9]{20,}\b/
];
const mimeForExtension = (ext) => ({ '.js': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/tsx', '.jsx': 'text/jsx', '.vue': 'text/vue', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.css': 'text/css', '.html': 'text/html', '.py': 'text/x-python', '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java', '.sql': 'application/sql', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream');
const languageForExtension = (ext) => ({ '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.vue': 'vue', '.svelte': 'svelte', '.py': 'python', '.rb': 'ruby', '.php': 'php', '.java': 'java', '.kt': 'kotlin', '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cs': 'csharp', '.swift': 'swift', '.sh': 'shell', '.ps1': 'powershell', '.sql': 'sql', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.md': 'markdown', '.html': 'html', '.css': 'css' }[ext] || '');
function normalizeScanPolicy(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const list = (value) => Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 200) : [];
  return {
    ...DEFAULT_SCAN_POLICY,
    includeGlobs: list(source.includeGlobs),
    excludeGlobs: list(source.excludeGlobs),
    textExtensions: list(source.textExtensions).map((ext) => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`),
    secretPatterns: list(source.secretPatterns),
    maxFileBytes: Math.min(32 * 1024 * 1024, Math.max(0, Number(source.maxFileBytes || DEFAULT_SCAN_POLICY.maxFileBytes))),
    maxFiles: Math.min(100000, Math.max(1, Number(source.maxFiles || DEFAULT_SCAN_POLICY.maxFiles))),
    maxDepth: Math.min(100, Math.max(1, Number(source.maxDepth || DEFAULT_SCAN_POLICY.maxDepth))),
    maxHashBytes: Math.min(32 * 1024 * 1024, Math.max(0, Number(source.maxHashBytes || DEFAULT_SCAN_POLICY.maxHashBytes))),
    followSymlinks: source.followSymlinks === true,
    includeBinary: source.includeBinary === true
  };
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function requireLoopback(req) {
  if (!isLoopbackRequest(req)) throw Object.assign(new Error('Project file APIs are restricted to the local machine'), { statusCode: 403 });
}
function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function canonicalProjectRoot(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.includes('\0')) throw Object.assign(new Error('rootPath is required'), { statusCode: 400 });
  if (raw.startsWith('\\\\') || raw.startsWith('//')) throw Object.assign(new Error('UNC and remote paths are not allowed'), { statusCode: 400 });
  const candidate = path.resolve(raw);
  let canonical;
  try { canonical = await realpath(candidate); } catch { throw Object.assign(new Error('rootPath does not exist or is not readable'), { statusCode: 400 }); }
  const info = await stat(canonical).catch(() => null);
  if (!info?.isDirectory()) throw Object.assign(new Error('rootPath must be a directory'), { statusCode: 400 });
  return canonical;
}
function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}
function globMatches(relativePath, globs) {
  return globs.some((glob) => { try { return globToRegExp(glob.replaceAll('\\', '/')).test(relativePath); } catch { return false; } });
}
function isSensitiveFilename(relativePath, customPatterns = []) {
  if (SECRET_FILENAME_RE.test(relativePath)) return true;
  return customPatterns.some((pattern) => { try { return new RegExp(pattern, 'i').test(relativePath); } catch { return false; } });
}
function detectSecretFlags(text) {
  return SECRET_CONTENT_RES.flatMap((expression, index) => expression.test(text) ? [`pattern_${index + 1}`] : []);
}
function fileKind(relativePath, ext, language, mime) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (language) return 'source';
  if (['package.json', 'pnpm-workspace.yaml', 'yarn.lock', 'package-lock.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'cargo.toml', 'pom.xml', 'dockerfile', '.gitignore', '.editorconfig'].includes(basename)) return 'config';
  if (mime.startsWith('text/') || ['.md', '.mdx', '.rst', '.txt'].includes(ext)) return 'document';
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
  return 'binary';
}
function textFile(relativePath, ext, policy) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return policy.textExtensions.includes(ext) || TEXT_EXTENSIONS.has(ext) || ['dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.npmrc'].includes(basename);
}
function summarizeText(text, language) {
  const imports = [...text.matchAll(/^(?:import\s+.*?\s+from\s+|import\s+|from\s+|require\s*\(\s*["'])([^"'\s)]+)/gm)].map((match) => match[1]).filter(Boolean).slice(0, 80);
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => match[1].trim()).filter(Boolean).slice(0, 40);
  const exports = [...text.matchAll(/^(?:export\s+(?:default\s+)?(?:class|function|const|let|var)\s+|func\s+|class\s+)([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]).filter(Boolean).slice(0, 80);
  return { language, imports: [...new Set(imports)], exports: [...new Set(exports)], headings };
}
function projectFingerprint(info) {
  return crypto.createHash('sha256').update(`${info.dev || ''}:${info.ino || ''}:${info.size || ''}:${info.mtimeMs || ''}`).digest('hex');
}
function projectView(row) {
  if (!row) return null;
  const latest = db.prepare('SELECT * FROM project_snapshots WHERE id = ?').get(row.last_snapshot_id) || db.prepare('SELECT * FROM project_snapshots WHERE project_id = ? ORDER BY started_at DESC LIMIT 1').get(row.id);
  return { id: row.id, name: row.name, rootPath: row.root_path, rootFingerprint: row.root_fingerprint, status: row.status, policy: json(row.policy_json, DEFAULT_SCAN_POLICY), privacyMode: row.privacy_mode, lastSnapshotId: row.last_snapshot_id || null, latestSnapshotId: latest?.id || null, latestSnapshot: latest ? snapshotView(latest) : null, createdAt: row.created_at, updatedAt: row.updated_at };
}
function snapshotView(row) {
  if (!row) return null;
  return { id: row.id, projectId: row.project_id, manifestHash: row.manifest_hash, scannerVersion: row.scanner_version, stats: json(row.stats_json, {}), status: row.status, startedAt: row.started_at, finishedAt: row.finished_at || null, error: row.error || '' };
}
function projectFileView(row) {
  return { relativePath: row.relative_path, kind: row.kind, language: row.language, mime: row.mime, size: row.size, mtimeNs: row.mtime_ns, included: Boolean(row.included), exclusionReason: row.exclusion_reason || '', contentHash: row.content_hash || '', lineCount: row.line_count, secretFlags: json(row.secret_flags_json, []), summary: json(row.summary_json, {}) };
}

async function scanProjectFiles(rootPath, policy) {
  const entries = [];
  const stats = { total: 0, included: 0, excluded: 0, bytes: 0, includedBytes: 0, sensitive: 0, symlinks: 0, truncated: false, byLanguage: {} };
  const state = { visited: new Set() };
  const addEntry = (entry) => { entries.push(entry); stats.total += 1; if (entry.included) { stats.included += 1; stats.includedBytes += entry.size; if (entry.language) stats.byLanguage[entry.language] = (stats.byLanguage[entry.language] || 0) + 1; } else stats.excluded += 1; stats.bytes += entry.size; if (entry.secretFlags.length) stats.sensitive += 1; if (entry.kind === 'symlink') stats.symlinks += 1; };
  const walk = async (absoluteDir, relativeDir, depth) => {
    if (entries.length >= policy.maxFiles) { stats.truncated = true; return; }
    let dirEntries;
    try { dirEntries = await readdir(absoluteDir, { withFileTypes: true }); } catch (error) { if (relativeDir) addEntry({ relativePath: relativeDir, kind: 'directory', language: '', mime: 'inode/directory', size: 0, mtimeNs: '', contentHash: '', lineCount: 0, included: false, exclusionReason: `read_error:${error.code || 'unknown'}`, secretFlags: [], summary: {} }); return; }
    dirEntries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const dirent of dirEntries) {
      if (entries.length >= policy.maxFiles) { stats.truncated = true; break; }
      const relativePath = path.posix.join(relativeDir.replaceAll('\\', '/'), dirent.name).replace(/^\//, '');
      const fullPath = path.join(absoluteDir, dirent.name);
      if (dirent.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(dirent.name.toLowerCase())) { addEntry({ relativePath, kind: 'directory', language: '', mime: 'inode/directory', size: 0, mtimeNs: '', contentHash: '', lineCount: 0, included: false, exclusionReason: 'excluded_directory', secretFlags: [], summary: {} }); continue; }
        if (globMatches(relativePath, policy.excludeGlobs)) { addEntry({ relativePath, kind: 'directory', language: '', mime: 'inode/directory', size: 0, mtimeNs: '', contentHash: '', lineCount: 0, included: false, exclusionReason: 'exclude_glob', secretFlags: [], summary: {} }); continue; }
        if (depth >= policy.maxDepth) { addEntry({ relativePath, kind: 'directory', language: '', mime: 'inode/directory', size: 0, mtimeNs: '', contentHash: '', lineCount: 0, included: false, exclusionReason: 'max_depth', secretFlags: [], summary: {} }); continue; }
        await walk(fullPath, relativePath, depth + 1); continue;
      }
      if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
      let target = fullPath;
      let kind = 'file';
      if (dirent.isSymbolicLink()) {
        kind = 'symlink';
        if (!policy.followSymlinks) { addEntry({ relativePath, kind, language: '', mime: 'application/octet-stream', size: 0, mtimeNs: '', contentHash: '', lineCount: 0, included: false, exclusionReason: 'symlink', secretFlags: [], summary: {} }); continue; }
        try { target = await realpath(fullPath); } catch { addEntry({ relativePath, kind, language: '', mime: 'application/octet-stream', size: 0, mtimeNs: '', contentHash: '', lineCount: 0, included: false, exclusionReason: 'broken_symlink', secretFlags: [], summary: {} }); continue; }
        if (!pathInside(rootPath, target)) { addEntry({ relativePath, kind, language: '', mime: 'application/octet-stream', size: 0, mtimeNs: '', contentHash: '', lineCount: 0, included: false, exclusionReason: 'symlink_outside_root', secretFlags: [], summary: {} }); continue; }
      }
      if (!pathInside(rootPath, target)) { addEntry({ relativePath, kind, language: '', mime: 'application/octet-stream', size: 0, mtimeNs: '', contentHash: '', lineCount: 0, included: false, exclusionReason: 'outside_root', secretFlags: [], summary: {} }); continue; }
      let info;
      try { info = await stat(target); } catch { addEntry({ relativePath, kind, language: '', mime: 'application/octet-stream', size: 0, mtimeNs: '', contentHash: '', lineCount: 0, included: false, exclusionReason: 'stat_error', secretFlags: [], summary: {} }); continue; }
      const ext = path.posix.extname(dirent.name).toLowerCase();
      const language = languageForExtension(ext);
      const mime = mimeForExtension(ext);
      const isText = textFile(relativePath, ext, policy);
      const fileKindValue = fileKind(relativePath, ext, language, mime);
      const base = { relativePath, kind: fileKindValue, language, mime, size: Number(info.size), mtimeNs: String(Math.trunc(Number(info.mtimeMs || 0) * 1000000)), contentHash: '', lineCount: 0, included: false, exclusionReason: '', secretFlags: [], summary: {} };
      const deny = (reason) => { base.exclusionReason = reason; addEntry(base); };
      if (globMatches(relativePath, policy.excludeGlobs)) { deny('exclude_glob'); continue; }
      if (policy.includeGlobs.length && !globMatches(relativePath, policy.includeGlobs)) { deny('not_in_include_glob'); continue; }
      if (isSensitiveFilename(relativePath, policy.secretPatterns)) { base.secretFlags = ['filename_pattern']; deny('sensitive_filename'); continue; }
      if (base.size > policy.maxFileBytes) { deny('max_file_bytes'); continue; }
      if (!isText && !policy.includeBinary) { deny('binary'); continue; }
      let content = null;
      if (isText && base.size <= policy.maxHashBytes) {
        try { content = await readFile(target, 'utf8'); } catch { deny('read_error'); continue; }
        const flags = detectSecretFlags(content);
        if (flags.length) { base.secretFlags = flags; deny('sensitive_content'); continue; }
        base.lineCount = content ? content.split(/\r?\n/).length : 0;
        base.summary = summarizeText(content, language);
      }
      if (base.size <= policy.maxHashBytes) {
        try { const bytes = content == null ? await readFile(target) : Buffer.from(content, 'utf8'); base.contentHash = crypto.createHash('sha256').update(bytes).digest('hex'); } catch { deny('read_error'); continue; }
      }
      base.included = true; addEntry(base);
    }
  };
  await walk(rootPath, '', 0);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  const manifest = entries.map((entry) => [entry.relativePath, entry.size, entry.mtimeNs, entry.contentHash, entry.included, entry.exclusionReason]);
  const manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { entries, stats, manifestHash };
}
async function scanProject(snapshotId, projectId, rootPath, policy) {
  const started = now();
  db.prepare('UPDATE project_snapshots SET status = ?, started_at = ?, error = ? WHERE id = ?').run('running', started, '', snapshotId);
  try {
    const result = await scanProjectFiles(rootPath, policy);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM project_files WHERE snapshot_id = ?').run(snapshotId);
      const insert = db.prepare(`INSERT INTO project_files (snapshot_id,relative_path,kind,language,mime,size,mtime_ns,content_hash,line_count,included,exclusion_reason,secret_flags_json,summary_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const entry of result.entries) insert.run(snapshotId, entry.relativePath, entry.kind, entry.language, entry.mime, entry.size, entry.mtimeNs, entry.contentHash, entry.lineCount, entry.included ? 1 : 0, entry.exclusionReason, JSON.stringify(entry.secretFlags), JSON.stringify(entry.summary));
      const finished = now();
      db.prepare('UPDATE project_snapshots SET manifest_hash = ?, stats_json = ?, status = ?, finished_at = ?, error = ? WHERE id = ?').run(result.manifestHash, JSON.stringify(result.stats), 'succeeded', finished, '', snapshotId);
      db.prepare('UPDATE projects SET status = ?, last_snapshot_id = ?, updated_at = ? WHERE id = ?').run('active', snapshotId, finished, projectId);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    return result;
  } catch (error) {
    const finished = now();
    db.prepare('UPDATE project_snapshots SET status = ?, finished_at = ?, error = ? WHERE id = ?').run('failed', finished, String(error?.message || error).slice(0, 1000), snapshotId);
    if (String(error?.code || '').includes('ENOENT')) db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run('unavailable', finished, projectId);
    return null;
  }
}

async function handleProjectCreate(req, res) {
  requireLoopback(req);
  const body = await readBody(req);
  const rootPath = await canonicalProjectRoot(body.rootPath);
  const info = await stat(rootPath);
  const existing = db.prepare('SELECT * FROM projects WHERE root_path = ? OR lower(root_path) = lower(?) LIMIT 1').get(rootPath, rootPath);
  if (existing) return send(res, 200, { project: projectView(existing), existing: true });
  const timestamp = now();
  const projectId = id('project');
  const name = String(body.name || path.basename(rootPath) || '本地项目').trim().slice(0, 160) || '本地项目';
  const policy = normalizeScanPolicy(body.policy);
  const privacyMode = body.privacyMode === 'external_ai_opt_in' ? 'external_ai_opt_in' : 'local_only';
  db.prepare(`INSERT INTO projects (id,name,root_path,root_fingerprint,status,policy_json,privacy_mode,last_snapshot_id,created_at,updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, '', ?, ?)`).run(projectId, name, rootPath, projectFingerprint(info), JSON.stringify(policy), privacyMode, timestamp, timestamp);
  return send(res, 201, { project: projectView(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)), existing: false });
}
async function handleProjectPatch(req, res, projectId) {
  requireLoopback(req);
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!existing) return notFound(res);
  const body = await readBody(req);
  if (body.rootPath !== undefined) {
    const candidate = await canonicalProjectRoot(body.rootPath);
    if (candidate.toLowerCase() !== existing.root_path.toLowerCase()) return send(res, 400, { error: 'rootPath is immutable; create another project for a different directory' });
  }
  const name = body.name === undefined ? existing.name : String(body.name).trim().slice(0, 160) || existing.name;
  const policy = body.policy === undefined ? json(existing.policy_json, DEFAULT_SCAN_POLICY) : normalizeScanPolicy(body.policy);
  const privacyMode = body.privacyMode === 'external_ai_opt_in' ? 'external_ai_opt_in' : body.privacyMode === 'local_only' ? 'local_only' : existing.privacy_mode;
  const timestamp = now();
  db.prepare('UPDATE projects SET name = ?, policy_json = ?, privacy_mode = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(policy), privacyMode, timestamp, projectId);
  return send(res, 200, { project: projectView(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)) });
}
async function handleProjectScan(req, res, projectId) {
  requireLoopback(req);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return notFound(res);
  const body = await readBody(req);
  let rootPath;
  try { rootPath = await canonicalProjectRoot(project.root_path); } catch (error) {
    db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run('unavailable', now(), projectId);
    return send(res, error.statusCode || 400, { error: error.message });
  }
  const policy = normalizeScanPolicy(body.policy === undefined ? json(project.policy_json, DEFAULT_SCAN_POLICY) : body.policy);
  const timestamp = now();
  const snapshotId = id('snapshot');
  db.prepare(`INSERT INTO project_snapshots (id,project_id,manifest_hash,scanner_version,stats_json,status,started_at,finished_at,error)
    VALUES (?, ?, '', '1.0', ?, 'queued', ?, '', '')`).run(snapshotId, projectId, JSON.stringify({ preview: body.preview === true, queued: true }), timestamp);
  db.prepare('UPDATE projects SET policy_json = ?, status = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(policy), 'active', timestamp, projectId);
  // Scans are deliberately detached from the request so large repositories do
  // not hold the HTTP connection open. The source tree remains read-only.
  void scanProject(snapshotId, projectId, rootPath, policy);
  return send(res, 202, { scanId: snapshotId, snapshot: snapshotView(db.prepare('SELECT * FROM project_snapshots WHERE id = ?').get(snapshotId)), preview: body.preview === true });
}
function handleScanGet(req, res, scanId) {
  requireLoopback(req);
  const row = db.prepare('SELECT * FROM project_snapshots WHERE id = ?').get(scanId);
  if (!row) return notFound(res);
  return send(res, 200, { scan: snapshotView(row), project: projectView(db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id)) });
}
function handleSnapshotFiles(req, res, projectId, snapshotId, url) {
  requireLoopback(req);
  const snapshot = db.prepare('SELECT * FROM project_snapshots WHERE id = ? AND project_id = ?').get(snapshotId, projectId);
  if (!snapshot) return notFound(res);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 200)));
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
  const included = url.searchParams.get('included');
  const q = String(url.searchParams.get('q') || '').trim();
  const clauses = ['snapshot_id = ?']; const args = [snapshotId];
  if (included === 'true' || included === 'false') { clauses.push('included = ?'); args.push(included === 'true' ? 1 : 0); }
  if (q) { clauses.push('relative_path LIKE ?'); args.push(`%${q}%`); }
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM project_files WHERE ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM project_files WHERE ${where} ORDER BY relative_path LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return send(res, 200, { projectId, snapshotId, files: rows.map(projectFileView), total, limit, offset, nextOffset: offset + rows.length < total ? offset + rows.length : null });
}

function architectureRunView(row) {
  if (!row) return null;
  const latestDocument = db.prepare('SELECT * FROM architecture_documents WHERE analysis_id = ? ORDER BY created_at DESC LIMIT 1').get(row.id);
  return {
    id: row.id,
    projectId: row.project_id,
    snapshotId: row.snapshot_id,
    mode: row.mode,
    status: row.status,
    prompt: row.prompt,
    providerProfileId: row.provider_profile_id,
    contextHash: row.context_hash,
    request: json(row.request_json, {}),
    response: json(row.response_json, {}),
    result: json(row.result_json, {}),
    error: row.error || '',
    document: latestDocument ? architectureDocumentView(latestDocument) : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null
  };
}

function architectureDocumentView(row) {
  if (!row) return null;
  return {
    id: row.id,
    analysisId: row.analysis_id,
    formatVersion: row.format_version,
    diagram: json(row.ir_json, {}),
    archify: json(row.archify_json, {}),
    validation: json(row.validation_json, {}),
    artifactPath: row.artifact_path || '',
    artifactHash: row.artifact_hash || '',
    isLastGood: Boolean(row.is_last_good),
    createdAt: row.created_at
  };
}

function architectureId(value, fallback) {
  const slug = String(value || fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return /^[a-z]/.test(slug) ? slug : `node-${slug || fallback}`;
}

async function projectFileText(project, relativePath, maxBytes = 16000) {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  if (!normalized || normalized.split('/').includes('..') || normalized.startsWith('/')) throw new Error('Invalid project relative path');
  const candidate = path.resolve(project.root_path, normalized);
  const canonical = await realpath(candidate);
  if (!pathInside(project.root_path, canonical)) throw new Error('Project file escapes the registered root');
  const content = await readFile(canonical, 'utf8');
  return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n…[truncated]` : content;
}

async function buildArchitectureEvidencePack(project, snapshotId, options = {}) {
  const maxFiles = Math.min(160, Math.max(1, Number(options.maxFiles || 80)));
  const maxBytes = Math.min(1_500_000, Math.max(32_000, Number(options.maxBytes || 700_000)));
  const rows = db.prepare(`SELECT * FROM project_files WHERE snapshot_id = ? AND included = 1 ORDER BY
    CASE WHEN kind = 'config' THEN 0 WHEN kind = 'source' THEN 1 ELSE 2 END, relative_path LIMIT ?`).all(snapshotId, maxFiles);
  const items = [];
  let usedBytes = 0;
  for (const row of rows) {
    if (usedBytes >= maxBytes) break;
    const item = {
      relativePath: row.relative_path,
      kind: row.kind,
      language: row.language,
      mime: row.mime,
      size: row.size,
      contentHash: row.content_hash,
      lineCount: row.line_count,
      summary: json(row.summary_json, {}),
      evidence: row.line_count ? [{ path: row.relative_path, line: 1, endLine: Math.min(row.line_count, 240), verification: 'working-tree' }] : []
    };
    if (row.language || row.mime.startsWith('text/')) {
      try {
        const remaining = maxBytes - usedBytes;
        const text = await projectFileText(project, row.relative_path, Math.min(16000, remaining));
        item.excerpt = text;
        usedBytes += Buffer.byteLength(text, 'utf8');
      } catch (error) {
        item.readError = String(error?.message || error);
      }
    }
    items.push(item);
  }
  const bundle = { version: 'mergegraph.evidence.v1', snapshotId, files: items, limits: { maxFiles, maxBytes, usedBytes } };
  const serialized = JSON.stringify(bundle);
  return { bundle, hash: crypto.createHash('sha256').update(serialized).digest('hex') };
}

function defaultArchitectureDiagram(project, snapshot, evidencePack) {
  const files = evidencePack.bundle.files.filter((file) => file.kind !== 'media').slice(0, 12);
  const used = new Set();
  const nodes = files.map((file, index) => {
    let nodeId = architectureId(file.relativePath.replaceAll('/', '-'), `component-${index + 1}`);
    while (used.has(nodeId)) nodeId = `${nodeId}-${index + 1}`;
    used.add(nodeId);
    const base = file.relativePath.toLowerCase();
    const kind = /(^|[/.])(db|database|migration|schema|sql)([/.]|$)/.test(base) ? 'database'
      : /(^|[/.])(ui|web|frontend|client|components)([/.]|$)/.test(base) ? 'frontend'
        : /(^|[/.])(security|auth|permission|policy)([/.]|$)/.test(base) ? 'security' : 'backend';
    return {
      id: nodeId,
      kind,
      label: file.relativePath,
      summary: [file.language, ...(file.summary?.exports || []).slice(0, 3)].filter(Boolean).join(' · ') || file.kind,
      tag: file.kind,
      evidence: file.evidence
    };
  });
  if (!nodes.length) {
    nodes.push({ id: 'project-root', kind: 'backend', label: project.name, summary: '未发现可纳入上下文的文本文件', evidence: [] });
  }
  const edges = nodes.slice(1).map((node, index) => ({
    id: `relation-${index + 1}`,
    source: nodes[index].id,
    target: node.id,
    label: 'project structure',
    variant: 'dashed',
    evidence: node.evidence || []
  }));
  const diagram = {
    schemaVersion: ARCHITECTURE_SCHEMA_VERSION,
    diagramType: 'architecture',
    meta: {
      title: `${project.name} · 本地结构架构图`,
      subtitle: 'MergeGraph 本地扫描结果（未调用外部 AI）',
      projectId: project.id,
      repoSnapshotId: snapshot.id,
      qualityProfile: 'standard',
      repository: { evidenceMode: 'working-tree', dirty: true }
    },
    nodes,
    edges,
    boundaries: [{ id: 'local-project', kind: 'region', label: 'Local project', nodeIds: nodes.map((node) => node.id) }],
    cards: [{ id: 'scan-summary', title: '扫描摘要', items: [`纳入 ${snapshot.stats?.included || nodes.length} 个文件`, `快照 ${snapshot.id}`, '节点和关系可继续由 AI 细化'], tone: 'cyan' }],
    recommendations: [{ id: 'review-entrypoints', title: '补充入口和运行链路', detail: '当前首版按文件结构绘制，配置 Provider 后可生成带调用关系和证据的版本。', priority: 'medium', evidence: [] }],
    openQuestions: [],
    evidenceGaps: []
  };
  return diagram;
}

function extractArchitectureJson(value) {
  if (value && typeof value === 'object') return value.diagram && typeof value.diagram === 'object' ? value.diagram : value;
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return extractArchitectureJson(JSON.parse(text)); } catch { /* try the first JSON object below */ }
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return extractArchitectureJson(JSON.parse(text.slice(start, end + 1)));
  throw new Error('AI response did not contain a JSON architecture diagram');
}

async function callArchitectureProvider(project, snapshot, evidencePack, body, provider) {
  if (!provider.baseUrl || body.externalAiOptIn !== true || project.privacy_mode !== 'external_ai_opt_in') {
    return { diagram: null, response: { mock: true, reason: 'local_only_or_no_provider' } };
  }
  const endpoint = `${String(provider.baseUrl).replace(/\/$/, '')}/chat/completions`;
  const parsedEndpoint = new URL(endpoint);
  const allowedHosts = String(process.env.MERGEGRAPH_ALLOWED_HOSTS || '').split(',').map((host) => host.trim()).filter(Boolean);
  if (allowedHosts.length && !allowedHosts.includes(parsedEndpoint.host)) throw Object.assign(new Error('Provider host is not in MERGEGRAPH_ALLOWED_HOSTS'), { statusCode: 400 });
  const prompt = String(body.prompt || '生成仓库高层架构图，限制 8-12 个核心节点，所有结论必须引用证据文件和行号。只返回 MergeGraph ArchitectureDiagramIR JSON。');
  const request = {
    model: provider.model,
    messages: [{ role: 'user', content: `${prompt}\n\nProject: ${project.name}\nSnapshot: ${snapshot.id}\nEvidencePack:\n${JSON.stringify(evidencePack.bundle)}` }],
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };
  const remote = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) }, signal: AbortSignal.timeout(provider.timeoutMs), body: JSON.stringify(request) });
  const text = await remote.text();
  const response = json(text, { raw: text.slice(0, 4000) });
  if (!remote.ok) throw new Error(`Provider HTTP ${remote.status}: ${text.slice(0, 500)}`);
  const content = response?.choices?.[0]?.message?.content || response?.output_text || response?.diagram || response;
  return { diagram: extractArchitectureJson(content), response };
}

function architectureArtifactHtml(diagram, validation, projectName) {
  const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const nodes = diagram.nodes || [];
  const width = Math.max(960, Math.ceil(Math.sqrt(nodes.length || 1)) * 300);
  const height = Math.max(640, Math.ceil((nodes.length || 1) / 3) * 190 + 180);
  const cards = nodes.map((node, index) => `<article class="node" style="left:${40 + (index % 3) * 300}px;top:${80 + Math.floor(index / 3) * 190}px"><b>${safe(node.label)}</b><small>${safe(node.kind)} · ${safe(node.summary || '')}</small><code>${safe((node.evidence || []).map((item) => `${item.path}:${item.line || 1}`).join(', '))}</code></article>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${safe(projectName)} · MergeGraph architecture</title><style>body{margin:0;background:#0b1118;color:#e9f1f8;font:14px system-ui;padding:24px}h1{font-size:22px}main{position:relative;width:${width}px;height:${height}px;background:radial-gradient(#263746 1px,transparent 1px);background-size:24px 24px;border:1px solid #304557;border-radius:14px}.node{position:absolute;width:240px;min-height:90px;padding:14px;background:#172431;border:1px solid #5a8195;border-radius:10px;box-shadow:0 12px 22px #0005}.node b,.node small,.node code{display:block}.node small{color:#8cd9c0;margin-top:8px}.node code{color:#96aabd;font-size:11px;margin-top:12px;white-space:pre-wrap}footer{color:#8a9aab;margin-top:12px}</style><h1>${safe(diagram.meta?.title || projectName)}</h1><main>${cards}</main><footer>MergeGraph IR ${safe(diagram.schemaVersion)} · ${validation.ok ? 'validated' : 'validation failed'}</footer></html>`;
}

function validateArchitectureEvidence(diagram, snapshotId) {
  const diagnostics = [];
  const fileRows = db.prepare('SELECT relative_path, included, line_count FROM project_files WHERE snapshot_id = ?').all(snapshotId);
  const files = new Map(fileRows.map((row) => [row.relative_path, row]));
  const owners = [
    ...(diagram.nodes || []).map((item) => ({ owner: item.id, evidence: item.evidence || [] })),
    ...(diagram.edges || []).map((item) => ({ owner: item.id, evidence: item.evidence || [] })),
    ...(diagram.recommendations || []).map((item) => ({ owner: item.id, evidence: item.evidence || [] })),
    ...(diagram.openQuestions || []).map((item) => ({ owner: item.id, evidence: item.evidence || [] })),
    ...(diagram.evidenceGaps || []).map((item) => ({ owner: item.id, evidence: item.evidence || [] }))
  ];
  for (const item of owners) for (const reference of item.evidence) {
    const row = files.get(reference.path);
    if (!row) diagnostics.push({ path: `evidence.${item.owner}`, code: 'evidence/file-missing', message: `Evidence file does not exist in snapshot: ${reference.path}` });
    else if (!row.included) diagnostics.push({ path: `evidence.${item.owner}`, code: 'evidence/file-excluded', message: `Evidence file was excluded from snapshot: ${reference.path}` });
    else if (reference.line !== undefined && row.line_count > 0 && reference.line > row.line_count) diagnostics.push({ path: `evidence.${item.owner}`, code: 'evidence/line-out-of-range', message: `Evidence line ${reference.line} exceeds ${row.line_count} lines in ${reference.path}` });
    else if (reference.endLine !== undefined && row.line_count > 0 && reference.endLine > row.line_count) diagnostics.push({ path: `evidence.${item.owner}`, code: 'evidence/end-line-out-of-range', message: `Evidence end line ${reference.endLine} exceeds ${row.line_count} lines in ${reference.path}` });
  }
  return diagnostics;
}

async function persistArchitectureDocument(project, analysisId, diagram, validation, snapshot) {
  assertArchitectureDiagram(diagram);
  const adapted = adaptArchitectureToArchify(diagram, { output: `${analysisId}.html`, qualityProfile: 'standard' });
  const documentId = id('architecture');
  const directory = path.join(DATA_DIR, 'projects', project.id, 'architecture');
  await mkdir(directory, { recursive: true });
  const htmlPath = path.join(directory, `${documentId}.html`);
  const jsonPath = path.join(directory, `${documentId}.json`);
  const html = architectureArtifactHtml(diagram, validation, project.name);
  const artifact = { diagram, archify: adapted.document, validation, archifyDiagnostics: adapted.diagnostics, snapshotId: snapshot.id };
  await writeFile(`${jsonPath}.tmp`, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8'); await rename(`${jsonPath}.tmp`, jsonPath);
  await writeFile(`${htmlPath}.tmp`, html, 'utf8'); await rename(`${htmlPath}.tmp`, htmlPath);
  const artifactHash = crypto.createHash('sha256').update(html).digest('hex');
  db.prepare('UPDATE architecture_documents SET is_last_good = 0 WHERE analysis_id IN (SELECT id FROM architecture_runs WHERE project_id = ?)').run(project.id);
  db.prepare(`INSERT INTO architecture_documents (id,analysis_id,format_version,ir_json,archify_json,validation_json,artifact_path,artifact_hash,is_last_good,created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(documentId, analysisId, diagram.schemaVersion, JSON.stringify(diagram), JSON.stringify(adapted.document), JSON.stringify({ ...validation, archifyDiagnostics: adapted.diagnostics }), htmlPath, artifactHash, now());
  const evidenceRows = [];
  for (const node of diagram.nodes || []) for (const evidence of node.evidence || []) evidenceRows.push([documentId, node.id, '', evidence.path, evidence.line || 0, evidence.endLine || evidence.line || 0, evidence.label || '', evidence.verification || 'unverified']);
  for (const edge of diagram.edges || []) for (const evidence of edge.evidence || []) evidenceRows.push([documentId, '', edge.id, evidence.path, evidence.line || 0, evidence.endLine || evidence.line || 0, evidence.label || '', evidence.verification || 'unverified']);
  const insertEvidence = db.prepare('INSERT INTO architecture_evidence (document_id,node_id,edge_id,relative_path,line_start,line_end,label,verification) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of evidenceRows) insertEvidence.run(...row);
  return { id: documentId, artifactPath: htmlPath, artifactHash, archify: adapted, diagram, validation };
}

function projectArchitectureToCanvas(project, analysisId, documentId, diagram) {
  const nodeMap = new Map();
  (diagram.nodes || []).forEach((node, index) => {
    const canvasId = id('node'); nodeMap.set(node.id, canvasId);
    const position = node.position || { x: 80 + (index % 3) * 300, y: 100 + Math.floor(index / 3) * 190 };
    db.prepare(`INSERT INTO canvas_nodes (id,type,x,y,width,height,data_json,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(canvasId, 'architecture', Number(position.x || 0), Number(position.y || 0), Number(node.size?.width || 240), Number(node.size?.height || 140), JSON.stringify({ title: node.label, body: node.summary || '', projectId: project.id, analysisId, architectureDocumentId: documentId, architectureNodeId: node.id, evidence: node.evidence || [], kind: node.kind }), now());
  });
  for (const edge of diagram.edges || []) {
    const source = nodeMap.get(edge.source); const target = nodeMap.get(edge.target); if (!source || !target || source === target) continue;
    db.prepare('INSERT INTO canvas_edges (id,source,target,label,updated_at) VALUES (?, ?, ?, ?, ?)').run(id('edge'), source, target, edge.label || 'depends on', now());
  }
  return { nodeCount: nodeMap.size, edgeCount: (diagram.edges || []).length };
}

async function runArchitectureAnalysis(project, snapshot, body) {
  const analysisId = id('analysis'); const started = now();
  const provider = resolveProvider(body.provider || {});
  const mode = String(body.mode || 'architecture');
  const prompt = String(body.prompt || '');
  const evidencePack = await buildArchitectureEvidencePack(project, snapshot.id, body.contextPolicy || {});
  const requestPayload = { mode, prompt, snapshotId: snapshot.id, contextHash: evidencePack.hash, provider: { profileId: provider.profileId, baseUrl: provider.baseUrl, model: provider.model } };
  db.prepare(`INSERT INTO architecture_runs (id,project_id,snapshot_id,mode,status,prompt,provider_profile_id,request_json,response_json,result_json,context_hash,error,started_at,finished_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?, '{}', '{}', ?, '', ?, '')`).run(analysisId, project.id, snapshot.id, mode, prompt, provider.profileId, JSON.stringify(requestPayload), evidencePack.hash, started);
  let response = {}; let diagram; let status = 'succeeded'; let error = ''; let document = null; let canvas = null;
  try {
    const remote = await callArchitectureProvider(project, snapshot, evidencePack, body, provider);
    response = remote.response || {};
    diagram = remote.diagram || defaultArchitectureDiagram(project, snapshot, evidencePack);
    if (!diagram.meta) diagram.meta = {};
    diagram.meta.projectId = project.id; diagram.meta.repoSnapshotId = snapshot.id;
    const validation = validateArchitectureDiagram(diagram);
    if (!validation.ok) { const cause = new Error('ArchitectureDiagramIR validation failed'); cause.diagnostics = validation.errors; throw cause; }
    const evidenceErrors = validateArchitectureEvidence(diagram, snapshot.id);
    if (evidenceErrors.length) { const cause = new Error('Architecture evidence does not match the selected snapshot'); cause.diagnostics = evidenceErrors; throw cause; }
    document = await persistArchitectureDocument(project, analysisId, diagram, validation, snapshot);
    canvas = projectArchitectureToCanvas(project, analysisId, document.id, diagram);
    const result = { documentId: document.id, diagram, validation, evidencePack: { hash: evidencePack.hash, fileCount: evidencePack.bundle.files.length }, canvas, archifyDiagnostics: document.archify.diagnostics };
    db.prepare('UPDATE architecture_runs SET status = ?, response_json = ?, result_json = ?, finished_at = ? WHERE id = ?').run(status, JSON.stringify(response), JSON.stringify(result), now(), analysisId);
  } catch (cause) {
    status = 'failed'; error = String(cause?.message || cause); response = response || {};
    db.prepare('UPDATE architecture_runs SET status = ?, response_json = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ?').run(status, JSON.stringify(response), JSON.stringify({ diagnostics: cause?.diagnostics || [] }), error.slice(0, 2000), now(), analysisId);
  }
  return architectureRunView(db.prepare('SELECT * FROM architecture_runs WHERE id = ?').get(analysisId));
}

async function handleArchitectureCreate(req, res, projectId) {
  requireLoopback(req);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return notFound(res);
  const body = await readBody(req);
  const snapshotId = String(body.snapshotId || project.last_snapshot_id || '');
  const snapshot = db.prepare('SELECT * FROM project_snapshots WHERE id = ? AND project_id = ?').get(snapshotId, projectId);
  if (!snapshot) return send(res, 400, { error: 'A completed project snapshot is required before analysis' });
  if (snapshot.status !== 'succeeded') return send(res, 409, { error: `Snapshot is not ready: ${snapshot.status}` });
  const analysis = await runArchitectureAnalysis(project, snapshot, body);
  return send(res, analysis.status === 'failed' ? 502 : 201, { analysis });
}

function handleArchitectureGet(req, res, analysisId) {
  requireLoopback(req);
  const row = db.prepare('SELECT * FROM architecture_runs WHERE id = ?').get(analysisId);
  return row ? send(res, 200, { analysis: architectureRunView(row) }) : notFound(res);
}

function handleArchitectureList(req, res, projectId) {
  requireLoopback(req);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return notFound(res);
  const rows = db.prepare('SELECT * FROM architecture_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 30').all(projectId);
  return send(res, 200, { projectId, analyses: rows.map(architectureRunView) });
}

function handleArchitectureDocuments(req, res, analysisId) {
  requireLoopback(req);
  const row = db.prepare('SELECT * FROM architecture_runs WHERE id = ?').get(analysisId);
  if (!row) return notFound(res);
  const documents = db.prepare('SELECT * FROM architecture_documents WHERE analysis_id = ? ORDER BY created_at DESC').all(analysisId).map(architectureDocumentView);
  return send(res, 200, { analysisId, documents });
}

function handleArchitectureSource(req, res, documentId) {
  requireLoopback(req);
  const row = db.prepare('SELECT * FROM architecture_documents WHERE id = ?').get(documentId);
  if (!row) return notFound(res);
  if (req.url?.endsWith('/preview')) {
    if (!row.artifact_path || !existsSync(row.artifact_path)) return notFound(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return createReadStream(row.artifact_path).pipe(res);
  }
  return send(res, 200, { document: architectureDocumentView(row) });
}

// Resolve a run's provider from the project-wide default profile. A supplied
// apiKey is accepted for backward compatibility with the old run form, but it
// is never included in requestPayload, run records, or API responses.
function resolveProvider(input = {}) {
  const requestedId = String(input.profileId || input.providerProfileId || defaultProviderId);
  const profile = providerRow(requestedId) || providerRow(defaultProviderId);
  const transientKey = input.apiKey && input.apiKey !== '••••••••' ? String(input.apiKey) : '';
  return {
    profileId: profile?.id || defaultProviderId,
    name: String(input.name || profile?.name || '默认 Provider'),
    baseUrl: String(input.baseUrl ?? profile?.base_url ?? ''),
    model: String(input.model || profile?.model || 'mergegraph-local-mock'),
    timeoutMs: Math.min(120000, Math.max(1000, Number(input.timeoutMs || profile?.timeout_ms || 30000))),
    apiKey: transientKey || String(profile?.api_key || '')
  };
}
function saveProviderProfile(body = {}) {
  const previous = providerRow(defaultProviderId);
  const timestamp = now();
  const suppliedKey = body.apiKey && body.apiKey !== '••••••••' ? String(body.apiKey) : null;
  const apiKey = body.clearApiKey === true ? '' : suppliedKey === null ? String(previous?.api_key || '') : suppliedKey;
  const name = String(body.name ?? previous?.name ?? '默认 Provider').trim().slice(0, 120) || '默认 Provider';
  const baseUrl = String(body.baseUrl ?? previous?.base_url ?? '').trim().slice(0, 500);
  const model = String(body.model ?? previous?.model ?? 'mergegraph-local-mock').trim().slice(0, 200) || 'mergegraph-local-mock';
  const timeoutMs = Math.min(120000, Math.max(1000, Number(body.timeoutMs ?? previous?.timeout_ms ?? 30000)));
  db.prepare(`INSERT INTO provider_profiles (id,name,base_url,model,api_key,timeout_ms,is_default,created_at,updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, model=excluded.model, api_key=excluded.api_key, timeout_ms=excluded.timeout_ms, is_default=1, updated_at=excluded.updated_at`).run(defaultProviderId, name, baseUrl, model, apiKey, timeoutMs, previous?.created_at || timestamp, timestamp);
  const safe = { profileId: defaultProviderId, name, baseUrl, model, timeoutMs, hasApiKey: Boolean(apiKey) };
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('provider', JSON.stringify(safe));
  return providerView(db.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(defaultProviderId));
}
function settingsView() {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const settings = Object.fromEntries(rows.map((row) => [row.key, json(row.value, row.value)]));
  settings.provider = providerView(providerRow(defaultProviderId));
  return settings;
}

const mediaType = (mime) => mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('text/') ? 'text' : 'file';
const safeFilename = (value) => path.basename(String(value || 'asset')).replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 160) || 'asset';
const extFor = (filename, mime) => path.extname(filename) || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'text/plain': '.txt' }[mime] || '.bin');

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function notFound(res) { send(res, 404, { error: 'Not found' }); }

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('Request body exceeds 32 MB');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }); }
}

function assetRow(row) {
  if (!row) return null;
  return { ...row, tags: json(row.tags_json, []), url: `/api/assets/${row.id}/content` };
}

function sidecarFor(row) {
  return {
    schemaVersion: '1.0', assetId: row.id, contentHash: row.content_hash, updatedAt: row.updated_at,
    context: { title: row.filename, tags: json(row.tags_json, []), notes: row.notes, prompt: row.prompt, source: row.source, license: row.license, project: row.project },
    provenance: [{ kind: 'stored_at', value: path.relative(DATA_DIR, row.storage_path).replaceAll(path.sep, '/'), at: row.created_at }]
  };
}

async function writeSidecar(row) {
  const sidecar = sidecarFor(row);
  if (sidecar.schemaVersion !== '1.0' || typeof sidecar.assetId !== 'string' || !/^[a-f0-9]{64}$/.test(sidecar.contentHash) || !Array.isArray(sidecar.context.tags)) throw new Error('Invalid context sidecar');
  const target = path.join(SIDECAR_DIR, `${row.id}.context.json`);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8'); await rename(temporary, target); } finally { if (existsSync(temporary)) await unlink(temporary).catch(() => {}); }
}

async function repairSidecars() {
  const rows = db.prepare('SELECT * FROM assets').all();
  for (const row of rows) await writeSidecar(row);
}

async function persistAsset({ filename, mime, content, context = {} }) {
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  const existing = db.prepare('SELECT * FROM assets WHERE content_hash = ? LIMIT 1').get(contentHash);
  if (existing) return { row: existing, duplicate: true };
  const assetId = id('asset');
  const storageName = `${assetId}${extFor(filename, mime)}`;
  const storagePath = path.join(ASSET_DIR, storageName);
  const temporaryPath = `${storagePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const timestamp = now();
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, storagePath);
  try {
    db.prepare(`INSERT INTO assets (id, filename, mime, media_type, size, content_hash, storage_path, tags_json, notes, prompt, source, license, project, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        assetId, safeFilename(filename), mime, mediaType(mime), content.length, contentHash, storagePath,
        JSON.stringify(Array.isArray(context.tags) ? context.tags : []), String(context.notes || ''), String(context.prompt || ''), String(context.source || ''), String(context.license || ''), String(context.project || ''), timestamp, timestamp
      );
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    await writeSidecar(row);
    return { row, duplicate: false };
  } catch (error) {
    db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
    await unlink(storagePath).catch(() => {});
    await unlink(path.join(SIDECAR_DIR, `${assetId}.context.json`)).catch(() => {});
    if (String(error.message || '').includes('UNIQUE constraint failed')) {
      const winner = db.prepare('SELECT * FROM assets WHERE content_hash = ? LIMIT 1').get(contentHash);
      if (winner) return { row: winner, duplicate: true };
    }
    throw error;
  } finally { if (existsSync(temporaryPath)) await unlink(temporaryPath).catch(() => {}); }
}

async function handleAssetCreate(req, res) {
  const body = await readBody(req);
  const filename = safeFilename(body.filename);
  const mime = String(body.mime || 'application/octet-stream');
  const encoded = String(body.dataBase64 || '');
  if (!encoded) return send(res, 400, { error: 'dataBase64 is required' });
  const raw = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded;
  const content = Buffer.from(raw, 'base64');
  if (!content.length) return send(res, 400, { error: 'The uploaded file is empty' });
  if (content.length > 24 * 1024 * 1024) return send(res, 413, { error: 'Decoded asset exceeds 24 MB' });
  const context = body.context && typeof body.context === 'object' ? body.context : {};
  const result = await persistAsset({ filename, mime, content, context });
  return send(res, result.duplicate ? 200 : 201, { asset: assetRow(result.row), ...(result.duplicate ? { duplicateOf: result.row.id } : { sidecar: `/api/assets/${result.row.id}/sidecar` }) });
}

async function handleAssetPatch(req, res, assetId) {
  const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  if (!existing) return notFound(res);
  const body = await readBody(req);
  const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : json(existing.tags_json, []);
  const timestamp = now();
  const updated = { ...existing, tags_json: JSON.stringify(tags), notes: String(body.notes ?? existing.notes), prompt: String(body.prompt ?? existing.prompt), source: String(body.source ?? existing.source), license: String(body.license ?? existing.license), project: String(body.project ?? existing.project), updated_at: timestamp };
  try {
    await writeSidecar(updated);
  } catch (error) {
    throw error;
  }
  try {
    db.exec('BEGIN');
    db.prepare(`UPDATE assets SET tags_json = ?, notes = ?, prompt = ?, source = ?, license = ?, project = ?, updated_at = ? WHERE id = ?`).run(updated.tags_json, updated.notes, updated.prompt, updated.source, updated.license, updated.project, timestamp, assetId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction did not start */ }
    await writeSidecar(existing).catch(() => {});
    throw error;
  }
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  return send(res, 200, { asset: assetRow(row) });
}

async function compileContext(assetRows) {
  const items = [];
  for (const row of assetRows) {
    const item = { assetId: row.id, filename: row.filename, mime: row.mime, mediaType: row.media_type, size: row.size, contentHash: row.content_hash, context: sidecarFor(row).context };
    if (row.media_type === 'text' && row.size <= 128 * 1024) item.text = await readFile(row.storage_path, 'utf8');
    if (row.media_type === 'image' && row.size <= 2 * 1024 * 1024 && existsSync(row.storage_path)) item.dataUrl = `data:${row.mime};base64,${(await readFile(row.storage_path)).toString('base64')}`;
    items.push(item);
  }
  const bundle = { version: '1.0', items };
  const serialized = JSON.stringify(bundle);
  return { bundle, hash: crypto.createHash('sha256').update(serialized).digest('hex') };
}

function runLinks(runId) {
  return db.prepare(`SELECT l.run_id, l.asset_id, l.relation, l.ordinal, a.filename, a.content_hash
    FROM run_links l LEFT JOIN assets a ON a.id = l.asset_id WHERE l.run_id = ? ORDER BY l.ordinal, l.relation, l.asset_id`).all(runId);
}

function runView(row) {
  return { id: row.id, status: row.status, provider: row.provider, model: row.model, request: json(row.request_json, {}), contextHash: row.context_hash, context: json(row.context_json, {}), response: json(row.response_json, {}), error: row.error, links: runLinks(row.id), startedAt: row.started_at, finishedAt: row.finished_at };
}

async function handleRun(req, res) {
  const body = await readBody(req);
  const runId = id('run');
  const started = now();
  const providerInput = body.provider || {};
  const provider = resolveProvider(providerInput);
  const effectiveApiKey = provider.apiKey;
  const model = provider.model;
  const inputAssetIds = Array.isArray(body.inputAssetIds) ? body.inputAssetIds.map(String) : [];
  const placeholders = inputAssetIds.map(() => '?').join(',');
  const inputRows = inputAssetIds.length ? db.prepare(`SELECT * FROM assets WHERE id IN (${placeholders})`).all(...inputAssetIds) : [];
  if (inputRows.length !== inputAssetIds.length) return send(res, 400, { error: 'One or more inputAssetIds do not exist' });
  const context = await compileContext(inputRows);
  const providerName = String(provider.name || (provider.baseUrl ? 'openai-compatible' : 'local-mock'));
  const requestPayload = { prompt: String(body.prompt || ''), inputAssetIds, provider: { baseUrl: String(provider.baseUrl || ''), model }, contextHash: context.hash };
  db.prepare(`INSERT INTO runs (id,status,provider,model,request_json,context_hash,context_json,started_at,finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, 'running', providerName, model, JSON.stringify(requestPayload), context.hash, JSON.stringify(context.bundle), started, started);
  for (const [ordinal, assetId] of inputAssetIds.entries()) db.prepare('INSERT OR IGNORE INTO run_links (run_id,asset_id,relation,ordinal) VALUES (?, ?, ?, ?)').run(runId, assetId, 'input', ordinal);
  let status = 'succeeded'; let response = {}; let error = '';
  let outputAsset = null;
  try {
    if (provider.baseUrl) {
      const endpoint = `${String(provider.baseUrl).replace(/\/$/, '')}/chat/completions`;
      const parsedEndpoint = new URL(endpoint);
      const allowedHosts = String(process.env.MERGEGRAPH_ALLOWED_HOSTS || '').split(',').map((host) => host.trim()).filter(Boolean);
      if (allowedHosts.length && !allowedHosts.includes(parsedEndpoint.host)) throw Object.assign(new Error('Provider host is not in MERGEGRAPH_ALLOWED_HOSTS'), { statusCode: 400 });
      const textPart = `${requestPayload.prompt}\n\nMergeGraph ContextBundle (${context.hash}):\n${JSON.stringify(context.bundle)}`;
      const imageParts = context.bundle.items.filter((item) => item.dataUrl).map((item) => ({ type: 'image_url', image_url: { url: item.dataUrl } }));
      const messageContent = imageParts.length ? [{ type: 'text', text: textPart }, ...imageParts] : textPart;
      const remote = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(effectiveApiKey ? { Authorization: `Bearer ${effectiveApiKey}` } : {}) }, signal: AbortSignal.timeout(provider.timeoutMs), body: JSON.stringify({ model, messages: [{ role: 'user', content: messageContent }], input_context: context.bundle, context_hash: context.hash, temperature: 0.7 }) });
      const text = await remote.text();
      response = json(text, { raw: text });
      if (!remote.ok) { status = 'failed'; error = `HTTP ${remote.status}: ${text.slice(0, 500)}`; }
    } else {
      response = { choices: [{ message: { role: 'assistant', content: `本地演示结果：已记录任务「${requestPayload.prompt || '未命名任务'}」，并绑定 ${context.bundle.items.length} 个上下文素材。你可以在设置中填入 OpenAI 兼容接口后运行真实调用。` } }], mock: true, context_hash: context.hash };
    }
    if (status === 'succeeded') {
      const outputText = String(response?.choices?.[0]?.message?.content || response?.output_text || '');
      if (outputText) {
        const generated = await persistAsset({ filename: `${runId}.md`, mime: 'text/markdown', content: Buffer.from(outputText, 'utf8'), context: { tags: ['generated', 'run'], notes: 'Generated by MergeGraph run', prompt: requestPayload.prompt, source: `mergegraph:run:${runId}`, license: 'generated' } });
        outputAsset = assetRow(generated.row);
        db.prepare('INSERT OR IGNORE INTO run_links (run_id,asset_id,relation,ordinal) VALUES (?, ?, ?, ?)').run(runId, generated.row.id, 'output', 0);
      }
    }
  } catch (cause) { status = 'failed'; error = cause instanceof Error ? cause.message : String(cause); }
  const finished = now();
  db.prepare('UPDATE runs SET status = ?, response_json = ?, error = ?, finished_at = ? WHERE id = ?').run(status, JSON.stringify(response), error, finished, runId);
  return send(res, status === 'failed' ? 502 : 201, { run: { id: runId, status, provider: providerName, model, request: requestPayload, contextHash: context.hash, context: context.bundle, response, error, links: runLinks(runId), outputAsset, startedAt: started, finishedAt: finished } });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  requireLoopback(req);
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, app: 'MergeGraph MVP', dataDir: DATA_DIR });
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    return send(res, 200, { projects: rows.map(projectView) });
  }
  if (req.method === 'POST' && url.pathname === '/api/projects') return handleProjectCreate(req, res);
  if (parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
    const projectId = parts[2];
    if (req.method === 'GET' && parts.length === 3) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      return row ? send(res, 200, { project: projectView(row) }) : notFound(res);
    }
    if (req.method === 'PATCH' && parts.length === 3) return handleProjectPatch(req, res, projectId);
    if (req.method === 'POST' && parts[3] === 'scans') return handleProjectScan(req, res, projectId);
    if (req.method === 'GET' && parts[3] === 'snapshots' && parts[4] && parts[5] === 'files') return handleSnapshotFiles(req, res, projectId, parts[4], url);
    if (req.method === 'POST' && parts[3] === 'analyses') return handleArchitectureCreate(req, res, projectId);
    if (req.method === 'GET' && parts[3] === 'analyses') return handleArchitectureList(req, res, projectId);
  }
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'scans' && parts[2]) return handleScanGet(req, res, parts[2]);
  if (parts[0] === 'api' && parts[1] === 'analyses' && parts[2]) {
    const analysisId = parts[2];
    if (req.method === 'GET' && parts.length === 3) return handleArchitectureGet(req, res, analysisId);
    if (req.method === 'GET' && parts[3] === 'documents') return handleArchitectureDocuments(req, res, analysisId);
    if (req.method === 'POST' && parts[3] === 'commit') {
      const row = db.prepare('SELECT * FROM architecture_runs WHERE id = ?').get(analysisId);
      if (!row) return notFound(res);
      const document = db.prepare('SELECT * FROM architecture_documents WHERE analysis_id = ? ORDER BY created_at DESC LIMIT 1').get(analysisId);
      return document ? send(res, 200, { committed: true, document: architectureDocumentView(document) }) : send(res, 409, { error: 'No validated architecture document is available' });
    }
  }
  if (parts[0] === 'api' && parts[1] === 'architecture-documents' && parts[2] && req.method === 'GET') {
    if (parts[3] === 'source' || parts[3] === 'preview') return handleArchitectureSource(req, res, parts[2]);
  }
  if ((url.pathname === '/api/settings/provider' || url.pathname === '/api/provider') && req.method === 'GET') return send(res, 200, { provider: providerView(providerRow(defaultProviderId)) });
  if ((url.pathname === '/api/settings/provider' || url.pathname === '/api/provider') && req.method === 'PUT') {
    const body = await readBody(req);
    return send(res, 200, { provider: saveProviderProfile(body) });
  }
  if (req.method === 'GET' && url.pathname === '/api/assets') {
    const q = String(url.searchParams.get('q') || '').trim();
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const where = q ? 'WHERE filename LIKE ? OR media_type LIKE ? OR tags_json LIKE ? OR notes LIKE ? OR prompt LIKE ?' : '';
    const args = q ? Array(5).fill(`%${q}%`) : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM assets ${where}`).get(...args).n;
    const rows = db.prepare(`SELECT * FROM assets ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return send(res, 200, { assets: rows.map(assetRow), total, limit, offset, nextOffset: offset + rows.length < total ? offset + rows.length : null });
  }
  if (parts[0] === 'api' && parts[1] === 'assets' && parts[2]) {
    const assetId = parts[2];
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!row) return notFound(res);
    if (req.method === 'GET' && parts[3] === 'content') {
      if (!existsSync(row.storage_path)) return notFound(res);
      res.writeHead(200, { 'Content-Type': row.mime, 'Content-Length': row.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return createReadStream(row.storage_path).pipe(res);
    }
    if (req.method === 'GET' && parts[3] === 'sidecar') return send(res, 200, sidecarFor(row));
    if (req.method === 'GET') return send(res, 200, { asset: assetRow(row) });
    if (req.method === 'PATCH') return handleAssetPatch(req, res, assetId);
  }
  if (req.method === 'POST' && url.pathname === '/api/assets') return handleAssetCreate(req, res);
  if (req.method === 'GET' && url.pathname === '/api/canvas') {
    const nodes = db.prepare('SELECT * FROM canvas_nodes ORDER BY updated_at').all().map((row) => ({ id: row.id, type: row.type, position: { x: row.x, y: row.y }, size: { width: row.width, height: row.height }, data: json(row.data_json, {}) }));
    const edges = db.prepare('SELECT * FROM canvas_edges ORDER BY updated_at').all().map((row) => ({ id: row.id, source: row.source, target: row.target, label: row.label }));
    return send(res, 200, { nodes, edges });
  }
  if (req.method === 'PUT' && url.pathname === '/api/canvas') {
    const body = await readBody(req); const nodes = Array.isArray(body.nodes) ? body.nodes : []; const edges = Array.isArray(body.edges) ? body.edges : []; const nodeIds = new Set(nodes.map((node) => String(node.id || '')));
    if (nodeIds.size !== nodes.length || nodeIds.has('')) return send(res, 400, { error: 'Canvas nodes must have unique non-empty ids' });
    for (const edge of edges) { if (!nodeIds.has(String(edge.source)) || !nodeIds.has(String(edge.target))) return send(res, 400, { error: 'Canvas edge references a missing node' }); if (String(edge.source) === String(edge.target)) return send(res, 400, { error: 'Canvas edge cannot point to itself' }); }
    const timestamp = now();
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM canvas_nodes; DELETE FROM canvas_edges;');
      for (const node of nodes) db.prepare('INSERT INTO canvas_nodes (id,type,x,y,width,height,data_json,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(String(node.id), String(node.type || 'note'), Number(node.position?.x || 0), Number(node.position?.y || 0), Number(node.size?.width || 220), Number(node.size?.height || 140), JSON.stringify(node.data || {}), timestamp);
      for (const edge of edges) db.prepare('INSERT INTO canvas_edges (id,source,target,label,updated_at) VALUES (?, ?, ?, ?, ?)').run(String(edge.id || id('edge')), String(edge.source), String(edge.target), String(edge.label || ''), timestamp);
      db.exec('COMMIT');
    } catch (cause) { db.exec('ROLLBACK'); throw cause; }
    return send(res, 200, { ok: true, savedAt: timestamp });
  }
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[2]) { const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(parts[2]); return row ? send(res, 200, { run: runView(row) }) : notFound(res); }
  if (req.method === 'GET' && url.pathname === '/api/runs') { const rows = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 50').all().map(runView); return send(res, 200, { runs: rows }); }
  if (req.method === 'POST' && url.pathname === '/api/runs') return handleRun(req, res);
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    return send(res, 200, { settings: settingsView() });
  }
  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    const body = await readBody(req);
    if (body.provider && typeof body.provider === 'object') {
      saveProviderProfile(body.provider);
      delete body.provider;
    }
    for (const [key, value] of Object.entries(body)) db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    return send(res, 200, { assets: db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, runs: db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, nodes: db.prepare('SELECT COUNT(*) AS n FROM canvas_nodes').get().n });
  }
  return notFound(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
    if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) return notFound(res);
    const info = await stat(filePath);
    if (!info.isFile()) return notFound(res);
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(filePath).pipe(res);
  } catch (cause) { console.error(cause); send(res, cause?.statusCode || 500, { error: cause instanceof Error ? cause.message : String(cause) }); }
});

await repairSidecars();
server.listen(PORT, '127.0.0.1', () => console.log(`MergeGraph MVP running at http://127.0.0.1:${PORT}`));

process.on('SIGINT', () => { db.close(); server.close(() => process.exit(0)); });
