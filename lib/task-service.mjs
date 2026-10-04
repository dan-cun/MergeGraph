/**
 * Local AI coding task orchestration.
 *
 * The service accepts structured file operations (or a unified diff), checks
 * every path against the selected workspace, creates a task backup, applies
 * the operations, runs a small allow-list of checks, and records changes for
 * the graph and UI layers.  It deliberately has no shell-string execution
 * path: only explicitly supported commands are converted to argv arrays.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { effectiveInstructions } from './instruction-service.mjs';
import { diffAndRecord, hashContent, hashFile, recordChanges } from './change-tracker.mjs';

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

const CONVERSATIONS = 'conversations';
const MESSAGES = 'messages';
const TASKS = 'tasks';
const STEPS = 'task_steps';
const PATCHES = 'patches';
const CHECKS = 'checks';
const EVENTS = 'task_events';
const STATUS = new Set(['queued', 'planning', 'planned', 'running', 'completed', 'failed', 'cancelling', 'cancelled', 'rolling_back', 'rolled_back']);
const STEP_STATUS = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);
const running = new Map();

const fallbackId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
async function id(prefix) { const c = await core(); return typeof c.id === 'function' ? c.id(prefix) : fallbackId(prefix); }
async function now() { const c = await core(); return typeof c.now === 'function' ? c.now() : new Date().toISOString(); }
async function list(collection) {
  const c = await core();
  if (!c.store?.list) return [];
  const result = c.store.list(collection);
  return result instanceof Promise ? result : result;
}
async function get(collection, key) {
  const c = await core();
  if (!c.store?.get) return null;
  const result = c.store.get(collection, key);
  return result instanceof Promise ? result : result;
}
async function put(collection, value) {
  const c = await core();
  if (!c.store?.put) return value;
  const result = c.store.put(collection, value);
  return result instanceof Promise ? result : result;
}
async function remove(collection, key) {
  const c = await core();
  if (!c.store?.remove) return;
  const result = c.store.remove(collection, key);
  return result instanceof Promise ? result : result;
}
async function publish(type, payload) {
  const c = await core();
  try {
    if (typeof c.emit !== 'function') return;
    const task = payload?.taskId ? await get(TASKS, payload.taskId) : null;
    c.emit(task?.workspaceId || payload?.workspaceId || '', type, payload);
  } catch { /* event observers are best effort */ }
}
async function workspaceOf(workspaceId) {
  const w = await workspaceService();
  if (typeof w.getWorkspace !== 'function') throw new Error('workspace-service.getWorkspace is unavailable');
  const workspace = await w.getWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} was not found`);
  return workspace;
}
function rootOf(workspace) {
  const root = workspace.rootPath || workspace.root_path || workspace.path || workspace.directory;
  if (!root) throw new Error('Workspace has no root path');
  return path.resolve(root);
}
function projectOf(workspace, workspaceId) { return workspace.projectId || workspace.project_id || workspaceId; }

function cleanRelative(input) {
  let value = String(input || '').trim().replaceAll('\\', '/');
  value = value.replace(/^a\//, '').replace(/^b\//, '');
  if (!value || value === '/dev/null') return value;
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) throw new Error(`Operation path must be relative: ${input}`);
  const parts = value.split('/');
  if (parts.some((part) => part === '..')) throw new Error(`Operation path escapes the workspace: ${input}`);
  return parts.filter((part) => part && part !== '.').join('/');
}
function fullPath(root, relative) {
  const clean = cleanRelative(relative);
  const target = path.resolve(root, clean);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Operation path escapes the workspace: ${relative}`);
  return target;
}
function operationName(value) {
  const op = String(value || 'modify').toLowerCase();
  if (op === 'write' || op === 'update' || op === 'modify') return 'modify';
  if (op === 'add' || op === 'create') return 'create';
  if (op === 'remove' || op === 'delete') return 'delete';
  if (op === 'append') return 'append';
  if (op === 'replace') return 'replace';
  throw new Error(`Unsupported file operation: ${value}`);
}

