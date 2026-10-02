/**
 * Pure ArchitectureDiagramIR helpers.
 *
 * This module deliberately has no filesystem, database, network, or model
 * dependencies. The server can use it at the boundary where an AI response
 * becomes a durable MergeGraph document, and again before invoking Archify.
 */

export const ARCHITECTURE_SCHEMA_VERSION = 'mergegraph.architecture.v1';
export const ARCHIFY_REPOSITORY_URL = 'https://github.com/tt-a1i/archify';

const NODE_KINDS = new Set(['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external']);
const EDGE_VARIANTS = new Set(['default', 'emphasis', 'security', 'dashed']);
const BOUNDARY_KINDS = new Set(['region', 'security-group']);
const QUALITY_PROFILES = new Set(['standard', 'showcase']);
const EVIDENCE_MODES = new Set(['web', 'local-only', 'working-tree']);
const PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const CARD_TONES = new Set(['cyan', 'emerald', 'violet', 'amber', 'rose', 'orange', 'slate']);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const SHA1_PATTERN = /^[a-f0-9]{40}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const REMOTE_PATTERN = /^(?:https?:\/\/|ssh:\/\/|git@)[^\s]+$/i;

const ARCHIFY_TYPES = new Set(['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathFor(parent, key) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return `${parent}.${key}`;
}

function add(errors, path, code, message, details = {}) {
  errors.push({ path, code, message, ...details });
}

function checkRecord(errors, value, path, allowed) {
  if (!isRecord(value)) {
    add(errors, path, 'type/object', 'must be an object');
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) add(errors, pathFor(path, key), 'property/unknown', `unknown property "${key}"`);
  }
  return true;
}

function checkString(errors, value, path, { required = false, minLength = 0, maxLength = Infinity, pattern, enumValues } = {}) {
  if (value === undefined || value === null) {
    if (required) add(errors, path, 'required', 'is required');
    return false;
  }
  if (typeof value !== 'string') {
    add(errors, path, 'type/string', 'must be a string');
    return false;
  }
  if (value.length < minLength) add(errors, path, 'string/min-length', `must contain at least ${minLength} character(s)`);
  if (value.length > maxLength) add(errors, path, 'string/max-length', `must contain at most ${maxLength} character(s)`);
  if (pattern && !pattern.test(value)) add(errors, path, 'string/pattern', 'has an invalid format');
  if (enumValues && !enumValues.has(value)) add(errors, path, 'enum', `must be one of ${[...enumValues].join(', ')}`);
  return true;
}

function checkNumber(errors, value, path, { required = false, positive = false } = {}) {
  if (value === undefined || value === null) {
    if (required) add(errors, path, 'required', 'is required');
    return false;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    add(errors, path, 'type/finite-number', 'must be a finite number');
    return false;
  }
  if (positive && value <= 0) add(errors, path, 'number/positive', 'must be greater than zero');
  return true;
}

function checkArray(errors, value, path, { required = false, minLength = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) add(errors, path, 'required', 'is required');
    return false;
  }
  if (!Array.isArray(value)) {
    add(errors, path, 'type/array', 'must be an array');
    return false;
  }
  if (value.length < minLength) add(errors, path, 'array/min-items', `must contain at least ${minLength} item(s)`);
  return true;
}

function checkId(errors, value, path, required = false) {
  return checkString(errors, value, path, { required, minLength: 1, maxLength: 80, pattern: ID_PATTERN });
}

