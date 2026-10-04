import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { store, id, now, emit, dataPath } from './core.mjs';
import { getWorkspace, getFiles } from './workspace-service.mjs';
import { listDeployments, discoverDeployments } from './deployment-service.mjs';
import { renderWithArchify, GRAPH_TO_ARCHIFY, isGraphType } from './archify-bridge.mjs';

export const GRAPH_TYPES = Object.freeze(Object.keys(GRAPH_TO_ARCHIFY));
const GRAPH_ENTITY = 'graphs';
const GRAPH_HEAD_ENTITY = 'graph_heads';
const FILE_EVENT_ENTITIES = ['file_change_events', 'file_events'];

function list(type, predicate) {
  const result = store.list(type, predicate);
  return Array.isArray(result) ? result : [];
}

function safeId(value, fallback = 'node') {
  const raw = String(value ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return (/^[a-zA-Z]/.test(raw) ? raw : `${fallback}_${raw}`).slice(0, 120) || `${fallback}_node`;
}

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function relativePath(workspace, value) {
  const text = normalizePath(value);
  if (!path.isAbsolute(String(value ?? ''))) return text;
  return normalizePath(path.relative(workspace.rootPath, String(value)));
}

function fileNodeId(filePath) {
  const digest = createHash('sha1').update(normalizePath(filePath)).digest('hex').slice(0, 12);
  return `file_${digest}`;
}

function languageType(file) {
  const p = String(file?.path || '').toLowerCase();
  if (/\.(vue|jsx?|tsx?|css|scss|html?)$/.test(p)) return 'frontend';
  if (/\.(sql|db|sqlite)$/.test(p)) return 'database';
  if (/\.(ya?ml|json|toml|ini)$/.test(p) || /(^|\/)(docker|deploy|infra|terraform)(\/|$)/.test(p)) return 'cloud';
  if (/\.(py|go|rs|java|kt|rb|php|cs|c|cpp|h)$/.test(p)) return 'backend';
  return 'external';
}

function eventFiles(workspaceId) {
  return FILE_EVENT_ENTITIES.flatMap((type) => list(type, (event) => event?.workspaceId === workspaceId));
}

function latestFileStates(workspaceId) {
  const result = new Map();
  for (const event of eventFiles(workspaceId).sort((a, b) => String(a?.createdAt || a?.updatedAt || '').localeCompare(String(b?.createdAt || b?.updatedAt || '')))) {
    const p = normalizePath(event.path || event.filePath);
    if (!p) continue;
    result.set(p, event);
  }
  return result;
}

function evidenceFor(file, workspace) {
  const p = relativePath(workspace, file.path);
  return [{ path: p || normalizePath(file.path), summary: '文件扫描证据', confidence: 'confirmed' }];
}

function fileNodes(workspace, files, workspaceId) {
  const states = latestFileStates(workspaceId);
  return files.filter((file) => file?.kind !== 'directory').map((file, index) => {
    const filePath = relativePath(workspace, file.path);
    const event = states.get(normalizePath(filePath)) || states.get(normalizePath(file.path));
    const state = event?.state || (event?.operation === 'delete' ? 'failed' : 'normal');
    return {
      id: fileNodeId(filePath),
      label: filePath || path.basename(String(file.path)),
      path: filePath,
      type: languageType(file),
      summary: '扫描发现的文件，职责待确认。',
      evidence: evidenceFor(file, workspace),
      x: 80 + (index % 4) * 220,
      y: 80 + Math.floor(index / 4) * 130,
      width: 180,
      height: 82,
      state,
      ...(event?.taskId ? { activeTaskId: event.taskId } : {}),
      ...(event?.stepId ? { activeStepId: event.stepId } : {}),
    };
  });
}

function importTargets(file, files) {
  const content = typeof file?.content === 'string' ? file.content : '';
  if (!content) return [];
  const source = normalizePath(file.path);
  const sourceDir = path.posix.dirname(source);
  const candidates = new Set();
  const patterns = [
    /(?:from|import)\s*[('\"]([^'\")]+)['\"]/g,
    /require\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
    /(?:include|include_once|require_once)\s*[('" ]([^'" )]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content))) {
      const target = match[1];
      if (!target || (!target.startsWith('.') && !target.startsWith('/'))) continue;
      const base = normalizePath(path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(sourceDir, target)));
      candidates.add(base);
      for (const ext of ['.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.json']) candidates.add(`${base}${ext}`);
      candidates.add(`${base}/index.js`);
      candidates.add(`${base}/index.ts`);
    }
  }
  const known = new Set(files.map((entry) => normalizePath(entry.path)));
  return [...candidates].filter((candidate) => known.has(candidate));
}

function evidenceEdges(files, nodes) {
  const byPath = new Map(nodes.map((node) => [normalizePath(node.path), node]));
  const edges = [];
  for (const file of files) {
    const sourcePath = normalizePath(file.path);
    const source = byPath.get(sourcePath);
    if (!source) continue;
    for (const targetPath of importTargets(file, files)) {
      const target = byPath.get(normalizePath(targetPath));
      if (!target || target.id === source.id) continue;
      const edgeId = safeId(`edge_${source.id}_${target.id}`, 'edge');
      if (edges.some((entry) => entry.id === edgeId)) continue;
      edges.push({ id: edgeId, source: source.id, target: target.id, label: '显式导入/引用' });
    }
  }
  return edges;
}

function graphSkeleton(workspaceId, type, version, nodes, edges, status = 'ready') {
  return {
    id: id('graph'),
    workspaceId,
    type,
    version,
    status,
    nodes,
    edges,
    createdAt: now(),
  };
}

function currentHead(workspaceId, type) {
  return list(GRAPH_HEAD_ENTITY, (head) => head.workspaceId === workspaceId && head.type === type)[0] || null;
}

function resolveGraph(graphId) {
  const direct = store.get(GRAPH_ENTITY, graphId);
  if (direct) return direct;
  const head = store.get(GRAPH_HEAD_ENTITY, graphId);
  return head?.currentId ? store.get(GRAPH_ENTITY, head.currentId) : null;
}

function saveHead(workspaceId, type, graph, previous, { lastGood = false } = {}) {
  const existing = currentHead(workspaceId, type);
  const head = {
    id: existing?.id || id('graph_head'),
    workspaceId,
    type,
    currentId: graph.id,
    lastGoodId: lastGood ? graph.id : (existing?.lastGoodId || previous?.lastGoodId || null),
    updatedAt: now(),
  };
  store.put(GRAPH_HEAD_ENTITY, head);
  return head;
}

function graphVersion(workspaceId, type) {
  const entries = list(GRAPH_ENTITY, (graph) => graph.workspaceId === workspaceId && graph.type === type);
  return entries.reduce((max, graph) => Math.max(max, Number(graph.version) || 0), 0) + 1;
}

function deploymentNodes(workspaceId) {
  return listDeployments(workspaceId).map((resource, index) => {
    const resourceId = safeId(resource.id || `deployment_${index + 1}`, 'deployment');
    const sourceFiles = Array.isArray(resource.relatedFiles) ? resource.relatedFiles : [];
    return {
      id: resourceId,
      label: resource.domain || resource.url || `部署资源 ${index + 1}`,
      path: sourceFiles[0] || resource.domain || resource.url || '',
      type: resource.provider ? 'cloud' : 'external',
      summary: resource.verificationStatus === 'verified' ? '已标记验证的部署资源。' : '来源于配置或用户输入，待核实。',
      evidence: sourceFiles.length ? sourceFiles.slice(0, 3).map((p) => ({ path: normalizePath(p), summary: '部署配置来源', confidence: resource.source === 'user' ? 'confirmed' : 'inferred' })) : [{ path: normalizePath(resource.domain || resource.url), summary: resource.source === 'user' ? '用户录入' : '部署资源记录', confidence: resource.source === 'user' ? 'confirmed' : 'inferred' }],
      x: 80 + (index % 4) * 220,
      y: 80 + Math.floor(index / 4) * 130,
      width: 220,
      height: 90,
      state: resource.verificationStatus === 'verified' ? 'verified' : 'normal',
      ...(resource.serviceNodeId ? { serviceNodeId: resource.serviceNodeId } : {}),
    };
  });
}

function buildGraph(workspace, type, files, version) {
  let nodes;
  let edges = [];
  if (type === 'deployment_ownership') {
    try { discoverDeployments(workspace.id); } catch { /* discovery remains optional when a config is unreadable */ }
    const resources = deploymentNodes(workspace.id);
    const resourceFiles = new Set(resources.flatMap((resource) => resource.evidence?.map((entry) => normalizePath(entry.path)) || []));
    const services = fileNodes(workspace, files, workspace.id)
      .filter((node) => resourceFiles.has(normalizePath(node.path)))
      .map((node, index) => ({ ...node, x: 360 + (index % 4) * 220, y: 80 + Math.floor(index / 4) * 130, summary: '部署资源关联的配置或服务文件。' }));
    nodes = [...resources, ...services];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const byPath = new Map(services.map((node) => [normalizePath(node.path), node]));
    for (const node of resources) {
      let target = node.serviceNodeId && byId.get(node.serviceNodeId);
      if (!target) target = byPath.get(normalizePath(node.path));
      if (target && target.id !== node.id) {
        edges.push({ id: safeId(`edge_${node.id}_${target.id}`, 'edge'), source: node.id, target: target.id, label: '配置关联（来源记录）', confidence: 'inferred' });
      }
    }
  } else if (type === 'agent_relation') {
    const agentFiles = files.filter((file) => path.basename(String(file.path)).toLowerCase() === 'agents.md');
    nodes = fileNodes(workspace, agentFiles, workspace.id);
    // A rule file is evidence of an instruction scope. It is not evidence of a
    // runtime call, so this graph intentionally has no inferred edges.
  } else {
    nodes = fileNodes(workspace, files, workspace.id);
    edges = evidenceEdges(files, nodes);
  }
  return graphSkeleton(workspace.id, type, version, nodes, edges);
}

export function listGraphs(workspaceId, requestedType = '') {
  const types = requestedType ? [requestedType] : GRAPH_TYPES;
  return types.map((type) => {
    const head = currentHead(workspaceId, type);
    return head?.currentId ? store.get(GRAPH_ENTITY, head.currentId) : null;
  }).filter(Boolean);
}

export function getGraph(graphId) {
  return resolveGraph(graphId);
}

export async function generateGraphs(workspaceId, { type, graphType, taskId } = {}) {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error(`工作区不存在: ${workspaceId}`);
  const files = getFiles(workspaceId);
  const requestedType = type || graphType;
  const types = requestedType ? [requestedType] : GRAPH_TYPES;
  if (types.some((entry) => !isGraphType(entry))) throw new Error(`不支持的图谱类型: ${types.find((entry) => !isGraphType(entry))}`);
  const results = [];
  for (const graphType of types) {
    const previousHead = currentHead(workspaceId, graphType);
    const previous = previousHead?.currentId ? store.get(GRAPH_ENTITY, previousHead.currentId) : null;
    const version = graphVersion(workspaceId, graphType);
    let graph = buildGraph(workspace, graphType, files, version);
    if (taskId) graph.taskId = taskId;
    try {
      if (!graph.nodes.length) {
        graph.status = 'empty';
        graph.receipt = { status: 'empty', reason: '没有可确认的图谱节点', generatedAt: now() };
      } else {
        const artifactRoot = dataPath('graphs', safeId(workspaceId, 'workspace'), graphType);
        const receipt = await renderWithArchify(graph, { outputDir: artifactRoot, stem: `graph-v${version}` });
        graph.receipt = receipt;
        if (receipt.ok) {
          graph.artifactPath = receipt.artifactPath;
          graph.status = 'ready';
        } else if (receipt.status === 'skipped') {
          graph.status = 'ready';
        } else {
          graph.status = 'failed';
          graph.error = receipt.stderr || 'Archify 图谱生成失败';
          graph.lastGoodId = previousHead?.lastGoodId || null;
        }
      }
    } catch (error) {
      graph.status = 'failed';
      graph.error = String(error?.message || error);
      graph.lastGoodId = previousHead?.lastGoodId || null;
      graph.receipt = { status: 'failed', error: graph.error, generatedAt: now() };
    }
    store.put(GRAPH_ENTITY, graph);
    saveHead(workspaceId, graphType, graph, previous, { lastGood: graph.status === 'ready' || graph.status === 'empty' });
    emit(workspaceId, 'GraphUpdated', { graphId: graph.id, type: graphType, status: graph.status, version: graph.version, taskId: taskId || null });
    results.push(graph);
  }
  return requestedType ? results[0] : results;
}

export function saveLayout(graphId, { nodes = [], viewport } = {}) {
  const graph = resolveGraph(graphId);
  if (!graph) throw new Error(`图谱不存在: ${graphId}`);
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  graph.nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).map((node) => {
    const layout = byId.get(node.id);
    if (!layout) return node;
    return {
      ...node,
      ...(Number.isFinite(layout.x ?? layout.position?.x) ? { x: Number(layout.x ?? layout.position.x) } : {}),
      ...(Number.isFinite(layout.y ?? layout.position?.y) ? { y: Number(layout.y ?? layout.position.y) } : {}),
      ...(Number.isFinite(layout.width ?? layout.size?.width) ? { width: Number(layout.width ?? layout.size.width) } : {}),
      ...(Number.isFinite(layout.height ?? layout.size?.height) ? { height: Number(layout.height ?? layout.size.height) } : {}),
      ...(typeof layout.collapsed === 'boolean' ? { collapsed: layout.collapsed } : {}),
    };
  });
  if (viewport && typeof viewport === 'object') graph.viewport = { ...viewport };
  graph.updatedAt = now();
  store.put(GRAPH_ENTITY, graph);
  emit(graph.workspaceId, 'GraphLayoutSaved', { graphId: graph.id, type: graph.type, version: graph.version });
  return graph;
}

export function nodeDetail(graphId, nodeId) {
  const graph = resolveGraph(graphId);
  if (!graph) return null;
  const node = (graph.nodes || []).find((entry) => entry.id === nodeId);
  if (!node) return null;
  const edges = (graph.edges || []).filter((edge) => edge.source === nodeId || edge.target === nodeId);
  const changes = eventFiles(graph.workspaceId).filter((event) => {
    const changed = normalizePath(event.path || event.filePath);
    const bound = normalizePath(node.path);
    return changed === bound || changed.endsWith(`/${bound}`);
  }).slice(-20);
  return { graphId: graph.id, graphType: graph.type, node, edges, changes, taskId: node.activeTaskId || null, stepId: node.activeStepId || null };
}

export function restoreGraph(graphId) {
  const graph = resolveGraph(graphId);
  if (!graph) throw new Error(`图谱不存在: ${graphId}`);
  const head = currentHead(graph.workspaceId, graph.type);
  const lastGoodId = graph.lastGoodId || head?.lastGoodId;
  if (!lastGoodId) return graph;
  const restored = store.get(GRAPH_ENTITY, lastGoodId);
  if (!restored) return graph;
  saveHead(graph.workspaceId, graph.type, restored, restored, { lastGood: true });
  emit(graph.workspaceId, 'GraphRestored', { graphId: restored.id, restoredFrom: graph.id, type: graph.type });
  return restored;
}

export function updateNodeStates(workspaceId, paths, state, taskId, stepId) {
  const targets = new Set((Array.isArray(paths) ? paths : [paths]).filter(Boolean).map(normalizePath));
  const changed = [];
  for (const graph of listGraphs(workspaceId)) {
    let touched = false;
    graph.nodes = (graph.nodes || []).map((node) => {
      const nodePath = normalizePath(node.path);
      const match = [...targets].some((target) => nodePath === target || nodePath.endsWith(`/${target}`) || target.endsWith(`/${nodePath}`));
      if (!match) return node;
      touched = true;
      return { ...node, state, ...(taskId ? { activeTaskId: taskId } : {}), ...(stepId ? { activeStepId: stepId } : {}), updatedAt: now() };
    });
    if (touched) {
      graph.updatedAt = now();
      store.put(GRAPH_ENTITY, graph);
      changed.push(graph);
    }
  }
  if (changed.length) emit(workspaceId, 'GraphNodeStatesUpdated', { paths: [...targets], state, taskId: taskId || null, stepId: stepId || null, graphIds: changed.map((graph) => graph.id) });
  return changed;
}