async function readJsonRecord(collection, key) {
  const record = await get(collection, key);
  if (!record) throw new Error(`${collection} record ${key} was not found`);
  return record;
}

async function taskEvent(taskId, type, data = {}) {
  const event = { id: await id('event'), taskId, type, data, createdAt: await now() };
  await put(EVENTS, event);
  await publish(`task.${type}`, event);
  await publish('task.event', event);
  return event;
}

async function updateTask(task, patch) {
  const next = { ...task, ...patch, updatedAt: await now() };
  if (!STATUS.has(next.status)) throw new Error(`Invalid task status: ${next.status}`);
  await put(TASKS, next);
  await taskEvent(next.id, 'updated', { status: next.status, task: next });
  return next;
}
async function updateStep(step, patch) {
  const next = { ...step, ...patch, updatedAt: await now() };
  if (!STEP_STATUS.has(next.status)) throw new Error(`Invalid task step status: ${next.status}`);
  await put(STEPS, next);
  await taskEvent(next.taskId, 'step_updated', { step: next });
  return next;
}

export async function createConversation(workspaceId, title = 'New coding task') {
  await workspaceOf(workspaceId);
  const timestamp = await now();
  const conversation = { id: await id('conversation'), workspaceId, title, status: 'active', createdAt: timestamp, updatedAt: timestamp };
  await put(CONVERSATIONS, conversation);
  await publish('conversation.created', conversation);
  return conversation;
}

/** Create a message; with no input, return the conversation history. */
export async function appendMessage(conversationId, input) {
  await readJsonRecord(CONVERSATIONS, conversationId);
  if (input === undefined) return (await list(MESSAGES)).filter((message) => message.conversationId === conversationId).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const value = typeof input === 'string' ? { role: 'user', content: input } : input || {};
  if (!value.content && !value.text) throw new Error('Message content is required');
  const conversation = await readJsonRecord(CONVERSATIONS, conversationId);
  const message = {
    id: await id('message'), conversationId, workspaceId: conversation.workspaceId,
    role: value.role || 'user', type: value.type || 'text', content: value.content || value.text,
    taskId: value.taskId, createdAt: await now(), metadata: value.metadata || {},
  };
  await put(MESSAGES, message);
  await put(CONVERSATIONS, { ...conversation, updatedAt: message.createdAt, lastMessageId: message.id });
  await publish('conversation.message', message);
  return message;
}

export async function createTask(workspaceId, conversationId, prompt) {
  await workspaceOf(workspaceId);
  let conversation = conversationId ? await readJsonRecord(CONVERSATIONS, conversationId) : await createConversation(workspaceId);
  if (conversation.workspaceId !== workspaceId) throw new Error('Conversation does not belong to the workspace');
  if (!prompt || !String(prompt).trim()) throw new Error('Task prompt is required');
  const timestamp = await now();
  const task = {
    id: await id('task'), workspaceId, projectId: workspaceId, conversationId: conversation.id,
    prompt: String(prompt).trim(), status: 'queued', providerMode: null, plan: null,
    backupDir: null, patchIds: [], checkIds: [], changedPaths: [], error: null,
    createdAt: timestamp, updatedAt: timestamp,
  };
  await put(TASKS, task);
  await appendMessage(conversation.id, { role: 'user', content: task.prompt, taskId: task.id, type: 'request' });
  await taskEvent(task.id, 'created', { task });
  return task;
}

export async function getTask(taskId) { return readJsonRecord(TASKS, taskId); }
export async function listTasks(workspaceId) { return (await list(TASKS)).filter((task) => !workspaceId || task.workspaceId === workspaceId).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))); }
export async function listTaskSteps(taskId) { return (await list(STEPS)).filter((step) => step.taskId === taskId).sort((a, b) => (a.order || 0) - (b.order || 0)); }
export async function taskEvents(taskId, options = {}) {
  const events = (await list(EVENTS)).filter((event) => event.taskId === taskId).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (typeof options.onEvent === 'function') {
    const c = await core();
    if (typeof c.subscribe === 'function') {
      const unsubscribe = c.subscribe('task.event', (event) => { if (event?.taskId === taskId) options.onEvent(event); });
      return { events, unsubscribe };
    }
  }
  return events;
}
export async function listTaskPatches(taskId) {
  return (await list(PATCHES))
    .filter((patch) => patch.taskId === taskId)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}