function checkEvidenceRef(errors, value, path) {
  const allowed = new Set(['path', 'line', 'endLine', 'label', 'verification']);
  if (!checkRecord(errors, value, path, allowed)) return;
  checkString(errors, value.path, pathFor(path, 'path'), { required: true, minLength: 1, maxLength: 240 });
  if (typeof value.path === 'string' && (value.path.includes('\\') || value.path.startsWith('/') || value.path.split('/').includes('..'))) {
    add(errors, pathFor(path, 'path'), 'evidence/path', 'must be a repository-relative POSIX path');
  }
  if (value.line !== undefined) {
    if (!Number.isInteger(value.line) || value.line < 1) add(errors, pathFor(path, 'line'), 'evidence/line', 'must be a positive integer');
  }
  if (value.endLine !== undefined) {
    if (!Number.isInteger(value.endLine) || value.endLine < 1) add(errors, pathFor(path, 'endLine'), 'evidence/end-line', 'must be a positive integer');
    if (value.line === undefined) add(errors, pathFor(path, 'endLine'), 'evidence/line-required', 'requires line');
    else if (Number.isInteger(value.line) && value.endLine < value.line) add(errors, pathFor(path, 'endLine'), 'evidence/range', 'must be greater than or equal to line');
  }
  if (value.label !== undefined) checkString(errors, value.label, pathFor(path, 'label'), { minLength: 1, maxLength: 80 });
  if (value.verification !== undefined) checkString(errors, value.verification, pathFor(path, 'verification'), { enumValues: new Set(['commit', 'working-tree', 'unverified']) });
}

function checkEvidenceList(errors, value, path) {
  if (!checkArray(errors, value, path)) return;
  value.forEach((entry, index) => checkEvidenceRef(errors, entry, pathFor(path, index)));
}

function checkPosition(errors, value, path) {
  if (!checkRecord(errors, value, path, new Set(['x', 'y']))) return;
  checkNumber(errors, value.x, pathFor(path, 'x'), { required: true });
  checkNumber(errors, value.y, pathFor(path, 'y'), { required: true });
}

function checkSize(errors, value, path) {
  if (!checkRecord(errors, value, path, new Set(['width', 'height']))) return;
  checkNumber(errors, value.width, pathFor(path, 'width'), { required: true, positive: true });
  checkNumber(errors, value.height, pathFor(path, 'height'), { required: true, positive: true });
}

function checkRepository(errors, value, path) {
  const allowed = new Set(['remoteUrl', 'commitSha', 'evidenceMode', 'branch', 'dirty', 'workingTreeHash']);
  if (!checkRecord(errors, value, path, allowed)) return;
  checkString(errors, value.evidenceMode, pathFor(path, 'evidenceMode'), { required: true, enumValues: EVIDENCE_MODES });
  if (value.remoteUrl !== undefined) {
    checkString(errors, value.remoteUrl, pathFor(path, 'remoteUrl'), { minLength: 1, maxLength: 2048, pattern: REMOTE_PATTERN });
  }
  if (value.commitSha !== undefined) checkString(errors, value.commitSha, pathFor(path, 'commitSha'), { pattern: SHA1_PATTERN });
  if (value.branch !== undefined) checkString(errors, value.branch, pathFor(path, 'branch'), { minLength: 1, maxLength: 200 });
  if (value.dirty !== undefined && typeof value.dirty !== 'boolean') add(errors, pathFor(path, 'dirty'), 'type/boolean', 'must be a boolean');
  if (value.workingTreeHash !== undefined) checkString(errors, value.workingTreeHash, pathFor(path, 'workingTreeHash'), { pattern: SHA256_PATTERN });
  if (value.evidenceMode === 'web' && (!value.remoteUrl || !value.commitSha)) {
    add(errors, path, 'repository/web-requires-identity', 'web evidence requires remoteUrl and a full commitSha');
  }
}

function checkNode(errors, value, path) {
  const allowed = new Set(['id', 'kind', 'label', 'summary', 'tag', 'position', 'size', 'evidence']);
  if (!checkRecord(errors, value, path, allowed)) return;
  checkId(errors, value.id, pathFor(path, 'id'), true);
  checkString(errors, value.kind, pathFor(path, 'kind'), { required: true, enumValues: NODE_KINDS });
  checkString(errors, value.label, pathFor(path, 'label'), { required: true, minLength: 1, maxLength: 160 });
  if (value.summary !== undefined) checkString(errors, value.summary, pathFor(path, 'summary'), { maxLength: 240 });
  if (value.tag !== undefined) checkString(errors, value.tag, pathFor(path, 'tag'), { maxLength: 100 });
  if (value.position !== undefined) checkPosition(errors, value.position, pathFor(path, 'position'));
  if (value.size !== undefined) checkSize(errors, value.size, pathFor(path, 'size'));
  if (value.evidence !== undefined) checkEvidenceList(errors, value.evidence, pathFor(path, 'evidence'));
}

