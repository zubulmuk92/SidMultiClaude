// src/server/ws/hub.ts — connections, views, per-chat seq, delta coalescing, backpressure, fan-out (SPEC §6.2, C19).
// - Every server → client frame is a JSON array of S2C, flushed once per tick (setImmediate); urgent ones in a microtask.
// - `ev` goes only to connections whose view.full has the chat; seq is per chat, +1 per emitted ev, and a `snap` always
//   precedes the ev that follow it on a connection. Nobody viewing a chat → its events are not emitted (no seq change):
//   the next viewer gets a snapshot anyway.
// - `delta` parts are buffered per chat; ONE 50 ms timer per chat, armed only while parts are pending and someone views it;
//   any other event of that chat flushes them first (order kept).
// - Backpressure per connection: > 4 MiB buffered → stale (no ev/snap, the rest still flows); a 100 ms re-check timer
//   runs only while stale; < 1 MiB → snap for each chat of its view; > 32 MiB → close 4001 `slow`.
import type * as P from '../../shared/protocol.ts';
import type { Clock, Hub, Logger } from '../contracts.ts';
import { BACKPRESSURE_CLOSE_BYTES, BACKPRESSURE_RESUME_BYTES, BACKPRESSURE_STALE_BYTES, DELTA_COALESCE_MS, WS_CLOSE_SLOW } from '../../shared/limits.ts';

export type WsLike = {
  readonly readyState: number; readonly bufferedAmount: number;
  send(data: string): void; close(code?: number, reason?: string): void;
  on(ev: 'message', cb: (data: unknown, isBinary: boolean) => void): unknown;
  on(ev: 'close' | 'error', cb: (...a: unknown[]) => void): unknown;
};
export type Conn = {
  readonly id: number; readonly ws: WsLike; full: Set<P.ChatId>; focused: P.ChatId | null; windowFocused: boolean;
  stale: boolean; out: P.S2C[]; closed: boolean; staleTimer: { cancel(): void } | null; data: Record<string, unknown>;
};
export type SnapshotProvider = (chatId: P.ChatId) => P.ChatSnapshot | null;
export const STALE_RECHECK_MS = 100;
const OPEN = 1;

export interface HubImpl extends Hub {
  attach(ws: WsLike): Conn;
  onConnect(cb: (c: Conn) => void): () => void;
  onMessage(cb: (c: Conn, data: string) => void): void;
  onViewChange(cb: () => void): () => void;
  setSnapshotProvider(fn: SnapshotProvider): void;
  push(chatId: P.ChatId | null, msgs: P.S2C[], urgent?: boolean): void;
  send(c: Conn, msgs: P.S2C[], urgent?: boolean): void;
  emit(chatId: P.ChatId, events: readonly P.ChatEvent[], urgent?: boolean): void;
  setView(c: Conn, full: readonly P.ChatId[], focused: P.ChatId | null, windowFocused: boolean): P.ChatId[];
  seq(chatId: P.ChatId): number;
  viewers(chatId: P.ChatId): number;
  rekey(from: P.ChatId, to: P.ChatId): void;
  list(): readonly Conn[];
  flushNow(): void;
  closeAll(code: number, reason: string): void;
}

