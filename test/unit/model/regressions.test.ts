// test/unit/model/regressions.test.ts — regression tests for defects found in review, one test each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveReducerX } from '../../../src/server/model/live-reducer.ts';
import { diskToTurns } from '../../../src/server/model/disk-turns.ts';
import { liteToolResult, toolData, utf8Head, utf8Tail } from '../../../src/server/model/tools-lite.ts';
import { TOOL_OUTPUT_HEAD_BYTES, TOOL_OUTPUT_TAIL_BYTES } from '../../../src/shared/limits.ts';
import type * as P from '../../../src/shared/protocol.ts';
import * as B from './build.ts';

const mk = (o: { resumed?: boolean; metrics?: P.ChatMetrics } = {}) =>
  createLiveReducerX({ chatId: B.CHAT, meta: { title: '', cwd: '', mode: 'default' }, metrics: o.metrics ?? {}, ...(o.resumed ? { resumed: true } : {}) });
const ids = (t: P.UiTurn | null): string[] => (t ? t.blocks.map((b) => `${b.id}:${b.k}`) : []);

test('CLI-initiated turn (task notification, no userStarted): streamed blocks open a system turn and stream', () => {
  const r = mk();
  r.step(B.init('i1'), 1);
  r.step(B.msgStart('m1'), 2);
  const start = r.step(B.blockStart(0, { type: 'thinking', thinking: '' }), 3).events;
  assert.deepEqual(start.map((e) => e.k), ['turn.start', 'block']);
  assert.ok(start[0]?.k === 'turn.start' && start[0].turn.id === 'x:i1');
  r.step(B.blockStart(1, { type: 'text', text: '' }), 4);
  const d = r.step(B.textDelta(1, 'Bonjour'), 5).events;
  assert.deepEqual(d, [{ k: 'delta', parts: [['a:m1:1', 'Bonjour']] }]);
  r.step(B.assistant('m1', { type: 'thinking', thinking: 'hmm' }), 6);
  r.step(B.assistant('m1', { type: 'text', text: 'Bonjour' }), 7);
  assert.deepEqual(ids(r.liveTurn()), ['a:m1:0:thinking', 'a:m1:1:text']);
  assert.equal(r.faults(), 0);
});

test('CLI-initiated turn without stream events: one id per block of the message (no overwrite)', () => {
  const r = mk();
  r.step(B.init('i2'), 1);
  r.step(B.assistant('m2', { type: 'thinking', thinking: 'hmm' }), 2);
  r.step(B.assistant('m2', { type: 'text', text: 'Fini' }), 3);
  r.step(B.assistant('m2', { type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'ls' } }), 4);
  assert.deepEqual(ids(r.liveTurn()), ['a:m2:0:thinking', 'a:m2:1:text', 't:tu9:tool']);
  // same ids as the disk rebuild of the same three entries
  const disk = diskToTurns(B.raw([
    B.dAssistant('e1', 'm2', { type: 'thinking', thinking: 'hmm' }, { apiBlockIndex: 0 }),
    B.dAssistant('e2', 'm2', { type: 'text', text: 'Fini' }, { apiBlockIndex: 1, parentUuid: 'e1' }),
    B.dAssistant('e3', 'm2', { type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'ls' } }, { apiBlockIndex: 2, parentUuid: 'e2' }),
  ]), { sessionId: B.SID }).turns;
  assert.deepEqual(disk.flatMap((t) => ids(t)), ids(r.liveTurn()));
});

test('events are snapshots: later deltas never change an emitted block, a snapshot or a turn head', () => {
  const r = mk();
  const head = r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  r.step(B.msgStart('m1'), 1);
  const ev = r.step(B.blockStart(0, { type: 'text', text: '' }), 2).events;
  const snap = r.liveTurn()!;
  r.step(B.textDelta(0, 'Hello'), 3);
  r.step(B.lifecycle('u1', 'completed'), 4);
  const blockEv = ev.find((e) => e.k === 'block');
  assert.ok(blockEv?.k === 'block' && blockEv.block.k === 'text' && blockEv.block.md === '');
  assert.ok(snap.blocks[0]?.k === 'text' && snap.blocks[0].md === '');
  assert.ok(head[0]?.k === 'turn.start' && head[0].turn.user?.delivery === 'started');
  const now = r.liveTurn()!;
  assert.ok(now.blocks[0]?.k === 'text' && now.blocks[0].md === 'Hello');
  assert.equal(now.user?.delivery, 'completed');
});