function checkEdge(errors, value, path) {
  const allowed = new Set(['id', 'source', 'target', 'label', 'variant', 'evidence']);
  if (!checkRecord(errors, value, path, allowed)) return;
  checkId(errors, value.id, pathFor(path, 'id'), true);
  checkId(errors, value.source, pathFor(path, 'source'), true);
  checkId(errors, value.target, pathFor(path, 'target'), true);
  if (value.label !== undefined) checkString(errors, value.label, pathFor(path, 'label'), { maxLength: 160 });
  if (value.variant !== undefined) checkString(errors, value.variant, pathFor(path, 'variant'), { enumValues: EDGE_VARIANTS });
  if (value.evidence !== undefined) checkEvidenceList(errors, value.evidence, pathFor(path, 'evidence'));
}

function checkBoundary(errors, value, path) {
  const allowed = new Set(['id', 'kind', 'label', 'nodeIds']);
  if (!checkRecord(errors, value, path, allowed)) return;
  checkId(errors, value.id, pathFor(path, 'id'), true);
  checkString(errors, value.kind, pathFor(path, 'kind'), { required: true, enumValues: BOUNDARY_KINDS });
  checkString(errors, value.label, pathFor(path, 'label'), { required: true, minLength: 1, maxLength: 180 });
  if (checkArray(errors, value.nodeIds, pathFor(path, 'nodeIds'), { required: true, minLength: 1 })) {
    value.nodeIds.forEach((id, index) => checkId(errors, id, pathFor(pathFor(path, 'nodeIds'), index), true));
  }
}

function checkCard(errors, value, path) {
  const allowed = new Set(['id', 'title', 'items', 'tone']);
  if (!checkRecord(errors, value, path, allowed)) return;
  checkId(errors, value.id, pathFor(path, 'id'), true);
  checkString(errors, value.title, pathFor(path, 'title'), { required: true, minLength: 1, maxLength: 160 });
  if (checkArray(errors, value.items, pathFor(path, 'items'), { required: true, minLength: 1 })) {
    value.items.forEach((item, index) => checkString(errors, item, pathFor(pathFor(path, 'items'), index), { required: true, minLength: 1, maxLength: 500 }));
  }
  if (value.tone !== undefined) checkString(errors, value.tone, pathFor(path, 'tone'), { enumValues: CARD_TONES });
}

function checkRecommendation(errors, value, path) {
  const allowed = new Set(['id', 'title', 'detail', 'priority', 'evidence']);
  if (!checkRecord(errors, value, path, allowed)) return;
  checkId(errors, value.id, pathFor(path, 'id'), true);
  checkString(errors, value.title, pathFor(path, 'title'), { required: true, minLength: 1, maxLength: 180 });
  checkString(errors, value.detail, pathFor(path, 'detail'), { required: true, minLength: 1, maxLength: 1200 });
  if (value.priority !== undefined) checkString(errors, value.priority, pathFor(path, 'priority'), { enumValues: PRIORITIES });
  if (value.evidence !== undefined) checkEvidenceList(errors, value.evidence, pathFor(path, 'evidence'));
}

function checkQuestion(errors, value, path) {
  const allowed = new Set(['id', 'detail', 'evidence']);
  if (!checkRecord(errors, value, path, allowed)) return;
  checkId(errors, value.id, pathFor(path, 'id'), true);
  checkString(errors, value.detail, pathFor(path, 'detail'), { required: true, minLength: 1, maxLength: 1200 });
  if (value.evidence !== undefined) checkEvidenceList(errors, value.evidence, pathFor(path, 'evidence'));
}

function checkUniqueIds(errors, values, path) {
  const seen = new Map();
  values.forEach((value, index) => {
    const id = value?.id;
    if (typeof id !== 'string') return;
    if (seen.has(id)) add(errors, pathFor(pathFor(path, index), 'id'), 'id/duplicate', `duplicates ${pathFor(path, seen.get(id))}.id`);
    else seen.set(id, index);
  });
}

