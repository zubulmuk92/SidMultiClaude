// test/helpers/ws-client.ts — WebSocket test client speaking the SidMultiClaude protocol (SPEC §4, §6).
// Used by server integration tests and any test that needs a "window": authenticates with a boot code or a
// device token through Sec-WebSocket-Protocol, sends the exact Origin/Host the guard expects, records every S2C frame,
// and pairs each C2S with its single ack.
import WebSocket from 'ws';
import type * as P from '../../src/shared/protocol.ts';

/** A C2S message without its id (the client numbers requests). */
export type C2SBody = P.C2S extends infer U ? (U extends unknown ? Omit<U, 'id'> : never) : never;
export type AckResult<T = unknown> = { ok: true; data?: T } | { ok: false; err: P.WireError };
export type WsClientOptions = {
  port: number;
  boot?: string;                 // one-time boot code (#boot=…)
  token?: string;                // device token (localStorage['smc.device'] in the page)
  origin?: string | null;        // default http://127.0.0.1:<port>; null sends no Origin header
  host?: string;                 // default 127.0.0.1:<port>
  path?: string;                 // default /ws
  protocols?: string[];          // default ['smc.v1', 'smc.auth.<token>'?, 'smc.boot.<code>'?]
};
export interface WsClient {
  readonly ws: WebSocket;
  readonly protocol: string;
  /** Every frame received, normalised to S2C arrays (a bare object, like guard.ts's device-token message, becomes [obj]). */
  readonly frames: P.S2C[][];
  readonly deviceToken: string | null;
  send(msg: P.C2S): void;
  /** Sends a request with the next id and resolves with its ack. */
  request<T = unknown>(msg: C2SBody, timeoutMs?: number): Promise<AckResult<T>>;
  /** Resolves with the first S2C (already received or future) matching pred that was not consumed before. */
  next<T extends P.S2C = P.S2C>(pred: (m: P.S2C) => boolean, timeoutMs?: number): Promise<T>;
  /** Every received S2C of type t. */
  all<K extends P.S2C['t']>(t: K): Extract<P.S2C, { t: K }>[];
  close(code?: number): Promise<{ code: number; reason: string }>;
  readonly closed: Promise<{ code: number; reason: string }>;
}

export function wsProtocols(o: Pick<WsClientOptions, 'boot' | 'token' | 'protocols'>): string[] {
  if (o.protocols) return o.protocols;
  return ['smc.v1', ...(o.token ? [`smc.auth.${o.token}`] : []), ...(o.boot ? [`smc.boot.${o.boot}`] : [])];
}

function openSocket(o: WsClientOptions): WebSocket {
  const origin = o.origin === undefined ? `http://127.0.0.1:${o.port}` : o.origin;
  return new WebSocket(`ws://127.0.0.1:${o.port}${o.path ?? '/ws'}`, wsProtocols(o), {
    ...(origin ? { origin } : {}),
    headers: { Host: o.host ?? `127.0.0.1:${o.port}` },
    perMessageDeflate: false,
  });
}

/** Opens a connection; rejects with `HTTP <status>` when the guard refuses the upgrade. */
export function connectWs(o: WsClientOptions): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = openSocket(o);
    const frames: P.S2C[][] = [];
    const seen: P.S2C[] = [];
    const consumed = new WeakSet<object>();
    const waiters: { pred: (m: P.S2C) => boolean; resolve: (m: P.S2C) => void }[] = [];
    const acks = new Map<number, (a: AckResult) => void>();
    let deviceToken: string | null = null;
    let nextId = 1;
    let settleClosed!: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((r) => { settleClosed = r; });
    const deliver = (m: P.S2C): void => {
      if (m.t === 'device-token') deviceToken = m.token;
      if (m.t === 'ack') {
        const done = acks.get(m.id);
        if (done) { acks.delete(m.id); done(m.ok ? ('data' in m ? { ok: true, data: m.data } : { ok: true }) : { ok: false, err: m.err }); }
      }
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { consumed.add(m); waiters.splice(i, 1)[0]!.resolve(m); }
    };
    ws.on('message', (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(data)); } catch { return; }
      const frame = (Array.isArray(parsed) ? parsed : [parsed]) as P.S2C[];
      frames.push(frame);
      for (const m of frame) { seen.push(m); deliver(m); }
    });
    ws.on('close', (code, reason) => settleClosed({ code, reason: String(reason) }));
    ws.once('unexpected-response', (_req, res) => { reject(new Error(`HTTP ${res.statusCode ?? 0}`)); res.resume(); });
    ws.once('error', (e) => reject(e));
    ws.once('open', () => {
      const client: WsClient = {
        ws,
        protocol: ws.protocol,
        frames,
        get deviceToken() { return deviceToken; },
        closed,
        send: (msg) => ws.send(JSON.stringify(msg)),
        request<T = unknown>(msg: C2SBody, timeoutMs = 5_000): Promise<AckResult<T>> {
          const id = nextId++;
          return new Promise<AckResult<T>>((res, rej) => {
            const timer = setTimeout(() => { acks.delete(id); rej(new Error(`no ack for ${String((msg as { t: string }).t)} #${id} within ${timeoutMs} ms`)); }, timeoutMs);
            acks.set(id, (a) => { clearTimeout(timer); res(a as AckResult<T>); });
            ws.send(JSON.stringify({ ...msg, id }));
          });
        },
        next<T extends P.S2C = P.S2C>(pred: (m: P.S2C) => boolean, timeoutMs = 5_000): Promise<T> {
          const already = seen.find((m) => !consumed.has(m) && pred(m));
          if (already) { consumed.add(already); return Promise.resolve(already as T); }
          return new Promise<T>((res, rej) => {
            const w = { pred, resolve: (m: P.S2C) => { clearTimeout(timer); res(m as T); } };
            const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error(`no matching S2C within ${timeoutMs} ms`)); }, timeoutMs);
            waiters.push(w);
          });
        },
        all<K extends P.S2C['t']>(t: K) { return seen.filter((m): m is Extract<P.S2C, { t: K }> => m.t === t); },
        close(code = 1000) { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code); return closed; },
      };
      resolve(client);
    });
  });
}

/** Guard tests: tries an upgrade and reports what happened, without keeping the socket. */
export async function tryConnect(o: WsClientOptions, holdMs = 50): Promise<{ ok: true; protocol: string; firstFrame: unknown } | { ok: false; status: number | null; error?: string }> {
  try {
    const c = await connectWs(o);
    await new Promise((r) => setTimeout(r, holdMs));
    const firstFrame = c.frames[0] ?? null;
    await c.close();
    return { ok: true, protocol: c.protocol, firstFrame };
  } catch (e) {
    const m = /^HTTP (\d+)$/.exec((e as Error).message);
    return m ? { ok: false, status: Number(m[1]) } : { ok: false, status: null, error: (e as Error).message };
  }
}
