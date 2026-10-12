// @ts-check
// src/web/derived.js — derived data: « À traiter » order, counters, window title, favicon spec, state glyphs, sidebar rows,
// quick-switcher results. Pure functions (unit-tested in Node) + a few computed signals over the store.
import { computed } from '@preact/signals-core';
import { fold, fuzzyScore, queryTokens, scoreFolded } from './lib/fuzzy.js';
import { baseName, fmtRel, fmtTime, parentName } from './lib/fmt.js';
import { t } from './lib/i18n.js';
import { accounts, asks, chats, serverNow, settings } from './store.js';

/** @typedef {import('../shared/protocol.ts').ChatSummary} ChatSummary */
/** @typedef {import('../shared/protocol.ts').AccountView} AccountView */
/** @typedef {import('../shared/protocol.ts').PendingAsk} PendingAsk */
/** @typedef {import('../shared/protocol.ts').UiState} UiState */

const NEEDS = new Set(['needs_permission', 'needs_answer', 'needs_plan']);
/** @param {ChatSummary} s */
export const isNeeds = (s) => NEEDS.has(s.state.phase);
/** @param {ChatSummary} s */
export const isUnread = (s) => s.state.phase === 'idle' && s.state.flags.unread;
/** @param {ChatSummary} s */
const extWaiting = (s) => { const x = s.state.flags.external; return Boolean(x && (x.status === 'waiting' || x.status === 'blocked')); };

/**
 * A limit whose reset time is already past (seen on real accounts: months-old limits read from transcript tails). The server
 * no longer seeds them; this is the window's own guard until the next summary arrives.
 * @param {ChatSummary} s @param {number | undefined} now
 */
export const isStaleLimit = (s, now) => s.state.phase === 'rate_limited' && now !== undefined
  && !!s.state.limit && s.state.limit.resetsAt > 0 && s.state.limit.resetsAt <= now;

/**
 * « À traiter » rank (ux §4.5): needs_* (0) › terminal waiting/blocked (1) › error (2) › rate_limited (3) › unread (4);
 * null = not listed (a stale limit included). @param {ChatSummary} s @param {number} [now] @returns {number | null}
 */
export function attentionRank(s, now) {
  if (isNeeds(s)) return 0;
  if (extWaiting(s)) return 1;
  if (s.state.phase === 'error') return 2;
  if (s.state.phase === 'rate_limited') return isStaleLimit(s, now) ? null : 3;
  if (isUnread(s)) return 4;
  return null;
}
/** When the need started (oldest first inside a rank). @param {ChatSummary} s */
export const attentionSince = (s) => (isNeeds(s) ? (s.state.pending.oldestAt ?? s.state.since) : s.state.since);

/** « À traiter » order: oldest need first. @param {ChatSummary[]} list @param {number} [now] @returns {ChatSummary[]} */
export function attentionList(list, now) {
  /** @type {{ s: ChatSummary; r: number; at: number }[]} */
  const xs = [];
  for (const s of list) { const r = attentionRank(s, now); if (r !== null) xs.push({ s, r, at: attentionSince(s) }); }
  xs.sort((a, b) => a.r - b.r || a.at - b.at || (a.s.chatId < b.s.chatId ? -1 : 1));
  return xs.map((x) => x.s);
}

