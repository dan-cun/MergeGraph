import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await sleep(100);
  }
  throw new Error('integration server did not become ready');
}

test('HTTP workspace and task contracts are lightweight and content-safe', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'mergegraph-http-workspace-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'mergegraph-http-data-'));
  await mkdir(path.join(workspaceRoot, 'src'));
  await writeFile(path.join(workspaceRoot, 'src', 'entry.js'), 'export const entry = 1;\n', 'utf8');
  const port = 45000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), MERGEGRAPH_DATA_DIR: dataRoot },
    stdio: 'ignore',
  });
  try {
    await waitForHealth(baseUrl, child);
    const started = Date.now();
    const created = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'HTTP test', rootPath: workspaceRoot }),
    });
    const elapsed = Date.now() - started;
    assert.equal(created.status, 201);
    assert.ok(elapsed < 2000, `workspace creation blocked for ${elapsed}ms`);
    const createdBody = await created.json();
    assert.equal(createdBody.initialization.status, 'running');
    const workspaceId = createdBody.workspace.id;

    const status = await (await fetch(`${baseUrl}/api/workspaces/${workspaceId}/status`)).json();
    assert.equal(status.workspace.id, workspaceId);
    assert.ok(status.initialization.status);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const current = await (await fetch(`${baseUrl}/api/workspaces/${workspaceId}/status`)).json();
      if (['ready', 'failed'].includes(current.initialization.status)) break;
      await sleep(100);
    }

    const files = await (await fetch(`${baseUrl}/api/workspaces/${workspaceId}/files`)).json();
    assert.ok(files.files.length >= 1);
    assert.equal(Object.hasOwn(files.files[0], 'content'), false);

    const taskStarted = Date.now();
    const taskResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, prompt: 'inspect the project' }),
    });
    assert.equal(taskResponse.status, 201);
    assert.ok(Date.now() - taskStarted < 1500, 'task creation should return before execution');
    const taskBody = await taskResponse.json();
    assert.equal(taskBody.task.status, 'queued');
    const taskId = taskBody.task.id;
    const conversationId = taskBody.task.conversationId;

    const messages = await (await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`)).json();
    assert.ok(Array.isArray(messages.messages));
    const patches = await (await fetch(`${baseUrl}/api/tasks/${taskId}/patches`)).json();
    assert.ok(Array.isArray(patches.patches));
  } finally {
    child.kill('SIGTERM');
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});