export function createHub(d: { clock: Clock; log: Logger }): HubImpl {
  const conns = new Set<Conn>();
  const seqs = new Map<P.ChatId, number>();
  const deltas = new Map<P.ChatId, { parts: P.DeltaPart[]; timer: { cancel(): void } | null }>();
  const connectCbs = new Set<(c: Conn) => void>();
  const emptyCbs = new Set<() => void>();
  const viewCbs = new Set<() => void>();
  let messageCb: (c: Conn, data: string) => void = () => {};
  let snapshot: SnapshotProvider = () => null;
  let nextId = 1;
  let immediate: NodeJS.Immediate | null = null;
  let micro = false;

  const safe = (what: string, fn: () => void): void => { try { fn(); } catch (e) { d.log.error('hub callback failed', { what, err: String(e) }); } };
  const viewersOf = (c: P.ChatId): Conn[] => [...conns].filter((k) => !k.closed && k.full.has(c));

  function flushConn(c: Conn): void {
    if (c.closed || !c.out.length) return;
    if (c.ws.readyState !== OPEN) { c.out = []; return; }
    if (c.ws.bufferedAmount > BACKPRESSURE_CLOSE_BYTES) { c.out = []; closeSlow(c); return; }
    const data = JSON.stringify(c.out);
    c.out = [];
    try { c.ws.send(data); } catch (e) { d.log.warn('ws send failed', { err: String(e) }); return; }
    if (c.ws.bufferedAmount > BACKPRESSURE_CLOSE_BYTES) closeSlow(c);
    else if (!c.stale && c.ws.bufferedAmount > BACKPRESSURE_STALE_BYTES) markStale(c);
  }
  function flushAll(): void {
    immediate = null;
    micro = false;
    for (const c of conns) flushConn(c);
  }
  function schedule(urgent: boolean): void {
    if (urgent) { if (!micro) { micro = true; queueMicrotask(flushAll); } return; }
    if (!immediate && !micro) immediate = setImmediate(flushAll);
  }
  function closeSlow(c: Conn): void {
    d.log.warn('ws closed: slow consumer', { conn: c.id });
    try { c.ws.close(WS_CLOSE_SLOW, 'slow'); } catch { /* already closing */ }
    drop(c);
  }
  function markStale(c: Conn): void {
    c.stale = true;
    c.out = c.out.filter((m) => m.t !== 'ev' && m.t !== 'snap');
    const check = (): void => {
      c.staleTimer = null;
      if (c.closed) return;
      if (c.ws.bufferedAmount > BACKPRESSURE_CLOSE_BYTES) { closeSlow(c); return; }
      if (c.ws.bufferedAmount >= BACKPRESSURE_RESUME_BYTES) { c.staleTimer = d.clock.timer(STALE_RECHECK_MS, check); return; }
      c.stale = false;
      const chats = [...c.full];
      for (const chat of chats) snapTo(c, chat);
      schedule(false);
    };
    c.staleTimer = d.clock.timer(STALE_RECHECK_MS, check);
  }
  function enqueue(c: Conn, m: P.S2C): void {
    if (c.closed) return;
    if (c.stale && (m.t === 'ev' || m.t === 'snap')) return;
    c.out.push(m);
  }
  /** Sends the buffered delta parts of a chat as one ev (to its current viewers). */
  function flushDeltas(chat: P.ChatId): void {
    const b = deltas.get(chat);
    if (!b) return;
    b.timer?.cancel();
    deltas.delete(chat);
    if (b.parts.length) sendEv(chat, { k: 'delta', parts: b.parts });
  }
  function sendEv(chat: P.ChatId, ev: P.ChatEvent): void {
    const vs = viewersOf(chat);
    if (!vs.length) return;
    const s = (seqs.get(chat) ?? 0) + 1;
    seqs.set(chat, s);
    const m: P.S2C = { t: 'ev', c: chat, s, ev };
    for (const c of vs) enqueue(c, m);
  }
  /** Fresh snapshot of `chat` for one connection (pending deltas go to the other viewers first). */
  function snapTo(c: Conn, chat: P.ChatId): void {
    c.full.delete(chat);
    flushDeltas(chat);
    c.full.add(chat);
    let snap: P.ChatSnapshot | null = null;
    try { snap = snapshot(chat); } catch (e) { d.log.error('snapshot failed', { chatId: chat, err: String(e) }); }
    if (snap) enqueue(c, { t: 'snap', snap: { ...snap, chatId: chat, seq: seqs.get(chat) ?? 0 } });
  }
  function drop(c: Conn): void {
    if (c.closed) return;
    c.closed = true;
    c.staleTimer?.cancel();
    c.out = [];
    conns.delete(c);
    for (const chat of c.full) if (!viewersOf(chat).length) { deltas.get(chat)?.timer?.cancel(); deltas.delete(chat); }
    for (const cb of viewCbs) safe('view', cb);
    if (conns.size === 0) for (const cb of emptyCbs) safe('empty', cb);
  }

  const hub: HubImpl = {
    attach(ws) {
      const c: Conn = { id: nextId++, ws, full: new Set(), focused: null, windowFocused: false, stale: false, out: [], closed: false, staleTimer: null, data: {} };
      conns.add(c);
      ws.on('message', (data, isBinary) => {
        if (isBinary || c.closed) return;
        const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data as Buffer[]).toString('utf8') : String(data);
        safe('message', () => messageCb(c, text));
      });
      ws.on('close', () => drop(c));
      ws.on('error', () => drop(c));
      for (const cb of connectCbs) safe('connect', () => cb(c));
      schedule(false);
      return c;
    },
    onConnect(cb) { connectCbs.add(cb); return () => connectCbs.delete(cb); },
    onMessage(cb) { messageCb = cb; },
    onViewChange(cb) { viewCbs.add(cb); return () => viewCbs.delete(cb); },
    onEmpty(cb) { emptyCbs.add(cb); return () => emptyCbs.delete(cb); },
    setSnapshotProvider(fn) { snapshot = fn; },
    push(chatId, msgs, urgent = false) {
      if (!msgs.length) return;
      const targets = chatId === null ? [...conns] : viewersOf(chatId);
      for (const c of targets) for (const m of msgs) enqueue(c, m);
      if (targets.length) schedule(urgent);
    },
    send(c, msgs, urgent = false) { for (const m of msgs) enqueue(c, m); schedule(urgent); },
    emit(chat, events, urgent = false) {
      if (!events.length) return;
      const viewed = viewersOf(chat).length > 0;
      if (!viewed) { deltas.get(chat)?.timer?.cancel(); deltas.delete(chat); return; }
      for (const ev of events) {
        if (ev.k === 'delta') {
          let b = deltas.get(chat);
          if (!b) { b = { parts: [], timer: null }; deltas.set(chat, b); }
          for (const [id, text] of ev.parts) {
            const last = b.parts[b.parts.length - 1];
            if (last && last[0] === id) last[1] += text; else b.parts.push([id, text]);
          }
          if (!b.timer) b.timer = d.clock.timer(DELTA_COALESCE_MS, () => { flushDeltas(chat); schedule(false); });
        } else {
          flushDeltas(chat);
          sendEv(chat, ev);
        }
      }
      schedule(urgent);
    },
    setView(c, full, focused, windowFocused) {
      const next = new Set(full);
      const same = next.size === c.full.size && [...next].every((x) => c.full.has(x)) && focused === c.focused && windowFocused === c.windowFocused;
      const added = same ? [...next] : [...next].filter((x) => !c.full.has(x));   // an identical view = resync request (§6.2)
      for (const x of [...c.full]) if (!next.has(x)) c.full.delete(x);
      c.focused = focused;
      c.windowFocused = windowFocused;
      if (!c.stale) for (const chat of added) snapTo(c, chat);
      for (const chat of next) c.full.add(chat);
      for (const [chat, b] of deltas) if (!viewersOf(chat).length) { b.timer?.cancel(); deltas.delete(chat); }
      for (const cb of viewCbs) safe('view', cb);
      schedule(true);
      return added;
    },
    seq: (chat) => seqs.get(chat) ?? 0,
    viewers: (chat) => viewersOf(chat).length,
    rekey(from, to) {
      deltas.get(from)?.timer?.cancel();
      deltas.delete(from);
      for (const c of conns) {
        if (!c.full.has(from)) continue;
        c.full.delete(from);
        if (c.focused === from) c.focused = to;
        if (!c.stale) snapTo(c, to); else c.full.add(to);
      }
      for (const cb of viewCbs) safe('view', cb);
      schedule(true);
    },
    visible() { const s = new Set<P.ChatId>(); for (const c of conns) for (const x of c.full) s.add(x); return s; },
    looking: (chat) => [...conns].some((c) => !c.closed && c.windowFocused && c.full.has(chat)),
    connections: () => conns.size,
    list: () => [...conns],
    flushNow() { if (immediate) { clearImmediate(immediate); immediate = null; } flushAll(); },
    closeAll(code, reason) {
      flushAll();
      for (const c of [...conns]) { try { c.ws.close(code, reason); } catch { /* closing */ } drop(c); }
    },
  };
  return hub;
}
