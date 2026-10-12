// @ts-check
// src/web/apply.js — frame application, batched in requestAnimationFrame (setTimeout while the window is hidden, so
// background windows still update the title, the favicon and the notifications).
// Every S2C of a WebSocket frame is applied in order inside one signals batch; acks are resolved in that same pass so a
// promise never resolves before the frames that came with it are visible.
import { batch, signal } from '@preact/signals-core';
import { t } from './lib/i18n.js';
import {
  accounts, askEndReasons, asks, chats, clearTranscript, clockSkew, conn, dropChatCaches, emptyDraft, getRec, hooks, hydrated, loginSteps,
  orphans, procs, pushToast, recs, sendIssues, setRemoteDraft, settings, ui,
} from './store.js';

/** @typedef {import('../shared/protocol.ts').S2C} S2C */
/** @typedef {import('../shared/protocol.ts').ChatEvent} ChatEvent */
/** @typedef {import('../shared/protocol.ts').ChatId} ChatId */
/** @typedef {import('../shared/protocol.ts').UiTurn} UiTurn */
/** @typedef {import('../shared/protocol.ts').UiTurnHead} UiTurnHead */
/** @typedef {import('../shared/protocol.ts').UiBlock} UiBlock */
/** @typedef {import('../shared/protocol.ts').ChatSummary} ChatSummary */
/** @typedef {import('./store.js').ChatRec} ChatRec */

/** Wired by net.js. */
export const applyHooks = {
  /** @type {(m: Extract<S2C, { t: 'ack' }>) => void} */ ack: () => {},
  /** @type {(m: Extract<S2C, { t: 'hello' }>, newBoot: boolean) => void} */ hello: () => {},
  /** @type {(reason: 'quit' | 'restart') => void} */ bye: () => {},
};

// ------------------------------------------------------------------ scheduling
/** @type {S2C[]} */
let pending = [];
let scheduled = false;
const hasDoc = typeof document !== 'undefined';
/** Queues one WebSocket frame (array of S2C) for the next animation frame. @param {S2C[]} frame */
export function enqueueFrame(frame) {
  for (const m of frame) pending.push(m);
  if (scheduled) return;
  scheduled = true;
  const run = () => { scheduled = false; flushFrames(); };
  if (hasDoc && document.visibilityState === 'visible' && typeof requestAnimationFrame === 'function') {
    // rAF stalls in occluded windows: a timer backs it up
    let done = false;
    const once = () => { if (!done) { done = true; run(); } };
    requestAnimationFrame(once);
    setTimeout(once, 100);
  } else setTimeout(run, 0);
}
/** Applies everything queued now (tests, and before the first paint). */
export function flushFrames() {
  const list = pending;
  pending = [];
  if (list.length) applyFrame(list);
}

/** @param {S2C[]} frame */
export function applyFrame(frame) {
  batch(() => { for (const m of frame) { try { applyOne(m); } catch (e) { try { console.error('apply', m.t, e); } catch { /* */ } } } });
}

