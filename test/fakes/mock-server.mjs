// test/fakes/mock-server.mjs — static + WS mock of the SidMultiClaude server for client development and the shell E2E.
// Two modes:
// - world (default): an in-memory world of N chats / 2 accounts that answers every C2S plausibly (snaps, tx.page,
//   chat.create with S9 / trust errors, a scripted streaming reply to chat.send, login steps, settings, ui.save…);
// - script: replays test/fixtures/protocol/<name>.jsonl (format: ProtocolStep in test/helpers/scenario.ts); requests
//   that no later `expect` step can match are acked ok so the client never hangs.
// Security model of the real server, reduced: exact Origin, path /ws, sub-protocol smc.v1 + device token or single-use
// boot code (then `device-token` first), CSP with the import-map hash, Trusted Types. Never binds anything but 127.0.0.1.
// CLI: node test/fakes/mock-server.mjs [--port n] [--print-boot] [--script <name>] [--chats <n>]
//      (extra harness args such as --data-dir / --profiles-root are ignored) → prints `SMC_BOOT {"port":…,"boot":"…"}`.
// Library: const m = await startMockServer({ chats: 200 }); … m.push([...]); m.restart(); await m.close();
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const WEB = path.join(ROOT, 'src', 'web');
const NM = path.join(ROOT, 'node_modules');
/** Same import map as src/server/http/static.ts (kept local so that this mock does not import server code). */
export const IMPORTS = Object.freeze({
  'preact': 'preact/dist/preact.mjs',
  'preact/hooks': 'preact/hooks/dist/hooks.mjs',
  'htm': 'htm/dist/htm.module.js',
  'htm/preact': 'htm/preact/index.module.js',
  '@preact/signals': '@preact/signals/dist/signals.module.js',
  '@preact/signals-core': '@preact/signals-core/dist/signals-core.module.js',
  'marked': 'marked/lib/marked.esm.js',
  'dompurify': 'dompurify/dist/purify.es.mjs',
  'hljs/core': '@highlightjs/cdn-assets/es/core.min.js',
});
const VENDOR_PKGS = ['preact', 'htm', '@preact/signals', '@preact/signals-core', 'marked', 'dompurify', '@highlightjs/cdn-assets'];
const MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const b64url = (n) => crypto.randomBytes(n).toString('base64url');