export async function getPatch(patchId) { return readJsonRecord(PATCHES, patchId); }

async function providerPlan(task, context) {
  let provider;
  try { provider = await import('./ai-provider.mjs'); } catch { provider = null; }
  if (provider && typeof provider.runStructured === 'function') {
    try {
      const response = await provider.runStructured(
        `Plan and implement this local coding task. Return JSON with steps, operations, checks, and summary.\nTask: ${task.prompt}`,
        context,
      );
      const normalized = normalizePlan(response);
      return { ...normalized, providerMode: response?.provider === 'local-mock' ? 'local_mock' : 'provider' };
    } catch (error) {
      return { ...localPlan(task, context), providerMode: 'local_mock', providerError: error.message };
    }
  }
  return { ...localPlan(task, context), providerMode: 'local_mock' };
}

function localPlan(task, context) {
  // A deterministic no-provider plan is deliberately read-only.  It gives
  // the UI useful task steps while never guessing destructive code changes.
  return {
    summary: `已生成本地规划：${task.prompt}`,
    steps: [{ title: '分析工作区并等待 AI Provider', detail: `当前任务涉及 ${context.files.length} 个已扫描文件。`, operations: [] }],
    operations: [], checks: [],
  };
}

function parseUnifiedDiff(text) {
  const lines = String(text || '').replaceAll('\r\n', '\n').split('\n');
  const operations = [];
  let current = null;
  let hunks = [];
  const flush = () => {
    if (!current) return;
    const from = current.from === '/dev/null' ? null : cleanRelative(current.from);
    const to = current.to === '/dev/null' ? null : cleanRelative(current.to);
    if (!to && from) operations.push({ path: from, operation: 'delete' });
    else if (to && !from) operations.push({ path: to, operation: 'create', hunks });
    else if (to) operations.push({ path: to, operation: 'modify', hunks });
    current = null; hunks = [];
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) { flush(); continue; }
    if (line.startsWith('--- ')) { if (!current) current = {}; current.from = line.slice(4).trim(); continue; }
    if (line.startsWith('+++ ')) { if (!current) current = {}; current.to = line.slice(4).trim(); continue; }
    if (line.startsWith('@@ ')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) hunks.push({ oldStart: Number(match[1]), oldCount: Number(match[2] || 1), newStart: Number(match[3]), newCount: Number(match[4] || 1), lines: [] });
      continue;
    }
    if (hunks.length && (/^[ +\-]/.test(line) || line === '\\ No newline at end of file')) hunks[hunks.length - 1].lines.push(line);
  }
  flush();
  return operations;
}

function applyHunks(original, hunks) {
  const source = String(original || '').replaceAll('\r\n', '\n').split('\n');
  if (source.length === 1 && source[0] === '') source.length = 0;
  const result = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    while (cursor < start) result.push(source[cursor++]);
    for (const line of hunk.lines) {
      if (line === '\\ No newline at end of file') continue;
      const marker = line[0];
      const value = line.slice(1);
      if (marker === ' ') { if (source[cursor] !== value) throw new Error('Unified diff context does not match the workspace'); result.push(source[cursor++]); }
      else if (marker === '-') { if (source[cursor] !== value) throw new Error('Unified diff removal does not match the workspace'); cursor += 1; }
      else if (marker === '+') result.push(value);
    }
  }
  while (cursor < source.length) result.push(source[cursor++]);
  return result.join('\n');
}

