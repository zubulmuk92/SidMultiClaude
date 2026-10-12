// test/unit/model/tools-lite.test.ts — per-tool summaries and extras (ux §5.4), denial kinds, patches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liteToolResult, patchOf, toolInputView, toolSummary, PATCH_MAX_LINES, FIELD_MAX_CHARS } from '../../../src/server/model/tools-lite.ts';
import { denialOf, toolStatusOf } from '../../../src/server/model/blocks.ts';

test('toolSummary table', () => {
  const rows: [string, Record<string, unknown>, string][] = [
    ['Bash', { command: 'npm ci\nnpm test', description: 'Install' }, 'npm ci'],
    ['PowerShell', { command: 'Get-ChildItem' }, 'Get-ChildItem'],
    ['Read', { file_path: 'C:\\w\\a.ts' }, 'C:\\w\\a.ts'],
    ['NotebookEdit', { notebook_path: 'nb.ipynb' }, 'nb.ipynb'],
    ['Grep', { pattern: 'TODO', path: 'src' }, 'TODO'],
    ['Glob', { pattern: '**/*.ts' }, '**/*.ts'],
    ['WebFetch', { url: 'https://x.dev/a', prompt: 'p' }, 'https://x.dev/a'],
    ['WebSearch', { query: 'preact signals' }, 'preact signals'],
    ['Agent', { description: 'Explorer le module', prompt: 'long' }, 'Explorer le module'],
    ['Skill', { skill: 'pdf' }, 'pdf'],
    ['AskUserQuestion', { questions: [{ question: 'Quelle lib ?' }] }, 'Quelle lib ?'],
    ['ExitPlanMode', { plan: 'stale', planFilePath: '.plans/p.md' }, '.plans/p.md'],
    ['TodoWrite', { todos: [{}, {}, {}] }, '3'],
    ['mcp__slack__post', { channel: '#dev', text: 'hi' }, '#dev'],
    ['Unknown', { a: 1, b: true }, 'a, b'],
  ];
  for (const [name, input, want] of rows) assert.equal(toolSummary(name, input), want, name);
});

test('toolInputView: long fields cut and listed; objects as JSON', () => {
  const v = toolInputView('Write', { file_path: 'a.ts', content: 'x'.repeat(FIELD_MAX_CHARS + 10), opts: { a: 1 }, n: 3, skip: null });
  assert.equal((v.fields['content'] as string).length, FIELD_MAX_CHARS);
  assert.deepEqual(v.truncated, ['content']);
  assert.equal(v.fields['opts'], '{"a":1}');
  assert.equal(v.fields['n'], 3);
  assert.ok(!('skip' in v.fields));
});

test('denial kinds and statuses (identical live and on disk)', () => {
  assert.equal(denialOf('user-rejected'), 'user');
  assert.equal(denialOf('permission-rule'), 'rule');
  assert.equal(denialOf('permission-rule', 'user_reject'), 'user');
  assert.equal(denialOf('automode-blocked'), 'auto');
  assert.equal(denialOf('automode-unavailable'), 'autoNa');
  assert.equal(denialOf('interrupted'), 'interrupted');
  assert.equal(denialOf('???'), undefined);
  assert.equal(toolStatusOf(true, 'rule', {}), 'denied');
  assert.equal(toolStatusOf(true, 'interrupted', {}), 'interrupted');
  assert.equal(toolStatusOf(false, undefined, { interrupted: true }), 'interrupted');
  assert.equal(toolStatusOf(true, undefined, {}), 'error');
  assert.equal(toolStatusOf(false, undefined, 'str'), 'ok');
});

test('extras: Edit patch counts, Grep counts, Agent facts, AskUserQuestion answers', () => {
  const e = liteToolResult('Edit', 'e', { content: 'ok', isError: false, toolUseResult: { filePath: 'a.ts', userModified: true, replaceAll: false,
    structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }] } });
  assert.deepEqual(e.result.data, { filePath: 'a.ts', userModified: true, replaceAll: false, added: 2, removed: 1 });
  assert.equal(e.result.patch?.length, 1);
  const g = liteToolResult('Grep', 'g', { content: 'f', isError: false, toolUseResult: { mode: 'files_with_matches', numFiles: 12, appliedLimit: 250, filenames: ['x'] } });
  assert.deepEqual(g.result.data, { mode: 'files_with_matches', numFiles: 12, appliedLimit: 250 });
  const a = liteToolResult('Agent', 'a', { content: [{ type: 'text', text: 'fini' }], isError: false, toolUseResult: { status: 'completed', agentType: 'Explore', totalTokens: 18000, prompt: 'long' } });
  assert.deepEqual(a.result.data, { status: 'completed', agentType: 'Explore', totalTokens: 18000 });
  const q = liteToolResult('AskUserQuestion', 'q', { content: 'x', isError: false, toolUseResult: { answers: { 'Quelle lib ?': 'date-fns' } } });
  assert.deepEqual(q.result.data, { q0: 'Quelle lib ?', a0: 'date-fns', answered: 1 });
  const s = liteToolResult('mcp__x__y', 's', { content: 'err', isError: false, toolUseResult: 'Error: boom' });
  assert.equal(s.result.summary, 'err');
});

test('patchOf caps the kept lines', () => {
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: Array.from({ length: 600 }, () => '+x') };
  const p = patchOf([hunk, hunk, hunk, hunk]);
  assert.equal(p.cut, true);
  assert.ok(p.patch.reduce((n, h) => n + h.lines.length, 0) <= PATCH_MAX_LINES);
  assert.deepEqual(patchOf('nope'), { patch: [], cut: false });
});
