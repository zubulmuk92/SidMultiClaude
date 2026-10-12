// @ts-check
// src/web/store.js — signals store. Provides `useChat` of src/web/contract.d.ts (the chat surface consumes it).
// Only @preact/signals-core here (no DOM, no preact), so apply/derived/store run in Node unit tests.
//
// Exports for the chat surface besides useChat: accounts, settings, chats, procs, ui, conn,
// sendIssues (failed chat.send per chat: cap / external / … with the original text, for CapChoice and banners),
// focusedChat, now (1 s clock signal), clockSkew.
import { signal, computed, batch } from '@preact/signals-core';

/** @typedef {import('../shared/protocol.ts').ChatId} ChatId */
/** @typedef {import('../shared/protocol.ts').ChatSummary} ChatSummary */
/** @typedef {import('../shared/protocol.ts').ChatMetaView} ChatMetaView */
/** @typedef {import('../shared/protocol.ts').ChatMetrics} ChatMetrics */
/** @typedef {import('../shared/protocol.ts').UiTurn} UiTurn */
/** @typedef {import('../shared/protocol.ts').UiBlock} UiBlock */
/** @typedef {import('../shared/protocol.ts').QueueItem} QueueItem */
/** @typedef {import('../shared/protocol.ts').TaskView} TaskView */
/** @typedef {import('../shared/protocol.ts').TodoItem} TodoItem */
/** @typedef {import('../shared/protocol.ts').PendingAsk} PendingAsk */
/** @typedef {import('../shared/protocol.ts').Draft} Draft */
/** @typedef {import('../shared/protocol.ts').Settings} Settings */
/** @typedef {import('../shared/protocol.ts').UiState} UiState */
/** @typedef {import('../shared/protocol.ts').AccountView} AccountView */
/** @typedef {import('../shared/protocol.ts').ProcStats} ProcStats */
/** @typedef {import('../shared/protocol.ts').LoginStep} LoginStep */
/** @typedef {import('../shared/protocol.ts').WireError} WireError */
/** @typedef {import('../shared/protocol.ts').ImageInput} ImageInput */
/** @typedef {import('@preact/signals-core').Signal<UiTurn>} TurnSig */
/** @typedef {import('@preact/signals-core').Signal<UiBlock>} BlockSig */
/** @typedef {import('./contract.d.ts').ChatVM} ChatVM */
/** @typedef {QueueItem & { local: true; images: number; imageData?: ImageInput[]; returned?: boolean }} LocalQueueItem */
/** @typedef {import('./contract.d.ts').SendIssue} SendIssue */
/** @typedef {{ id: number; level: 'info' | 'warn' | 'error'; key: string; args?: Record<string, string | number>; chatId?: ChatId; text?: string; action?: { label: string; run: () => void }; ttl: number }} Toast */
/** @typedef {'connecting' | 'open' | 'reconnecting' | 'expired' | 'closed'} ConnStatus */

/** Browser-side copies of src/shared/limits.ts (no .ts reaches the browser); a unit test checks they match. */
export const LIMITS = Object.freeze({
  WS_MAX_PAYLOAD_BYTES: 16 * 1024 * 1024, MAX_IMAGES_TOTAL_BYTES: 12 * 1024 * 1024, MAX_IMAGES_PER_MESSAGE: 8,
  MAX_IMAGE_BYTES: 5 * 1024 * 1024, MAX_TEXT_BYTES: 1024 * 1024, MAX_DRAFT_BYTES: 1024 * 1024, TX_PAGE_LIMIT_MAX: 50,
  TITLE_BADGE_MIN_INTERVAL_MS: 1000, PREFETCH_DEBOUNCE_MS: 150, PEEK_EXCHANGES: 3, SIDEBAR_VIRTUALISE_ABOVE: 300,
  SIDEBAR_WIDTH_DEFAULT_PX: 280, SIDEBAR_WIDTH_MIN_PX: 220, SIDEBAR_WIDTH_MAX_PX: 420, PANE_MIN_WIDTH_PX: 420,
  META_DEBOUNCE_MS: 1000, MAX_LIVE_MIN: 2, MAX_LIVE_MAX: 8, REAP_WARN_BELOW_MIN: 60, DOUBLE_ESC_MS: 600,
});
export const TAIL_PAGE = 30;
export const OLDER_PAGE = 20;

