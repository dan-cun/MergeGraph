import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARCHIFY_COMMIT,
  ARCHIFY_VERSION,
  graphToArchify,
  renderWithArchify,
  validateArchifyDocument,
} from '../lib/archify-bridge.mjs';
import { renderArchifyDocument } from '../lib/archify-renderer-api.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mergegraph-graphs-'));

function graph(type) {
  return {
    id: `graph-${type}`,
    workspaceId: 'workspace-test',
    type,
    version: 1,
    nodes: [
      { id: 'file_a', label: 'src/a.js', path: 'src/a.js', summary: '扫描节点', x: 80, y: 80, width: 180, height: 82, evidence: [{ path: 'src/a.js' }] },
      { id: 'file_b', label: 'src/b.js', path: 'src/b.js', summary: '扫描节点', x: 300, y: 80, width: 180, height: 82, evidence: [{ path: 'src/b.js' }] },
    ],
    edges: [{ id: 'edge_a_b', source: 'file_a', target: 'file_b', label: '显式导入/引用' }],
  };
}

test('five graph types adapt to Archify schemas', async () => {
  for (const type of ['main_flow', 'asset_call', 'execution', 'agent_relation', 'deployment_ownership']) {
    const document = graphToArchify(graph(type));
    assert.ok(document, `${type} should have an Archify document`);
    const result = await validateArchifyDocument(type, document);
    assert.equal(result.ok, true);
    assert.equal(result.version, ARCHIFY_VERSION);
    assert.equal(result.commit, ARCHIFY_COMMIT);
  }
});

test('pure renderer API is repeatable, concurrent and side-effect free', async () => {
  const beforeArgv = [...process.argv];
  const beforeEnv = {
    quality: process.env.ARCHIFY_QUALITY_PROFILE,
    repoRoot: process.env.ARCHIFY_REPO_ROOT,
  };
  const types = ['main_flow', 'asset_call', 'execution', 'agent_relation', 'deployment_ownership'];
  const documents = types.map((type) => [type, graphToArchify(graph(type))]);
  const beforeDocuments = documents.map(([, document]) => JSON.stringify(document));
  const first = await Promise.all(documents.map(async ([type, document]) => renderArchifyDocument(
    { main_flow: 'workflow', asset_call: 'dataflow', execution: 'sequence', agent_relation: 'lifecycle', deployment_ownership: 'architecture' }[type],
    document,
  )));
  const second = await Promise.all(documents.map(async ([type, document]) => renderArchifyDocument(
    { main_flow: 'workflow', asset_call: 'dataflow', execution: 'sequence', agent_relation: 'lifecycle', deployment_ownership: 'architecture' }[type],
    document,
  )));
  for (let index = 0; index < types.length; index += 1) {
    assert.match(first[index].svg, /<svg[\s\S]*<\/svg>/);
    assert.equal(first[index].svg, second[index].svg);
  }
  assert.deepEqual(documents.map(([, document]) => JSON.stringify(document)), beforeDocuments);
  assert.deepEqual(process.argv, beforeArgv);
  assert.equal(process.env.ARCHIFY_QUALITY_PROFILE, beforeEnv.quality);
  assert.equal(process.env.ARCHIFY_REPO_ROOT, beforeEnv.repoRoot);
});

test('empty graphs stay empty and do not claim a rendered artifact', async () => {
  const empty = { type: 'agent_relation', nodes: [], edges: [] };
  assert.equal(graphToArchify(empty), null);
  const receipt = await renderWithArchify(empty, { outputDir: tempRoot, stem: 'empty' });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, 'skipped');
  assert.equal(fs.existsSync(path.join(tempRoot, 'empty.html')), false);
});

test('Archify renderer creates HTML and extracted SVG for every non-empty type', async () => {
  for (const type of ['main_flow', 'asset_call', 'execution', 'agent_relation', 'deployment_ownership']) {
    const receipt = await renderWithArchify(graph(type), { outputDir: tempRoot, stem: `render-${type}` });
    assert.equal(receipt.ok, true, `${type}: ${receipt.stderr || receipt.error || 'render failed'}`);
    assert.equal(receipt.status, 'rendered');
    assert.equal(receipt.execution, 'pure_renderer_api');
    assert.equal(receipt.command[0], 'in-process-api');
    assert.ok(receipt.artifactSha256);
    assert.ok(receipt.svgSha256);
    assert.equal(fs.existsSync(receipt.artifactPath), true);
    assert.equal(fs.existsSync(receipt.svgPath), true);
  }
});

test('workspace graph generation and deployment inventory are project-scoped', async () => {
  process.env.MERGEGRAPH_DATA_DIR = path.join(tempRoot, 'workspace-db');
  const { createWorkspace, scanWorkspace } = await import('../lib/workspace-service.mjs');
  const { generateGraphs, listGraphs } = await import('../lib/graph-service.mjs');
  const { discoverDeployments, saveDeployment, deleteDeployment, listDeployments } = await import('../lib/deployment-service.mjs');
  const projectRoot = fs.mkdtempSync(path.join(tempRoot, 'project-'));
  fs.mkdirSync(path.join(projectRoot, 'src'));
  fs.writeFileSync(path.join(projectRoot, 'src', 'entry.js'), "import './module.js';\nexport const entry = true;\n", 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'src', 'module.js'), 'export const module = true;\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.env.example'), 'PUBLIC_URL=https://example.test/app\n', 'utf8');
  const workspace = await createWorkspace({ name: 'graph-test', rootPath: projectRoot });
  await scanWorkspace(workspace.id);
  const graphs = await generateGraphs(workspace.id);
  assert.equal(graphs.find((entry) => entry.type === 'main_flow')?.status, 'ready');
  assert.equal(listGraphs(workspace.id).length, 5);
  const found = discoverDeployments(workspace.id);
  assert.equal(found.some((entry) => entry.domain === 'example.test'), true);
  const manual = saveDeployment(workspace.id, { domain: 'manual.example.test', environment: 'production' });
  assert.equal(listDeployments(workspace.id).some((entry) => entry.id === manual.id), true);
  assert.equal(deleteDeployment(manual.id), true);
});
