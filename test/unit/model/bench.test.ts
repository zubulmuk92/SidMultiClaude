// test/unit/model/bench.test.ts — step() < 50 µs per delta frame (acceptance 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createLiveReducerX } from '../../../src/server/model/live-reducer.ts';
import * as B from './build.ts';
import { budget } from '../../helpers/perf.ts';

function warmReducer() {
  const r = createLiveReducerX({ chatId: B.CHAT, meta: { title: '', cwd: '', mode: 'default' }, metrics: {} });
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  r.step(B.msgStart('m1'), 1);
  r.step(B.blockStart(0, { type: 'thinking', thinking: '' }), 1);
  r.step(B.blockStart(1, { type: 'text', text: '' }), 1);
  return r;
}

test('step() takes < 50 µs per text / thinking delta frame', () => {
  const N = 20_000;
  const text = Array.from({ length: N }, (_, i) => B.textDelta(1, `mot${i} `));
  const think = Array.from({ length: N }, (_, i) => B.thinkingDelta(0, `pensée${i} `));
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    const r = warmReducer();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) { r.step(text[i]!, 2 + i); r.step(think[i]!, 2 + i); }
    best = Math.min(best, ((performance.now() - t0) * 1000) / (2 * N));
  }
  assert.ok(best < budget(50), `${best.toFixed(2)} µs per delta`);
});

test('thinking progress is throttled to ≤ 1/s per block; text deltas are all returned', () => {
  const r = warmReducer();
  let progress = 0, deltas = 0;
  for (let i = 0; i < 300; i++) {
    for (const e of r.step(B.thinkingDelta(0, 'ab'), 10 * i).events) if (e.k === 'progress') progress++;
    for (const e of r.step(B.textDelta(1, 'c'), 10 * i).events) if (e.k === 'delta') deltas++;
  }
  assert.equal(progress, 3);          // t = 0, 1000, 2000 (3 s of frames at 10 ms)
  assert.equal(deltas, 300);
  const out = r.step(B.textDelta(1, 'd'), 5_000);
  assert.equal(out.urgent, false);
});
