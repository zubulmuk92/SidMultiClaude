// test/unit/model/disk-turns.test.ts — diskToTurns display rules (SPEC §5.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diskToTurns, linearize } from '../../../src/server/model/disk-turns.ts';
import * as B from './build.ts';

const run = (entries: Record<string, unknown>[]) => diskToTurns(B.raw(entries), { sessionId: B.SID }).turns;

test('hidden entries: isMeta users, stop_hook_summary, attachments (except queued_command → folded user block)', () => {
  const turns = run([
    B.dUser('u1', 'Bonjour'),
    B.dUser('m1', 'caveat', { isMeta: true }),
    { type: 'attachment', uuid: 'at1', attachment: { type: 'instructions', files: [] } },
    { type: 'system', subtype: 'stop_hook_summary', uuid: 's1' },
    B.dAssistant('a1', 'msg1', { type: 'text', text: 'Salut' }),
    { type: 'attachment', uuid: 'at2', attachment: { type: 'queued_command', prompt: 'et aussi', source_uuid: 'q1' } },
    B.dAssistant('a2', 'msg2', { type: 'text', text: 'OK' }),
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]!.blocks.map((b) => b.id), ['a:msg1:0', 'u:q1', 'a:msg2:0']);
  const q = turns[0]!.blocks[1]!;
  assert.ok(q.k === 'user' && q.msg.text === 'et aussi' && q.msg.delivery === 'folded');
  assert.equal(turns[0]!.user?.text, 'Bonjour');
  assert.equal(turns[0]!.user?.origin, 'human');
});

test('rows: api_error → retry, isApiErrorMessage → error, interrupt text → interrupted, local_command → local', () => {
  const turns = run([
    B.dUser('u1', 'go'),
    { type: 'system', subtype: 'api_error', uuid: 'e1', error: { status: 529 }, retryAttempt: 2, maxRetries: 10, retryInMs: 8000 },
    B.dAssistant('a1', 'm0', { type: 'text', text: 'API Error: overloaded' }, { isApiErrorMessage: true, error: 'overloaded' }, '<synthetic>'),
    B.dUser('i1', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    { type: 'system', subtype: 'local_command', uuid: 'l1', content: '<local-command-stdout>ok</local-command-stdout>' },
  ]);
  assert.deepEqual(turns[0]!.blocks.map((b) => (b.k === 'system' ? [b.id, b.row.kind] : [b.id])), [
    ['x:e1', 'retry'], ['x:a1', 'error'], ['x:i1', 'interrupted'], ['x:l1', 'local'],
  ]);
  const retry = turns[0]!.blocks[0]!;
  assert.ok(retry.k === 'system' && retry.row.data?.['status'] === 529 && retry.row.data['attempt'] === 2);
});

test('compaction: boundary row, collapsed summary, earlier turns marked beforeCompaction', () => {
  const turns = run([
    B.dUser('u1', 'avant'),
    B.dAssistant('a1', 'm1', { type: 'text', text: 'réponse' }),
    B.dUser('c1', '<command-name>/compact</command-name>'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'cb', compactMetadata: { trigger: 'auto', preTokens: 182_000, postTokens: 24_000 } },
    B.dUser('sum', 'Résumé de la conversation…', { isCompactSummary: true }),
    B.dUser('u2', 'après'),
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns[0]!.beforeCompaction, true);
  assert.equal(turns[1]!.beforeCompaction, undefined);
  assert.equal(turns[2]!.beforeCompaction, undefined);
  assert.equal(turns[1]!.user?.origin, 'command');
  const kinds = turns[1]!.blocks.map((b) => (b.k === 'system' ? `${b.row.kind}${b.row.data?.['summary'] ? ':summary' : ''}` : b.k));
  assert.deepEqual(kinds, ['compact', 'compact:summary']);
});

test('assistant grouping: apiBlockIndex wins, else the ordinal per message.id; results attach by tool_use_id', () => {
  const turns = run([
    B.dUser('u1', 'go'),
    B.dAssistant('a1', 'm1', { type: 'thinking', thinking: 'hmm' }, { apiBlockIndex: 0 }),
    B.dAssistant('a2', 'm1', { type: 'tool_use', id: 'tA', name: 'Read', input: { file_path: 'a.ts' } }, { apiBlockIndex: 2 }),
    B.dAssistant('a3', 'm1', { type: 'tool_use', id: 'tB', name: 'Grep', input: { pattern: 'x' } }),
    B.dResult('r2', 'tB', 'no match', { toolDenialKind: 'permission-rule' }, true),
    B.dResult('r1', 'tA', 'contenu', { toolUseResult: { type: 'text', file: { filePath: 'a.ts', numLines: 1 } } }),
    { type: 'system', subtype: 'turn_duration', uuid: 'd1', durationMs: 4200 },
  ]);
  const t = turns[0]!;
  assert.deepEqual(t.blocks.map((b) => b.id), ['a:m1:0', 't:tA', 't:tB']);
  const a = t.blocks[1]!, b = t.blocks[2]!;
  assert.ok(a.k === 'tool' && a.status === 'ok' && a.input.summary === 'a.ts' && a.result?.data?.['filePath'] === 'a.ts');
  assert.ok(b.k === 'tool' && b.status === 'denied' && b.result?.denial === 'rule');
  assert.deepEqual(t.footer, { input: 5, cacheRead: 1000, cacheWrite: 10, output: 20, models: ['claude-opus-5-5'], durationMs: 4200 });
});

test('a tool left without result is interrupted once a later turn exists', () => {
  const turns = run([
    B.dUser('u1', 'go'),
    B.dAssistant('a1', 'm1', { type: 'tool_use', id: 'tX', name: 'Bash', input: { command: 'sleep 99' } }),
    B.dUser('u2', 'encore'),
  ]);
  const b = turns[0]!.blocks[0]!;
  assert.ok(b.k === 'tool' && b.status === 'interrupted');
});

test('origins: peer, task-notification, command', () => {
  const turns = run([
    B.dUser('p1', 'salut', { origin: { kind: 'peer' } }),
    B.dUser('t1', 'tâche finie', { origin: { kind: 'task-notification' } }),
    B.dUser('c1', '<command-name>/clear</command-name>'),
  ]);
  assert.deepEqual(turns.map((t) => t.user?.origin), ['peer', 'task', 'command']);
});

test('linearize: latest leaf, abandoned branches dropped, parallel tool results kept', () => {
  const e = (uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}) => ({ ...B.dUser(uuid, uuid), parentUuid, ...extra });
  const chain = linearize(B.raw([
    e('u1', null),
    { ...B.dAssistant('a1', 'm1', { type: 'tool_use', id: 't1', name: 'Bash', input: {} }), parentUuid: 'u1' },
    { ...B.dAssistant('a2', 'm1', { type: 'tool_use', id: 't2', name: 'Bash', input: {} }), parentUuid: 'a1' },
    { ...B.dResult('r1', 't1', 'x'), parentUuid: 'a2', sourceToolAssistantUUID: 'a1' },
    { ...B.dResult('r2', 't2', 'y'), parentUuid: 'r1', sourceToolAssistantUUID: 'a2' },
    e('old', 'r2'),
    e('new', 'r2'),
    { type: 'custom-title', customTitle: 'x' },
  ]));
  assert.deepEqual(chain.map((r) => r.e['uuid']), ['u1', 'a1', 'a2', 'r1', 'r2', 'new']);
});
