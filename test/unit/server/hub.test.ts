// WP-D acceptance 2: contiguous per-chat seq, snap before ev, delta coalescing (≤ 20 delta frames/s per chat, viewers
// only), backpressure → stale → snap, close at 32 MiB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type * as P from '../../../src/shared/protocol.ts';
import { createHub } from '../../../src/server/ws/hub.ts';
import type { WsLike } from '../../../src/server/ws/hub.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';
import { BACKPRESSURE_CLOSE_BYTES, BACKPRESSURE_STALE_BYTES, WS_CLOSE_SLOW } from '../../../src/shared/limits.ts';

const A = 'perso:4adf4c63-b504-4be1-804b-92a88963e275';
const B = 'perso:5bdf4c63-b504-4be1-804b-92a88963e275';
class FakeWs extends EventEmitter implements WsLike {
  readyState = 1; bufferedAmount = 0; sent: P.S2C[][] = []; closed: { code?: number; reason?: string } | null = null;
  send(data: string): void { this.sent.push(JSON.parse(data) as P.S2C[]); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
  msgs(): P.S2C[] { return this.sent.flat(); }
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const snapOf = (chatId: P.ChatId): P.ChatSnapshot => ({ chatId, seq: 0, state: { phase: 'idle', since: 0, flags: { live: true, unread: false, bgTasks: 0, queued: 0, external: null, stuck: false, notStarted: false }, pending: { count: 0 } },
  meta: { title: 't', cwd: 'C:\\', mode: 'default' }, metrics: {}, queue: [], tasks: [], todos: null, live: null, lastDiskTurnId: null });

function setup() {
  const clock = createFakeClock();
  const hub = createHub({ clock, log: nullLogger });
  hub.setSnapshotProvider(snapOf);
  return { clock, hub };
}

test('seq is contiguous per chat, snap precedes ev, ev only to viewers', async () => {
  const { hub } = setup();
  const w1 = new FakeWs(), w2 = new FakeWs();
  const c1 = hub.attach(w1), c2 = hub.attach(w2);
  hub.emit(A, [{ k: 'queue', items: [] }]);                      // nobody views A: not emitted, no seq change
  assert.equal(hub.seq(A), 0);
  hub.setView(c1, [A], A, true);
  hub.emit(A, [{ k: 'queue', items: [] }, { k: 'tasks', tasks: [] }]);
  hub.setView(c2, [A, B], B, false);
  hub.emit(A, [{ k: 'todos', todos: null }]);
  hub.emit(B, [{ k: 'todos', todos: null }]);
  await tick();
  const m1 = w1.msgs().filter((m) => m.t === 'snap' || m.t === 'ev');
  assert.deepEqual(m1.map((m) => (m.t === 'snap' ? `snap${m.snap.seq}` : m.t === 'ev' ? `${m.c === A ? 'A' : 'B'}${m.s}` : '')), ['snap0', 'A1', 'A2', 'A3']);
  const m2 = w2.msgs().filter((m) => m.t === 'snap' || m.t === 'ev');
  assert.deepEqual(m2.map((m) => (m.t === 'snap' ? `snap${m.snap.chatId === A ? 'A' : 'B'}${m.snap.seq}` : m.t === 'ev' ? `${m.c === A ? 'A' : 'B'}${m.s}` : '')), ['snapA2', 'snapB0', 'A3', 'B1']);
  assert.equal(hub.looking(A), true);
  assert.equal(hub.looking(B), false, 'c2 window not focused');
  assert.deepEqual([...hub.visible()].sort(), [A, B].sort());
  hub.setView(c2, [A, B], B, false);                              // identical view = resync request → fresh snaps
  await tick();
  assert.equal(w2.msgs().filter((m) => m.t === 'snap').length, 4);
});

test('deltas: coalesced in one 50 ms timer per chat, ≤ 20 delta frames per second, flushed before any other event', async () => {
  const { hub, clock } = setup();
  const w = new FakeWs();
  const c = hub.attach(w);
  hub.setView(c, [A], A, true);
  for (let ms = 0; ms < 1_000; ms += 5) {                          // 200 deltas over 1 s
    hub.emit(A, [{ k: 'delta', parts: [['a:m:0', 'x']] }]);
    clock.advance(5);
    await tick();
  }
  const deltaEvs = w.msgs().filter((m) => m.t === 'ev' && m.ev.k === 'delta');
  assert.ok(deltaEvs.length <= 20 && deltaEvs.length >= 18, `delta frames ${deltaEvs.length}`);
  const text = deltaEvs.map((m) => (m.t === 'ev' && m.ev.k === 'delta' ? m.ev.parts.map((p) => p[1]).join('') : '')).join('');
  hub.emit(A, [{ k: 'delta', parts: [['a:m:0', 'y']] }, { k: 'turn.end', turnId: 't', footer: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, models: [] } }]);
  await tick();
  const tail = w.msgs().filter((m) => m.t === 'ev').slice(-2).map((m) => (m.t === 'ev' ? m.ev.k : ''));
  assert.deepEqual(tail, ['delta', 'turn.end'], 'pending parts flushed first');
  assert.ok(text.length >= 195, 'no text lost');
  assert.equal(clock.pending(), 0, 'no timer left armed');
  const w2 = new FakeWs();
  hub.attach(w2);
  hub.emit(B, [{ k: 'delta', parts: [['a:n:0', 'z']] }]);         // nobody views B: no timer at all
  assert.equal(clock.pending(), 0);
});

test('backpressure: > 4 MiB → stale (no ev, chats still flow), < 1 MiB → snap; > 32 MiB → close 4001', async () => {
  const { hub, clock } = setup();
  const w = new FakeWs();
  const c = hub.attach(w);
  hub.setView(c, [A], A, true);
  await tick();
  w.bufferedAmount = BACKPRESSURE_STALE_BYTES + 1;
  hub.emit(A, [{ k: 'queue', items: [] }]);
  await tick();
  assert.equal(c.stale, true);
  const before = w.sent.length;
  hub.emit(A, [{ k: 'tasks', tasks: [] }]);
  hub.push(null, [{ t: 'chats', upsert: [], remove: [] }]);
  await tick();
  assert.deepEqual(w.sent.slice(before).flat().map((m) => m.t), ['chats'], 'ev dropped, chats kept');
  w.bufferedAmount = 0;
  clock.advance(100);
  await tick();
  assert.equal(c.stale, false);
  assert.equal(w.msgs().at(-1)?.t, 'snap', 'snap after recovery');
  w.bufferedAmount = BACKPRESSURE_CLOSE_BYTES + 1;
  hub.push(null, [{ t: 'chats', upsert: [], remove: [] }]);
  await tick();
  assert.deepEqual(w.closed, { code: WS_CLOSE_SLOW, reason: 'slow' });
  assert.equal(hub.connections(), 0);
});

test('batching: one JSON array per tick; urgent messages flush in the current tick (microtask)', async () => {
  const { hub } = setup();
  const w = new FakeWs();
  hub.attach(w);
  await tick();
  w.sent = [];
  hub.push(null, [{ t: 'chats', upsert: [], remove: [] }]);
  hub.push(null, [{ t: 'toast', level: 'info', key: 'x' }]);
  await Promise.resolve();
  assert.equal(w.sent.length, 0, 'non-urgent: waits for the end of the tick');
  await tick();
  assert.deepEqual(w.sent.map((f) => f.map((m) => m.t)), [['chats', 'toast']], 'one frame, a JSON array');
  hub.push(null, [{ t: 'askEnd', chatId: A, requestId: 'r', reason: 'answered' }], true);
  await Promise.resolve();
  assert.deepEqual(w.sent.at(-1)?.map((m) => m.t), ['askEnd'], 'urgent: sent before the next macrotask');
});

test('rekey moves views and onEmpty fires when the last window leaves', async () => {
  const { hub } = setup();
  let empty = 0;
  hub.onEmpty(() => { empty++; });
  const w = new FakeWs();
  const c = hub.attach(w);
  hub.setView(c, [A], A, true);
  hub.rekey(A, B);
  await tick();
  assert.deepEqual([...c.full], [B]);
  assert.equal(c.focused, B);
  assert.equal(w.msgs().filter((m) => m.t === 'snap').at(-1)?.t === 'snap' && (w.msgs().filter((m) => m.t === 'snap').at(-1) as { snap: P.ChatSnapshot }).snap.chatId, B);
  w.close();
  assert.equal(empty, 1);
});
