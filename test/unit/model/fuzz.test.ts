// test/unit/model/fuzz.test.ts — 10⁴ random frames (mutated fixtures, unknown types/subtypes) never throw (acceptance 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveReducerX } from '../../../src/server/model/live-reducer.ts';
import { diskToTurns, linearize } from '../../../src/server/model/disk-turns.ts';
import { createChatState } from '../../../src/server/model/chat-state.ts';
import { activityLine, deriveTitle } from '../../../src/server/model/derive.ts';
import { loadFrames, transcriptRawEntries } from '../../helpers/scenario.ts';
import type { RawEntry, SdkFrame } from '../../../src/server/contracts.ts';

/** mulberry32: deterministic PRNG so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const JUNK: unknown[] = [null, undefined, 0, -1, 1e308, NaN, '', 'x', '[Request interrupted by user]', true, [], {}, [null], { type: 'text' }, { type: 'image' }, { type: 'tool_result' }];
const TYPES = ['assistant', 'user', 'system', 'result', 'stream_event', 'command_lifecycle', 'rate_limit_event', 'tool_progress', 'zz_unknown', '', 'auth_status', 'tool_use_summary'];
const SUBS = ['init', 'status', 'compact_boundary', 'api_retry', 'task_started', 'task_progress', 'task_notification', 'task_updated', 'background_tasks_changed',
  'thinking_tokens', 'session_title_changed', 'conversation_reset', 'hook_response', 'local_command_output', 'permission_denied', 'informational', 'notification',
  'model_refusal_fallback', 'commands_changed', 'what_is_this', 'success', 'error_during_execution'];

function mutate(v: unknown, rnd: () => number, depth = 0): unknown {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  if (rnd() < 0.08) return pick(JUNK);
  if (Array.isArray(v)) return depth > 6 ? v : v.map((x) => mutate(x, rnd, depth + 1)).filter(() => rnd() > 0.05);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) { if (rnd() < 0.05) continue; out[k] = depth > 6 ? x : mutate(x, rnd, depth + 1); }
    if (rnd() < 0.05) out[pick(['type', 'subtype', 'index', 'message', 'event', 'content', 'id'])] = pick(JUNK);
    return out;
  }
  return v;
}

test('LiveReducer: 10⁴ random frames never throw', () => {
  const rnd = prng(42);
  const pool = [...loadFrames('main'), ...loadFrames('plan'), ...loadFrames('fork'), ...loadFrames('dry')].map((f) => f.m);
  const r = createLiveReducerX({ chatId: 'acc:fuzz', meta: { title: '', cwd: '', mode: 'default' }, metrics: {} });
  let events = 0;
  for (let i = 0; i < 10_000; i++) {
    let f: unknown;
    const x = rnd();
    if (x < 0.6) f = mutate(pool[Math.floor(rnd() * pool.length)], rnd);
    else if (x < 0.9) f = { type: TYPES[Math.floor(rnd() * TYPES.length)], subtype: SUBS[Math.floor(rnd() * SUBS.length)], uuid: `f${i}`, ...(mutate(pool[i % pool.length], rnd) as object) };
    else f = JUNK[Math.floor(rnd() * JUNK.length)];
    const out = r.step(f as SdkFrame, i);
    events += out.events.length;
    if (i % 97 === 0) r.userStarted({ uuid: `u${i}`, text: String(i), images: i % 3, folded: rnd() < 0.3, at: i });
    if (i % 501 === 0) r.localRow({ kind: 'crash', text: 'x' }, i);
    if (i % 113 === 0) { r.liveTurn(); r.meta(); r.metrics(); r.tasks(); r.todos(); r.detail(`t:${i}`, 'output'); }
  }
  assert.ok(events > 0);
  // step() swallows exceptions; a non-zero count means a frame was silently dropped by a crash in the reducer
  assert.equal(r.faults(), 0, 'frames that crashed the reducer');
  JSON.stringify(r.liveTurn());
});

test('diskToTurns / linearize: mutated transcripts never throw', () => {
  const rnd = prng(7);
  const base = [...transcriptRawEntries('main'), ...transcriptRawEntries('plan')];
  for (let round = 0; round < 40; round++) {
    const chain: RawEntry[] = base.map((r) => ({ off: r.off, len: r.len, e: (mutate(r.e, rnd) ?? {}) as Record<string, unknown> }))
      .map((r) => (r.e && typeof r.e === 'object' && !Array.isArray(r.e) ? r : { ...r, e: {} }));
    const out = diskToTurns(chain, { sessionId: '' });
    assert.ok(Array.isArray(out.turns));
    linearize(chain);
  }
});

test('chat-state and derive: random inputs never throw', () => {
  const rnd = prng(9);
  const s = createChatState({ notStarted: rnd() < 0.5 });
  for (let i = 0; i < 2000; i++) {
    const k = Math.floor(rnd() * 6);
    if (k === 0) s.onSignals(mutate({ sub: 'tool', subTool: 'Bash', rateLimit: { status: 'rejected', resetsAt: i, info: {} }, turnEnded: true }, rnd) as never, i);
    else if (k === 1) s.onFacts(rnd() < 0.2 ? null : (mutate({ chatId: 'c', sessionId: 's', phase: 'live', busy: true, pendingAsks: 0, bgTasks: 1, queuedTurns: 0, queue: [], spawnedAt: 0, sentAny: true, ttlMs: 1, mode: 'default', capabilities: [], stuck: false }, rnd) as never), i);
    else if (k === 2) s.onAsks(Math.floor(rnd() * 3), i, 'question');
    else if (k === 3) s.onExit({ reason: 'crash', code: 1, signal: null, at: i, stderrTail: '' }, i);
    else if (k === 4) s.onUser(rnd() < 0.5 ? 'viewed' : 'send', i);
    else s.onExternal(null);
    s.view();
  }
  for (const j of JUNK) { deriveTitle(j as string); activityLine({ lastText: typeof j === 'string' ? j : undefined }); }
});
