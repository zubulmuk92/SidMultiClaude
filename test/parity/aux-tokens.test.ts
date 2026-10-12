// test/parity/aux-tokens.test.ts — T-P4: the auxTokens sentinel (Δ Σ modelUsage − main usage) is 0 on plain recorded turns and flags a
// B1-style hidden title call (tokens.md §2: modelUsage +1,174 in / +15 out over the main usage). SPEC §2.12, §11 WP-A.8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auxTokens, modelUsageTotal, usageTokens } from '../../src/server/model/accounting.ts';
import { loadFrames } from '../helpers/scenario.ts';
import type { FixtureName } from '../helpers/scenario.ts';

type R = { usage?: unknown; modelUsage?: unknown };
/** auxTokens of every result after the first of one process (the first has no baseline in that process). */
function sentinel(results: readonly R[]): number[] {
  const out: number[] = [];
  let prev: number | undefined;
  for (const r of results) {
    const cur = modelUsageTotal(r.modelUsage);
    const a = auxTokens(prev, cur, usageTokens(r.usage));
    if (a !== undefined) out.push(a);
    prev = cur;
  }
  return out;
}

test('T-P4: auxTokens is 0 on every plain recorded turn (main, plan fixtures)', () => {
  for (const name of ['main', 'plan'] as FixtureName[]) {
    const results = loadFrames(name).map((r) => r.m as Record<string, unknown>).filter((m) => m['type'] === 'result') as R[];
    const s = sentinel(results);
    assert.ok(results.length >= 1, name);
    assert.deepEqual(s, s.map(() => 0), `${name}: ${JSON.stringify(s)}`);
  }
});

test('T-P4: a B1-style hidden title call is flagged (> 0, = its tokens)', () => {
  const m = 'claude-haiku-5-5';
  const mu = (i: number, o: number, cr: number, cw: number) => ({ [m]: { inputTokens: i, outputTokens: o, cacheReadInputTokens: cr, cacheCreationInputTokens: cw } });
  const turn1 = { usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 16_790, cache_creation_input_tokens: 20_360 }, modelUsage: mu(2, 4, 16_790, 20_360) };
  const turn2 = { usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 37_154, cache_creation_input_tokens: 81 },
    modelUsage: mu(2 + 2 + 1_174, 4 + 4 + 15, 16_790 + 37_154, 20_360 + 81) };   // turn 2 also paid a title call
  assert.deepEqual(sentinel([turn1, turn2]), [1_189]);
  const plain2 = { ...turn2, modelUsage: mu(4, 8, 16_790 + 37_154, 20_360 + 81) };
  assert.deepEqual(sentinel([turn1, plain2]), [0]);
});