function checkMeta(errors, value) {
  const path = '$.meta';
  const allowed = new Set(['title', 'subtitle', 'projectId', 'repoSnapshotId', 'qualityProfile', 'repository', 'generatedAt']);
  if (!checkRecord(errors, value, path, allowed)) return;
  checkString(errors, value.title, pathFor(path, 'title'), { required: true, minLength: 1, maxLength: 200 });
  if (value.subtitle !== undefined) checkString(errors, value.subtitle, pathFor(path, 'subtitle'), { maxLength: 400 });
  if (value.projectId !== undefined) checkString(errors, value.projectId, pathFor(path, 'projectId'), { minLength: 1, maxLength: 160 });
  if (value.repoSnapshotId !== undefined) checkString(errors, value.repoSnapshotId, pathFor(path, 'repoSnapshotId'), { minLength: 1, maxLength: 160 });
  if (value.qualityProfile !== undefined) checkString(errors, value.qualityProfile, pathFor(path, 'qualityProfile'), { enumValues: QUALITY_PROFILES });
  if (value.repository !== undefined) checkRepository(errors, value.repository, pathFor(path, 'repository'));
  if (value.generatedAt !== undefined) {
    checkString(errors, value.generatedAt, pathFor(path, 'generatedAt'));
    if (typeof value.generatedAt === 'string' && Number.isNaN(Date.parse(value.generatedAt))) add(errors, pathFor(path, 'generatedAt'), 'date-time', 'must be an ISO date-time');
  }
}

/**
 * Validate a MergeGraph ArchitectureDiagramIR without external packages.
 * The returned diagnostics are intentionally stable enough for a UI or an AI
 * repair step to display and act on.
 */
export function validateArchitectureDiagram(input) {
  const errors = [];
  if (!checkRecord(errors, input, '$', new Set(['schemaVersion', 'diagramType', 'meta', 'nodes', 'edges', 'boundaries', 'cards', 'recommendations', 'openQuestions', 'evidenceGaps']))) {
    return { ok: false, errors };
  }
  if (input.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) add(errors, '$.schemaVersion', 'schema/version', `must equal ${ARCHITECTURE_SCHEMA_VERSION}`);
  if (input.diagramType !== 'architecture') add(errors, '$.diagramType', 'diagram/type', 'must equal architecture');
  checkMeta(errors, input.meta);
  if (checkArray(errors, input.nodes, '$.nodes', { required: true, minLength: 1 })) input.nodes.forEach((node, index) => checkNode(errors, node, pathFor('$.nodes', index)));
  if (checkArray(errors, input.edges, '$.edges', { required: true })) input.edges.forEach((edge, index) => checkEdge(errors, edge, pathFor('$.edges', index)));
  if (input.boundaries !== undefined && checkArray(errors, input.boundaries, '$.boundaries')) input.boundaries.forEach((boundary, index) => checkBoundary(errors, boundary, pathFor('$.boundaries', index)));
  if (input.cards !== undefined && checkArray(errors, input.cards, '$.cards')) input.cards.forEach((card, index) => checkCard(errors, card, pathFor('$.cards', index)));
  if (input.recommendations !== undefined && checkArray(errors, input.recommendations, '$.recommendations')) input.recommendations.forEach((recommendation, index) => checkRecommendation(errors, recommendation, pathFor('$.recommendations', index)));
  if (input.openQuestions !== undefined && checkArray(errors, input.openQuestions, '$.openQuestions')) input.openQuestions.forEach((question, index) => checkQuestion(errors, question, pathFor('$.openQuestions', index)));
  if (input.evidenceGaps !== undefined && checkArray(errors, input.evidenceGaps, '$.evidenceGaps')) input.evidenceGaps.forEach((question, index) => checkQuestion(errors, question, pathFor('$.evidenceGaps', index)));

  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const boundaries = Array.isArray(input.boundaries) ? input.boundaries : [];
  checkUniqueIds(errors, nodes, '$.nodes');
  checkUniqueIds(errors, edges, '$.edges');
  checkUniqueIds(errors, boundaries, '$.boundaries');
  const nodeIds = new Set(nodes.map((node) => node?.id).filter((id) => typeof id === 'string'));
  edges.forEach((edge, index) => {
    if (!nodeIds.has(edge?.source)) add(errors, pathFor(pathFor('$.edges', index), 'source'), 'edge/missing-source', `references unknown node ${JSON.stringify(edge?.source)}`);
    if (!nodeIds.has(edge?.target)) add(errors, pathFor(pathFor('$.edges', index), 'target'), 'edge/missing-target', `references unknown node ${JSON.stringify(edge?.target)}`);
    if (edge?.source && edge.source === edge.target) add(errors, pathFor('$.edges', index), 'edge/self-reference', 'must not connect a node to itself');
  });
  boundaries.forEach((boundary, index) => {
    if (!Array.isArray(boundary?.nodeIds)) return;
    const seen = new Set();
    boundary.nodeIds.forEach((nodeId, nodeIndex) => {
      if (seen.has(nodeId)) add(errors, pathFor(pathFor(pathFor('$.boundaries', index), 'nodeIds'), nodeIndex), 'boundary/duplicate-node', `lists node ${JSON.stringify(nodeId)} more than once`);
      seen.add(nodeId);
      if (!nodeIds.has(nodeId)) add(errors, pathFor(pathFor(pathFor('$.boundaries', index), 'nodeIds'), nodeIndex), 'boundary/missing-node', `references unknown node ${JSON.stringify(nodeId)}`);
    });
  });
  const repository = input.meta?.repository;
  const hasCommitEvidence = [...nodes, ...edges, ...(input.recommendations || []), ...(input.openQuestions || []), ...(input.evidenceGaps || [])]
    .some((item) => Array.isArray(item?.evidence) && item.evidence.some((ref) => ref?.verification === 'commit'));
  if (hasCommitEvidence && !SHA1_PATTERN.test(repository?.commitSha || '')) {
    add(errors, '$.meta.repository.commitSha', 'evidence/commit-required', 'commit-verified evidence requires a full 40-character commitSha');
  }
  return { ok: errors.length === 0, errors };
}

