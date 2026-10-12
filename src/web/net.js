// @ts-check
// src/web/net.js — WS connect/auth/reconnect/outbox/acks (SPEC §6.1–6.2).
// - Auth: sub-protocols ['smc.v1', 'smc.auth.<device token>'?, 'smc.boot.<code>'?]; the boot code comes from #boot and is
//   removed from the URL at once; the device token lives in localStorage['smc.device'] (every access in try/catch).
// - Every C2S gets exactly one ack: request() resolves with { ok, data | err } and never rejects.
// - Outbox: requests made while disconnected wait; after a reconnect with the SAME boot, unacknowledged requests are
//   re-sent when that is safe (chat.send keeps its uuid, the server answers 'duplicate'; reads and last-write-wins
//   saves). A request with side effects that went out but got no ack (chat.create, chat.fork, chat.interrupt, open,
//   app.quit…) may have run already: it is NOT re-sent, it fails with message 'connection_lost'. After a NEW boot, sent
//   requests resolve with { ok:false, err:{ code:'internal', message:'server_restarted' } } (chat.send: actions.js
//   returns the sends to the composer; never re-sent) or message 'restarted' (anything else).
import { applyHooks, enqueueFrame } from './apply.js';
import { conn, later, LIMITS } from './store.js';

/** @typedef {import('../shared/protocol.ts').C2S} C2S */
/** @typedef {import('../shared/protocol.ts').S2C} S2C */
/** @typedef {import('../shared/protocol.ts').WireError} WireError */
/** @typedef {C2S extends infer U ? (U extends unknown ? Omit<U, 'id'> : never) : never} C2SBody */
/** @typedef {{ ok: true; data?: any } | { ok: false; err: WireError }} AckResult */
/** @typedef {{ msg: C2S; resolve: (r: AckResult) => void; sent: boolean; timer: ReturnType<typeof setTimeout> | null }} Pending */

export const DEVICE_KEY = 'smc.device';
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 5000];
const REQUEST_TIMEOUT_MS = 60_000;
/** Requests that only make sense for the current connection: never queued, never re-sent. */
const EPHEMERAL = new Set(['view']);
/** At most one unsent request of these types is kept (the latest wins). */
const COALESCE = new Set(['view', 'ui.save', 'settings.set']);
/** Safe to send again when the first copy may have been processed: idempotent, first-answer-wins or deduplicated. */
const REPLAYABLE = new Set(['chat.send', 'chat.prespawn', 'chat.cancelQueued', 'chat.decide', 'chat.setMode', 'chat.setModel', 'chat.rename',
  'chat.flags', 'chat.setCwd', 'chat.info', 'tx.page', 'tx.detail', 'tx.search', 'prompts.search', 'account.candidates', 'account.update',
  'account.loginCancel', 'fs.mentions', 'fs.dirs', 'ui.save', 'draft.save', 'settings.set', 'log.client']);
/** @param {C2S} m */
const replayable = (m) => REPLAYABLE.has(m.t) || (m.t === 'chat.rewind' && m.dryRun === true);
const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
/** Exact UTF-8 size of a frame (WS_MAX_PAYLOAD_BYTES counts bytes, not UTF-16 units). @param {string} s */
const byteLength = (s) => (s.length * 3 <= LIMITS.WS_MAX_PAYLOAD_BYTES || !utf8 ? s.length : utf8.encode(s).length);

/** @type {Map<number, Pending>} */
const outbox = new Map();
let nextId = 1;
/** @type {WebSocket | null} */
let ws = null;
/** @type {string | null} */
let bootCode = null;
let attempts = 0;
let stopped = false;
let everOpened = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let retryTimer = null;
/** @type {(frame: S2C[]) => void} */
let sink = enqueueFrame;
/** @type {(() => void)[]} */
const helloListeners = [];