/** Window-level counters (ux §4.5); a stale limit counts for nothing. @param {Iterable<ChatSummary>} list @param {number} [now] */
export function counts(list, now) {
  let needs = 0, errors = 0, done = 0, running = 0;
  for (const s of list) {
    if (isNeeds(s)) needs++;
    else if (s.state.phase === 'error' || (s.state.phase === 'rate_limited' && !isStaleLimit(s, now))) errors++;
    else if (isUnread(s)) done++;
    if (s.state.phase === 'running' || s.state.phase === 'starting') running++;
  }
  return { needs, errors, done, running };
}
/** `!2 ✕1 ✓1 · SidMultiClaude`. @param {{ needs: number; errors: number; done: number }} c */
export function windowTitle(c) {
  const parts = [];
  if (c.needs) parts.push(`!${c.needs}`);
  if (c.errors) parts.push(`✕${c.errors}`);
  if (c.done) parts.push(`✓${c.done}`);
  return parts.length ? `${parts.join(' ')} · SidMultiClaude` : 'SidMultiClaude';
}
/** Favicon badge, highest priority first. @param {{ needs: number; errors: number; done: number; running: number }} c */
export function faviconSpec(c) {
  if (c.needs) return { kind: 'needs', text: c.needs > 9 ? '9+' : String(c.needs) };
  if (c.errors) return { kind: 'error', text: '' };
  if (c.done) return { kind: 'done', text: '' };
  if (c.running) return { kind: 'running', text: '' };
  return { kind: 'none', text: '' };
}

/**
 * Glyph, CSS state class and French label for a chat (ux §4.4: colour is never the only cue).
 * @param {ChatSummary} s @returns {{ glyph: string; cls: string; label: string }}
 */
export function stateGlyph(s) {
  const st = s.state;
  switch (st.phase) {
    case 'cold': return { glyph: '○', cls: 'cold', label: t(st.flags.notStarted ? 'state.new' : 'state.cold') };
    case 'starting': return { glyph: '◌', cls: 'starting', label: t('state.starting') };
    case 'running': return { glyph: '◐', cls: 'running', label: t('state.running') };
    case 'needs_permission': return { glyph: '!', cls: 'needs', label: t('state.needsPermission') };
    case 'needs_answer': return { glyph: '?', cls: 'needs', label: t('state.needsAnswer') };
    case 'needs_plan': return { glyph: '≡', cls: 'needs', label: t('state.needsPlan') };
    case 'rate_limited': return { glyph: '⧗', cls: 'limit', label: t('state.rateLimited') };
    case 'error': return { glyph: '✕', cls: 'error', label: t('state.error') };
    default:
      if (st.flags.unread) return { glyph: '✓', cls: 'done', label: t('state.done') };
      if (st.flags.bgTasks > 0) return { glyph: '◐', cls: 'bg', label: t('state.bg', { n: st.flags.bgTasks }) };
      return { glyph: '', cls: 'idle', label: t('state.idle') };
  }
}

/** Short summary of a pending ask for rows and notifications. @param {PendingAsk} a */
export function askSummary(a) {
  if (a.kind === 'question') return a.questions?.[0]?.question ?? '';
  if (a.kind === 'plan') return t('state.needsPlan');
  if (a.kind === 'elicitation') return a.elicitation?.message ?? a.toolName;
  const inp = /** @type {Record<string, unknown>} */ (a.input);
  const v = inp['command'] ?? inp['file_path'] ?? inp['path'] ?? inp['url'] ?? inp['pattern'] ?? inp['description'] ?? a.description ?? '';
  return String(v).split('\n')[0]?.slice(0, 120) ?? '';
}

/**
 * French framing of ChatSummary.activity, which the server sends as DATA only (« Bash : npm test », the question text,
 * the plan's first line): « Question : … » / « Plan à valider : … » while that ask is pending, else the data in quotes.
 * @param {ChatSummary} s @returns {string}
 */
export function activityText(s) {
  const a = s.activity?.trim();
  if (!a) return '';
  if (s.state.phase === 'needs_answer') return t('shell.reason.question', { q: a });
  if (s.state.phase === 'needs_plan') return t('shell.activity.plan', { texte: a });
  return t('shell.activity.quoted', { texte: a });
}