export class ArchitectureDiagramError extends Error {
  constructor(message, diagnostics) {
    super(message);
    this.name = 'ArchitectureDiagramError';
    this.code = 'architecture-ir/invalid';
    this.diagnostics = diagnostics;
  }
}

export function assertArchitectureDiagram(input) {
  const result = validateArchitectureDiagram(input);
  if (!result.ok) throw new ArchitectureDiagramError('ArchitectureDiagramIR validation failed.', result.errors);
  return input;
}

function portableOutput(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return 'architecture.html';
  if (candidate.includes('\\') || candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate) || candidate.split('/').includes('..')) {
    throw new ArchitectureDiagramError('Archify output must be a relative POSIX path.', [{ path: '$.meta.output', code: 'output/path', message: 'must be a relative POSIX path' }]);
  }
  return candidate.endsWith('.html') ? candidate : `${candidate}.html`;
}

function titleSlug(value) {
  return String(value || 'architecture')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 64) || 'architecture';
}

function providerFor(remoteUrl) {
  const url = String(remoteUrl || '').toLowerCase();
  if (url.includes('github.com')) return 'github';
  if (url.includes('gitee.com')) return 'gitee';
  return undefined;
}

function toArchifySource(ref) {
  if (ref?.verification && ref.verification !== 'commit') return null;
  return {
    path: String(ref.path).replaceAll('\\', '/'),
    ...(ref.line !== undefined ? { line: ref.line } : {}),
    ...(ref.endLine !== undefined ? { end_line: ref.endLine } : {}),
    ...(ref.label ? { label: ref.label } : {}),
  };
}

function mapSources(refs, diagnostics, ownerPath) {
  const mapped = [];
  for (const ref of refs || []) {
    const source = toArchifySource(ref);
    if (source) mapped.push(source);
    else diagnostics.push({
      severity: 'warning',
      code: ref?.verification === 'working-tree' ? 'archify/working-tree-evidence' : 'archify/unverified-evidence',
      path: ownerPath,
      message: `Evidence ${JSON.stringify(ref?.path || '')} was not copied to Archify because it is not commit-verified.`,
    });
  }
  return mapped.length ? mapped : undefined;
}