/** @param {S2C} m */
function applyOne(m) {
  switch (m.t) {
    case 'hello': return applyHello(m);
    case 'device-token': return;                       // stored by net.js on receipt
    case 'ack': return applyHooks.ack(m);
    case 'accounts': accounts.value = m.accounts; return;
    case 'chats': return applyChats(m.upsert, m.remove, m.rekey);
    case 'ask': {
      const rest = asks.value.filter((a) => !(a.chatId === m.ask.chatId && a.requestId === m.ask.requestId));
      asks.value = [...rest, m.ask].sort((a, b) => a.since - b.since);
      hooks.onAsk(m.ask);
      return;
    }
    case 'askEnd':
      askEndReasons.set(`${m.chatId}|${m.requestId}`, m.reason);
      if (askEndReasons.size > 500) { const first = askEndReasons.keys().next().value; if (first !== undefined) askEndReasons.delete(first); }
      asks.value = asks.value.filter((a) => !(a.chatId === m.chatId && a.requestId === m.requestId));
      return;
    case 'snap': return applySnap(m.snap);
    case 'ev': return applyEv(m.c, m.s, m.ev);
    case 'procs': procs.value = m.procs; return;
    case 'settings': settings.value = m.settings; return;
    case 'login': {
      // the server sends `waiting` right after `url` (claude auth login then waits for the browser): the URL and the
      // code field stay needed until done / error, so `waiting` never replaces a `url` step
      const prev = loginSteps.value[m.accountId];
      const step = m.step.step === 'waiting' && prev?.step === 'url' ? prev : m.step;
      loginSteps.value = { ...loginSteps.value, [m.accountId]: step };
      return;
    }
    case 'orphans': orphans.value = m.items.length ? m.items : null; return;
    case 'toast': pushToast({ level: m.level, key: m.key, ...(m.args ? { args: m.args } : {}), ...(m.chatId ? { chatId: m.chatId } : {}) }); return;
    case 'bye': return applyHooks.bye(m.reason);
    default: return;
  }
}

/** @param {Extract<S2C, { t: 'hello' }>} m */
function applyHello(m) {
  const prevBoot = conn.value.boot;
  const newBoot = prevBoot !== null && prevBoot !== m.boot;
  if (newBoot) {
    dropChatCaches();
    // a `claude auth login` run does not survive a server restart: an open login dialog must not wait forever
    const steps = { ...loginSteps.value };
    for (const [acc, s] of Object.entries(steps)) if (s.step === 'url' || s.step === 'waiting') steps[acc] = { step: 'error', message: t('shell.err.restarted') };
    loginSteps.value = steps;
  }
  else if (prevBoot !== null) for (const rec of recs.values()) rec.awaitingSnap = false;
  clockSkew.value = m.now - Date.now();
  settings.value = m.settings;
  accounts.value = m.accounts;
  chats.value = new Map(m.chats.map((c) => [c.chatId, c]));
  asks.value = [...m.asks].sort((a, b) => a.since - b.since);
  // a RESTARTED server may have lost the last acknowledged ui.save (its write is debounced: a crash within
  // the second drops it). This window's layout is then newer than the hello's: keep it and save it again.
  const keepUi = prevBoot !== null && (hooks.uiPending() || (newBoot && JSON.stringify(ui.value) !== JSON.stringify(m.ui)));
  if (!keepUi) ui.value = m.ui;
  else if (newBoot && !hooks.uiPending()) hooks.uiChanged();
  procs.value = m.procs;
  // last write wins by `at`: text typed here while the connection was down is newer than the server's copy (its
  // draft.save is still in the outbox) and must not be reverted
  for (const [c, d] of Object.entries(m.drafts)) { const rec = getRec(c); if (prevBoot === null || d.at >= rec.draft.value.at) setRemoteDraft(rec, d); }
  for (const rec of recs.values()) if (!(rec.id in m.drafts) && prevBoot === null) setRemoteDraft(rec, emptyDraft());
  conn.value = { ...conn.value, status: 'open', boot: m.boot, attempts: 0 };
  hydrated.value = true;
  applyHooks.hello(m, newBoot);
}

/** @param {ChatSummary[]} upsert @param {ChatId[]} remove @param {{ from: ChatId; to: ChatId }[] | undefined} rekey */
function applyChats(upsert, remove, rekey) {
  const next = new Map(chats.value);
  for (const r of rekey ?? []) rekeyChat(next, r.from, r.to);
  for (const c of remove) next.delete(c);
  /** @type {[ChatSummary | undefined, ChatSummary][]} */
  const changed = [];
  for (const s of upsert) { changed.push([next.get(s.chatId), s]); next.set(s.chatId, s); }
  chats.value = next;
  if (remove.length) {
    const gone = new Set(remove);
    asks.value = asks.value.filter((a) => !gone.has(a.chatId));
    hooks.onRemoved(remove.filter((c) => !next.has(c)));      // deleted elsewhere: no tab may keep showing it
  }
  for (const [p, s] of changed) hooks.onSummary(p, s);
}

