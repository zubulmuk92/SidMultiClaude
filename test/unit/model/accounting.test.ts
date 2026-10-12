// test/unit/model/accounting.test.ts — SPEC §2.12 (acceptance 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auxTokens, autoCompactAt, baselineFromEntries, cacheMissCause, contextOf, costDelta, footerFromUsages, isCacheMiss, ttlFromUsage,
  usageTokens, wakeDialog, wakeEstimate,
} from '../../../src/server/model/accounting.ts';
import { createLiveReducerX } from '../../../src/server/model/live-reducer.ts';
import { loadPair, transcriptRawEntries } from '../../helpers/scenario.ts';
import { replay } from './replay.ts';
import * as B from './build.ts';
import type * as P from '../../../src/shared/protocol.ts';

const footers = (ev: P.ChatEvent[]): P.TurnFooter[] => ev.flatMap((e) => (e.k === 'turn.end' ? [e.footer] : []));

test('auxTokens is 0 on every turn of the plain fixtures', () => {
  for (const name of ['main', 'plan'] as const) {
    const p = loadPair(name);
    const fs = footers(replay(p.frames, p.inputs).events);
    assert.ok(fs.length > 0);
    for (const f of fs) assert.equal(f.auxTokens, 0, `${name} aux`);
  }
});

test('cost Δ between consecutive results; resumed process starts from the cost-state baseline', () => {
  const p = loadPair('main');
  const costs = p.frames.filter((f) => f.m['type'] === 'result').map((f) => f.m['total_cost_usd'] as number);
  const fs = footers(replay(p.frames, p.inputs).events);
  assert.equal(fs.length, costs.length);
  fs.forEach((f, i) => assert.ok(Math.abs((f.costUsd ?? -1) - (costs[i]! - (i ? costs[i - 1]! : 0))) < 1e-8));
  // fork: the forked process restores the parent's totals; the baseline is the parent's last cost-state
  const baseline = baselineFromEntries(transcriptRawEntries('main'));
  assert.ok(baseline && baseline.costUsd !== undefined && baseline.tokens! > 0);
  const fk = loadPair('fork');
  const total = fk.frames.find((f) => f.m['type'] === 'result')!.m['total_cost_usd'] as number;
  const ff = footers(replay(fk.frames, fk.inputs, { resumed: true, baseline }).events);
  assert.equal(ff.length, 1);
  assert.equal(ff[0]!.auxTokens, 0);
  assert.ok(Math.abs(ff[0]!.costUsd! - (total - baseline.costUsd!)) < 1e-8);
  // resumed without any baseline: no false aux figure
  const nb = footers(replay(fk.frames, fk.inputs, { resumed: true }).events);
  assert.equal(nb[0]!.auxTokens, undefined);
});

test('auxTokens / costDelta helpers', () => {
  const u = { input: 10, cacheRead: 100, cacheWrite: 5, output: 20 };
  assert.equal(auxTokens(1000, 1135, u), 0);
  assert.equal(auxTokens(1000, 1535, u), 400);
  assert.equal(auxTokens(undefined, 1535, u), undefined);
  assert.equal(costDelta(0.1, 0.30000000000000004), 0.2);
  assert.equal(costDelta(undefined, 0.5), 0.5);
  assert.equal(costDelta(0.5, undefined), undefined);
});

test('context from message_start (live) and contextWindow / autoCompactAt from modelUsage', () => {
  const r = createLiveReducerX({ chatId: B.CHAT, meta: { title: '', cwd: '', mode: 'default' }, metrics: {} });
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  r.step(B.msgStart('m1', { input_tokens: 3, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 500, output_tokens: 1 }), 1);
  assert.equal(r.metrics().contextTokens, 40_503);
  r.step(B.result(), 2);
  assert.equal(r.metrics().contextWindow, 200_000);
  assert.equal(r.metrics().autoCompactAt, 167_000);
  assert.equal(autoCompactAt(1_000_000), 967_000);
  assert.equal(contextOf({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 99 }), 6);
});