/** Reads and removes #boot=<code> (call once, before connecting). @returns {string | null} */
export function takeBootCode() {
  if (typeof location === 'undefined' || !location.hash) return null;
  const code = new URLSearchParams(location.hash.slice(1)).get('boot');
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* */ }
  return code && /^[A-Za-z0-9_-]{16,128}$/.test(code) ? code : null;
}
/** @returns {string | null} */
export function readDeviceToken() { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } }
/** @param {string} t */
function storeDeviceToken(t) { try { localStorage.setItem(DEVICE_KEY, t); } catch { /* private mode: boot codes only */ } }

/** @param {Partial<{ status: import('./store.js').ConnStatus; attempts: number }>} p */
function setConn(p) { conn.value = { ...conn.value, ...p, since: Date.now() }; }

/** Opens the connection (reconnects by itself). @param {(frame: S2C[]) => void} [onFrame] @returns {{ send(m: C2S): void; close(): void }} */
export function connect(onFrame) {
  if (onFrame) sink = onFrame;
  stopped = false;
  if (bootCode === null) bootCode = takeBootCode();
  open();
  return { send: (m) => { rawSend(m); }, close: () => { stopped = true; ws?.close(1000); } };
}

function open() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const token = readDeviceToken();
  if (!token && !bootCode) { setConn({ status: 'expired' }); return; }
  const protocols = ['smc.v1', ...(token ? [`smc.auth.${token}`] : []), ...(bootCode ? [`smc.boot.${bootCode}`] : [])];
  let opened = false;
  let sock;
  try { sock = new WebSocket(`ws://${location.host}/ws`, protocols); } catch { scheduleRetry(); return; }
  ws = sock;
  if (bootCode) bootCode = null;                 // single use, whatever happens
  sock.onopen = () => { opened = true; everOpened = true; attempts = 0; };
  sock.onmessage = (e) => {
    let data;
    try { data = JSON.parse(String(e.data)); } catch { return; }
    /** @type {S2C[]} */
    const frame = Array.isArray(data) ? data : [data];
    for (const m of frame) if (m && m.t === 'device-token' && typeof m.token === 'string') storeDeviceToken(m.token);
    sink(frame);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    for (const p of outbox.values()) if (p.sent && EPHEMERAL.has(p.msg.t)) finish(p.msg.id, { ok: true });
    if (stopped) { setConn({ status: 'closed' }); return; }
    if (!opened) void checkExpired();
    else { setConn({ status: 'reconnecting', attempts }); scheduleRetry(); }
  };
}

/** A refused handshake looks like a network error: if the HTTP side answers, the token was refused. */
async function checkExpired() {
  let serverUp = false;
  try { serverUp = typeof fetch === 'function' && (await fetch('/', { method: 'HEAD', cache: 'no-store' })).ok; } catch { serverUp = false; }
  if (serverUp && (attempts >= 2 || !everOpened)) { setConn({ status: 'expired' }); retryTimer = later(open, 15_000); return; }
  setConn({ status: everOpened ? 'reconnecting' : 'connecting', attempts });
  scheduleRetry();
}
function scheduleRetry() {
  if (stopped) return;
  const d = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 5000;
  attempts++;
  retryTimer = later(open, d);
}
/** Immediate reconnect (bye{restart}, focus regained, « Réessayer »). */
export function reconnectNow() { attempts = 0; if (!ws) open(); }
/** bye{quit}: the server is going away for good. */
export function stop() { stopped = true; if (retryTimer) clearTimeout(retryTimer); ws?.close(1000); setConn({ status: 'closed' }); }

// ------------------------------------------------------------------ requests and acks
const isOpen = () => ws !== null && ws.readyState === 1 && conn.value.status === 'open';
/** @param {C2S} m @returns {boolean} */
function rawSend(m) {
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(m)); return true; } catch { return false; }
}
/** @param {number} id @param {AckResult} r */
function finish(id, r) {
  const p = outbox.get(id);
  if (!p) return;
  outbox.delete(id);
  if (p.timer) clearTimeout(p.timer);
  p.resolve(r);
}

