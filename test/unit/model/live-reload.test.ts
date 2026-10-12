// test/unit/model/live-reload.test.ts — the "live = reload" invariant (SPEC §11 acceptance 2).
// For every pairs/<name>: the turns built from the live frames equal diskToTurns(transcript) on ids, kinds, texts,
// statuses and tool summaries. The fork transcript also holds the copied history of its parent: the live process
// only produced the last turn(s), so the comparison is on the tail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPair, transcriptRawEntries } from '../../helpers/scenario.ts';
import type { PairName } from '../../helpers/scenario.ts';
import { replay, shape } from './replay.ts';
import { diskToTurns, linearize } from '../../../src/server/model/disk-turns.ts';

for (const name of ['main', 'plan', 'fork'] as PairName[]) {
  test(`live = reload: ${name}`, () => {
    const p = loadPair(name);
    const live = replay(p.frames, p.inputs).turns;
    const disk = diskToTurns(linearize(transcriptRawEntries(name)), { sessionId: '' }).turns;
    assert.ok(live.length > 0);
    const tail = name === 'fork' ? disk.slice(-live.length) : disk;
    assert.deepEqual(shape(live), shape(tail));
    // user origins and delivery-independent fields match too
    live.forEach((t, i) => assert.equal(t.user?.origin ?? null, tail[i]!.user?.origin ?? null));
  });
}

test('live = reload: tool results carry the same denial kinds and image refs', () => {
  const p = loadPair('main');
  const live = replay(p.frames, p.inputs).turns;
  const disk = diskToTurns(linearize(transcriptRawEntries('main')), { sessionId: '' }).turns;
  const tools = (ts: typeof live): unknown[] => ts.flatMap((t) => t.blocks).flatMap((b) => (b.k === 'tool'
    ? [{ id: b.id, denial: b.result?.denial ?? null, isError: b.result?.isError ?? null, images: b.result?.images?.map((x) => x.ref) ?? [] }] : []));
  assert.deepEqual(tools(live), tools(disk));
  const denied = tools(live).filter((x) => (x as { denial: string | null }).denial !== null);
  assert.ok(denied.length > 0, 'the main fixture records denials');
});

test('disk: the fork transcript keeps the copied history before the new turn', () => {
  const disk = diskToTurns(linearize(transcriptRawEntries('fork')), { sessionId: '' }).turns;
  const main = diskToTurns(linearize(transcriptRawEntries('main')), { sessionId: '' }).turns;
  assert.ok(disk.length > 1);
  assert.equal(disk[0]!.id, main[0]!.id);
});

for (const name of ['main', 'plan', 'fork'] as PairName[]) {
  test(`live = reload without stream events (assistant frames only): ${name}`, () => {
    const p = loadPair(name);
    const live = replay(p.frames.filter((f) => f.m['type'] !== 'stream_event'), p.inputs).turns;
    const disk = diskToTurns(linearize(transcriptRawEntries(name)), { sessionId: '' }).turns;
    assert.deepEqual(shape(live), shape(name === 'fork' ? disk.slice(-live.length) : disk));
  });
}