/** /clear or another fork id: the chat continues under a new id; tabs, panes, draft and asks follow. @param {Map<ChatId, ChatSummary>} map @param {ChatId} from @param {ChatId} to */
function rekeyChat(map, from, to) {
  const s = map.get(from);
  map.delete(from);
  if (s) map.set(to, { ...s, chatId: to, sessionId: to.slice(to.indexOf(':') + 1) });
  const u = ui.value;
  const sw = (/** @type {ChatId | null} */ c) => (c === from ? to : c);
  /** @template V @param {Record<ChatId, V>} r @returns {Record<ChatId, V>} */
  const moveKey = (r) => { if (!(from in r)) return r; const n = { ...r }; const v = n[from]; delete n[from]; if (v !== undefined) n[to] = v; return n; };
  ui.value = { ...u, tabs: [...new Set(u.tabs.map((c) => /** @type {ChatId} */ (sw(c))))], closed: [...new Set(u.closed.map((c) => /** @type {ChatId} */ (sw(c))))],
    panes: u.panes.map(sw), views: moveKey(u.views), scroll: moveKey(u.scroll) };
  const old = recs.get(from);
  if (old) {
    const d = old.draft.value;
    recs.delete(from);
    if (d.text || d.attachments.length) setRemoteDraft(getRec(to), d);
  }
  asks.value = asks.value.map((a) => (a.chatId === from ? { ...a, chatId: to } : a));
  const issues = sendIssues.value;
  if (issues.has(from)) { const n = new Map(issues); const v = n.get(from); n.delete(from); if (v) n.set(to, v); sendIssues.value = n; }
  hooks.uiChanged();                                         // the server's UiState still names `from`: a reload must not
  hooks.resendView();                                        // bring back the conversation from before /clear
}

// ------------------------------------------------------------------ per-chat snapshot and events
/** Patches the summary's state (chats frames carry it too; snap/ev may be fresher). @param {ChatId} c @param {ChatSummary['state']} state */
function patchState(c, state) {
  const prev = chats.value.get(c);
  if (!prev) return;
  const next = { ...prev, state };
  const map = new Map(chats.value);
  map.set(c, next);
  chats.value = map;
  hooks.onSummary(prev, next);
}

/** @param {import('../shared/protocol.ts').ChatSnapshot} s */
function applySnap(s) {
  const rec = getRec(s.chatId);
  rec.seq = s.seq;
  rec.awaitingSnap = false;
  patchState(s.chatId, s.state);
  rec.meta.value = s.meta;
  rec.metrics.value = s.metrics;
  rec.serverQueue.value = s.queue;
  rec.tasks.value = s.tasks;
  rec.todos.value = s.todos;
  if (s.live) upsertTurn(rec, s.live, true);
  const stale = !rec.loadedTail || (s.lastDiskTurnId !== null && s.lastDiskTurnId !== rec.lastDiskTurnId);
  rec.lastDiskTurnId = s.lastDiskTurnId;
  if (stale) hooks.loadTail(s.chatId);
}

/** @param {ChatId} c @param {number} s @param {ChatEvent} ev */
function applyEv(c, s, ev) {
  const rec = recs.get(c);
  if (!rec || rec.awaitingSnap || rec.seq < 0) return;  // no snap yet: the snap will carry this state
  if (s <= rec.seq) return;                            // duplicate
  if (s > rec.seq + 1) {                               // gap: ask for a fresh snap
    rec.awaitingSnap = true;
    hooks.resendView(c);
    return;
  }
  rec.seq = s;
  applyChatEvent(rec, ev);
}

