// src/server/ws/rpc.ts — dispatch + exactly-one-ack (SPEC §4, §10 S6/S20).
// One C2S per frame: parse → validate (validate.ts) → handler → ONE ack with the same id, whatever happens:
// a validation error, a thrown handler or a rejected promise all become `ok:false` acks. A frame whose id cannot be read
// gets no ack (there is nothing to pair it with); it is logged. A duplicate of an id still in flight is ignored (logged).
import type * as P from '../../shared/protocol.ts';
import type { Logger } from '../contracts.ts';
import { validateC2S } from './validate.ts';

export type AckOut = { ok: true; data?: unknown } | { ok: false; err: P.WireError };
export type HandlerCtx<C> = { conn: C };
export type Handler<C> = (msg: P.C2S, ctx: HandlerCtx<C>) => AckOut | void | Promise<AckOut | void>;
export type Handlers<C> = Partial<Record<P.C2SType, Handler<C>>>;

/** An error a handler can throw to answer a specific code (anything else becomes `internal`). */
export class WireFail extends Error {
  readonly wire: P.WireError;
  constructor(wire: P.WireError) { super(wire.code); this.name = 'WireFail'; this.wire = wire; }
}
export const fail = (code: Exclude<P.ErrorCode, 'cap' | 'external'>, message?: string): never => {
  throw new WireFail(message ? { code, message } : { code });
};
const CODES = new Set<string>(['invalid', 'not_found', 'not_pending', 'busy', 'forbidden', 'unsupported', 'timeout', 'internal', 'too_large',
  'cap_busy', 'not_logged_in', 'untrusted', 'cwd_missing', 'cwd_too_long', 'cwd_refused', 'exe_missing', 'spawn_failed', 'breaker_open', 'not_live']);

/** Maps a thrown value to a WireError: WireFail, then any error carrying a known `code` (EngineError…), else internal. */
export function toWireError(e: unknown): P.WireError {
  if (e instanceof WireFail) return e.wire;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && CODES.has(code)) return { code: code as Exclude<P.ErrorCode, 'cap' | 'external'> };
  return { code: 'internal' };
}

export function createRpc<C extends object>(d: {
  handlers: Handlers<C>; log: Logger;
  sendAck: (conn: C, ack: P.S2C) => void;
  onHandled?: (t: P.C2SType, ms: number) => void;
}) {
  const inflight = new WeakMap<C, Set<number>>();
  const ack = (conn: C, id: number, out: AckOut): void => {
    const m: P.S2C = out.ok ? (out.data === undefined ? { t: 'ack', id, ok: true } : { t: 'ack', id, ok: true, data: out.data }) : { t: 'ack', id, ok: false, err: out.err };
    try { d.sendAck(conn, m); } catch (e) { d.log.error('ack send failed', { err: String(e) }); }
  };

  /** Handles one text frame. Never throws, never rejects; resolves once the (single) ack is queued. */
  async function handle(conn: C, text: string): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch {
      const m = /^\s*\{\s*"id"\s*:\s*(\d{1,15})\s*[,}]/.exec(text.slice(0, 256)); // best effort: a complete leading id only (never a cut one)
      if (m) ack(conn, Number(m[1]), { ok: false, err: { code: 'invalid', message: 'json' } });
      else d.log.warn('ws frame without id', { bytes: text.length });
      return;
    }
    const v = validateC2S(raw);
    if (!v.ok) {
      if (v.id !== null) ack(conn, v.id, { ok: false, err: v.err });
      else d.log.warn('ws frame without id', { bytes: text.length });
      return;
    }
    const msg = v.msg;
    let ids = inflight.get(conn);
    if (!ids) { ids = new Set(); inflight.set(conn, ids); }
    // A second frame with an id still in flight gets no ack of its own: the running request's ack is THE ack of that id
    // (exactly one per id; an early `invalid` would otherwise settle the client's pending request with the wrong answer).
    if (ids.has(msg.id)) { d.log.warn('duplicate request id in flight: ignored', { t: msg.t, id: msg.id }); return; }
    ids.add(msg.id);
    const t0 = performance.now();
    let out: AckOut;
    try {
      const h = d.handlers[msg.t];
      if (!h) out = { ok: false, err: { code: 'unsupported' } };
      else out = (await h(msg, { conn })) ?? { ok: true };
    } catch (e) {
      out = { ok: false, err: toWireError(e) };
      if (!(e instanceof WireFail)) d.log.error('handler failed', { t: msg.t, err: String((e as Error)?.stack ?? e).slice(0, 2_000) });
    }
    ids.delete(msg.id);
    ack(conn, msg.id, out);
    d.onHandled?.(msg.t, performance.now() - t0);
  }
  return { handle };
}
export type Rpc<C extends object> = ReturnType<typeof createRpc<C>>;