function importMapJson() {
  const imports = {};
  for (const [k, v] of Object.entries(IMPORTS)) imports[k] = `/vendor/${v}`;
  imports['hljs/lang/'] = '/vendor/@highlightjs/cdn-assets/es/languages/';
  return JSON.stringify({ imports });
}
function csp(hash) {
  return [`default-src 'none'`, `script-src 'self' 'sha256-${hash}'`, `style-src 'self'`, `img-src 'self' data: blob:`, `font-src 'self'`,
    `connect-src 'self'`, `manifest-src 'self'`, `worker-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`,
    `frame-ancestors 'none'`, `require-trusted-types-for 'script'`, `trusted-types dompurify`].join('; ');
}
/** Static file for a URL path, or null (no traversal: segments are checked, the result must stay under its root). */
function staticFile(url) {
  const p = decodeURIComponent(url.split('?')[0]);
  if (p.includes('\0') || p.split('/').some((s) => s === '..' || s === '.')) return null;
  let file = null;
  if (p.startsWith('/app/')) file = path.join(WEB, ...p.slice(5).split('/'));
  else if (p.startsWith('/vendor/')) {
    const rel = p.slice(8);
    if (VENDOR_PKGS.some((pkg) => rel.startsWith(pkg + '/'))) file = path.join(NM, ...rel.split('/'));
  } else if (p === '/favicon.svg') file = path.join(ROOT, 'assets', 'favicon.svg');
  if (!file || !MIME[path.extname(file)] || /\.d\.ts$/.test(file)) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

// ------------------------------------------------------------------ the fake world (world mode)
export const HOME = 'C:\\Users\\me';
const FOLDERS = ['SidMultiClaude', 'api-gateway', 'blog', 'site', 'outils', 'notes', 'scripts', 'demo', 'infra', 'docs', 'mobile', 'data'];
const TITLES = ['Refacto auth', 'Fix CI', 'Spec API', 'Idées UI', 'Réparer le démarrage Edge', 'Article cache', 'Tests parseur', 'Migration DB',
  'Revue PR', 'Optimiser la recherche', 'Bug login', 'Nouvelle page', 'Doc install', 'Profilage mémoire'];
export const SETTINGS = Object.freeze({ port: 41731, browser: 'edge', exe: 'installed', isolation: 'job', maxLive: 4, reapMin: 60, prespawn: true,
  allowBypass: false, aiTitles: false, notifications: true, sound: false, volume: 0.6, onlyWhenAway: true, dndUntil: null,
  reopenWindowOnAttention: true, ctrlEnterSends: false, shiftTabModes: false, showOtherOrigins: true, wakeNeverAsk: false,
  theme: 'system', density: 'compact', defaultView: 'normal' });
const uuidOf = (i) => { const h = crypto.createHash('sha1').update(`chat-${i}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const emptyState = (phase, since, extra = {}) => ({ phase, since, flags: { live: phase !== 'cold', unread: false, bgTasks: 0, queued: 0, external: null, stuck: false, notStarted: false },
  pending: { count: 0 }, ...extra });
function account(id, name, color, mono, configDir, isDefault, pct) {
  return { id, name, color, monogram: mono, configDir, isDefault, hidden: false, login: 'connected',
    identity: { email: `${id}@example.invalid`, plan: id === 'perso' ? 'Max 5x' : 'Team', accountUuid: crypto.randomUUID() },
    usage: { source: 'snapshot', at: Date.now() - 300_000, stale: false, rows: [{ key: 'five_hour', label: 'Session (5 h)', pct, severity: 'normal', headline: true, resetsAt: Date.now() + 7_200_000 }] },
    defaults: {}, diag: { leakFiles: isDefault ? [] : [`${HOME}\\.claude\\CLAUDE.md`], leakExcluded: false, resumeStable: true, cleanupDays: 30, expiringSoon: 0 } };
}
/** @param {{ chats?: number; now?: number }} o */
export function makeWorld(o = {}) {
  const now = o.now ?? Date.now();
  const n = o.chats ?? 40;
  const accounts = [account('perso', 'Perso', 1, 'P', null, true, 42), account('pro', 'ACME', 2, 'A', `${HOME}\\.claude-pro`, false, 14)];
  const chats = new Map();
  const asks = [];
  for (let i = 0; i < n; i++) {
    const acc = i % 3 === 2 ? 'pro' : 'perso';
    const sid = uuidOf(i);
    const chatId = `${acc}:${sid}`;
    const updatedAt = now - (i * 37 + 3) * 60_000;
    let state = emptyState('cold', updatedAt);
    if (i === 1) state = { ...emptyState('needs_permission', now - 120_000), pending: { count: 1, oldestAt: now - 120_000, kind: 'permission' } };
    else if (i === 4) state = { ...emptyState('needs_answer', now - 60_000), pending: { count: 1, oldestAt: now - 60_000, kind: 'question' } };
    else if (i === 2) state = emptyState('running', now - 42_000, { sub: 'writing' });
    else if (i === 3) { state = emptyState('idle', now - 30_000); state.flags.unread = true; }
    else if (i === 5) state = emptyState('error', now - 600_000, { error: { code: 'crash', exitCode: 1 } });
    const title = i < TITLES.length ? TITLES[i] : `${TITLES[i % TITLES.length]} ${Math.floor(i / TITLES.length) + 1}`;
    chats.set(chatId, { chatId, accountId: acc, sessionId: sid, title, titleSource: 'custom', cwd: `${HOME}\\proj\\${FOLDERS[i % FOLDERS.length]}`,
      branch: i % 4 === 0 ? 'main' : undefined, origin: i % 7 === 6 ? 'cli' : 'app', firstPrompt: `Peux-tu regarder ${title.toLowerCase()} ?`,
      createdAt: updatedAt - 3_600_000, updatedAt, size: 20_000 + i * 1000, model: 'claude-test', mode: 'default', pinned: i === 7, archived: false,
      muted: false, keepAlive: false, state, activity: i === 1 ? 'Bash · npm ci' : `Dernière réponse ${i}`, expiresInDays: i === 9 ? 3 : null, foreignOwner: false });
    if (i === 1) asks.push({ chatId, requestId: `req-${i}`, toolUseId: `toolu_${i}`, kind: 'permission', toolName: 'Bash', description: 'Installer les dépendances',
      input: { command: 'npm ci', description: 'Installer les dépendances' }, offerAlways: true, alwaysRules: ['Bash(npm ci)'], offerAuto: false, defaultToNo: false, since: now - 120_000 });
    if (i === 4) asks.push({ chatId, requestId: `req-${i}`, toolUseId: `toolu_${i}`, kind: 'question', toolName: 'AskUserQuestion',
      input: {}, questions: [{ question: 'Quelle librairie utiliser ?', header: 'Lib', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
      offerAlways: false, alwaysRules: [], offerAuto: false, defaultToNo: false, since: now - 60_000 });
  }
  return { accounts, chats, asks, settings: { ...SETTINGS }, ui: null, drafts: {}, seq: new Map(), trusted: new Set() };
}
/** Deterministic transcript turns for a chat (newest last). */
export function turnsFor(chatId, count = 12, now = Date.now()) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const u = crypto.createHash('md5').update(`${chatId}:${k}`).digest('hex');
    const uuid = `${u.slice(0, 8)}-${u.slice(8, 12)}-4${u.slice(13, 16)}-a${u.slice(17, 20)}-${u.slice(20, 32)}`;
    const user = { uuid, text: `Question ${k + 1} sur ce chat`, origin: 'human' };
    out.push({ id: `u:${uuid}`, at: now - (count - k) * 60_000, user,
      blocks: [{ k: 'user', id: `u:${uuid}`, msg: user }, { k: 'text', id: `a:msg_${u.slice(0, 12)}:0`, md: `Réponse **${k + 1}** de Claude.` }],
      footer: { input: 10, cacheRead: 100, cacheWrite: 0, output: 20, models: ['claude-test'] } });
  }
  return out;
}

const META = (s) => ({ title: s.title, cwd: s.cwd, ...(s.branch ? { branch: s.branch } : {}), mode: s.mode ?? 'default', model: 'claude-test', capabilities: [] });
const DIRS = { [`${HOME}\\proj`]: FOLDERS, [HOME]: ['proj', 'Documents', '.claude'], 'C:\\': ['Users', 'Windows'], 'C:\\Users': ['me', 'Public'] };

/** World-mode answer to one request. `x` = { world, conn, broadcast, emit, snap, delay }. Returns the ack (and an async tail). */
export function worldHandle(x, req) {
  const w = x.world;
  const ok = (data) => ({ ok: true, ...(data !== undefined ? { data } : {}) });
  const fail = (code, extra = {}) => ({ ok: false, err: { code, ...extra } });
  const chat = req.chatId ? w.chats.get(req.chatId) : undefined;
  const upsert = (s) => { w.chats.set(s.chatId, s); x.broadcast([{ t: 'chats', upsert: [s], remove: [] }]); };
  switch (req.t) {
    case 'view': {
      const prev = new Set(x.conn.view?.full ?? []);
      const v = x.conn.view;
      // like ws/hub.ts: an identical view is a resync request (the client saw a seq gap) → a fresh snap for every chat
      const same = v !== null && prev.size === new Set(req.full).size && req.full.every((c) => prev.has(c)) && v.focused === req.focused && v.windowFocused === req.windowFocused;
      x.conn.view = { full: req.full, focused: req.focused, windowFocused: req.windowFocused };
      const snaps = req.full.filter((c) => same || !prev.has(c) || x.conn.forceSnap).map((c) => x.snap(c)).filter(Boolean);
      x.conn.forceSnap = false;
      for (const c of req.full) { const s = w.chats.get(c); if (s?.state.flags.unread && req.windowFocused) upsert({ ...s, state: { ...s.state, flags: { ...s.state.flags, unread: false } } }); }
      return { ack: ok(), then: snaps.map((snap) => ({ t: 'snap', snap })) };
    }
    case 'tx.page': {
      if (!chat) return { ack: fail('not_found') };
      const all = w.turns?.get(req.chatId) ?? turnsFor(req.chatId, 12);
      const end = req.before ? Number(req.before) : all.length;
      const start = Math.max(0, end - req.limit);
      return { ack: ok({ turns: all.slice(start, end), cursor: start > 0 ? String(start) : null, hasMore: start > 0 }) };
    }
    case 'chat.create': {
      const cwd = req.cwd;
      if (!w.accounts.some((a) => a.id === req.accountId && a.login === 'connected')) return { ack: fail('not_logged_in') };
      if (/missing|introuvable/i.test(cwd)) return { ack: fail('cwd_missing', { message: cwd }) };
      if (cwd.toLowerCase() === HOME.toLowerCase()) return { ack: fail('cwd_refused', { message: 'home' }) };
      if (cwd.length >= 259) return { ack: fail('cwd_too_long') };
      if (!req.trust && !w.trusted.has(cwd.toLowerCase()) && /untrusted|nouveau/i.test(cwd)) return { ack: fail('untrusted') };
      if (req.trust) w.trusted.add(cwd.toLowerCase());
      const sid = crypto.randomUUID();
      const chatId = `${req.accountId}:${sid}`;
      const at = Date.now();
      upsert({ chatId, accountId: req.accountId, sessionId: sid, title: req.title ?? '', titleSource: req.title ? 'app' : 'none', cwd, origin: 'app',
        createdAt: at, updatedAt: at, size: 0, mode: req.mode, pinned: false, archived: false, muted: false, keepAlive: false,
        state: { ...emptyState('cold', at), flags: { ...emptyState('cold', at).flags, notStarted: true } }, activity: '', expiresInDays: null, foreignOwner: false });
      w.turns ??= new Map();
      w.turns.set(chatId, []);
      return { ack: ok({ chatId }) };
    }
    case 'chat.send': {
      if (!chat) return { ack: fail('not_found') };
      w.sent ??= new Set();
      if (w.sent.has(req.uuid)) return { ack: ok({ accepted: 'duplicate' }) };
      if (w.capNext) { w.capNext = false; return { ack: fail('cap', { candidates: [] }) }; }
      w.sent.add(req.uuid);
      return { ack: ok({ accepted: 'new' }), tail: () => streamReply(x, chat, req) };
    }
    case 'chat.rename': if (!chat) return { ack: fail('not_found') }; upsert({ ...chat, title: req.title, titleSource: 'custom' }); return { ack: ok() };
    case 'chat.flags': {
      if (!chat) return { ack: fail('not_found') };
      const { t: _t, id: _i, chatId: _c, ...f } = req;
      upsert({ ...chat, ...f });
      return { ack: ok() };
    }
    case 'chat.delete': if (!chat) return { ack: fail('not_found') }; w.chats.delete(req.chatId); x.broadcast([{ t: 'chats', upsert: [], remove: [req.chatId] }]); return { ack: ok() };
    case 'chat.decide': {
      const a = w.asks.find((q) => q.chatId === req.chatId && q.requestId === req.requestId);
      if (!a) return { ack: fail('not_pending') };
      w.asks = w.asks.filter((q) => q !== a);
      const s = w.chats.get(req.chatId);
      const then = [{ t: 'askEnd', chatId: req.chatId, requestId: req.requestId, reason: 'answered' }];
      if (s) { const ns = { ...s, state: { ...emptyState('running', Date.now()) } }; w.chats.set(ns.chatId, ns); then.push({ t: 'chats', upsert: [ns], remove: [] }); }
      x.broadcast(then);
      return { ack: ok() };
    }
    case 'settings.set': w.settings = { ...w.settings, ...req.patch }; x.broadcast([{ t: 'settings', settings: w.settings }]); return { ack: ok() };
    case 'ui.save': w.ui = req.ui; return { ack: ok() };
    case 'draft.save': if (req.draft) w.drafts[req.chatId] = req.draft; else delete w.drafts[req.chatId]; return { ack: ok() };
    case 'fs.dirs': {
      if (req.path === null) return { ack: ok({ path: '', dirs: [], drives: ['C:\\', 'D:\\'] }) };
      const p = req.path.replace(/[\\/]+$/, '') || req.path;
      const key = Object.keys(DIRS).find((k) => k.toLowerCase() === p.toLowerCase()) ?? (/^[A-Z]:$/i.test(p) ? 'C:\\' : null);
      const known = key ?? (p.toLowerCase().startsWith(`${HOME}\\proj`.toLowerCase()) && !/missing|introuvable/i.test(p) ? p : null);
      if (!known) return { ack: fail('cwd_missing', { message: p }) };
      const warning = known.toLowerCase() === HOME.toLowerCase() ? 'home' : /^[A-Z]:\\?$|^C:\\Users$/i.test(known) ? 'ancestor' : undefined;
      const parent = known.includes('\\') && !/^[A-Z]:\\?$/i.test(known) ? known.slice(0, known.lastIndexOf('\\')) || undefined : undefined;
      return { ack: ok({ path: known, ...(parent ? { parent: /^[A-Z]:$/i.test(parent) ? parent + '\\' : parent } : {}), dirs: DIRS[known] ?? [], ...(warning ? { warning } : {}) }) };
    }
    case 'account.candidates': return { ack: ok([{ configDir: null, login: 'connected', added: true }, { configDir: `${HOME}\\.claude-pro`, login: 'connected', added: true },
      { configDir: `${HOME}\\.claude-perso`, login: 'disconnected', added: false }]) };
    // like src/server/claude/login.ts: `url` then `waiting` in the same frame; loginCancel kills the run, after which a
    // code goes nowhere (so a stray cancel from the client makes the flow fail, as it would for real)
    case 'account.login': {
      const acc = req.accountId;
      (w.logins ??= new Set()).add(acc);
      return { ack: ok(), tail: async () => { await x.delay(50); x.broadcast([{ t: 'login', accountId: acc, step: { step: 'url', url: 'https://claude.ai/oauth/authorize?fake=1' } }, { t: 'login', accountId: acc, step: { step: 'waiting' } }]); } };
    }
    case 'account.loginCancel': w.logins?.delete(req.accountId); return { ack: ok() };
    case 'account.loginCode': {
      if (!w.logins?.has(req.accountId)) return { ack: ok() };
      w.logins.delete(req.accountId);
      return { ack: ok(), tail: async () => { await x.delay(30); x.broadcast([{ t: 'login', accountId: req.accountId, step: { step: 'done', email: `${req.accountId}@example.invalid`, plan: 'Max' } }]); } };
    }
    case 'account.usage': { const a = w.accounts.find((q) => q.id === req.accountId); return { ack: ok(a?.usage ?? null) }; }
    case 'app.quit': {
      const live = [...w.chats.values()].some((s) => s.state.flags.live);
      if (live && !req.force) return { ack: fail('busy') };
      return { ack: ok(), tail: async () => { x.broadcast([{ t: 'bye', reason: 'quit' }]); } };
    }
    case 'prompts.search': case 'fs.mentions': case 'tx.search': return { ack: ok([]) };
    default: return { ack: ok() };
  }
}

/** The scripted reply to chat.send: running → user turn → streamed text (deltas) → footer → idle (unread). */
async function streamReply(x, chat, req) {
  const id = chat.chatId;
  const at = Date.now();
  const turnId = `u:${req.uuid}`;
  const user = { uuid: req.uuid, text: req.text, origin: 'human' };
  const blockId = `a:msg_${req.uuid.slice(0, 8)}:0`;
  const set = (phase, extra = {}) => {
    const s = x.world.chats.get(id);
    if (!s) return null;
    const ns = { ...s, updatedAt: Date.now(), state: { ...emptyState(phase, Date.now()), ...extra } };
    x.world.chats.set(id, ns);
    return ns;
  };
  const running = set('running', { sub: 'writing' });
  x.broadcast([{ t: 'chats', upsert: [running], remove: [] }]);
  x.emit(id, { k: 'state', state: running.state });
  x.emit(id, { k: 'turn.start', turn: { id: turnId, at, user } });
  x.emit(id, { k: 'block', turnId, block: { k: 'user', id: turnId, msg: { ...user, delivery: 'started' } } });
  x.emit(id, { k: 'block', turnId, block: { k: 'text', id: blockId, md: '', live: true } });
  const parts = ['Bien reçu', ' : voici ', 'la réponse **simulée**.'];
  for (const p of parts) { await x.delay(40); x.emit(id, { k: 'delta', parts: [[blockId, p]] }); }
  await x.delay(30);
  x.emit(id, { k: 'block', turnId, block: { k: 'text', id: blockId, md: parts.join('') } });
  x.emit(id, { k: 'turn.end', turnId, footer: { input: 5, cacheRead: 50, cacheWrite: 0, output: 12, models: ['claude-test'] } });
  const looking = [...x.conns()].some((c) => c.view?.full.includes(id) && c.view.windowFocused);
  const idle = set('idle');
  idle.state.flags.unread = !looking;
  idle.state.flags.live = true;
  x.emit(id, { k: 'state', state: idle.state });
  x.broadcast([{ t: 'chats', upsert: [idle], remove: [] }]);
  const all = x.world.turns?.get(id) ?? turnsFor(id, 12);
  all.push({ id: turnId, at, user, blocks: [{ k: 'user', id: turnId, msg: user }, { k: 'text', id: blockId, md: parts.join('') }] });
  x.world.turns ??= new Map();
  x.world.turns.set(id, all);
}

const DEFAULT_UI = { layout: 1, tabs: [], closed: [], panes: [null], focusedPane: 0,
  sidebar: { width: 280, collapsed: false, grouping: 'account', showArchived: false }, scroll: {}, views: {} };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the mock. o: { port?, chats?, script?: name, world? }.
 * @returns {Promise<{ port: number; origin: string; boot: () => string; bootCode: () => string; url: (code?: string) => string;
 *   world: any; requests: any[]; conns: () => Set<any>; push: (frame: any[]) => void; emit: (c: string, ev: any) => void;
 *   drop: () => void; restart: () => void; waitFor: (pred: (r: any) => boolean, ms?: number) => Promise<any>; close: () => Promise<void> }>}
 */
export async function startMockServer(o = {}) {
  const world = o.world ?? makeWorld({ chats: o.chats ?? 40 });
  let serverBoot = b64url(9);
  const deviceToken = b64url(32);
  const codes = new Set();
  const newCode = () => { const c = b64url(24); codes.add(c); return c; };
  const firstCode = newCode();
  const map = importMapJson();
  const hash = crypto.createHash('sha256').update(map).digest('base64');
  const indexHtml = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace('__IMPORTMAP__', map);
  const requests = [];
  const conns = new Set();
  const waiters = new Set();
  let port = 0;
  const headers = (type) => ({ 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': csp(hash) });
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(421).end(); return; }
    const url = (req.url ?? '/').split('#')[0];
    if (url === '/' || url.startsWith('/?')) { res.writeHead(200, headers(MIME['.html'])); res.end(req.method === 'HEAD' ? undefined : indexHtml); return; }
    const file = staticFile(url);
    if (!file) { res.writeHead(404).end(); return; }
    res.writeHead(200, headers(MIME[path.extname(file)]));
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false,
    handleProtocols: (set) => (set.has('smc.v1') ? 'smc.v1' : false) });
  server.on('upgrade', (req, sock, head) => {
    const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const tok = protos.find((p) => p.startsWith('smc.auth.'))?.slice(9);
    const code = protos.find((p) => p.startsWith('smc.boot.'))?.slice(9);
    const tokenOk = tok !== undefined && tok.length === deviceToken.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(deviceToken));
    const codeOk = !tokenOk && code !== undefined && codes.delete(code);
    const good = req.url === '/ws' && req.headers.origin === `http://127.0.0.1:${port}` && req.headers.host === `127.0.0.1:${port}` && protos.includes('smc.v1') && (tokenOk || codeOk);
    if (!good) { sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => onConn(ws, codeOk));
  });
  const send = (c, frame) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(frame)); };
  const broadcast = (frame) => { for (const c of conns) send(c, frame); };
  const emit = (chatId, ev) => {
    const s = (world.seq.get(chatId) ?? 0) + 1;
    world.seq.set(chatId, s);
    for (const c of conns) if (c.view?.full.includes(chatId)) send(c, [{ t: 'ev', c: chatId, s, ev }]);
  };
  const snap = (chatId) => {
    const s = world.chats.get(chatId);
    if (!s) return null;
    const turns = world.turns?.get(chatId) ?? turnsFor(chatId, 12);
    return { chatId, seq: world.seq.get(chatId) ?? 0, state: s.state, meta: META(s), metrics: {}, queue: [], tasks: [], todos: null, live: null,
      lastDiskTurnId: turns.at(-1)?.id ?? null };
  };
  const hello = () => ({ t: 'hello', v: 1, boot: serverBoot, now: Date.now(), settings: world.settings, accounts: world.accounts, chats: [...world.chats.values()],
    asks: world.asks, ui: world.ui ?? DEFAULT_UI, drafts: world.drafts, procs: { live: 2, max: 4, effectiveMax: 4, lowMem: false, estRamMB: 480, isolation: 'job', items: [] } });
  const script = o.script ? await import('../helpers/scenario.ts').then((m) => ({ m, steps: m.loadProtocol(o.script) })) : null;
  const runner = script ? makeRunner(script, { send, conns, delay }) : null;
  function onConn(ws, viaCode) {
    const c = { ws, view: null, forceSnap: false };
    conns.add(c);
    if (viaCode) send(c, [{ t: 'device-token', token: deviceToken }]);
    if (runner) runner.connected(c); else send(c, [hello()]);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      requests.push(msg);
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.delete(w); w.resolve(msg); }
      if (runner) { runner.request(c, msg); return; }
      const x = { world, conn: c, broadcast, emit, snap, delay, conns: () => conns };
      let r;
      try { r = worldHandle(x, msg); } catch (e) { r = { ack: { ok: false, err: { code: 'internal', message: String(e) } } }; }
      const ack = r.ack.ok ? { t: 'ack', id: msg.id, ok: true, ...(r.ack.data !== undefined ? { data: r.ack.data } : {}) } : { t: 'ack', id: msg.id, ok: false, err: r.ack.err };
      send(c, [ack, ...(r.then ?? [])]);
      if (r.tail) void r.tail();
    });
    ws.on('close', () => conns.delete(c));
  }
  await new Promise((resolve) => server.listen(o.port ?? 0, '127.0.0.1', resolve));
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    port, origin, world, requests,
    boot: () => serverBoot,
    bootCode: () => firstCode,
    url: (code) => `${origin}/#boot=${code ?? newCode()}`,
    conns: () => conns,
    push: broadcast, emit,
    drop: () => { for (const c of conns) c.ws.terminate(); },
    restart: () => { serverBoot = b64url(9); world.seq.clear(); for (const c of conns) c.ws.terminate(); },
    waitFor: (pred, ms = 5000) => new Promise((resolve, reject) => {
      const hit = requests.find(pred);
      if (hit) { resolve(hit); return; }
      const w = { pred, resolve };
      waiters.add(w);
      setTimeout(() => { if (waiters.delete(w)) reject(new Error('mock: request not seen in time')); }, ms);
    }),
    close: () => new Promise((resolve) => { for (const c of conns) c.ws.terminate(); wss.close(); server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

/** Script replay (test/fixtures/protocol/*.jsonl), one runner for the whole server: steps run in order across connections. */
function makeRunner(script, io) {
  const { m, steps } = script;
  const vars = {};
  /** @type {{ c: any; msg: any }[]} */
  const queue = [];
  let current = null;
  let wake = () => {};
  let connects = 0;
  const nextEvent = () => new Promise((r) => { wake = r; });
  const ack = (c, msg, a, then) => io.send(c, [m.ackFor(msg.id, a), ...(then ?? [])]);
  /** True when a later expect step may still match this request (keep it for that step). */
  const wanted = (msg, from) => steps.slice(from).some((s) => s.step === 'expect' && Object.entries(s.match).every(([k, v]) => k in msg && (typeof v === 'string' && v.includes('$') ? true : JSON.stringify(msg[k]) === JSON.stringify(v))));
  let pc = 0;
  const run = async () => {
    for (; pc < steps.length; pc++) {
      const s = steps[pc];
      if (s.step === 'meta') continue;
      if (s.step === 'connect') { while (connects === 0) await nextEvent(); connects--; continue; }
      if (s.step === 'drop') { current?.ws.terminate(); current = null; continue; }
      if (s.step === 'send') { await io.delay(s.delayMs ?? 0); if (current) io.send(current, m.bindTemplates(s.frame, vars)); continue; }
      if (s.step === 'expect') {
        for (;;) {
          const i = queue.findIndex((q) => m.matchesRequest(s.match, q.msg, vars));
          if (i >= 0) {
            const [{ c, msg }] = queue.splice(i, 1);
            vars.req = msg;
            if (s.as) vars[s.as] = msg;
            ack(c, msg, m.bindTemplates(s.ack, vars), m.bindTemplates(s.then ?? [], vars));
            break;
          }
          await nextEvent();
        }
      }
    }
  };
  void run();
  return {
    connected(c) { current = c; connects++; wake(); },
    request(c, msg) {
      if (!wanted(msg, pc)) { ack(c, msg, { ok: true }); return; }
      queue.push({ c, msg });
      wake();
    },
  };
}

// ------------------------------------------------------------------ CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const m = await startMockServer({ port: Number(opt('--port') ?? 0), chats: Number(opt('--chats') ?? 40), ...(opt('--script') ? { script: opt('--script') } : {}) });
  if (args.includes('--print-boot')) process.stdout.write(`SMC_BOOT ${JSON.stringify({ port: m.port, boot: m.bootCode() })}\n`);
  else process.stdout.write(`mock-server: ${m.url(m.bootCode())}\n`);
  const stop = () => { void m.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