function toArchifyRepository(repository) {
  if (!repository?.remoteUrl || !SHA1_PATTERN.test(repository.commitSha || '')) return undefined;
  const provider = providerFor(repository.remoteUrl);
  return {
    url: repository.remoteUrl,
    revision: repository.commitSha,
    ...(provider ? { provider } : {}),
    // Archify only creates clickable web evidence links for GitHub/Gitee.
    // Other remotes retain their identity but are deliberately local-only.
    link_mode: repository.evidenceMode === 'web' && provider ? 'web' : 'local-only',
  };
}

/**
 * Adapt MergeGraph IR to the Archify architecture.schema.json shape.
 * `diagnostics` reports information intentionally omitted at the boundary,
 * such as working-tree evidence that Archify cannot verify against a commit.
 */
export function adaptArchitectureToArchify(input, options = {}) {
  assertArchitectureDiagram(input);
  const diagnostics = [];
  const repository = toArchifyRepository(input.meta.repository);
  const hasRepository = Boolean(input.meta.repository);
  const hasIdentity = Boolean(input.meta.repository?.remoteUrl && input.meta.repository?.commitSha);
  if (hasRepository && !repository) diagnostics.push({ severity: 'warning', code: 'archify/repository-identity-omitted', path: '$.meta.repository', message: 'Archify repository evidence was omitted because remoteUrl and a full commitSha are required.' });
  if (repository && input.meta.repository.evidenceMode === 'web' && !providerFor(input.meta.repository.remoteUrl)) diagnostics.push({ severity: 'warning', code: 'archify/local-only-remote', path: '$.meta.repository.remoteUrl', message: 'Archify source links support GitHub/Gitee only; this repository identity will use local-only links.' });
  const archifyMeta = {
    title: input.meta.title,
    output: portableOutput(options.output || `${titleSlug(input.meta.title)}.html`),
    ...(input.meta.subtitle ? { subtitle: input.meta.subtitle } : {}),
    quality_profile: options.qualityProfile || input.meta.qualityProfile || 'showcase',
    ...(repository ? { repository } : {}),
  };
  const components = input.nodes.map((node, index) => {
    const sources = mapSources(node.evidence, diagnostics, `$.nodes[${index}].evidence`);
    return {
      id: node.id,
      type: node.kind,
      label: node.label,
      ...(node.summary ? { sublabel: node.summary } : {}),
      ...(node.tag ? { tag: node.tag } : {}),
      ...(node.position ? { pos: [node.position.x, node.position.y] } : {}),
      ...(node.size ? { size: [node.size.width, node.size.height] } : {}),
      ...(sources ? { sources } : {}),
    };
  });
  const connections = input.edges.map((edge, index) => {
    // Archify architecture connections do not have a `sources` field. Keep
    // edge evidence in MergeGraph's IR and report that it was not projected;
    // component evidence remains the portable source-backed Archify form.
    if (edge.evidence?.length) {
      diagnostics.push({
        severity: 'warning',
        code: 'archify/edge-evidence-not-projectable',
        path: `$.edges[${index}].evidence`,
        message: 'Edge evidence remains in MergeGraph because Archify architecture connections have no sources field.',
      });
    }
    return {
      id: edge.id,
      from: edge.source,
      to: edge.target,
      ...(edge.label ? { label: edge.label } : {}),
      ...(edge.variant ? { variant: edge.variant } : {}),
    };
  });
  const boundaries = (input.boundaries || []).map((boundary) => ({
    kind: boundary.kind,
    label: boundary.label,
    wraps: boundary.nodeIds,
  }));
  const cards = (input.cards || []).map((card) => ({
    dot: card.tone || 'cyan',
    title: card.title,
    items: card.items,
  }));
  if (hasRepository && input.meta.repository.evidenceMode === 'working-tree') diagnostics.push({ severity: 'warning', code: 'archify/working-tree-snapshot', path: '$.meta.repository', message: 'The diagram is based on a working-tree snapshot; Archify source links are restricted to commit-verified evidence.' });
  if (hasRepository && !hasIdentity && (input.nodes.some((node) => node.evidence?.length) || input.edges.some((edge) => edge.evidence?.length))) diagnostics.push({ severity: 'warning', code: 'archify/evidence-without-identity', path: '$.meta.repository', message: 'Evidence is retained in MergeGraph but cannot be published as Archify source references without a pinned repository identity.' });
  return {
    document: {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: archifyMeta,
      components,
      ...(boundaries.length ? { boundaries } : {}),
      ...(connections.length ? { connections } : {}),
      ...(cards.length ? { cards } : {}),
    },
    diagnostics,
  };
}