/** @type {UiState} */
export const DEFAULT_UI = {
  layout: 1, tabs: [], closed: [], panes: [null], focusedPane: 0,
  sidebar: { width: 280, collapsed: false, grouping: 'account', showArchived: false }, scroll: {}, views: {},
};

// ------------------------------------------------------------------ world (every window gets these)
export const conn = signal(/** @type {{ status: ConnStatus; boot: string | null; attempts: number; since: number }} */ ({ status: 'connecting', boot: null, attempts: 0, since: 0 }));
export const settings = signal(/** @type {Settings | null} */ (null));
export const accounts = signal(/** @type {AccountView[]} */ ([]));
export const chats = signal(/** @type {Map<ChatId, ChatSummary>} */ (new Map()));
export const asks = signal(/** @type {PendingAsk[]} */ ([]));
export const ui = signal(/** @type {UiState} */ (DEFAULT_UI));
export const procs = signal(/** @type {ProcStats | null} */ (null));
export const loginSteps = signal(/** @type {Record<string, LoginStep>} */ ({}));
export const orphans = signal(/** @type {{ pid: number; name: string }[] | null} */ (null));
export const toasts = signal(/** @type {Toast[]} */ ([]));
export const sendIssues = signal(/** @type {Map<ChatId, SendIssue>} */ (new Map()));
export const windowState = signal({ visible: true, focused: true });
export const hydrated = signal(false);            // first hello applied
export const clockSkew = signal(0);               // hello.now − Date.now()
export const now = signal(Date.now());            // ticks every second while something shows a timer (main.js)
/** Shell overlay (one at a time): newChat, resume, accounts, login, settings, confirm, orphans, switcher, help, peek, dirBrowser, trust. */
/** Why each ask ended (`${chatId}|${requestId}` → reason; the chat surface shows « Demande annulée » for cancelled / crash). */
export const askEndReasons = /** @type {Map<string, import('../shared/protocol.ts').AskEndReason>} */ (new Map());
export const overlay = signal(/** @type {{ kind: string; props?: Record<string, any> } | null} */ (null));

export const focusedChat = computed(() => { const u = ui.value; return u.panes[u.focusedPane] ?? null; });
export const accountById = computed(() => new Map(accounts.value.map((a) => [a.id, a])));

/** setTimeout that never keeps a Node test process alive (unref is a no-op in browsers). @param {() => void} fn @param {number} ms */
export function later(fn, ms) {
  const h = setTimeout(fn, ms);
  /** @type {any} */ (h)?.unref?.();
  return h;
}

/**
 * Runs fn at most once per `ms`, the trailing call kept (window title and favicon badge: ≤ 1/s, ux §4.5).
 * @param {() => void} fn @param {number} ms @returns {() => void}
 */
export function throttle(fn, ms) {
  let last = -Infinity;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  return () => {
    const wait = last + ms - Date.now();
    if (wait <= 0) { last = Date.now(); fn(); return; }
    if (!timer) timer = later(() => { timer = null; last = Date.now(); fn(); }, wait);
  };
}

/** Hooks wired by actions.js / main.js (avoids import cycles). */
export const hooks = {
  /** @type {(c: ChatId) => void} */ loadTail: () => {},
  /** @type {(gapChat?: ChatId) => void} */ resendView: () => {},
  /** @type {(prev: ChatSummary | undefined, next: ChatSummary) => void} */ onSummary: () => {},
  /** @type {(a: PendingAsk) => void} */ onAsk: () => {},
  /** @type {(c: ChatId, d: Draft | null) => void} */ saveDraft: () => {},
  /** @type {() => boolean} true while a local UiState change is not saved yet (hello must not overwrite it) */ uiPending: () => false,
  /** @type {() => void} ui.value was changed outside actions.updateUi (rekey): save it (debounced) */ uiChanged: () => {},
  /** @type {(ids: ChatId[]) => void} chats removed by the server: their tabs and panes close */ onRemoved: () => {},
};

