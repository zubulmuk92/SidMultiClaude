// test/unit/model/payload.test.ts — heavy fields never reach events or pages (SPEC §11 acceptance 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveReducerX } from '../../../src/server/model/live-reducer.ts';
import { detailFromEntry, diskToTurns } from '../../../src/server/model/disk-turns.ts';
import { liteToolResult } from '../../../src/server/model/tools-lite.ts';
import { TOOL_OUTPUT_HEAD_BYTES, TOOL_OUTPUT_TAIL_BYTES } from '../../../src/shared/limits.ts';
import { loadPair, transcriptRawEntries } from '../../helpers/scenario.ts';
import { replay } from './replay.ts';
import * as B from './build.ts';

const THINK = 'SECRET-THINKING-TEXT';
const B64 = 'QUJDRA'.repeat(2000);
const ORIG = 'ORIGINAL-FILE-CONTENT\n'.repeat(50);
const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(10)}`).join('\n');
const writeTur = { type: 'update', filePath: 'C:\\w\\a.ts', content: 'new', originalFile: ORIG, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] };

function liveRun(): { events: string; r: ReturnType<typeof createLiveReducerX> } {
  const r = createLiveReducerX({ chatId: B.CHAT, meta: { title: '', cwd: '', mode: 'default' }, metrics: {} });
  const ev: unknown[] = [];
  ev.push(...r.userStarted({ uuid: 'u1', text: 'hello', images: 1, folded: false, at: 1 }));
  const frames = [
    B.msgStart('m1'), B.blockStart(0, { type: 'thinking', thinking: '' }), B.thinkingDelta(0, THINK),
    B.assistant('m1', { type: 'thinking', thinking: THINK, signature: 'sig' }),
    B.blockStart(1, { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }),
    B.assistant('m1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat big.txt' } }),
    B.blockStart(2, { type: 'tool_use', id: 'tu2', name: 'Write', input: {} }),
    B.assistant('m1', { type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: 'C:\\w\\a.ts', content: 'new' } }),
    B.blockStart(3, { type: 'tool_use', id: 'tu3', name: 'Read', input: {} }),
    B.assistant('m1', { type: 'tool_use', id: 'tu3', name: 'Read', input: { file_path: 'C:\\w\\p.png' } }),
    B.toolResult('tu1', BIG, { tool_use_result: { stdout: BIG, stderr: '', interrupted: false } }),
    B.toolResult('tu2', 'ok', { tool_use_result: writeTur }),
    B.toolResult('tu3', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } }], { tool_use_result: { type: 'image' } }),
    B.result(),
  ];
  for (const fr of frames) ev.push(...r.step(fr, 2).events);
  ev.push(r.liveTurn());
  return { events: JSON.stringify(ev), r };
}

test('live: no thinking text, base64 or originalFile in any event; detail() serves them', () => {
  const { events, r } = liveRun();
  assert.ok(!events.includes(THINK), 'thinking text leaked');
  assert.ok(!events.includes(B64.slice(0, 64)), 'base64 leaked');
  assert.ok(!events.includes('ORIGINAL-FILE-CONTENT'), 'originalFile leaked');
  assert.ok(!events.includes('"originalFile"'));
  assert.equal(r.detail('a:m1:0', 'thinking')?.text, THINK);
  assert.equal(r.detail('t:tu2', 'originalFile')?.text, ORIG);
  assert.equal(r.detail('t:tu1', 'output')?.text, BIG);
  assert.ok(r.detail('t:tu3#0', 'image')?.dataUrl?.startsWith('data:image/png;base64,QUJD'));
  const t = r.liveTurn()!;
  const bash = t.blocks.find((b) => b.id === 't:tu1');
  assert.ok(bash?.k === 'tool' && bash.result?.truncated === true);
  assert.equal(bash.result.head?.length, TOOL_OUTPUT_HEAD_BYTES);
  assert.equal(bash.result.tail?.length, TOOL_OUTPUT_TAIL_BYTES);
  assert.equal(bash.result.tail, BIG.slice(-TOOL_OUTPUT_TAIL_BYTES));
  assert.equal(bash.result.totalLines, 3000);
  const write = t.blocks.find((b) => b.id === 't:tu2');
  assert.ok(write?.k === 'tool' && write.result?.data?.['hasOriginal'] === true && write.result.data['added'] === 1 && write.result.data['removed'] === 1);
});

test('disk: same rule on pages; HeavyLoc points at the transcript line', () => {
  const chain = B.raw([
    B.dUser('u1', [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } }]),
    B.dAssistant('a1', 'm1', { type: 'thinking', thinking: THINK, signature: 's' }, { parentUuid: 'u1' }),
    B.dAssistant('a2', 'm1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat big.txt' } }, { parentUuid: 'a1' }),
    B.dResult('r1', 'tu1', BIG, { toolUseResult: { stdout: BIG, stderr: '' }, parentUuid: 'a2' }),
    B.dAssistant('a3', 'm1', { type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: 'a.ts', content: 'new' } }, { parentUuid: 'r1' }),
    B.dResult('r2', 'tu2', 'ok', { toolUseResult: writeTur, parentUuid: 'a3' }),
  ]);
  const { turns, heavy } = diskToTurns(chain, { sessionId: B.SID });
  const json = JSON.stringify(turns);
  assert.ok(!json.includes(THINK) && !json.includes(B64.slice(0, 64)) && !json.includes('ORIGINAL-FILE-CONTENT'));
  const kinds = heavy.map((h) => `${h.id}|${h.field}`).sort();
  assert.deepEqual(kinds, ['a:m1:0|thinking', 't:tu1|output', 't:tu2|originalFile', 'u:u1#0|image'].sort());
  for (const h of heavy) {
    const entry = chain.find((c) => c.off === h.off && c.len === h.len);
    assert.ok(entry, `loc of ${h.id}`);
    const d = detailFromEntry(entry.e, h.id, h.field);
    assert.ok(d && (d.text || d.dataUrl), `detail of ${h.id} ${h.field}`);
  }
  assert.equal(detailFromEntry(chain[1]!.e, 'a:m1:0', 'thinking')?.text, THINK);
});

test('fixtures: no base64 or originalFile in live events or disk pages', () => {
  for (const name of ['main', 'plan', 'fork'] as const) {
    const p = loadPair(name);
    const live = JSON.stringify(replay(p.frames, p.inputs).events);
    const disk = JSON.stringify(diskToTurns(transcriptRawEntries(name), { sessionId: '' }).turns);
    for (const s of [live, disk]) {
      assert.ok(!s.includes('"originalFile"'), `${name} originalFile`);
      assert.ok(!/"type":"base64"/.test(s) && !/data:image\//.test(s), `${name} base64`);
    }
  }
});

test('liteToolResult: small outputs are kept whole; images become refs', () => {
  const r = liteToolResult('Bash', 'x', { content: 'a\nb', isError: false, toolUseResult: { stdout: 'a\nb', stderr: '' } });
  assert.equal(r.result.head, 'a\nb');
  assert.equal(r.result.tail, undefined);
  assert.equal(r.heavy.length, 0);
  const im = liteToolResult('Read', 'y', { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }], isError: false, toolUseResult: {} });
  assert.deepEqual(im.result.images, [{ ref: 't:y#0', mediaType: 'image/jpeg', bytes: 3 }]);
});