test('the partial assistant frame of an interrupt (aborted:true) marks its text block aborted, as isAbortedMidStream on disk', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  r.step(B.msgStart('m1'), 1);
  r.step(B.blockStart(0, { type: 'text', text: '' }), 2);
  r.step(B.textDelta(0, 'Je comm'), 3);
  r.step(B.assistant('m1', { type: 'text', text: 'Je comm' }, { aborted: true }), 4);
  const b = r.liveTurn()!.blocks[0];
  assert.ok(b?.k === 'text' && b.aborted === true && b.live === undefined);
  const disk = diskToTurns(B.raw([B.dUser('u1', 'x'), B.dAssistant('a1', 'm1', { type: 'text', text: 'Je comm' }, { parentUuid: 'u1', isAbortedMidStream: true })]), { sessionId: B.SID }).turns;
  const db = disk[0]!.blocks[0];
  assert.ok(db?.k === 'text' && db.aborted === true);
});

test('an `error` on a real model message keeps its content (as on disk) and still raises the signal', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  const out = r.step(B.assistant('m1', { type: 'text', text: 'partiel' }, { error: 'max_output_tokens' }), 1);
  assert.deepEqual(ids(r.liveTurn()), ['a:m1:0:text']);
  assert.deepEqual(out.signals, {});
  const syn = r.step(B.assistant('m2', { type: 'text', text: 'API Error: 529' }, { error: 'overloaded', uuid: 'e1' }, '<synthetic>'), 2);
  assert.equal(syn.signals.overloaded, true);
  assert.ok(r.liveTurn()!.blocks.some((b) => b.id === 'x:e1' && b.k === 'system' && b.row.kind === 'error'));
});

test('cost of a resumed process: unknown without its cost-state (never the cumulative total); exact with metrics.costUsd', () => {
  const footer = (r: ReturnType<typeof mk>, total: number): P.TurnFooter | undefined => {
    r.userStarted({ uuid: `u${total}`, text: 'x', images: 0, folded: false, at: 0 });
    const ev = r.step(B.result({ total_cost_usd: total }), 1).events;
    const e = ev.find((x) => x.k === 'turn.end');
    return e?.k === 'turn.end' ? e.footer : undefined;
  };
  const blind = mk({ resumed: true });
  assert.equal(footer(blind, 0.5)?.costUsd, undefined);
  assert.equal(footer(blind, 0.75)?.costUsd, 0.25);
  const seeded = mk({ metrics: { costUsd: 0.5 } });          // the frozen-contract path: the server seeds metrics.costUsd
  assert.equal(footer(seeded, 0.75)?.costUsd, 0.25);
  assert.equal(footer(mk(), 0.01)?.costUsd, 0.01);           // brand-new session: Δ from 0
});

test('tool outputs are cut to 4 KiB of UTF-8 head + tail (CJK / emoji included), never inside a surrogate pair', () => {
  const big = '漢字テキスト😀'.repeat(1500);                   // 8 UTF-16 units / 22 UTF-8 bytes per repeat
  const r = liteToolResult('Bash', 'b1', { content: big, isError: false, toolUseResult: { stdout: big, stderr: '错'.repeat(5000) } });
  const head = r.result.head ?? '', tail = r.result.tail ?? '';
  assert.equal(r.result.truncated, true);
  assert.ok(Buffer.byteLength(head, 'utf8') <= TOOL_OUTPUT_HEAD_BYTES && Buffer.byteLength(head, 'utf8') > TOOL_OUTPUT_HEAD_BYTES - 4);
  assert.ok(Buffer.byteLength(tail, 'utf8') <= TOOL_OUTPUT_TAIL_BYTES && Buffer.byteLength(tail, 'utf8') > TOOL_OUTPUT_TAIL_BYTES - 4);
  assert.ok(big.startsWith(head) && big.endsWith(tail));
  assert.ok(!/[\uD800-\uDBFF]$/.test(head) && !/^[\uDC00-\uDFFF]/.test(tail));
  assert.ok(Buffer.byteLength(String(r.result.data?.['stderr']), 'utf8') <= TOOL_OUTPUT_HEAD_BYTES);
  assert.deepEqual(r.heavy.map((h) => h.field), ['output']);
  assert.equal(utf8Head('a😀b', 4), 'a');
  assert.equal(utf8Tail('a😀b', 5), '😀b');
  const small = liteToolResult('Bash', 'b2', { content: 'é'.repeat(5000), isError: false, toolUseResult: {} });
  assert.equal(small.result.truncated, true, '5000 chars = 10 000 bytes > 8 KiB');
});

test('unknown / MCP tool results: no file copy or inline payload in UiToolResult.data', () => {
  const d = toolData('mcp__x__edit', { originalFile: 'FULL FILE', original_file: 'FULL', base64: 'QUJD', img: 'data:image/png;base64,QUJD', ok: true, path: 'a.ts' });
  assert.deepEqual(d, { ok: true, path: 'a.ts' });
});

