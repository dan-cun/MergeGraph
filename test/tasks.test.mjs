import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots } from '../lib/change-tracker.mjs';
import { cleanRelative, normalizePlan, parseUnifiedDiff } from '../lib/task-service.mjs';
import { parseRules } from '../lib/instruction-service.mjs';

test('snapshot diff reports create, modify and delete operations', () => {
  const changes = diffSnapshots(
    { 'a.txt': { hash: 'one' }, 'gone.txt': { hash: 'old' } },
    { 'a.txt': { hash: 'two' }, 'new.txt': { hash: 'new' } },
  );
  assert.deepEqual(changes, [
    { path: 'a.txt', operation: 'modify', preHash: 'one', postHash: 'two' },
    { path: 'gone.txt', operation: 'delete', preHash: 'old', postHash: null },
    { path: 'new.txt', operation: 'create', preHash: null, postHash: 'new' },
  ]);
});

test('instruction parser separates required and forbidden rules', () => {
  const rules = parseRules('- 必须运行测试\n- 禁止修改 migrations\n- style: use semicolons');
  assert.equal(rules.required.length, 1);
  assert.equal(rules.forbidden.length, 1);
  assert.equal(rules.style.length, 1);
});

test('unified diff is converted to a structured operation without trusting paths', () => {
  const plan = normalizePlan('diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-old\n+new\n');
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].path, 'src/a.js');
  assert.equal(plan.operations[0].operation, 'modify');
  assert.throws(() => cleanRelative('../outside.txt'), /escapes/);
  assert.equal(parseUnifiedDiff('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created\n')[0].operation, 'create');
});