/** Reason line of an « À traiter » row. @param {ChatSummary} s @param {PendingAsk | undefined} ask @param {number} now */
export function attentionReason(s, ask, now) {
  const st = s.state;
  if (st.phase === 'needs_permission') return ask ? `${ask.displayName ?? ask.toolName} · ${askSummary(ask)}` : s.activity || t('state.needsPermission');
  if (st.phase === 'needs_answer') return ask ? t('shell.reason.question', { q: askSummary(ask) }) : t('state.needsAnswer');
  if (st.phase === 'needs_plan') return t('state.needsPlan');
  if (extWaiting(s)) return t('ext.attention');
  if (st.phase === 'rate_limited') return st.limit ? t('limit.cold', { heure: fmtTime(st.limit.resetsAt) }) : t('state.rateLimited');
  if (st.phase === 'error') {
    if (st.error?.code === 'auth') return t('acc.authError');
    if (st.error?.code === 'crash') return t('err.crash', { code: st.error.exitCode ?? '?' });
    if (st.error?.code === 'breaker') return t('err.breaker');
    return st.error?.message ?? t('state.error');
  }
  return t('shell.reason.done', { quand: fmtRel(st.since, now) });
}

// ------------------------------------------------------------------ sidebar rows (flat, fixed height: virtualised above 300)
/**
 * @typedef {{ kind: 'section'; key: string; label: string; count: number }
 *   | { kind: 'chat'; key: string; s: ChatSummary; depth: number; reason?: string }
 *   | { kind: 'account'; key: string; a: AccountView; collapsed: boolean; count: number }
 *   | { kind: 'folder'; key: string; label: string; path: string; collapsed: boolean; count: number; depth: number }
 *   | { kind: 'more'; key: string; n: number; group: string; depth: number }} SideRow
 */
export const FOLDER_SHOWN = 5;
/** @param {ChatSummary} s */
const chatKeys = (s) => [s.title, s.cwd, s.branch ?? '', s.firstPrompt ?? ''];
const STATE_ORDER = ['needs', 'running', 'error', 'done', 'idle', 'cold'];
/** @param {ChatSummary} s */
function stateBucket(s) {
  const c = stateGlyph(s).cls;
  return c === 'limit' ? 'error' : c === 'starting' || c === 'bg' ? 'running' : c;
}

/**
 * @param {{ list: ChatSummary[]; accounts: AccountView[]; grouping: 'account' | 'folder' | 'state'; showArchived: boolean;
 *   showOther: boolean; filter: string; collapsed: Set<string>; expanded: Set<string>; asks: PendingAsk[]; now: number }} o
 * @returns {SideRow[]}
 */