export function toArchifyArchitecture(input, options = {}) {
  return adaptArchitectureToArchify(input, options).document;
}

function assertArchifyArchitecture(input) {
  const errors = [];
  if (!isRecord(input)) add(errors, '$', 'type/object', 'must be an object');
  if (input?.schema_version !== 1) add(errors, '$.schema_version', 'schema/version', 'must equal 1');
  if (input?.diagram_type !== 'architecture') add(errors, '$.diagram_type', 'diagram/type', 'must equal architecture');
  if (!isRecord(input?.meta)) add(errors, '$.meta', 'type/object', 'must be an object');
  else if (typeof input.meta.title !== 'string' || !input.meta.title) add(errors, '$.meta.title', 'required', 'must be a non-empty string');
  if (!Array.isArray(input?.components) || input.components.length === 0) add(errors, '$.components', 'required', 'must contain at least one component');
  if (errors.length) throw new ArchitectureDiagramError('Archify architecture document validation failed.', errors);
  return input;
}

/** Convert a validated Archify Architecture document back to MergeGraph IR. */
export function fromArchifyArchitecture(input, options = {}) {
  assertArchifyArchitecture(input);
  const repository = input.meta.repository ? {
    ...(input.meta.repository.url ? { remoteUrl: input.meta.repository.url } : {}),
    ...(input.meta.repository.revision ? { commitSha: input.meta.repository.revision } : {}),
    evidenceMode: input.meta.repository.link_mode === 'web' ? 'web' : 'local-only',
  } : undefined;
  const nodes = input.components.map((component) => ({
    id: component.id,
    kind: component.type,
    label: component.label,
    ...(component.sublabel ? { summary: component.sublabel } : {}),
    ...(component.tag ? { tag: component.tag } : {}),
    ...(Array.isArray(component.pos) ? { position: { x: component.pos[0], y: component.pos[1] } } : {}),
    ...(Array.isArray(component.size) ? { size: { width: component.size[0], height: component.size[1] } } : {}),
    ...(Array.isArray(component.sources) ? { evidence: component.sources.map((source) => ({ path: source.path, ...(source.line !== undefined ? { line: source.line } : {}), ...(source.end_line !== undefined ? { endLine: source.end_line } : {}), ...(source.label ? { label: source.label } : {}), verification: 'commit' })) } : {}),
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const boundaries = (input.boundaries || []).map((boundary, index) => ({
    id: `boundary-${index + 1}`,
    kind: boundary.kind,
    label: boundary.label,
    nodeIds: boundary.wraps.filter((id) => nodeIds.has(id)),
  })).filter((boundary) => boundary.nodeIds.length);
  const result = {
    schemaVersion: ARCHITECTURE_SCHEMA_VERSION,
    diagramType: 'architecture',
    meta: {
      title: input.meta.title,
      ...(input.meta.subtitle ? { subtitle: input.meta.subtitle } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.repoSnapshotId ? { repoSnapshotId: options.repoSnapshotId } : {}),
      ...(input.meta.quality_profile ? { qualityProfile: input.meta.quality_profile } : {}),
      ...(repository ? { repository } : {}),
    },
    nodes,
    edges: (input.connections || []).map((connection, index) => ({
      id: connection.id || `edge-${index + 1}`,
      source: connection.from,
      target: connection.to,
      ...(connection.label ? { label: connection.label } : {}),
      ...(connection.variant ? { variant: connection.variant } : {}),
    })),
    ...(boundaries.length ? { boundaries } : {}),
    ...(input.cards?.length ? { cards: input.cards.map((card, index) => ({ id: `card-${index + 1}`, title: card.title, items: card.items, ...(card.dot ? { tone: card.dot } : {}) })) } : {}),
  };
  return result;
}