function normalizePlan(input) {
  let response = input;
  if (typeof response === 'string') {
    const trimmed = response.trim();
    if (trimmed.startsWith('diff --git ') || trimmed.startsWith('--- ')) return { summary: 'Apply unified diff', steps: [], operations: parseUnifiedDiff(trimmed), checks: [] };
    try { response = JSON.parse(trimmed); } catch { return { summary: trimmed, steps: [], operations: [], checks: [] }; }
  }
  response ||= {};
  let operations = Array.isArray(response.operations) ? response.operations : [];
  if (!operations.length && response.unifiedDiff) operations = parseUnifiedDiff(response.unifiedDiff);
  operations = operations.map((operation) => {
    const normalized = { ...operation, path: cleanRelative(operation.path || operation.file || operation.filePath), operation: operationName(operation.operation || operation.op || 'modify') };
    if (normalized.operation === 'modify' && normalized.content === undefined && normalized.newContent !== undefined) normalized.content = normalized.newContent;
    return normalized;
  });
  const steps = Array.isArray(response.steps) ? response.steps.map((step, index) => ({ ...step, order: index + 1, operations: Array.isArray(step.operations) ? step.operations : [] })) : [];
  if (!steps.length) operations.forEach((operation, index) => steps.push({ order: index + 1, title: `${operation.operation} ${operation.path}`, operations: [operation] }));
  return { summary: response.summary || response.message || '', steps, operations, checks: Array.isArray(response.checks) ? response.checks : [] };
}

function operationList(plan) {
  const all = [];
  for (const step of plan.steps || []) for (const operation of step.operations || []) all.push(operation);
  if (!all.length) return plan.operations || [];
  return all;
}

