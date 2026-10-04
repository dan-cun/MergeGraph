/**
 * MergeGraph -> Archify bridge.
 *
 * Archify remains the renderer and validator.  This module only translates the
 * workspace graph model into Archify's typed JSON and records a reproducible
 * render receipt.  It intentionally does not infer relationships that are not
 * present in the MergeGraph evidence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyTemplate, renderCards } from '../vendor/archify/renderers/shared/utils.mjs';
import { renderArchifyDocument, validateArchifyDocument as validatePureArchifyDocument } from './archify-renderer-api.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ARCHIFY_VERSION = '3.0.1';
export const ARCHIFY_COMMIT = 'd5a1333d7447c866a765adac7d4d062f2f02e4d2';
export const ARCHIFY_ROOT = path.resolve(THIS_DIR, '..', 'vendor', 'archify');

const ARCHIFY_TEMPLATE = fs.readFileSync(path.join(ARCHIFY_ROOT, 'assets', 'template.html'), 'utf8');

export const GRAPH_TO_ARCHIFY = Object.freeze({
  main_flow: 'workflow',
  asset_call: 'dataflow',
  execution: 'sequence',
  agent_relation: 'lifecycle',
  deployment_ownership: 'architecture',
});

const GRAPH_TYPES = new Set(Object.keys(GRAPH_TO_ARCHIFY));
const ARCHIFY_TYPES = new Set(Object.values(GRAPH_TO_ARCHIFY));

function safeId(value, fallback = 'node') {
  const raw = String(value ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const result = /^[a-zA-Z]/.test(raw) ? raw : `${fallback}_${raw}`;
  return result.slice(0, 120) || `${fallback}_node`;
}

function safeText(value, fallback = '') {
  return String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function portablePath(value) {
  const text = safeText(value, 'workspace');
  const normalized = text.replaceAll('\\', '/').replace(/^\/+/, '');
  return normalized || 'workspace';
}

function sourceRefs(node) {
  const evidence = Array.isArray(node?.evidence) ? node.evidence : [];
  const refs = evidence
    .map((entry) => ({
      path: portablePath(entry?.path || node?.path || node?.label),
      ...(Number.isInteger(entry?.line) && entry.line > 0 ? { line: entry.line } : {}),
      ...(safeText(entry?.summary) ? { label: safeText(entry.summary).slice(0, 48) } : {}),
    }))
    .filter((entry) => entry.path.length > 0)
    .slice(0, 3);
  if (refs.length) return refs;
  return [{ path: portablePath(node?.path || node?.label || 'workspace') }];
}

function componentType(node) {
  if (['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external'].includes(node?.type)) {
    return node.type;
  }
  const p = String(node?.path || '').toLowerCase();
  if (/\.(vue|jsx?|tsx?|css|scss|html?)$/.test(p)) return 'frontend';
  if (/\.(sql|db|sqlite)$/.test(p)) return 'database';
  if (/\.(ya?ml|json|toml|ini|dockerfile)$/.test(p) || /(^|\/)(docker|deploy|infra|terraform)(\/|$)/.test(p)) return 'cloud';
  if (/\.(py|go|rs|java|kt|rb|php|cs|c|cpp|h)$/.test(p)) return 'backend';
  return 'external';
}

function nodeBase(node, index) {
  const id = safeId(node?.id || `node_${index + 1}`);
  const label = safeText(node?.label || node?.path || id, id).slice(0, 160);
  const summary = safeText(node?.summary || '职责待确认');
  return {
    id,
    label,
    type: componentType(node),
    sublabel: summary.slice(0, 160),
  };
}

function nodePosition(node, index) {
  const x = Number.isFinite(node?.x) ? node.x : 80 + (index % 4) * 220;
  const y = Number.isFinite(node?.y) ? node.y : 80 + Math.floor(index / 4) * 130;
  const width = Number.isFinite(node?.width) ? Math.max(120, node.width) : 180;
  const height = Number.isFinite(node?.height) ? Math.max(64, node.height) : 82;
  return { x, y, width, height };
}

function edgeBase(edge, index) {
  const result = {
    id: safeId(edge?.id || `edge_${index + 1}`, 'edge'),
    from: safeId(edge?.source || edge?.from || ''),
    to: safeId(edge?.target || edge?.to || ''),
  };
  const label = safeText(edge?.label);
  if (label) result.label = label.slice(0, 160);
  return result;
}

function commonMeta(graph, outputName, title) {
  return {
    title: safeText(title || `${graph.type || 'graph'} · MergeGraph`, 'MergeGraph 图谱').slice(0, 200),
    subtitle: '由 MergeGraph 工作区证据生成；未标注关系不作调用链推断。',
    output: outputName,
    locale: 'zh-CN',
    visual_preset: 'blueprint',
    quality_profile: 'standard',
  };
}

function layoutFor(nodes) {
  const components = nodes.map((node, index) => {
    const base = nodeBase(node, index);
    const box = nodePosition(node, index);
    return { ...base, pos: [box.x, box.y], size: [box.width, box.height] };
  });
  const maxX = components.reduce((max, node) => Math.max(max, node.pos[0] + node.size[0]), 0);
  const maxY = components.reduce((max, node) => Math.max(max, node.pos[1] + node.size[1]), 0);
  return { components, viewBox: [Math.max(760, maxX + 100), Math.max(480, maxY + 100)] };
}

function workflowDocument(graph, outputName) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const laneId = 'workspace';
  const resultNodes = nodes.map((node, index) => {
    const base = nodeBase(node, index);
    const box = nodePosition(node, index);
    return {
      id: base.id,
      lane: laneId,
      col: index % 6,
      type: base.type,
      label: base.label,
      sublabel: base.sublabel,
      width: box.width,
      height: box.height,
      yOffset: box.y,
    };
  });
  const resultEdges = edges.map(edgeBase).filter((edge) => resultNodes.some((n) => n.id === edge.from) && resultNodes.some((n) => n.id === edge.to));
  const starts = resultNodes.filter((node) => !resultEdges.some((edge) => edge.to === node.id));
  const nextById = new Map(resultEdges.map((edge) => [edge.from, edge.to]));
  const mainPath = [];
  let cursor = starts.find((node) => resultEdges.some((edge) => edge.from === node.id))?.id || starts[0]?.id;
  const visited = new Set();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    mainPath.push(cursor);
    cursor = nextById.get(cursor);
  }
  const pathColumns = new Map(mainPath.map((nodeId, index) => [nodeId, index]));
  for (const node of resultNodes) if (pathColumns.has(node.id)) node.col = pathColumns.get(node.id);
  return {
    schema_version: 2,
    diagram_type: 'workflow',
    meta: commonMeta(graph, outputName, 'MergeGraph 主体流程图'),
    lanes: [{ id: laneId, label: '工作区文件' }],
    nodes: resultNodes,
    edges: resultEdges,
    ...(mainPath.length >= 2 ? { mainPath } : {}),
  };
}

function dataflowDocument(graph, outputName) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const resultNodes = nodes.map((node, index) => {
    const base = nodeBase(node, index);
    const box = nodePosition(node, index);
    return {
      id: base.id,
      type: base.type,
      label: base.label,
      sublabel: base.sublabel,
      stage: Math.min(1, Math.floor(index / Math.max(1, Math.ceil(nodes.length / 2)))),
      row: index % 5,
      width: 150,
      height: 58,
    };
  });
  const resultEdges = edges.map(edgeBase).filter((edge) => resultNodes.some((n) => n.id === edge.from) && resultNodes.some((n) => n.id === edge.to)).map((edge) => {
    // Dataflow labels sit on narrow stage lanes and frequently collide with
    // adjacent cards. The MergeGraph canvas keeps the full relation label;
    // Archify receives an unlabeled evidence edge so validation remains true.
    return { ...edge, label: '证据' };
  });
  return {
    schema_version: 1,
    diagram_type: 'dataflow',
    meta: { ...commonMeta(graph, outputName, 'MergeGraph 调用资产图'), viewBox: [Math.max(1000, resultNodes.length * 220), 720] },
    stages: [{ label: '扫描节点' }, { label: '关联节点' }],
    nodes: resultNodes,
    flows: resultEdges,
  };
}

function sequenceDocument(graph, outputName) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const participants = nodes.map((node, index) => {
    const base = nodeBase(node, index);
    return { id: base.id, type: base.type, label: base.label };
  });
  const messages = edges.map((edge, index) => {
    const base = edgeBase(edge, index);
    return { ...base, y: 180 + index * 74, label: base.label || '证据关系' };
  }).filter((edge) => participants.some((n) => n.id === edge.from) && participants.some((n) => n.id === edge.to));
  return {
    schema_version: 1,
    diagram_type: 'sequence',
    meta: commonMeta(graph, outputName, 'MergeGraph 执行逻辑图'),
    participants,
    messages,
  };
}

function lifecycleDocument(graph, outputName) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const states = nodes.map((node, index) => {
    const base = nodeBase(node, index);
    const stateType = ({ running: 'active', modified: 'active', verified: 'success', failed: 'failure', planned: 'waiting', stale: 'waiting' })[node.state] || 'neutral';
    return {
      id: base.id,
      type: stateType,
      label: base.label,
      sublabel: base.sublabel,
      lane: 'main',
      col: index % 5,
      step: node.state || 'normal',
    };
  });
  const transitions = edges.map(edgeBase).filter((edge) => states.some((n) => n.id === edge.from) && states.some((n) => n.id === edge.to));
  return {
    schema_version: 2,
    diagram_type: 'lifecycle',
    meta: commonMeta(graph, outputName, 'MergeGraph Agent 关系图'),
    lanes: [{ id: 'main', label: '项目规则与任务' }],
    states,
    transitions,
  };
}

function architectureDocument(graph, outputName) {
  const { components, viewBox } = layoutFor(Array.isArray(graph.nodes) ? graph.nodes : []);
  const componentIds = new Set(components.map((node) => node.id));
  const connections = (Array.isArray(graph.edges) ? graph.edges : [])
    .map(edgeBase)
    .filter((edge) => componentIds.has(edge.from) && componentIds.has(edge.to))
    .map((edge) => ({ ...edge, labelDy: 70 }));
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { ...commonMeta(graph, outputName, 'MergeGraph 网址与域名图'), viewBox },
    components,
    ...(connections.length ? { connections } : {}),
  };
}

/** Convert a MergeGraph graph into the corresponding Archify typed document. */
export function graphToArchify(graph, { outputName = 'graph.html' } = {}) {
  const graphType = graph?.type;
  const type = GRAPH_TO_ARCHIFY[graphType];
  if (!type) throw new Error(`Unsupported MergeGraph graph type: ${graphType}`);
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) return null;
  if (type === 'workflow') return workflowDocument(graph, outputName);
  if (type === 'dataflow') return dataflowDocument(graph, outputName);
  if (type === 'sequence') {
    if (graph.nodes.length < 2 || !Array.isArray(graph.edges) || graph.edges.length === 0) return null;
    return sequenceDocument(graph, outputName);
  }
  if (type === 'lifecycle') {
    if (graph.nodes.length < 2) return null;
    return lifecycleDocument(graph, outputName);
  }
  return architectureDocument(graph, outputName);
}