export function buildSidebar(o) {
  const hidden = new Set(o.accounts.filter((a) => a.hidden).map((a) => a.id));
  const q = o.filter.trim();
  let visible = o.list.filter((s) => !hidden.has(s.accountId) && (o.showOther || s.origin !== 'other'));
  const tree = visible.filter((s) => o.showArchived || !s.archived);
  /** @type {SideRow[]} */
  const rows = [];
  const askOf = new Map(o.asks.map((a) => [a.chatId, a]));
  if (q) {
    const hits = tree.map((s) => ({ s, sc: fuzzyScore(q, chatKeys(s).join(' ')) })).filter((x) => x.sc !== null)
      .sort((a, b) => /** @type {number} */ (b.sc) - /** @type {number} */ (a.sc) || b.s.updatedAt - a.s.updatedAt);
    rows.push({ kind: 'section', key: 'sec:filter', label: t('shell.side.results'), count: hits.length });
    for (const h of hits) rows.push({ kind: 'chat', key: `f:${h.s.chatId}`, s: h.s, depth: 0 });
    return rows;
  }
  const att = attentionList(visible, o.now);
  if (att.length) {
    rows.push({ kind: 'section', key: 'sec:att', label: t('nav.attention'), count: att.length });
    for (const s of att) rows.push({ kind: 'chat', key: `a:${s.chatId}`, s, depth: 0, reason: attentionReason(s, askOf.get(s.chatId), o.now) });
  }
  const pinned = tree.filter((s) => s.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
  if (pinned.length) {
    rows.push({ kind: 'section', key: 'sec:pin', label: t('nav.pinned'), count: pinned.length });
    for (const s of pinned) rows.push({ kind: 'chat', key: `p:${s.chatId}`, s, depth: 0 });
  }
  /** @param {string} gkey @param {ChatSummary[]} items @param {number} depth */
  const pushChats = (gkey, items, depth) => {
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    const all = o.expanded.has(gkey);
    const shown = all ? items : items.slice(0, FOLDER_SHOWN);
    for (const s of shown) rows.push({ kind: 'chat', key: `t:${s.chatId}`, s, depth });
    if (!all && items.length > FOLDER_SHOWN) rows.push({ kind: 'more', key: `m:${gkey}`, n: items.length - FOLDER_SHOWN, group: gkey, depth });
  };
  /** @param {string} prefix @param {ChatSummary[]} items @param {number} depth */
  const pushFolders = (prefix, items, depth) => {
    /** @type {Map<string, ChatSummary[]>} */
    const byDir = new Map();
    for (const s of items) { const k = s.cwd.toLowerCase(); const l = byDir.get(k); if (l) l.push(s); else byDir.set(k, [s]); }
    const dirs = [...byDir.values()].map((l) => ({ l, path: l[0]?.cwd ?? '', last: Math.max(...l.map((s) => s.updatedAt)) }))
      .sort((a, b) => b.last - a.last);
    const names = new Map();
    for (const d of dirs) { const b = baseName(d.path).toLowerCase(); names.set(b, (names.get(b) ?? 0) + 1); }
    for (const d of dirs) {
      const b = baseName(d.path) || d.path;
      const label = (names.get(b.toLowerCase()) ?? 0) > 1 && parentName(d.path) ? `${b} (${parentName(d.path)})` : b;
      const key = `${prefix}|${d.path.toLowerCase()}`;
      const collapsed = o.collapsed.has(key);
      rows.push({ kind: 'folder', key: `d:${key}`, label, path: d.path, collapsed, count: d.l.length, depth });
      if (!collapsed) pushChats(key, d.l, depth + 1);
    }
  };
  if (o.grouping === 'account') {
    for (const a of o.accounts) {
      if (a.hidden) continue;
      const items = tree.filter((s) => s.accountId === a.id);
      const key = `acc:${a.id}`;
      const collapsed = o.collapsed.has(key);
      rows.push({ kind: 'account', key, a, collapsed, count: items.length });
      if (!collapsed) pushFolders(a.id, items, 1);
    }
  } else if (o.grouping === 'folder') {
    pushFolders('all', tree, 0);
  } else {
    for (const b of STATE_ORDER) {
      const items = tree.filter((s) => stateBucket(s) === b);
      if (!items.length) continue;
      const key = `st:${b}`;
      rows.push({ kind: 'section', key, label: t(`shell.bucket.${b}`), count: items.length });
      pushChats(key, items, 0);
    }
  }
  return rows;
}

// ------------------------------------------------------------------ quick switcher (ux §10.1): prefixes > c: d: e:
/** e: values → predicate. */
const STATE_FILTERS = /** @type {Record<string, (s: ChatSummary) => boolean>} */ ({
  attente: (s) => isNeeds(s) || extWaiting(s),
  cours: (s) => s.state.phase === 'running' || s.state.phase === 'starting',
  erreur: (s) => s.state.phase === 'error',
  limite: (s) => s.state.phase === 'rate_limited',
  veille: (s) => s.state.phase === 'cold',
  nonlu: (s) => isUnread(s),
});
/** @param {string} q @returns {{ actions: boolean; account: string[]; folder: string[]; state: string[]; text: string }} */
export function parseQuery(q) {
  const out = { actions: false, account: /** @type {string[]} */ ([]), folder: /** @type {string[]} */ ([]), state: /** @type {string[]} */ ([]), text: '' };
  let rest = q.trimStart();
  if (rest.startsWith('>')) { out.actions = true; rest = rest.slice(1); }
  const words = [];
  for (const w of rest.split(/\s+/).filter(Boolean)) {
    const m = /^([cde]):(.*)$/i.exec(w);
    if (!m) { words.push(w); continue; }
    const v = m[2] ?? '';
    const k = (m[1] ?? '').toLowerCase();
    if (k === 'c') out.account.push(v); else if (k === 'd') out.folder.push(v); else out.state.push(fold(v));
  }
  out.text = words.join(' ');
  return out;
}
/**
 * @template A
 * @typedef {{ group: 'attention' | 'chats'; s: ChatSummary; score: number }
 *   | { group: 'folders'; path: string; accountId: string; score: number }
 *   | { group: 'actions'; action: A; score: number }} SwitchHit
 */
/** Folded switcher text of a chat, cached per summary object (every change brings a new object) and account label. */
const haystacks = /** @type {WeakMap<ChatSummary, { acc: string; h: string }>} */ (new WeakMap());
/** @param {ChatSummary} s @param {string} acc */
function haystack(s, acc) {
  const c = haystacks.get(s);
  if (c && c.acc === acc) return c.h;
  const h = fold([s.title, baseName(s.cwd), s.branch ?? '', s.firstPrompt ?? '', acc].join(' · '));
  haystacks.set(s, { acc, h });
  return h;
}
/**
 * Ranked results: attention first, then fuzzy score, then recency. Under 5 ms for 5 k items (in-memory).
 * @template {{ label: string; keywords?: string }} A
 * @param {string} query @param {ChatSummary[]} list @param {AccountView[]} accts @param {A[]} actionItems @param {number} [limit]
 * @returns {SwitchHit<A>[]}
 */
export function switcherResults(query, list, accts, actionItems, limit = 40) {
  const p = parseQuery(query);
  /** @type {SwitchHit<A>[]} */
  const out = [];
  if (p.actions) {
    for (const a of actionItems) {
      const sc = fuzzyScore(p.text, `${a.label} ${a.keywords ?? ''}`);
      if (sc !== null) out.push({ group: 'actions', action: a, score: sc });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  const accName = new Map(accts.map((a) => [a.id, `${a.name} ${a.monogram} ${a.id}`]));
  // the query is folded once per call and every chat's text once per summary object (≈ 5 ms for 5 k chats, ux §10.1)
  const tokens = queryTokens(p.text);
  const accTokens = p.account.map(queryTokens), dirTokens = p.folder.map(queryTokens);
  const accOk = (/** @type {ChatSummary} */ s) => accTokens.every((v) => scoreFolded(v, fold(accName.get(s.accountId) ?? s.accountId)) !== null);
  const dirOk = (/** @type {ChatSummary} */ s) => dirTokens.every((v) => scoreFolded(v, fold(s.cwd)) !== null);
  const stOk = (/** @type {ChatSummary} */ s) => p.state.every((v) => { const f = Object.entries(STATE_FILTERS).find(([k]) => k.startsWith(v)); return f ? f[1](s) : false; });
  /** @type {{ s: ChatSummary; sc: number; att: number | null }[]} */
  const hits = [];
  for (const s of list) {
    if (s.archived && !p.text) continue;
    if (!accOk(s) || !dirOk(s) || !stOk(s)) continue;
    const sc = p.text ? scoreFolded(tokens, haystack(s, accName.get(s.accountId) ?? '')) : 0;
    if (sc === null) continue;
    hits.push({ s, sc, att: attentionRank(s, Date.now()) });
  }
  hits.sort((a, b) => (a.att ?? 9) - (b.att ?? 9) || b.sc - a.sc || b.s.updatedAt - a.s.updatedAt);
  for (const h of hits.slice(0, limit)) out.push({ group: h.att !== null && h.att < 4 ? 'attention' : 'chats', s: h.s, score: h.sc });
  if (p.text && !p.state.length) {
    const seen = new Set();
    for (const s of list) {
      const k = `${s.accountId}|${s.cwd.toLowerCase()}`;
      if (seen.has(k) || !accOk(s) || !dirOk(s)) continue;
      seen.add(k);
      const sc = scoreFolded(tokens, fold(baseName(s.cwd)));
      if (sc !== null) out.push({ group: 'folders', path: s.cwd, accountId: s.accountId, score: sc });
    }
    for (const a of actionItems) {
      const sc = fuzzyScore(p.text, `${a.label} ${a.keywords ?? ''}`);
      if (sc !== null && sc > 0) out.push({ group: 'actions', action: a, score: sc });
    }
  }
  const order = { attention: 0, chats: 1, folders: 2, actions: 3 };
  return out.sort((a, b) => order[a.group] - order[b.group]).slice(0, limit + 10);
}

/** Recent folders across accounts, most recent first (new-chat dialog). @param {ChatSummary[]} list @param {number} [n] */
export function recentFolders(list, n = 8) {
  /** @type {Map<string, { path: string; accountId: string; at: number }>} */
  const m = new Map();
  for (const s of list) {
    if (!s.cwd) continue;
    const k = s.cwd.toLowerCase();
    const cur = m.get(k);
    if (!cur || s.updatedAt > cur.at) m.set(k, { path: s.cwd, accountId: s.accountId, at: s.updatedAt });
  }
  return [...m.values()].sort((a, b) => b.at - a.at).slice(0, n);
}

// ------------------------------------------------------------------ dashboard (home view)
const DAY_MS = 86_400_000;
/** Local midnight of a timestamp. @param {number} at */
export function dayStart(at) { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); }
/**
 * Chats per local day of their LAST activity (updatedAt), oldest day first, today last. A chat used on several days
 * counts once, on its last one: the summaries carry no per-day history, and the chart's caption says so.
 * @param {ChatSummary[]} list @param {number} now @param {number} [days] @returns {number[]}
 */
export function activityByDay(list, now, days = 14) {
  const out = new Array(days).fill(0);
  const today = dayStart(now);
  for (const s of list) {
    const i = days - 1 - Math.round((today - dayStart(s.updatedAt)) / DAY_MS);   // round: a day is 23 or 25 h at a DST change
    if (i >= 0 && i < days) out[i]++;
  }
  return out;
}
/** Non-archived chats: all of them, and those active in the last 7 days. @param {ChatSummary[]} list @param {number} now */
export function chatVolume(list, now) {
  let total = 0, recent = 0;
  for (const s of list) {
    if (s.archived) continue;
    total++;
    if (now - s.updatedAt < 7 * DAY_MS) recent++;
  }
  return { total, recent };
}

// ------------------------------------------------------------------ computed signals
export const chatList = computed(() => [...chats.value.values()]);
/** What the sidebar lists: hidden accounts and, unless shown, other origins left out. */
export const visibleChats = computed(() => {
  const hidden = new Set(accounts.value.filter((a) => a.hidden).map((a) => a.id));
  const showOther = settings.value?.showOtherOrigins ?? true;
  return chatList.value.filter((s) => !hidden.has(s.accountId) && (showOther || s.origin !== 'other'));
});
/** The sidebar's « À traiter »: the rail, Alt+A and the dashboard use it too. */
export const attention = computed(() => attentionList(visibleChats.value, serverNow()));
export const windowCounts = computed(() => counts(chatList.value, serverNow()));
export const asksByChat = computed(() => {
  /** @type {Map<string, PendingAsk[]>} */
  const m = new Map();
  for (const a of asks.value) { const l = m.get(a.chatId); if (l) l.push(a); else m.set(a.chatId, [a]); }
  return m;
});