function commandToArgv(command) {
  const raw = typeof command === 'string' ? command.trim() : String(command?.command || '').trim();
  if (!raw) throw new Error('Empty check command');
  let match = raw.match(/^node\s+--check\s+(.+)$/i);
  if (match) return { executable: process.execPath, args: ['--check', cleanRelative(match[1].trim().replace(/^['"]|['"]$/g, ''))], label: raw };
  if (/^(?:npm|npm\.cmd)\s+(?:test|run\s+(?:test|build|check|lint))$/i.test(raw)) {
    const parts = raw.split(/\s+/); return { executable: process.platform === 'win32' ? 'npm.cmd' : parts[0], args: parts.slice(1), label: raw };
  }
  if (/^(?:pnpm|yarn)\s+(?:test|build|lint)$/i.test(raw)) { const parts = raw.split(/\s+/); return { executable: parts[0], args: parts.slice(1), label: raw }; }
  throw new Error(`Check command is not allow-listed: ${raw}`);
}

function runProcess(executable, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function runChecks(task, checks, root, stepId) {
  const results = [];
  for (const check of checks || []) {
    const command = typeof check === 'string' ? check : check.command;
    const timestamp = await now();
    let result;
    try {
      const argv = commandToArgv(command);
      const args = argv.args.map((arg) => arg === cleanRelative(arg) && argv.executable === process.execPath ? fullPath(root, arg) : arg);
      const processResult = await runProcess(argv.executable, args, root);
      result = { status: processResult.code === 0 ? 'passed' : 'failed', exitCode: processResult.code, stdout: processResult.stdout, stderr: processResult.stderr, command: argv.label };
    } catch (error) {
      result = { status: 'rejected', exitCode: null, stdout: '', stderr: error.message, command: String(command || '') };
    }
    const record = { id: await id('check'), taskId: task.id, stepId, ...result, startedAt: timestamp, finishedAt: await now() };
    await put(CHECKS, record); results.push(record); await taskEvent(task.id, 'check_completed', { check: record });
  }
  return results;
}

async function backupPath(root, taskId, relative, content) {
  const directory = path.join(root, '.mergegraph', 'backups', taskId, path.dirname(relative));
  await mkdir(directory, { recursive: true });
  const destination = path.join(root, '.mergegraph', 'backups', taskId, relative);
  if (content === null) await writeFile(`${destination}.deleted`, 'deleted', 'utf8');
  else await writeFile(destination, content, 'utf8');
  return path.relative(root, destination).replaceAll(path.sep, '/');
}

async function applyOperation(task, root, operation, stepId) {
  const relative = cleanRelative(operation.path || operation.file || operation.filePath);
  if (!relative) throw new Error('Operation path is required');
  const target = fullPath(root, relative);
  let before = null;
  try { before = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const preHash = before === null ? null : await hashContent(before);
  if (operation.preHash && operation.preHash !== preHash) throw new Error(`Pre-change hash mismatch for ${relative}`);
  let after = null;
  const op = operationName(operation.operation || operation.op);
  if (op === 'delete') after = null;
  else if (op === 'append') after = `${before || ''}${String(operation.content ?? operation.text ?? '')}`;
  else if (op === 'replace') {
    if (before === null) throw new Error(`Cannot replace missing file ${relative}`);
    const oldText = String(operation.oldText ?? operation.from ?? '');
    if (!oldText || !before.includes(oldText)) throw new Error(`Replacement text was not found in ${relative}`);
    after = before.replace(oldText, String(operation.newText ?? operation.to ?? operation.content ?? ''));
  } else {
    if (operation.hunks) after = applyHunks(before || '', operation.hunks);
    else {
      if (operation.content === undefined && operation.newContent === undefined) throw new Error(`Content is required for ${op} ${relative}`);
      after = String(operation.content ?? operation.newContent);
    }
  }
  const backup = await backupPath(root, task.id, relative, before);
  if (after === null) {
    if (before !== null) await unlink(target);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, after, 'utf8');
  }
  const postHash = after === null ? null : await hashContent(after);
  const patch = {
    id: await id('patch'), taskId: task.id, stepId, path: relative, operation: op,
    preHash, postHash, beforeContent: before, afterContent: after, backupPath: backup,
    createdAt: await now(),
  };
  await put(PATCHES, patch);
  await recordChanges(task.workspaceId, [{ path: relative, operation: op === 'create' ? 'create' : op === 'delete' ? 'delete' : 'modify', preHash, postHash }], { taskId: task.id, stepId, origin: 'ai', source: 'task-service' });
  try {
    const graph = await import('./graph-service.mjs');
    graph.updateNodeStates?.(task.workspaceId, [relative], 'modified', task.id, stepId);
  } catch { /* graph refresh is best effort; the task patch remains authoritative */ }
  return patch;
}

async function contextFor(task) {
  const workspace = await workspaceOf(task.workspaceId);
  const root = rootOf(workspace);
  const w = await workspaceService();
  let files = [];
  if (typeof w.getFiles === 'function') {
    try { files = await w.getFiles(task.workspaceId) || []; } catch { files = []; }
  }
  const instructions = await effectiveInstructions(task.workspaceId, '.');
  return { workspaceId: task.workspaceId, root, files, instructions, instructionText: instructions.text };
}

async function planTask(task) {
  const context = await contextFor(task);
  const plan = await providerPlan(task, context);
  const operations = operationList(plan);
  const steps = (plan.steps?.length ? plan.steps : [{ title: '分析任务', detail: plan.summary, operations }]).map((step, index) => ({
    id: undefined, taskId: task.id, order: index + 1, title: step.title || `步骤 ${index + 1}`, detail: step.detail || '', status: 'pending',
    operations: (step.operations || []).map((operation) => ({ ...operation, path: cleanRelative(operation.path || operation.file || operation.filePath) })),
    files: (step.operations || []).map((operation) => cleanRelative(operation.path || operation.file || operation.filePath)).filter(Boolean),
  }));
  for (const step of steps) { step.id = await id('step'); await put(STEPS, step); }
  const next = await updateTask(task, { status: 'planned', providerMode: plan.providerMode, plan: { summary: plan.summary, operations, checks: plan.checks || [], providerError: plan.providerError, instructions: context.instructions.sources }, stepIds: steps.map((step) => step.id) });
  await appendMessage(task.conversationId, { role: 'assistant', type: 'plan', content: plan.summary || '任务计划已生成', taskId: task.id, metadata: { providerMode: plan.providerMode, steps: steps.map((step) => step.id) } });
  return { task: next, steps, context, plan };
}

export async function startTask(taskId, options = {}) {
  const task = await getTask(taskId);
  if (running.has(taskId)) throw new Error('Task is already running');
  if (['completed', 'cancelled', 'rolled_back'].includes(task.status) && !options.retry) throw new Error(`Task cannot start from ${task.status}`);
  const state = { cancelled: false }; running.set(taskId, state);
  try {
    let planned = task.plan ? { task, steps: await listTaskSteps(taskId), context: await contextFor(task), plan: task.plan } : await planTask(await updateTask(task, { status: 'planning', error: null }));
    if (options.autoApply === false) return planned.task;
    let current = await updateTask(planned.task, { status: 'running', startedAt: planned.task.startedAt || await now() });
    const patchIds = [...(current.patchIds || [])]; const changedPaths = [...(current.changedPaths || [])]; const checks = [];
    const allSteps = planned.steps || await listTaskSteps(taskId);
    for (const step of allSteps) {
      if (state.cancelled) throw new Error('Task cancelled');
      await updateStep(step, { status: 'running', startedAt: await now() });
      try {
        for (const operation of step.operations || []) {
          if (state.cancelled) throw new Error('Task cancelled');
          const patch = await applyOperation(current, planned.context.root, operation, step.id);
          patchIds.push(patch.id); if (!changedPaths.includes(patch.path)) changedPaths.push(patch.path);
        }
        const stepChecks = await runChecks(current, planned.plan.checks || [], planned.context.root, step.id);
        checks.push(...stepChecks);
        if (stepChecks.some((check) => check.status !== 'passed')) throw new Error('A task check failed');
        await updateStep(step, { status: 'completed', finishedAt: await now() });
      } catch (error) {
        await updateStep(step, { status: state.cancelled ? 'cancelled' : 'failed', finishedAt: await now(), error: error.message });
        throw error;
      }
    }
    current = await updateTask(current, { status: 'completed', finishedAt: await now(), patchIds, checkIds: checks.map((check) => check.id), changedPaths, summary: planned.plan.summary });
    try {
      const graph = await import('./graph-service.mjs');
      await graph.generateGraphs(current.workspaceId, { type: 'main_flow', taskId: current.id });
      await taskEvent(current.id, 'graph_updated', { graphType: 'main_flow' });
    } catch (error) {
      await taskEvent(current.id, 'graph_update_failed', { graphType: 'main_flow', error: error.message });
    }
    await appendMessage(current.conversationId, { role: 'assistant', type: 'result', content: current.summary || '任务完成', taskId: current.id, metadata: { changedPaths, checkIds: current.checkIds } });
    return current;
  } catch (error) {
    const latest = await getTask(taskId);
    const status = state.cancelled ? 'cancelled' : 'failed';
    await updateTask(latest, { status, error: error.message, failedAt: await now() });
    await taskEvent(taskId, 'failed', { error: error.message, cancelled: state.cancelled });
    if (options.rollbackOnFailure) await rollbackTask(taskId);
    return { ...(await getTask(taskId)), error: error.message };
  } finally { running.delete(taskId); }
}

export async function cancelTask(taskId) {
  const task = await getTask(taskId);
  const state = running.get(taskId);
  if (state) state.cancelled = true;
  return updateTask(task, { status: state ? 'cancelling' : 'cancelled', cancelledAt: await now() });
}

export async function rollbackTask(taskId) {
  const task = await getTask(taskId);
  const patches = (await list(PATCHES)).filter((patch) => patch.taskId === taskId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const workspace = await workspaceOf(task.workspaceId); const root = rootOf(workspace);
  await updateTask(task, { status: 'rolling_back' });
  for (const patch of patches) {
    const target = fullPath(root, patch.path);
    if (patch.beforeContent === null || patch.beforeContent === undefined) {
      try { await unlink(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, patch.beforeContent, 'utf8');
    }
    await recordChanges(task.workspaceId, [{ path: patch.path, operation: patch.beforeContent === null ? 'delete' : 'modify', preHash: patch.postHash, postHash: patch.preHash }], { taskId, origin: 'ai', source: 'rollback' });
  }
  const result = await updateTask(await getTask(taskId), { status: 'rolled_back', rolledBackAt: await now(), rollbackPatchIds: patches.map((patch) => patch.id) });
  await taskEvent(taskId, 'rolled_back', { patchCount: patches.length });
  return result;
}

export { parseUnifiedDiff, normalizePlan, cleanRelative };