/** @param {ChatId} id @returns {ChatSummary} */
export function placeholderSummary(id) {
  const i = id.indexOf(':');
  return {
    chatId: id, accountId: i > 0 ? id.slice(0, i) : '', sessionId: i > 0 ? id.slice(i + 1) : id, title: '', titleSource: 'none',
    cwd: '', origin: 'app', createdAt: 0, updatedAt: 0, size: 0, pinned: false, archived: false, muted: false, keepAlive: false,
    state: { phase: 'cold', since: 0, flags: { live: false, unread: false, bgTasks: 0, queued: 0, external: null, stuck: false, notStarted: false }, pending: { count: 0 } },
    activity: '', expiresInDays: null, foreignOwner: false,
  };
}
/** @returns {Draft} */
export const emptyDraft = () => ({ text: '', attachments: [], at: 0 });

// ------------------------------------------------------------------ per-chat records (one per chat ever looked at)
/**
 * @typedef {{
 *   id: ChatId; vm: ChatVM; summary: import('@preact/signals-core').ReadonlySignal<ChatSummary>;
 *   meta: import('@preact/signals-core').Signal<ChatMetaView | null>; metrics: import('@preact/signals-core').Signal<ChatMetrics>;
 *   turns: import('@preact/signals-core').Signal<{ id: string; sig: TurnSig }[]>; turnSigs: Map<string, TurnSig>;
 *   blockSigs: Map<string, BlockSig>; blockTurn: Map<string, string>;
 *   serverQueue: import('@preact/signals-core').Signal<QueueItem[]>; localQueue: import('@preact/signals-core').Signal<LocalQueueItem[]>;
 *   tasks: import('@preact/signals-core').Signal<TaskView[]>; todos: import('@preact/signals-core').Signal<TodoItem[] | null>;
 *   hasMore: import('@preact/signals-core').Signal<boolean>; loading: import('@preact/signals-core').Signal<boolean>;
 *   draft: import('@preact/signals-core').Signal<Draft>;
 *   seq: number; awaitingSnap: boolean; cursor: string | null; loadedTail: boolean; lastDiskTurnId: string | null; tailLoading: boolean;
 *   peekCache: { at: number; turns: UiTurn[] } | null; remoteDraft: Draft; draftTimer: ReturnType<typeof setTimeout> | null;
 *   gen: number;
 * }} ChatRec
 */
/** @type {Map<ChatId, ChatRec>} */
export const recs = new Map();