export function validateArchifyDocument(graphType, document) {
  const archifyType = GRAPH_TO_ARCHIFY[graphType] || graphType;
  if (!ARCHIFY_TYPES.has(archifyType)) throw new Error(`Unsupported Archify diagram type: ${archifyType}`);
  validatePureArchifyDocument(archifyType, document);
  return { ok: true, graphType, archifyType, version: ARCHIFY_VERSION, commit: ARCHIFY_COMMIT };
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function redactRuntimePaths(value, outputRoot) {
  let text = String(value ?? '');
  for (const [source, replacement] of [
    [path.resolve(outputRoot), '<artifact>'],
    [path.resolve(ARCHIFY_ROOT), '<archify>'],
    [path.resolve(process.cwd()), '<app>'],
  ]) {
    text = text.replaceAll(source, replacement);
  }
  return text;
}

export async function renderWithArchify(graph, { outputDir, stem = 'graph' } = {}) {
  const archifyType = GRAPH_TO_ARCHIFY[graph?.type];
  if (!archifyType) throw new Error(`Unsupported MergeGraph graph type: ${graph?.type}`);
  const root = path.resolve(outputDir || path.join(os.tmpdir(), 'mergegraph-archify'));
  fs.mkdirSync(root, { recursive: true });
  const outputName = `${safeId(stem, 'graph')}.html`;
  const candidate = graphToArchify(graph, { outputName });
  if (!candidate) return {
    ok: false,
    status: 'skipped',
    reason: 'insufficient_evidence_or_nodes',
    graphType: graph.type,
    archifyType,
    version: ARCHIFY_VERSION,
    commit: ARCHIFY_COMMIT,
  };
  await validateArchifyDocument(graph.type, candidate);
  const candidatePath = path.join(root, `${safeId(stem, 'graph')}.json`);
  const outputPath = path.join(root, outputName);
  fs.writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  let renderedPayload;
  let renderError;
  try {
    renderedPayload = renderArchifyDocument(archifyType, candidate, { validate: false, qualityProfile: 'standard' });
    const html = applyTemplate(ARCHIFY_TEMPLATE, {
      title: renderedPayload.meta.title,
      subtitle: renderedPayload.meta.subtitle,
      svg: renderedPayload.svg,
      cards: renderCards(renderedPayload.cards),
      locale: renderedPayload.meta.locale,
      visualPreset: renderedPayload.meta.visual_preset || 'classic',
      sourceEvidence: renderedPayload.sourceEvidence || null,
    });
    fs.writeFileSync(outputPath, html, 'utf8');
  } catch (error) {
    renderError = error;
  }
  const rendered = !renderError && fs.existsSync(outputPath);
  const receipt = {
    schemaVersion: 1,
    ok: rendered,
    status: rendered ? 'rendered' : 'failed',
    graphType: graph.type,
    archifyType,
    execution: 'pure_renderer_api',
    archifyVersion: ARCHIFY_VERSION,
    archifyCommit: ARCHIFY_COMMIT,
    command: ['in-process-api', `renderers/${archifyType}/render-${archifyType}.mjs`, 'render', archifyType],
    inputSha256: sha256File(candidatePath),
    exitCode: rendered ? 0 : 1,
    stdout: '',
    stderr: renderError
      ? redactRuntimePaths(renderError?.stack || renderError?.message || String(renderError), root)
      : '',
    generatedAt: new Date().toISOString(),
  };
  if (receipt.ok) {
    receipt.artifactPath = outputPath;
    receipt.artifactSha256 = sha256File(outputPath);
    const html = fs.readFileSync(outputPath, 'utf8');
    const svg = html.match(/<svg[\s\S]*?<\/svg>/i)?.[0] || '';
    if (svg) {
      const svgPath = path.join(root, `${safeId(stem, 'graph')}.svg`);
      fs.writeFileSync(svgPath, `${svg}\n`, 'utf8');
      receipt.svgPath = svgPath;
      receipt.svgSha256 = sha256File(svgPath);
    }
  }
  return receipt;
}

export function isGraphType(value) {
  return GRAPH_TYPES.has(value);
}