test('hook rows cut a huge stderr', () => {
  const r = mk();
  const ev = r.step({ type: 'system', subtype: 'hook_response', uuid: 'h1', session_id: B.SID, hook_name: 'Stop', hook_event: 'Stop', outcome: 'error', stderr: 'e'.repeat(100_000) } as never, 1).events;
  const row = ev.find((e) => e.k === 'system');
  assert.ok(row?.k === 'system' && (row.row.text?.length ?? 0) <= TOOL_OUTPUT_HEAD_BYTES);
});

test('local command output: same text live and on disk (transcript wrappers dropped)', () => {
  const r = mk();
  r.step(B.init('i1'), 1);
  const ev = r.step({ type: 'system', subtype: 'local_command_output', uuid: 'l1', session_id: B.SID, content: '<local-command-stdout>Coût : 0 $</local-command-stdout>' } as never, 2).events;
  const live = ev.find((e) => e.k === 'system');
  const disk = diskToTurns(B.raw([{ type: 'system', subtype: 'local_command', uuid: 'l1', content: '<local-command-stdout>Coût : 0 $</local-command-stdout>' }]), { sessionId: B.SID }).turns;
  const d = disk[0]!.blocks[0];
  assert.ok(live?.k === 'system' && d?.k === 'system');
  assert.equal(live.row.text, 'Coût : 0 $');
  assert.deepEqual([live.id, live.row.kind, live.row.text], [d.id, d.row.kind, d.row.text]);
});

test('command_lifecycle refused is a delivery state', () => {
  const r = mk();
  r.step(B.lifecycle('q1', 'queued'), 1);
  r.step(B.lifecycle('q1', 'refused'), 2);
  assert.equal(r.deliveries()['q1'], 'refused');
});

test('a process that exits mid-turn leaves nothing running (open tool → interrupted, live text cut)', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'go', images: 0, folded: false, at: 1 });
  r.step(B.init('i1'), 2);
  r.step(B.msgStart('m1'), 3);
  r.step(B.blockStart(0, { type: 'text', text: '' }), 4);
  r.step(B.textDelta(0, 'Je lance'), 5);
  r.step(B.assistant('m1', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }), 6);
  r.step(B.msgStart('m2'), 7);
  r.step(B.blockStart(0, { type: 'text', text: '' }), 8);
  r.step(B.textDelta(0, 'en cours'), 9);
  const before = r.liveTurn()!.blocks.map((b) => (b.k === 'tool' ? `tool:${b.status}` : b.k === 'text' ? `text:${b.live ? 'live' : 'done'}` : b.k));
  assert.ok(before.includes('tool:running') && before.includes('text:live'), before.join(','));
  const ev = r.processExited!();
  const after = r.liveTurn()!.blocks;
  assert.ok(after.every((b) => !(b.k === 'tool' && (b.status === 'running' || b.status === 'asking'))), 'no tool left running');
  assert.ok(after.every((b) => !((b.k === 'text' || b.k === 'thinking') && b.live)), 'no live text left');
  assert.ok(after.some((b) => b.k === 'text' && b.aborted), 'the cut text is marked aborted');
  assert.ok(ev.some((e) => e.k === 'block' && e.block.k === 'tool' && e.block.status === 'interrupted'), 'running → interrupted (asking → withdrawn)');
  assert.deepEqual(r.processExited!(), [], 'idempotent');
});

test('diskToTurns `closed` interrupts the last turn\'s tools left without a result (cold chat after a crash)', () => {
  const chain = B.raw([B.dUser('u1', 'go'), B.dAssistant('a1', 'm1', { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'x' } })]);
  const open = diskToTurns(chain, { sessionId: B.SID }).turns.at(-1)!.blocks.find((b) => b.k === 'tool');
  const closed = diskToTurns(chain, { sessionId: B.SID, closed: true }).turns.at(-1)!.blocks.find((b) => b.k === 'tool');
  assert.equal(open?.k === 'tool' && open.status, 'running');
  assert.equal(closed?.k === 'tool' && closed.status, 'interrupted');
});

test('a tool whose ask was still open when the process died is « withdrawn » (Demande annulée)', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'go', images: 0, folded: false, at: 1 });
  r.step(B.init('i1'), 2);
  r.step(B.msgStart('m1'), 3);
  r.step(B.assistant('m1', { type: 'tool_use', id: 'toolu_7', name: 'Bash', input: { command: 'npm ci' } }), 4);
  r.processExited!(new Set(['toolu_7']));
  const t = r.liveTurn()!.blocks.find((b) => b.k === 'tool');
  assert.equal(t?.k === 'tool' && t.status, 'withdrawn');
});
