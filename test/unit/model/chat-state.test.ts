// test/unit/model/chat-state.test.ts — every row of ux §4.2, table-driven (SPEC §11 acceptance 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatState } from '../../../src/server/model/chat-state.ts';
import type { ChatStateMachine, ExitInfo, ProcessFacts } from '../../../src/server/contracts.ts';
import type * as P from '../../../src/shared/protocol.ts';

const facts = (o: Partial<ProcessFacts> = {}): ProcessFacts => ({
  chatId: 'a:s', sessionId: 's', phase: 'live', busy: false, pendingAsks: 0, bgTasks: 0, queuedTurns: 0, queue: [], spawnedAt: 0,
  sentAny: true, ttlMs: 3_600_000, mode: 'default', capabilities: [], stuck: false, ...o,
});
const exit = (reason: ExitInfo['reason'], o: Partial<ExitInfo> = {}): ExitInfo => ({ reason, code: null, signal: null, at: 0, stderrTail: '', ...o });
const q = (delivery: P.Delivery): P.QueueItem => ({ uuid: `q-${delivery}`, text: 't', images: 0, delivery });
const holder: P.ExternalHolder = { pid: 42, kind: 'interactive', entrypoint: 'cli', status: 'busy' };
const idle = (s: ChatStateMachine): void => { s.onFacts(facts({ phase: 'spawning' }), 1); s.onFacts(facts(), 2); };
const running = (s: ChatStateMachine): void => { idle(s); s.onUser('send', 3); s.onFacts(facts({ busy: true, queue: [q('started')] }), 3); };