test('TTL detection: 5 min when only ephemeral_5m was written, 1 h otherwise; warm-until follows', () => {
  assert.equal(ttlFromUsage({ cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 } }), 300_000);
  assert.equal(ttlFromUsage({ cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 } }), 3_600_000);
  assert.equal(ttlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 5 } }, 300_000), 3_600_000);
  assert.equal(ttlFromUsage({}, 300_000), 300_000);
  const r = createLiveReducerX({ chatId: B.CHAT, meta: { title: '', cwd: '', mode: 'default' }, metrics: {} });
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  r.step(B.status('requesting'), 1_000);
  assert.equal(r.metrics().cacheWarmUntil, 1_000 + 3_600_000);
  r.step(B.result({ usage: { input_tokens: 1, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 } } }), 2_000);
  assert.equal(r.metrics().cacheTtlMs, 300_000);
  assert.equal(r.metrics().cacheWarmUntil, 1_000 + 300_000);
  assert.equal(r.metrics().lastRequestAt, 1_000);
});

test('cache-miss rule: > 30 % of input + cache and > 10 k', () => {
  const t = (input: number, cacheRead: number, cacheWrite: number) => ({ input, cacheRead, cacheWrite, output: 0 });
  const rows: [ReturnType<typeof t>, boolean][] = [
    [t(10, 0, 84_000), true], [t(10, 20_000, 10_001), true], [t(10, 100_000, 30_000), false],
    [t(0, 0, 10_000), false], [t(0, 1_000, 9_000), false], [t(0, 0, 0), false], [t(5, 23_000, 11_000), true],
  ];
  for (const [u, want] of rows) assert.equal(isCacheMiss(u), want, JSON.stringify(u));
  assert.equal(cacheMissCause({ modelChanged: true, compacted: true }), 'compaction');
  assert.equal(cacheMissCause({ modelChanged: true }), 'model');
  assert.equal(cacheMissCause({ effortChanged: true }), 'effort');
  assert.equal(cacheMissCause({ resumed: true }), 'resume');
  assert.equal(cacheMissCause({ idleMs: 400_000, ttlMs: 300_000 }), 'expired');
  assert.equal(cacheMissCause({ images: true }), 'images');
  assert.equal(cacheMissCause({}), 'unknown');
});

test('cache-miss row: emitted live (not on the first turn of a new session) and never kept in the turn', () => {
  const r = createLiveReducerX({ chatId: B.CHAT, meta: { title: '', cwd: '', mode: 'default' }, metrics: {} });
  const miss = { usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000, output_tokens: 3 } };
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  assert.ok(!r.step(B.result(miss), 1).events.some((e) => e.k === 'system' && e.row.kind === 'cacheMiss'));
  r.userStarted({ uuid: 'u2', text: 'y', images: 0, folded: false, at: 2 });
  r.step(B.status('requesting'), 4_000_000);
  const ev = r.step(B.result({ ...miss, modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 23, cacheCreationInputTokens: 50_010, cacheReadInputTokens: 1000 } } }), 4_000_100).events;
  const row = ev.find((e) => e.k === 'system' && e.row.kind === 'cacheMiss');
  assert.ok(row && row.k === 'system' && row.id.startsWith('x:app:') && row.row.data?.['tokens'] === 50_000);
  assert.ok(!r.liveTurn()!.blocks.some((b) => b.k === 'system' && b.row.kind === 'cacheMiss'));
});

test('wakeEstimate table and the wake dialog rule', () => {
  const rows: [number, 'sameCwd' | 'account' | 'none', number][] = [
    [100_000, 'sameCwd', 81_000], [100_000, 'account', 83_200], [100_000, 'none', 100_000],
    [10_000, 'sameCwd', 0], [10_000, 'account', 0], [0, 'none', 0], [-5, 'none', 0], [Number.NaN, 'account', 0],
  ];
  for (const [ctx, shared, want] of rows) assert.equal(wakeEstimate(ctx, shared), want, `${ctx} ${shared}`);
  assert.equal(wakeDialog(150_000, 2 * 3_600_000, false), true);
  assert.equal(wakeDialog(150_000, 2 * 3_600_000, true), false);
  assert.equal(wakeDialog(90_000, 2 * 3_600_000, false), false);
  assert.equal(wakeDialog(150_000, 30 * 60_000, false), false);
});

test('disk footer sums usage once per distinct message.id', () => {
  const u = { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 2, output_tokens: 3 };
  const f = footerFromUsages(new Map([['m1', u], ['m2', u]]), ['claude-haiku-5-5']);
  assert.deepEqual(f, { input: 2, cacheRead: 20, cacheWrite: 4, output: 6, models: ['claude-haiku-5-5'] });
  assert.deepEqual(usageTokens(null), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  assert.equal(baselineFromEntries([{ type: 'user' }]), null);
});