/** Applies one ChatEvent to a record (exported for tests and the stub store of the chat surface). @param {ChatRec} rec @param {ChatEvent} ev */
export function applyChatEvent(rec, ev) {
  switch (ev.k) {
    case 'state': return patchState(rec.id, ev.state);
    case 'meta': rec.meta.value = { ...(rec.meta.value ?? { title: '', cwd: '', mode: 'default' }), ...ev.meta }; return;
    case 'metrics': rec.metrics.value = { ...rec.metrics.value, ...ev.metrics }; return;
    case 'turn.start': return upsertTurn(rec, { ...ev.turn, blocks: [] }, false);
    case 'block': return upsertBlock(rec, ev.turnId, ev.block);
    case 'delta':
      for (const [id, add] of ev.parts) {
        const sig = rec.blockSigs.get(id);
        if (sig && sig.value.k === 'text') sig.value = { ...sig.value, md: sig.value.md + add };
      }
      return;
    case 'progress': {
      const sig = rec.blockSigs.get(ev.blockId);
      if (!sig) return;
      const b = sig.value;
      if (b.k === 'tool' && ev.elapsedMs !== undefined) sig.value = { ...b, elapsedMs: ev.elapsedMs };
      else if (b.k === 'thinking') sig.value = { ...b, ...(ev.chars !== undefined ? { chars: ev.chars } : {}), ...(ev.tokens !== undefined ? { tokens: ev.tokens } : {}) };
      return;
    }
    case 'tool.result': {
      const id = `t:${ev.toolUseId}`;
      const sig = rec.blockSigs.get(id);
      if (sig && sig.value.k === 'tool') upsertBlock(rec, rec.blockTurn.get(id) ?? ev.turnId, { ...sig.value, status: ev.status, result: ev.result });
      return;
    }
    case 'turn.end': {
      const sig = rec.turnSigs.get(ev.turnId);
      if (sig) sig.value = { ...sig.value, footer: ev.footer };
      return;
    }
    case 'system': {
      /** @type {UiBlock} */
      const block = { k: 'system', id: ev.id, row: ev.row };
      if (ev.turnId && rec.turnSigs.has(ev.turnId)) upsertBlock(rec, ev.turnId, block);
      else upsertTurn(rec, { id: ev.id, at: Date.now(), user: null, blocks: [block] }, false);
      return;
    }
    case 'queue': rec.serverQueue.value = ev.items; pruneLocalQueue(rec); return;
    case 'tasks': rec.tasks.value = ev.tasks; return;
    case 'todos': rec.todos.value = ev.todos; return;
    case 'reset': clearTranscript(rec); hooks.loadTail(rec.id); return;
    default: return;
  }
}

/** Local optimistic chips disappear once the server knows the uuid (queue item or user turn). @param {ChatRec} rec */
export function pruneLocalQueue(rec) {
  const l = rec.localQueue.value;
  if (!l.length) return;
  const known = new Set(rec.serverQueue.value.map((q) => q.uuid));
  const keep = l.filter((q) => q.returned || !(known.has(q.uuid) || rec.turnSigs.has(`u:${q.uuid}`)));
  if (keep.length !== l.length) rec.localQueue.value = keep;
}

// ------------------------------------------------------------------ transcript helpers (idempotent: block ids are stable)
/** @param {ChatRec} rec @param {UiBlock} b @param {string} turnId */
function setBlockSig(rec, b, turnId) {
  const sig = rec.blockSigs.get(b.id);
  if (sig) { if (sig.value !== b) sig.value = b; } else rec.blockSigs.set(b.id, signal(b));
  rec.blockTurn.set(b.id, turnId);
}

/**
 * Inserts or merges a turn. `preferIncoming`: incoming block values win (snap / disk page) except over a block that is
 * still streaming (`live`) here. Returns the turn signal.
 * @param {ChatRec} rec @param {UiTurn} turn @param {boolean} preferIncoming @param {'end' | 'none'} [place]
 */