/**
 * Sends a request and resolves with its ack (never rejects). Frames above WS_MAX_PAYLOAD_BYTES are refused locally
 * with too_large.
 * @param {C2SBody} body @returns {Promise<AckResult>}
 */
export function request(body) {
  const id = nextId++;
  const msg = /** @type {C2S} */ ({ ...body, id });
  if (byteLength(JSON.stringify(msg)) > LIMITS.WS_MAX_PAYLOAD_BYTES) return Promise.resolve({ ok: false, err: { code: 'too_large' } });
  if (COALESCE.has(msg.t)) {
    for (const p of [...outbox.values()]) {
      if (p.sent || p.msg.t !== msg.t) continue;
      // settings.set carries a partial patch: the waiting one is merged in, never dropped (view / ui.save are whole states)
      if (msg.t === 'settings.set' && p.msg.t === 'settings.set') msg.patch = { ...p.msg.patch, ...msg.patch };
      finish(p.msg.id, { ok: true });
    }
  }
  return new Promise((resolve) => {
    /** @type {Pending} */
    const p = { msg, resolve, sent: false, timer: null };
    outbox.set(id, p);
    if (msg.t !== 'chat.send') p.timer = later(() => finish(id, { ok: false, err: { code: 'timeout' } }), REQUEST_TIMEOUT_MS);
    if (isOpen()) p.sent = rawSend(msg);
    else if (EPHEMERAL.has(msg.t)) finish(id, { ok: true });   // a fresh view goes out after the next hello anyway
  });
}

/** Called for every ack S2C (from apply.js, in frame order). @param {Extract<S2C, { t: 'ack' }>} m */
function onAck(m) { finish(m.id, m.ok ? { ok: true, data: m.data } : { ok: false, err: m.err }); }

/** After hello: re-send or drop what was in flight, then flush the queue. @param {boolean} newBoot */
function onHello(newBoot) {
  for (const p of [...outbox.values()]) {
    // new boot: no unattended re-sending (SPEC §6.2) — every chat.send still waiting goes back to the composer
    if (newBoot && (p.sent || p.msg.t === 'chat.send')) {
      finish(p.msg.id, { ok: false, err: { code: 'internal', message: p.msg.t === 'chat.send' ? 'server_restarted' : 'restarted' } });
      continue;
    }
    if (EPHEMERAL.has(p.msg.t)) { finish(p.msg.id, { ok: true }); continue; }
    // same boot: frames of the old socket (acks included) were applied before this hello, so what is still here and
    // was sent got no answer; a request with side effects may have run already — never run it twice
    if (p.sent && !replayable(p.msg)) { finish(p.msg.id, { ok: false, err: { code: 'internal', message: 'connection_lost' } }); continue; }
    p.sent = rawSend(p.msg);
  }
  for (const f of helloListeners) f();
}

/** Runs after every hello (actions.js re-sends the view). @param {() => void} f */
export function onEveryHello(f) { helloListeners.push(f); }

/** Unacknowledged chat.send uuids (tests and the status bar). @returns {string[]} */
export function inFlightSends() {
  return [...outbox.values()].filter((p) => p.msg.t === 'chat.send').map((p) => /** @type {{ uuid: string }} */ (/** @type {unknown} */ (p.msg)).uuid);
}

applyHooks.ack = onAck;
const prevHello = applyHooks.hello;
applyHooks.hello = (m, newBoot) => { prevHello(m, newBoot); onHello(newBoot); };

/** Test seam: swaps the socket factory target and resets module state. @param {{ reset?: boolean }} [o] */
export function _testReset(o = {}) {
  if (o.reset) { for (const id of [...outbox.keys()]) finish(id, { ok: false, err: { code: 'internal' } }); nextId = 1; attempts = 0; everOpened = false; }
  ws = null; stopped = false; bootCode = null; sink = enqueueFrame;
}
