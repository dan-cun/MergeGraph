import fs from 'node:fs';
import path from 'node:path';
import { store, id, now } from './core.mjs';
import { getWorkspace, getFiles } from './workspace-service.mjs';

const ENTITY = 'deployment_resources';

function list(predicate) {
  const result = store.list(ENTITY, predicate);
  return Array.isArray(result) ? result : [];
}

function normalizeRelative(workspace, value) {
  const input = String(value ?? '');
  return path.isAbsolute(input)
    ? path.relative(workspace.rootPath, input).replaceAll('\\', '/')
    : input.replaceAll('\\', '/').replace(/^\.\//, '');
}

function cleanUrl(value) {
  const raw = String(value ?? '').trim().replace(/[),;]+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return '';
  }
}

function hostname(value) {
  try { return new URL(cleanUrl(value)).hostname; } catch { return ''; }
}

function dedupeStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim()).filter(Boolean))];
}

function normalizeBody(workspaceId, body, existing = null, source = 'user') {
  const url = cleanUrl(body?.url || existing?.url);
  const domain = String(body?.domain || existing?.domain || hostname(url)).trim().toLowerCase();
  if (!url && !domain) throw new Error('至少提供 url 或 domain');
  const environment = String(body?.environment || existing?.environment || 'unknown').trim().slice(0, 80);
  const provider = String(body?.provider || existing?.provider || '').trim().slice(0, 120);
  const relatedFiles = dedupeStrings(body?.relatedFiles || body?.related_files || existing?.relatedFiles);
  const resource = {
    id: existing?.id || body?.id || id('deployment'),
    workspaceId,
    ...(url ? { url } : {}),
    ...(domain ? { domain } : {}),
    environment,
    ...(provider ? { provider } : {}),
    ...(body?.serviceNodeId || existing?.serviceNodeId ? { serviceNodeId: String(body?.serviceNodeId || existing?.serviceNodeId) } : {}),
    relatedFiles,
    verificationStatus: String(body?.verificationStatus || body?.verification_status || existing?.verificationStatus || 'unverified'),
    source,
    confidence: source === 'user' ? 'confirmed' : 'inferred',
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
  return resource;
}

export function listDeployments(workspaceId) {
  return list((resource) => resource?.workspaceId === workspaceId)
    .sort((a, b) => String(a.domain || a.url || '').localeCompare(String(b.domain || b.url || '')));
}

export function saveDeployment(workspaceId, body, resourceId) {
  const existing = resourceId ? store.get(ENTITY, resourceId) : (body?.id ? store.get(ENTITY, body.id) : null);
  const effectiveWorkspaceId = workspaceId || existing?.workspaceId || body?.workspaceId;
  if (!effectiveWorkspaceId) throw new Error('workspaceId is required');
  if (existing && existing.workspaceId !== effectiveWorkspaceId) throw new Error('部署资源不属于当前工作区');
  const resource = normalizeBody(effectiveWorkspaceId, body, existing, 'user');
  store.put(ENTITY, resource);
  return resource;
}

export function deleteDeployment(resourceId) {
  const existing = store.get(ENTITY, resourceId);
  if (!existing) return false;
  store.remove(ENTITY, resourceId);
  return true;
}

function shouldInspect(file) {
  const p = String(file?.path || '').toLowerCase();
  const name = path.basename(p);
  return /(^|\/)(\.env(?:\.[^/]+)?|docker-compose[^/]*|compose[^/]*|nginx\.conf|caddyfile|vercel\.json|netlify\.toml|wrangler\.toml|fly\.toml|render\.yaml|railway\.json|deploy[^/]*|k8s[^/]*)$/.test(p)
    || /\.(env|ya?ml|json|toml|ini|conf|config|md)$/.test(p)
    || ['vite.config.js', 'vite.config.ts', 'next.config.js', 'next.config.mjs', 'nuxt.config.ts'].includes(name);
}

function readFileContent(workspace, file) {
  if (typeof file?.content === 'string') return file.content;
  const raw = String(file?.path || '');
  const full = path.isAbsolute(raw) ? raw : path.join(workspace.rootPath, raw);
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 1024 * 1024) return '';
    return fs.readFileSync(full, 'utf8');
  } catch {
    return '';
  }
}

function extractCandidates(content) {
  const found = [];
  const urlPattern = /https?:\/\/[^\s"'<>`\\\])}]+/gi;
  let match;
  while ((match = urlPattern.exec(content))) found.push({ url: cleanUrl(match[0]) });
  const keyPattern = /(?:URL|URI|HOST|DOMAIN|ENDPOINT|ORIGIN|BASE_URL|API_URL)\s*[:=]\s*["']?([^\s"'`,}\\]+)["']?/gi;
  while ((match = keyPattern.exec(content))) {
    const candidate = cleanUrl(match[1]);
    if (candidate) found.push({ url: candidate });
    else if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?$/i.test(match[1])) found.push({ domain: match[1].toLowerCase() });
  }
  // A bare domain is accepted only in an explicit domain/host key. This keeps
  // package names and arbitrary prose out of the deployment inventory.
  return found.filter((entry) => entry.url || entry.domain);
}

export function discoverDeployments(workspaceId) {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error(`工作区不存在: ${workspaceId}`);
  const files = getFiles(workspaceId);
  const discovered = new Map();
  for (const file of files) {
    if (!shouldInspect(file)) continue;
    const content = readFileContent(workspace, file);
    if (!content) continue;
    const related = normalizeRelative(workspace, file.path);
    for (const candidate of extractCandidates(content)) {
      const url = candidate.url || '';
      const domain = candidate.domain || hostname(url);
      const key = url || domain;
      if (!key) continue;
      const current = discovered.get(key) || { url, domain, relatedFiles: [] };
      current.relatedFiles = dedupeStrings([...current.relatedFiles, related]);
      discovered.set(key, current);
    }
  }
  const existing = listDeployments(workspaceId);
  const byKey = new Map(existing.map((entry) => [entry.url || entry.domain, entry]));
  const results = [];
  for (const candidate of discovered.values()) {
    const current = byKey.get(candidate.url || candidate.domain);
    const resource = normalizeBody(workspaceId, candidate, current, current?.source === 'user' ? 'user' : 'scan');
    store.put(ENTITY, resource);
    results.push(resource);
  }
  return results.length ? results : existing;
}