/** @param {ChatId} id @returns {ChatRec} */
export function getRec(id) {
  let r = recs.get(id);
  if (r) return r;
  const summary = computed(() => chats.value.get(id) ?? placeholderSummary(id));
  const serverQueue = signal(/** @type {QueueItem[]} */ ([]));
  const localQueue = signal(/** @type {LocalQueueItem[]} */ ([]));
  const queue = computed(() => {
    const s = serverQueue.value, l = localQueue.value;
    if (!l.length) return s;
    const known = new Set(s.map((q) => q.uuid));
    return [...s, ...l.filter((q) => !known.has(q.uuid))];
  });
  const chatAsks = computed(() => asks.value.filter((a) => a.chatId === id));
  const initialDraft = emptyDraft();
  /** @type {ChatRec} */
  const rec = {
    id, summary, meta: signal(null), metrics: signal({}), turns: signal([]), turnSigs: new Map(), blockSigs: new Map(), blockTurn: new Map(),
    serverQueue, localQueue, tasks: signal([]), todos: signal(null), hasMore: signal(false), loading: signal(false),
    draft: signal(initialDraft), seq: -1, awaitingSnap: false, cursor: null, loadedTail: false, lastDiskTurnId: null, tailLoading: false,
    peekCache: null, remoteDraft: initialDraft, draftTimer: null, gen: 0,
    vm: /** @type {ChatVM} */ (/** @type {unknown} */ (null)),
  };
  rec.vm = {
    id, summary, meta: rec.meta, metrics: rec.metrics, turns: rec.turns, blocks: (b) => rec.blockSigs.get(b),
    queue, tasks: rec.tasks, todos: rec.todos, asks: chatAsks, hasMore: rec.hasMore, loading: rec.loading, draft: rec.draft,
    askEndReason: (requestId) => askEndReasons.get(`${id}|${requestId}`),
    autoAvailable: computed(() => rec.meta.value?.autoAvailable === true),
  };
  // drafts typed in the composer are saved through the server, debounced 1 s (last write wins by `at`).
  // subscribe() also runs at once with the initial value, and a remote draft set inside a frame batch reaches this
  // callback after the batch: both are recognised by identity, so neither is echoed back (an echo of the empty initial
  // value would erase on the server a draft typed in another window).
  rec.draft.subscribe((d) => {
    if (d === rec.remoteDraft) return;
    if (rec.draftTimer) clearTimeout(rec.draftTimer);
    rec.draftTimer = later(() => {
      rec.draftTimer = null;
      const empty = !d.text && !d.attachments.length;
      hooks.saveDraft(id, empty ? null : d);
    }, LIMITS.META_DEBOUNCE_MS);
  });
  recs.set(id, rec);
  return rec;
}

/**
 * Sets a draft that came from the server without echoing it back; a local save still waiting for its debounce is
 * dropped (it is older than this one). @param {ChatRec} rec @param {Draft} d
 */
export function setRemoteDraft(rec, d) {
  if (rec.draftTimer) { clearTimeout(rec.draftTimer); rec.draftTimer = null; }
  rec.remoteDraft = d;
  rec.draft.value = d;
}

/** @type {typeof import('./contract.d.ts').useChat} */
export const useChat = (c) => getRec(c).vm;

/** Drops the transcript cache of a chat (new boot, reset, rekey); keeps its draft. @param {ChatRec} rec */
export function clearTranscript(rec) {
  rec.gen++;                                      // a tx.page answer still in flight belongs to the dropped transcript
  batch(() => {
    rec.turns.value = [];
    rec.turnSigs.clear(); rec.blockSigs.clear(); rec.blockTurn.clear();
    rec.hasMore.value = false; rec.cursor = null; rec.loadedTail = false; rec.lastDiskTurnId = null; rec.peekCache = null;
  });
}
/** New server boot: drop every per-chat cache and seq, keep drafts (and ui scroll anchors). */
export function dropChatCaches() {
  batch(() => {
    for (const rec of recs.values()) {
      clearTranscript(rec);
      rec.seq = -1; rec.awaitingSnap = false; rec.meta.value = null; rec.metrics.value = {};
      rec.serverQueue.value = []; rec.tasks.value = []; rec.todos.value = null;
    }
  });
}

// ------------------------------------------------------------------ toasts
let toastN = 0;
/** @param {Omit<Toast, 'id' | 'ttl'> & { ttl?: number }} t @returns {number} id */
export function pushToast(t) {
  const id = ++toastN;
  const item = { ttl: t.level === 'error' ? 10_000 : 6_000, ...t, id };
  toasts.value = [...toasts.value.slice(-4), item];
  if (item.ttl > 0) later(() => dismissToast(id), item.ttl);
  return id;
}
/** @param {number} id */
export function dismissToast(id) { toasts.value = toasts.value.filter((x) => x.id !== id); }

/** Server time estimate. */
export const serverNow = () => Date.now() + clockSkew.value;