export function upsertTurn(rec, turn, preferIncoming, place = 'end') {
  const sig = rec.turnSigs.get(turn.id);
  if (!sig) {
    for (const b of turn.blocks) setBlockSig(rec, b, turn.id);
    const s = signal(turn);
    rec.turnSigs.set(turn.id, s);
    if (place === 'end') rec.turns.value = [...rec.turns.value, { id: turn.id, sig: s }];
    if (turn.user) pruneLocalQueue(rec);
    return s;
  }
  const cur = sig.value;
  const blocks = cur.blocks.slice();
  const index = new Map(blocks.map((b, i) => [b.id, i]));
  for (const b of turn.blocks) {
    const i = index.get(b.id);
    if (i === undefined) { index.set(b.id, blocks.length); blocks.push(b); setBlockSig(rec, b, turn.id); continue; }
    const mine = rec.blockSigs.get(b.id)?.value ?? blocks[i];
    const mineLive = /** @type {{ live?: boolean }} */ (mine).live === true;
    const incomingLive = /** @type {{ live?: boolean }} */ (b).live === true;
    const take = preferIncoming && !(mineLive && !incomingLive);   // a disk copy never overwrites a block still streaming here
    if (take) { blocks[i] = b; setBlockSig(rec, b, turn.id); }
  }
  sig.value = { ...cur, ...(turn.user ? { user: turn.user } : {}), at: cur.at || turn.at, blocks,
    ...(turn.footer ? { footer: turn.footer } : {}), ...(turn.beforeCompaction ? { beforeCompaction: true } : {}) };
  return sig;
}

/** Upsert by block.id (full replacement; it freezes a live block). @param {ChatRec} rec @param {string} turnId @param {UiBlock} block */
export function upsertBlock(rec, turnId, block) {
  let sig = rec.turnSigs.get(turnId);
  if (!sig) sig = upsertTurn(rec, { id: turnId, at: Date.now(), user: null, blocks: [] }, false);
  const cur = sig.value;
  const i = cur.blocks.findIndex((b) => b.id === block.id);
  setBlockSig(rec, block, turnId);
  if (i < 0) sig.value = { ...cur, blocks: [...cur.blocks, block] };
  else { const blocks = cur.blocks.slice(); blocks[i] = block; sig.value = { ...cur, blocks }; }
}

/**
 * Merges a tx.page result. 'tail': the page is the newest disk turns (turns kept here that are older than the page stay
 * before it, live-only turns after it). 'older': the page goes before everything.
 * @param {ChatRec} rec @param {import('../shared/protocol.ts').TranscriptPage} page @param {'tail' | 'older'} mode
 */
export function mergePage(rec, page, mode) {
  batch(() => {
    for (const t of page.turns) upsertTurn(rec, t, true, 'none');
    const pageIds = page.turns.map((t) => t.id);
    const inPage = new Set(pageIds);
    const cur = rec.turns.value.map((x) => x.id);
    let order;
    if (mode === 'older') order = [...pageIds.filter((id) => !cur.includes(id)), ...cur];
    else {
      const common = cur.map((id, i) => (inPage.has(id) ? i : -1)).filter((i) => i >= 0);
      if (!common.length) order = [...pageIds, ...cur.filter((id) => !inPage.has(id))];
      else {
        const first = /** @type {number} */ (common[0]), last = /** @type {number} */ (common[common.length - 1]);
        const before = cur.slice(0, first).filter((id) => !inPage.has(id));
        const after = cur.slice(last + 1).filter((id) => !inPage.has(id));
        order = [...before, ...pageIds, ...after];
      }
    }
    rec.turns.value = order.map((id) => ({ id, sig: /** @type {import('./store.js').TurnSig} */ (rec.turnSigs.get(id)) })).filter((x) => x.sig);
    if (mode === 'tail') { rec.loadedTail = true; if (rec.cursor === null || !rec.hasMore.value) { rec.cursor = page.cursor; rec.hasMore.value = page.hasMore; } }
    else { rec.cursor = page.cursor; rec.hasMore.value = page.hasMore; }
    pruneLocalQueue(rec);
  });
}
