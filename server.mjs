import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recentEvents, subscribe } from './lib/core.mjs';
import { createWorkspace, getWorkspace, listWorkspaces, updateWorkspace, scanWorkspace, getFiles, readWorkspaceFile, startWorkspaceWatcher, stopWorkspaceWatcher } from './lib/workspace-service.mjs';
import { getProvider, saveProvider } from './lib/ai-provider.mjs';
import { discoverInstructions, effectiveInstructions } from './lib/instruction-service.mjs';
import { createTask, getTask, listTasks, listTaskSteps, startTask, cancelTask, rollbackTask, taskEvents, appendMessage, listTaskPatches, getPatch } from './lib/task-service.mjs';
import { listGraphs, getGraph, generateGraphs, saveLayout, nodeDetail, restoreGraph } from './lib/graph-service.mjs';
import { listDeployments, saveDeployment, deleteDeployment, discoverDeployments } from './lib/deployment-service.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4310);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const send = (res, status, body, headers = {}) => { const payload = body === undefined ? '' : JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(payload); };
const ok = (res, body) => send(res, 200, body);
const created = (res, body) => send(res, 201, body);
const errorResponse = (res, error) => send(res, Number(error?.statusCode || 500), { error: String(error?.message || error || 'Internal error') });
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); if (!chunks.length) return {}; try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }); } }
function loopback(req) { const value = String(req.socket?.remoteAddress || ''); return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'; }
function requireLoopback(req) { if (!loopback(req)) throw Object.assign(new Error('MergeGraph workspace APIs are local-only'), { statusCode: 403 }); }
async function serveStatic(req, res, pathname) { const requested = pathname === '/' ? '/index.html' : pathname; const target = path.resolve(PUBLIC_DIR, `.${requested}`); if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`) && target !== PUBLIC_DIR) return false; const info = await stat(target).catch(() => null); if (!info?.isFile()) return false; res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); createReadStream(target).pipe(res); return true; }
const wid = (p) => decodeURIComponent(p.match(/^\/api\/workspaces\/([^/]+)/)?.[1] || '');
const gid = (p) => decodeURIComponent(p.match(/^\/api\/graphs\/([^/]+)/)?.[1] || '');
const tid = (p) => decodeURIComponent(p.match(/^\/api\/tasks\/([^/]+)/)?.[1] || '');
const did = (p) => decodeURIComponent(p.match(/^\/api\/deployments\/([^/]+)/)?.[1] || '');
const taskView = async (task) => task ? { ...task, steps: await listTaskSteps(task.id) } : task;
const compactFile = ({ content, ...file }) => file;
const workspaceInitializations = new Map();
function initializationView(workspaceId) {
  const current = workspaceInitializations.get(workspaceId);
  if (current) return { ...current };
  const workspace = getWorkspace(workspaceId);
  return { workspaceId, status: workspace?.snapshotId ? 'ready' : 'idle', snapshotId: workspace?.snapshotId || null, error: workspace?.initializationError || null };
}
function initializeWorkspace(workspaceId) {
  const existing = workspaceInitializations.get(workspaceId);
  if (existing?.status === 'running') return existing;
  const state = { workspaceId, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, snapshotId: null, error: null };
  workspaceInitializations.set(workspaceId, state);
  updateWorkspace(workspaceId, { initializationStatus: 'running', initializationError: null });
  Promise.resolve().then(async () => {
    const scan = await scanWorkspace(workspaceId, { origin: 'initial' });
    await generateGraphs(workspaceId);
    Object.assign(state, { status: 'ready', finishedAt: new Date().toISOString(), snapshotId: scan.snapshotId });
    updateWorkspace(workspaceId, { initializationStatus: 'ready', initializationError: null, snapshotId: scan.snapshotId });
  }).catch((error) => {
    Object.assign(state, { status: 'failed', finishedAt: new Date().toISOString(), error: String(error?.message || error) });
    updateWorkspace(workspaceId, { initializationStatus: 'failed', initializationError: state.error });
  });
  return state;
}
function sseHeaders(res) { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write(': connected\n\n'); }
function eventTaskId(event) { return event?.taskId || event?.payload?.taskId || event?.payload?.data?.taskId || event?.payload?.task?.id || event?.payload?.data?.task?.id || ''; }
function sse(req, res, workspaceId, after = 0, taskId = '') {
  const matches = (event) => !taskId || String(eventTaskId(event)) === String(taskId);
  sseHeaders(res);
  for (const event of recentEvents(workspaceId, after, 100).filter(matches)) res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const unsubscribe = subscribe(workspaceId, (event) => { if (matches(event)) res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
}
async function refreshDeploymentGraphs(workspaceId = '') {
  const ids = workspaceId ? [workspaceId] : listWorkspaces().map((workspace) => workspace.id);
  await Promise.all(ids.map((id) => generateGraphs(id, { type: 'deployment_ownership' }).catch(() => null)));
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) return (await serveStatic(req, res, pathname)) || send(res, 404, { error: 'Not found' });
  requireLoopback(req);
  const method = req.method || 'GET';
  if (pathname === '/api/health' && method === 'GET') return ok(res, { ok: true, service: 'mergegraph', time: new Date().toISOString() });
  if ((pathname === '/api/settings/provider' || pathname === '/api/provider') && method === 'GET') return ok(res, { provider: getProvider() });
  if ((pathname === '/api/settings/provider' || pathname === '/api/provider') && method === 'PUT') return ok(res, { provider: saveProvider(await body(req)) });

  if (pathname === '/api/workspaces' && method === 'GET') return ok(res, { workspaces: listWorkspaces() });
  if (pathname === '/api/workspaces' && method === 'POST') { const input = await body(req); const workspace = await createWorkspace(input); startWorkspaceWatcher(workspace.id); const initialization = initializeWorkspace(workspace.id); return created(res, { workspace: getWorkspace(workspace.id), initialization, graphs: [] }); }
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/status$/) && method === 'GET') { const workspaceId = wid(pathname); const workspace = getWorkspace(workspaceId); if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 }); return ok(res, { workspace, initialization: initializationView(workspaceId) }); }
  if (pathname.match(/^\/api\/workspaces\/[^/]+$/)) { const workspaceId = wid(pathname); const workspace = getWorkspace(workspaceId); if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 }); if (method === 'GET') { const reopened = workspace.status === 'closed' ? updateWorkspace(workspaceId, { status: 'ready', closedAt: null }) : workspace; startWorkspaceWatcher(workspaceId); return ok(res, { workspace: reopened, initialization: initializationView(workspaceId), files: getFiles(workspaceId).map(compactFile), graphs: await listGraphs(workspaceId), instructions: await discoverInstructions(workspaceId) }); } if (method === 'PATCH') return ok(res, { workspace: updateWorkspace(workspaceId, await body(req)) }); }
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/scan$/) && method === 'POST') { const workspaceId = wid(pathname); const scan = await scanWorkspace(workspaceId); const graphs = await generateGraphs(workspaceId); return ok(res, { workspace: scan.workspace, snapshotId: scan.snapshotId, stats: scan.stats, changes: scan.changes, graphs: graphs.map(({ nodes = [], edges = [], ...summary }) => ({ ...summary, nodeCount: nodes.length, edgeCount: edges.length })) }); }
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/close$/) && method === 'POST') { const workspaceId = wid(pathname); stopWorkspaceWatcher(workspaceId); return ok(res, { workspace: updateWorkspace(workspaceId, { status: 'closed', closedAt: new Date().toISOString() }) }); }
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/files$/) && method === 'GET') return ok(res, { files: getFiles(wid(pathname)).map(compactFile) });
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/file$/) && method === 'GET') return ok(res, { content: await readWorkspaceFile(wid(pathname), url.searchParams.get('path') || '') });
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/events$/) && method === 'GET') return sse(req, res, wid(pathname), Number(url.searchParams.get('after') || req.headers['last-event-id'] || 0));

  if (pathname.match(/^\/api\/workspaces\/[^/]+\/instructions$/) && method === 'GET') return ok(res, { instructions: await discoverInstructions(wid(pathname)) });
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/instructions\/effective$/) && method === 'GET') return ok(res, await effectiveInstructions(wid(pathname), url.searchParams.get('path') || ''));
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/instructions\/refresh$/) && method === 'POST') return ok(res, { instructions: await discoverInstructions(wid(pathname)) });
  if (pathname === '/api/instructions' && method === 'GET') return ok(res, { instructions: await discoverInstructions(url.searchParams.get('workspaceId') || '') });

  if (pathname.match(/^\/api\/workspaces\/[^/]+\/graphs$/) && method === 'GET') return ok(res, { graphs: await listGraphs(wid(pathname), url.searchParams.get('type') || '') });
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/graphs\/generate$/) && method === 'POST') return ok(res, { graphs: await generateGraphs(wid(pathname), await body(req)) });
  if (pathname === '/api/graphs' && method === 'GET') return ok(res, { graphs: await listGraphs(url.searchParams.get('workspaceId') || '', url.searchParams.get('type') || url.searchParams.get('graphType') || '') });
  if (pathname === '/api/graphs' && method === 'POST') { const input = await body(req); return ok(res, { graph: await generateGraphs(input.workspaceId, { type: input.type || input.graphType, taskId: input.taskId }) }); }
  if (pathname.match(/^\/api\/graphs\/[^/]+$/)) { const graphId = gid(pathname); if (method === 'GET') return ok(res, { graph: await getGraph(graphId) }); if (method === 'POST') return ok(res, { graph: await restoreGraph(graphId) }); }
  if (pathname.match(/^\/api\/graphs\/[^/]+\/layout$/) && method === 'PATCH') return ok(res, { graph: await saveLayout(gid(pathname), await body(req)) });
  if (pathname.match(/^\/api\/graphs\/[^/]+$/) && method === 'PUT') return ok(res, { graph: saveLayout(gid(pathname), await body(req)) });
  if (pathname.match(/^\/api\/graphs\/[^/]+\/nodes\/[^/]+$/) && method === 'GET') { const match = pathname.match(/^\/api\/graphs\/([^/]+)\/nodes\/([^/]+)$/); return ok(res, { node: await nodeDetail(decodeURIComponent(match[1]), decodeURIComponent(match[2])) }); }
  if (pathname.match(/^\/api\/graphs\/[^/]+\/preview$/) && method === 'GET') return ok(res, { graph: await getGraph(gid(pathname)) });

  if (pathname.match(/^\/api\/workspaces\/[^/]+\/conversations$/) && method === 'POST') { const input = await body(req); const task = await createTask(wid(pathname), null, input.prompt || input.title || '新建编码任务'); return created(res, { conversationId: task.conversationId, task }); }
  if (pathname === '/api/tasks' && method === 'POST') { const input = await body(req); const task = await createTask(input.workspaceId, null, input.prompt || input.message); const options = { autoApply: input.autoApply !== false }; Promise.resolve().then(() => startTask(task.id, options)).catch(() => {}); return created(res, { task: await taskView(task) }); }
  if (pathname.match(/^\/api\/conversations\/[^/]+\/messages$/) && method === 'GET') { const conversationId = decodeURIComponent(pathname.match(/^\/api\/conversations\/([^/]+)/)?.[1] || ''); return ok(res, { messages: await appendMessage(conversationId) }); }
  if (pathname.match(/^\/api\/conversations\/[^/]+\/messages$/) && method === 'POST') { const conversationId = decodeURIComponent(pathname.match(/^\/api\/conversations\/([^/]+)/)?.[1] || ''); const input = await body(req); const task = await createTask(input.workspaceId, conversationId, input.content || input.prompt); const options = { autoApply: input.autoApply !== false }; Promise.resolve().then(() => startTask(task.id, options)).catch(() => {}); return created(res, { task: await taskView(task) }); }
  if (pathname.match(/^\/api\/tasks\/[^/]+$/) && method === 'GET') return ok(res, { task: await taskView(await getTask(tid(pathname))) });
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/tasks$/) && method === 'GET') return ok(res, { tasks: await listTasks(wid(pathname)) });
  if (pathname.match(/^\/api\/tasks\/[^/]+\/steps$/) && method === 'GET') return ok(res, { steps: await listTaskSteps(tid(pathname)) });
  if (pathname.match(/^\/api\/tasks\/[^/]+\/events$/) && method === 'GET') { const task = await getTask(tid(pathname)); return sse(req, res, task?.workspaceId || '', Number(url.searchParams.get('after') || 0), tid(pathname)); }
  if (pathname.match(/^\/api\/tasks\/[^/]+\/start$/) && method === 'POST') { const taskId = tid(pathname); const options = await body(req); const task = await getTask(taskId); Promise.resolve().then(() => startTask(taskId, options || {})).catch(() => {}); return ok(res, { task: await taskView(task) }); }
  if (pathname.match(/^\/api\/tasks\/[^/]+\/cancel$/) && method === 'POST') return ok(res, { task: await cancelTask(tid(pathname)) });
  if (pathname.match(/^\/api\/tasks\/[^/]+\/rollback$/) && method === 'POST') return ok(res, { task: await rollbackTask(tid(pathname)) });
  if (pathname.match(/^\/api\/tasks\/[^/]+\/patches$/) && method === 'GET') return ok(res, { patches: await listTaskPatches(tid(pathname)) });
  if (pathname.match(/^\/api\/patches\/[^/]+$/) && method === 'GET') return ok(res, { patch: await getPatch(decodeURIComponent(pathname.match(/^\/api\/patches\/([^/]+)$/)?.[1] || '')) });

  if (pathname.match(/^\/api\/workspaces\/[^/]+\/deployments$/) && method === 'GET') return ok(res, { deployments: listDeployments(wid(pathname)) });
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/deployments$/) && method === 'POST') { const workspaceId = wid(pathname); const deployment = saveDeployment(workspaceId, await body(req)); await refreshDeploymentGraphs(workspaceId); return created(res, { deployment }); }
  if (pathname.match(/^\/api\/workspaces\/[^/]+\/deployments\/discover$/) && method === 'POST') { const workspaceId = wid(pathname); const deployments = await discoverDeployments(workspaceId); await refreshDeploymentGraphs(workspaceId); return ok(res, { deployments }); }
  if (pathname === '/api/deployments' && method === 'GET') return ok(res, { deployments: listDeployments(url.searchParams.get('workspaceId') || '') });
  if (pathname === '/api/deployments/discover' && method === 'POST') { const workspaceId = (await body(req)).workspaceId || ''; const deployments = await discoverDeployments(workspaceId); await refreshDeploymentGraphs(workspaceId); return ok(res, { deployments }); }
  if (pathname.match(/^\/api\/deployments\/[^/]+$/)) { const deploymentId = did(pathname); if (method === 'PATCH') { const deployment = saveDeployment('', await body(req), deploymentId); await refreshDeploymentGraphs(deployment.workspaceId); return ok(res, { deployment }); } if (method === 'DELETE') { deleteDeployment(deploymentId); await refreshDeploymentGraphs(url.searchParams.get('workspaceId') || ''); return ok(res, { ok: true }); } }
  throw Object.assign(new Error('Not found'), { statusCode: 404 });
}

const server = createServer((req, res) => handle(req, res).catch((error) => errorResponse(res, error)));
server.listen(PORT, '127.0.0.1', () => console.log(`MergeGraph workspace server listening at http://127.0.0.1:${PORT}`));
process.on('SIGINT', () => { for (const workspace of listWorkspaces()) stopWorkspaceWatcher(workspace.id); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { for (const workspace of listWorkspaces()) stopWorkspaceWatcher(workspace.id); server.close(() => process.exit(0)); });