type Row = { row: string; seed?: Parameters<typeof createChatState>[0]; run: (s: ChatStateMachine) => void; phase: P.ChatPhase; check?: (v: P.ChatStateView) => void };
const ROWS: Row[] = [
  { row: 'initial cold chat', run: () => {}, phase: 'cold', check: (v) => assert.equal(v.flags.live, false) },
  { row: 'new chat is « Pas encore démarré »', seed: { notStarted: true }, run: () => {}, phase: 'cold', check: (v) => assert.equal(v.flags.notStarted, true) },
  { row: 'cold → first keystroke (pre-spawn) → starting', run: (s) => s.onFacts(facts({ phase: 'spawning', sentAny: false }), 5), phase: 'starting', check: (v) => assert.equal(v.since, 5) },
  { row: 'cold → send → starting, message held in the queue', run: (s) => s.onFacts(facts({ phase: 'spawning', busy: true, queue: [q('pending')] }), 5), phase: 'starting', check: (v) => assert.equal(v.flags.queued, 1) },
  { row: 'starting → init OK + queued → running', run: (s) => { s.onFacts(facts({ phase: 'spawning' }), 1); s.onFacts(facts({ busy: true, queue: [q('queued')] }), 2); }, phase: 'running' },
  { row: 'starting → init OK, message handed but not acknowledged yet → running, no « Prêt » flash', run: (s) => { s.onFacts(facts({ phase: 'spawning', queue: [q('pending')] }), 1); s.onFacts(facts({ queue: [q('pending')] }), 2); }, phase: 'running' },
  { row: 'starting → init OK, nothing queued → idle', run: idle, phase: 'idle', check: (v) => { assert.equal(v.flags.live, true); assert.equal(v.since, 2); } },
  { row: 'starting → spawn failure → error startup', run: (s) => { s.onFacts(facts({ phase: 'spawning' }), 1); s.onExit(exit('spawn_failed', { message: 'boom' }), 2); }, phase: 'error', check: (v) => assert.deepEqual(v.error, { code: 'startup', message: 'boom' }) },
  { row: 'starting → init timeout → error startup', run: (s) => { s.onFacts(facts({ phase: 'spawning' }), 1); s.onExit(exit('init_timeout'), 2); }, phase: 'error', check: (v) => assert.equal(v.error?.code, 'startup') },
  { row: 'starting → auth failure → error auth', run: (s) => { s.onFacts(facts({ phase: 'spawning' }), 1); s.onSignals({ authError: true }, 2); }, phase: 'error', check: (v) => assert.equal(v.error?.code, 'auth') },
  { row: 'idle → send (started) → running, clears unread', run: (s) => { idle(s); s.onSignals({ turnEnded: true }, 3); s.onUser('send', 4); s.onFacts(facts({ busy: true }), 4); }, phase: 'running', check: (v) => assert.equal(v.flags.unread, false) },
  { row: 'running sub-status: tool + name', run: (s) => { running(s); s.onSignals({ sub: 'tool', subTool: 'Bash' }, 4); }, phase: 'running', check: (v) => { assert.equal(v.sub, 'tool'); assert.equal(v.subTool, 'Bash'); } },
  { row: 'running sub-status: thinking (no tool name)', run: (s) => { running(s); s.onSignals({ sub: 'tool', subTool: 'Bash' }, 4); s.onSignals({ sub: 'thinking' }, 5); }, phase: 'running', check: (v) => { assert.equal(v.sub, 'thinking'); assert.equal(v.subTool, undefined); } },
  { row: 'running sub-status: api retry', run: (s) => { running(s); s.onSignals({ sub: 'retry', retry: { attempt: 2, max: 10, inMs: 8000 } }, 4); }, phase: 'running', check: (v) => assert.equal(v.sub, 'retry') },
  { row: 'running → canUseTool (ordinary) → needs_permission', run: (s) => { running(s); s.onAsks(1, 7, 'permission'); }, phase: 'needs_permission', check: (v) => { assert.equal(v.since, 7); assert.deepEqual(v.pending, { count: 1, oldestAt: 7, kind: 'permission' }); } },
  { row: 'running → AskUserQuestion → needs_answer', run: (s) => { running(s); s.onAsks(1, 7, 'question'); }, phase: 'needs_answer' },
  { row: 'running → ExitPlanMode → needs_plan', run: (s) => { running(s); s.onAsks(1, 7, 'plan'); }, phase: 'needs_plan' },
  { row: 'running → MCP elicitation → needs_permission', run: (s) => { running(s); s.onAsks(1, 7, 'elicitation'); }, phase: 'needs_permission' },
  { row: 'needs_* with several asks follows the oldest', run: (s) => { running(s); s.onAsks(1, 7, 'plan'); s.onAsks(2, 7, 'plan'); }, phase: 'needs_plan', check: (v) => assert.equal(v.pending.count, 2) },
  { row: 'needs_* → decision sent → running', run: (s) => { running(s); s.onAsks(1, 7, 'permission'); s.onAsks(0, undefined, undefined); }, phase: 'running', check: (v) => assert.deepEqual(v.pending, { count: 0 }) },
  { row: 'running → Échap → running (Arrêt…)', run: (s) => { running(s); s.onUser('interrupt', 5); }, phase: 'running', check: (v) => assert.equal(v.sub, 'stopping') },
  { row: 'running → result, nothing queued → idle + unread', run: (s) => { running(s); s.onSignals({ sub: null, turnEnded: true }, 6); s.onFacts(facts(), 6); }, phase: 'idle', check: (v) => { assert.equal(v.flags.unread, true); assert.equal(v.sub, undefined); assert.equal(v.since, 6); } },
  { row: 'unread cleared by viewed', run: (s) => { running(s); s.onSignals({ turnEnded: true }, 6); s.onFacts(facts(), 6); s.onUser('viewed', 7); }, phase: 'idle', check: (v) => assert.equal(v.flags.unread, false) },
  { row: 'running → rate limit rejected → rate_limited', run: (s) => { running(s); s.onSignals({ rateLimit: { status: 'rejected', resetsAt: 9_000, kind: 'five_hour', info: {} } }, 6); }, phase: 'rate_limited', check: (v) => assert.deepEqual(v.limit, { resetsAt: 9_000, kind: 'five_hour' }) },
  { row: 'idle → rate limit rejected → rate_limited', run: (s) => { idle(s); s.onSignals({ rateLimit: { status: 'rejected', resetsAt: 9_000, info: {} } }, 6); }, phase: 'rate_limited' },
  { row: 'rate_limited → reset reached, automatic resume → running', run: (s) => { idle(s); s.onSignals({ rateLimit: { status: 'rejected', resetsAt: 9_000, info: {} } }, 6); s.onSignals({ rateLimit: { status: 'allowed', info: {} } }, 9_000); s.onFacts(facts({ busy: true }), 9_001); }, phase: 'running', check: (v) => assert.equal(v.limit, undefined) },
  { row: 'rate_limited → reset reached, no automatic resume → idle', run: (s) => { idle(s); s.onSignals({ rateLimit: { status: 'rejected', resetsAt: 9_000, info: {} } }, 6); s.onSignals({ rateLimit: { status: 'allowed', info: {} } }, 9_000); }, phase: 'idle', check: (v) => assert.equal(v.since, 9_000) },
  { row: 'rate_limit_event (resetsAt) then the assistant rate_limit error and the result text keep the known reset time', run: (s) => { running(s); s.onSignals({ rateLimit: { status: 'rejected', resetsAt: 9_000, kind: 'seven_day', info: {} } }, 6); s.onSignals({ rateLimit: { status: 'rejected', info: {} } }, 7); s.onSignals({ sub: null, turnEnded: true, rateLimit: { status: 'rejected', info: {} } }, 8); }, phase: 'rate_limited', check: (v) => assert.deepEqual(v.limit, { resetsAt: 9_000, kind: 'seven_day' }) },
  { row: 'cold chat seeded with a known limit → rate_limited', seed: { notStarted: false, limitResetsAt: 5_000 }, run: () => {}, phase: 'rate_limited', check: (v) => assert.equal(v.limit?.resetsAt, 5_000) },
  { row: 'live → unexpected exit → error crash', run: (s) => { running(s); s.onExit(exit('crash', { code: 3, message: 'x' }), 9); }, phase: 'error', check: (v) => { assert.deepEqual(v.error, { code: 'crash', exitCode: 3, message: 'x' }); assert.equal(v.flags.live, false); } },
  { row: 'live → billing_error → error billing', run: (s) => { running(s); s.onSignals({ billingError: true }, 9); }, phase: 'error', check: (v) => assert.equal(v.error?.code, 'billing') },
  { row: 'live → model_not_found → error', run: (s) => { running(s); s.onSignals({ modelNotFound: true }, 9); }, phase: 'error', check: (v) => assert.equal(v.error?.code, 'model_not_found') },
  { row: 'live → overloaded after retries → error', run: (s) => { running(s); s.onSignals({ overloaded: true }, 9); }, phase: 'error', check: (v) => assert.equal(v.error?.code, 'overloaded') },
  { row: 'error beats an open ask', run: (s) => { running(s); s.onAsks(1, 7, 'plan'); s.onSignals({ authError: true }, 9); }, phase: 'error' },
  { row: 'error → Réessayer → starting', run: (s) => { running(s); s.onExit(exit('crash'), 9); s.onFacts(facts({ phase: 'spawning' }), 10); }, phase: 'starting', check: (v) => assert.equal(v.error, undefined) },
  { row: 'crash → send refused by the open breaker → error breaker', run: (s) => { running(s); s.onExit(exit('crash'), 9); s.onUser('breaker', 10); }, phase: 'error', check: (v) => assert.equal(v.error?.code, 'breaker') },
  { row: 'error breaker → chat.retry → cold, no error', run: (s) => { running(s); s.onExit(exit('crash'), 9); s.onUser('breaker', 10); s.onUser('retry', 11); }, phase: 'cold', check: (v) => assert.equal(v.error, undefined) },
  { row: 'breaker event while live is ignored', run: (s) => { idle(s); s.onUser('breaker', 10); }, phase: 'idle', check: (v) => assert.equal(v.error, undefined) },
  { row: 'error (auth, from disk) → send clears it', seed: { notStarted: false, lastError: { kind: 'auth' }, accountLogin: 'reauth' }, run: (s) => s.onUser('send', 1), phase: 'cold' },
  // found on a real run: stale transcript tails must not mark a cold chat
  { row: 'seeded limit already reset (resetsAt ≤ now) → cold, no limit', seed: { notStarted: false, limitResetsAt: 5_000, now: 5_000 }, run: () => {}, phase: 'cold', check: (v) => assert.equal(v.limit, undefined) },
  { row: 'disk rate_limit lastError long past → cold, no limit', seed: { notStarted: false, lastError: { kind: 'rate_limit', resetsAt: 1_000 }, now: 9_000_000 }, run: () => {}, phase: 'cold', check: (v) => assert.equal(v.limit, undefined) },
  { row: 'disk rate_limit lastError still ahead → rate_limited', seed: { notStarted: false, lastError: { kind: 'rate_limit', resetsAt: 9_000 }, now: 1_000 }, run: () => {}, phase: 'rate_limited', check: (v) => assert.equal(v.limit?.resetsAt, 9_000) },
  { row: 'disk rate_limit without reset time → cold', seed: { notStarted: false, lastError: { kind: 'rate_limit' }, now: 1_000 }, run: () => {}, phase: 'cold' },
  { row: 'old auth lastError, account connected → cold, no error', seed: { notStarted: false, lastError: { kind: 'auth' }, accountLogin: 'connected' }, run: () => {}, phase: 'cold', check: (v) => assert.equal(v.error, undefined) },
  { row: 'old auth lastError, account state unknown → cold', seed: { notStarted: false, lastError: { kind: 'auth' } }, run: () => {}, phase: 'cold' },
  { row: 'auth lastError, account reauth → error auth', seed: { notStarted: false, lastError: { kind: 'auth' }, accountLogin: 'reauth' }, run: () => {}, phase: 'error', check: (v) => assert.equal(v.error?.code, 'auth') },
  { row: 'auth lastError, account disconnected → error auth', seed: { notStarted: false, lastError: { kind: 'auth' }, accountLogin: 'disconnected' }, run: () => {}, phase: 'error' },
  { row: 'idle → reaped (cache expired) → cold, silent', run: (s) => { idle(s); s.onFacts(null, 20); s.onExit(exit('closed'), 20); }, phase: 'cold', check: (v) => { assert.equal(v.error, undefined); assert.equal(v.since, 20); } },
  { row: 'idle → never-sent pre-spawn reaped after 10 min → cold', run: (s) => { s.onFacts(facts({ phase: 'spawning', sentAny: false }), 1); s.onFacts(facts({ sentAny: false }), 2); s.onExit(exit('closed'), 600_002); }, phase: 'cold' },
  { row: 'idle → evicted by the cap → cold', run: (s) => { idle(s); s.onExit(exit('killed'), 30); }, phase: 'cold', check: (v) => assert.equal(v.error, undefined) },
  { row: 'idle → Ouvrir dans le terminal → cold + external', run: (s) => { idle(s); s.onExit(exit('closed'), 30); s.onExternal(holder); }, phase: 'cold', check: (v) => assert.deepEqual(v.flags.external, holder) },
  { row: 'cold → registry shows another process → cold + external', run: (s) => s.onExternal(holder), phase: 'cold', check: (v) => assert.equal(v.flags.external?.pid, 42) },
  { row: 'cold + external → entry disappears → cold', run: (s) => { s.onExternal(holder); s.onExternal(null); }, phase: 'cold', check: (v) => assert.equal(v.flags.external, null) },
  { row: 'conversation_reset (/clear) → same state', run: (s) => { idle(s); s.onSignals({}, 40); }, phase: 'idle', check: (v) => assert.equal(v.since, 2) },
  { row: 'idle with background tasks keeps the flag', run: (s) => { idle(s); s.onFacts(facts({ bgTasks: 2 }), 3); }, phase: 'idle', check: (v) => assert.equal(v.flags.bgTasks, 2) },
  { row: 'interrupt watchdog → stuck flag', run: (s) => { running(s); s.onFacts(facts({ busy: true, stuck: true }), 5); }, phase: 'running', check: (v) => assert.equal(v.flags.stuck, true) },
  { row: 'first send clears notStarted', seed: { notStarted: true }, run: (s) => { s.onFacts(facts({ phase: 'spawning', sentAny: false }), 1); s.onFacts(facts({ busy: true, sentAny: true }), 2); }, phase: 'running', check: (v) => assert.equal(v.flags.notStarted, false) },
];

for (const r of ROWS) {
  test(`ux §4.2: ${r.row}`, () => {
    const s = createChatState(r.seed ?? { notStarted: false });
    r.run(s);
    const v = s.view();
    assert.equal(v.phase, r.phase);
    r.check?.(v);
  });
}

test('on*() returns true only when the view changed; since moves only with the phase', () => {
  const s = createChatState({ notStarted: false });
  assert.equal(s.onFacts(facts({ phase: 'spawning' }), 1), true);
  assert.equal(s.onFacts(facts({ phase: 'spawning' }), 2), false);
  assert.equal(s.onFacts(facts(), 3), true);
  assert.equal(s.view().since, 3);
  assert.equal(s.onUser('viewed', 4), false);
  assert.equal(s.onFacts(facts({ bgTasks: 1 }), 5), true);
  assert.equal(s.view().since, 3);
});
