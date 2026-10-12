// test/unit/model/reducer-blocks.test.ts — SPEC §5.5 frame table: blocks, users, results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveReducerX } from '../../../src/server/model/live-reducer.ts';
import type * as P from '../../../src/shared/protocol.ts';
import * as B from './build.ts';

const mk = () => createLiveReducerX({ chatId: B.CHAT, meta: { title: '', cwd: '', mode: 'default', model: 'claude-opus-5-5' }, metrics: {} });
const kinds = (ev: P.ChatEvent[]): string[] => ev.map((e) => e.k);

test('stream blocks: ids a:<message.id>:<index> / t:<id>, live flags, deltas, then the final assistant content', () => {
  const r = mk();
  assert.deepEqual(kinds(r.userStarted({ uuid: 'u1', text: 'salut', images: 0, folded: false, at: 0 })), ['turn.start']);
  r.step(B.msgStart('m1'), 1);
  const s1 = r.step(B.blockStart(0, { type: 'text', text: '' }), 2);
  assert.equal(s1.signals.sub, 'writing');
  assert.deepEqual(s1.events[0], { k: 'block', turnId: 'u:u1', block: { k: 'text', id: 'a:m1:0', md: '', live: true, model: 'claude-opus-5-5' } });
  const d = r.step(B.textDelta(0, 'Bon'), 3);
  assert.deepEqual(d.events, [{ k: 'delta', parts: [['a:m1:0', 'Bon']] }]);
  assert.equal(d.urgent, false);
  r.step(B.textDelta(0, 'jour'), 3);
  const a = r.step(B.assistant('m1', { type: 'text', text: 'Bonjour' }), 4);
  assert.deepEqual(a.events, [{ k: 'block', turnId: 'u:u1', block: { k: 'text', id: 'a:m1:0', md: 'Bonjour', model: 'claude-opus-5-5' } }]);
  const t = r.step(B.blockStart(1, { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }), 5);
  assert.equal(t.signals.sub, 'tool');
  assert.equal(t.signals.subTool, 'Bash');
  assert.equal(r.step(B.stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"co' } }), 5).events.length, 0);
  r.step(B.assistant('m1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: 'Tests' } }), 6);
  const tool = r.liveTurn()!.blocks.find((b) => b.id === 't:tu1');
  assert.ok(tool?.k === 'tool' && tool.status === 'running' && tool.input.summary === 'npm test' && tool.input.fields['description'] === 'Tests');
  const p1 = r.step(B.result(), 7);
  assert.ok(p1.urgent);
  assert.ok(p1.signals.turnEnded);
  assert.equal(p1.signals.sub, null);
});

test('assistant frames without stream events use the ordinal per message.id', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  r.step(B.assistant('m9', { type: 'thinking', thinking: '' }), 1);
  r.step(B.assistant('m9', { type: 'text', text: 'a' }), 1);
  assert.deepEqual(r.liveTurn()!.blocks.map((b) => b.id), ['a:m9:0', 'a:m9:1']);
});

test('tool_result → tool.result with status; denial kinds; interrupt marker → interrupted row', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  for (const id of ['ok', 'err', 'den', 'int']) r.step(B.assistant('m1', { type: 'tool_use', id, name: 'Bash', input: { command: id } }), 1);
  const ok = r.step(B.toolResult('ok', 'fine', { tool_use_result: { stdout: 'fine', stderr: '' } }), 2).events[0];
  assert.ok(ok?.k === 'tool.result' && ok.status === 'ok' && ok.result.summary === 'fine' && ok.turnId === 'u:u1');
  const er = r.step(B.toolResult('err', 'Exit code 1', {}, true), 2).events[0];
  assert.ok(er?.k === 'tool.result' && er.status === 'error' && er.result.isError);
  const dn = r.step(B.toolResult('den', 'no', { tool_result_meta: [{ id: 'den', non_execution_kind: 'user-rejected' }] }, true), 2).events[0];
  assert.ok(dn?.k === 'tool.result' && dn.status === 'denied' && dn.result.denial === 'user');
  const it = r.step(B.toolResult('int', 'x', { tool_use_result: { stdout: '', interrupted: true } }), 2).events[0];
  assert.ok(it?.k === 'tool.result' && it.status === 'interrupted');
  const mark = r.step({ type: 'user', uuid: 'iu', session_id: B.SID, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } } as never, 3).events;
  assert.deepEqual(mark, [{ k: 'system', turnId: 'u:u1', id: 'x:iu', row: { kind: 'interrupted', text: '[Request interrupted by user]' } }]);
  assert.ok(r.liveTurn()!.blocks.some((b) => b.id === 'x:iu'));
});

test('result: footer, live blocks frozen, aborted text on interrupt, metrics', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  r.step(B.msgStart('m1'), 1);
  r.step(B.blockStart(0, { type: 'text', text: '' }), 1);
  r.step(B.textDelta(0, 'part'), 1);
  const out = r.step(B.result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' }), 2);
  const blk = out.events.find((e) => e.k === 'block');
  assert.ok(blk?.k === 'block' && blk.block.k === 'text' && blk.block.aborted === true && blk.block.live === undefined);
  const end = out.events.find((e) => e.k === 'turn.end');
  assert.ok(end?.k === 'turn.end' && end.footer.interrupted === true && end.footer.terminal === 'aborted_streaming' && end.turnId === 'u:u1');
  assert.deepEqual(end.footer.models, ['claude-opus-5-5']);
  assert.ok(out.events.some((e) => e.k === 'metrics'));
  assert.equal(r.liveTurn()!.footer?.durationMs, 1000);
});

test('userStarted folded adds a user block in the running turn; folded result uuids mark deliveries', () => {
  const r = mk();
  r.step(B.lifecycle('u1', 'queued'), 0);
  r.userStarted({ uuid: 'u1', text: 'a', images: 2, folded: false, at: 0 });
  const ev = r.userStarted({ uuid: 'u2', text: 'b', images: 0, folded: true, at: 1 });
  assert.deepEqual(kinds(ev), ['block']);
  const t = r.liveTurn()!;
  assert.equal(t.id, 'u:u1');
  assert.deepEqual(t.user?.images?.map((i) => i.ref), ['u:u1#0', 'u:u1#1']);
  assert.ok(t.blocks.some((b) => b.k === 'user' && b.id === 'u:u2' && b.msg.delivery === 'folded'));
  r.step(B.result({ user_message_uuid: 'u1', user_message_uuids: ['u1', 'u3'] }), 2);
  r.step(B.lifecycle('u3', 'completed'), 3);
  assert.equal(r.deliveries()['u3'], 'folded');
  r.step(B.lifecycle('u1', 'completed'), 3);
  assert.equal(r.deliveries()['u1'], 'completed');
});

test('assistant errors become signals and error rows; usage-limit result text → rateLimit', () => {
  const cases: [string, keyof import('../../../src/server/contracts.ts').FrameSignals][] = [
    ['authentication_failed', 'authError'], ['billing_error', 'billingError'], ['model_not_found', 'modelNotFound'], ['overloaded', 'overloaded'], ['rate_limit', 'rateLimit'],
  ];
  for (const [err, sig] of cases) {
    const r = mk();
    r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
    const out = r.step(B.assistant('m1', { type: 'text', text: 'API Error' }, { error: err, isApiErrorMessage: true }, '<synthetic>'), 1);
    assert.ok(out.signals[sig], err);
    assert.ok(out.events.some((e) => e.k === 'system' && e.row.kind === 'error'));
  }
  const r = mk();
  const out = r.step(B.result({ is_error: true, subtype: 'success', result: "You've hit your limit · resets 3pm" }), 1);
  assert.equal(out.signals.rateLimit?.status, 'rejected');
});

test('synthetic local answer (/usage) → local row; subagent frames never touch the main turn', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: '/usage', images: 0, folded: false, at: 0 });
  const out = r.step(B.assistant('m1', { type: 'text', text: '## Usage' }, { usage_report: { rows: [] } }, '<synthetic>'), 1);
  assert.deepEqual(out.events, [{ k: 'system', turnId: 'u:u1', id: 'x:as-m1-text', row: { kind: 'local', text: '## Usage', data: { usageReport: true } } }]);
  const sub = r.step(B.assistant('m2', { type: 'text', text: 'sub' }, { parent_tool_use_id: 'tuX' }), 2);
  assert.equal(sub.events.length, 0);
  assert.equal(r.liveTurn()!.blocks.length, 1);
});
