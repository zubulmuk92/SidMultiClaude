// @ts-check
// src/web/components/chat/env.js — the chat surface's view of the store.
// useChat / actions come from the shell (contract.d.ts: cap choice, Renvoyer, search, log.client, terminal,
// flags, open, settings, close, force stop, chat.retry, view / scroll persistence). The store data the surface reads
// (accounts, settings, procs, summaries, send issues, ui) comes from store.js. The browser harness swaps all of
// it through configureChatSurface() (typed: Partial<ChatEnv>).
import { signal } from '@preact/signals';
import * as store from '../../store.js';
import { actions as storeActions, peekTurns as storePeekTurns } from '../../actions.js';

/** @typedef {import('../../../shared/protocol.ts').ChatId} ChatId */
/** @typedef {import('../../../shared/protocol.ts').AccountView} AccountView */
/** @typedef {import('../../../shared/protocol.ts').ChatSummary} ChatSummary */
/** @typedef {import('../../../shared/protocol.ts').Settings} Settings */
/** @typedef {import('../../../shared/protocol.ts').ProcStats} ProcStats */
/** @typedef {import('../../../shared/protocol.ts').ViewMode} ViewMode */
/** @typedef {import('../../contract.d.ts').Actions} Actions */
/** @typedef {import('../../contract.d.ts').ChatVM} ChatVM */
/** @typedef {import('../../contract.d.ts').SendIssue} SendIssue */
/** @typedef {import('../../contract.d.ts').SendChoice} CapAnswer */
/** @typedef {import('../../contract.d.ts').ScrollAnchor} ScrollAnchor */

/**
 * @typedef {object} ChatEnv
 * @property {(c: ChatId) => ChatVM} useChat
 * @property {Actions} actions
 * @property {import('@preact/signals').ReadonlySignal<AccountView[]>} accounts
 * @property {import('@preact/signals').ReadonlySignal<Settings | null>} settings
 * @property {import('@preact/signals').ReadonlySignal<ProcStats | null>} procs
 * @property {(c: ChatId) => ChatSummary | undefined} summaryOf  any chat's summary (links, cap candidates)
 * @property {(c: ChatId) => SendIssue | undefined} sendIssue  last chat.send of a chat refused with cap / external
 * @property {(c: ChatId) => Promise<import('../../../shared/protocol.ts').UiTurn[]>} peekTurns  tx.page, cached, never spawns
 * @property {(c: ChatId) => ViewMode | undefined} savedView  the chat's persisted view mode (UiState.views), read once
 * @property {(c: ChatId) => ScrollAnchor | undefined} savedScroll  the chat's persisted scroll anchor (UiState.scroll), read once per mount
 */

/** @type {ChatEnv} */
const env = {
  useChat: store.useChat,
  actions: storeActions,
  accounts: store.accounts,
  settings: store.settings,
  procs: store.procs,
  summaryOf: (c) => store.chats.value.get(c),
  sendIssue: (c) => store.sendIssues.value.get(c),
  peekTurns: (c) => storePeekTurns(c),
  savedView: (c) => store.ui.peek().views[c],
  savedScroll: (c) => store.ui.peek().scroll[c],
};

/** The test harness calls this once before mounting (production uses the store as is). @param {Partial<ChatEnv>} patch */
export function configureChatSurface(patch) { Object.assign(env, patch); }
/** @returns {ChatEnv} */
export const getEnv = () => env;
/** @param {ChatId} c */
export const useChatVM = (c) => env.useChat(c);
/** @returns {Actions} */
export const act = () => env.actions;

/** Report a render error (SPEC §9.2 item 8). Never throws. @param {string} msg @param {ChatId} [c] */
export function reportError(msg, c) {
  try { env.actions.logClient('error', msg.slice(0, 2000), c); } catch { try { console.warn('[chat]', msg); } catch { /* never */ } }
}

/** Per-chat view mode (Ctrl+O). Seeded from the persisted ui.views, else settings.defaultView; saved through saveView. */
const views = new Map();
/** @param {ChatId} c @returns {import('@preact/signals').Signal<ViewMode>} */
export function viewModeOf(c) {
  let s = views.get(c);
  if (!s) { s = signal(/** @type {ViewMode} */ (env.savedView(c) ?? env.settings.value?.defaultView ?? 'normal')); views.set(c, s); }
  return s;
}
/** @param {ChatId} c @param {ViewMode} [to] */
export function cycleView(c, to) {
  const s = viewModeOf(c);
  const order = /** @type {ViewMode[]} */ (['normal', 'detailed', 'focus']);
  s.value = to ?? order[(order.indexOf(s.value) + 1) % order.length] ?? 'normal';
  env.actions.saveView(c, s.value);
}

/** Account record for an id (badge, colours). @param {string} id */
export const accountOf = (id) => env.accounts.value.find((a) => a.id === id);

/** One polite live region for the whole surface (ux §14): announcements only, never streaming text. */
export const announcement = signal('');
/** @param {string} text */
export function announce(text) { announcement.value = ''; queueMicrotask(() => { announcement.value = text; }); }

/**
 * Per-chat transient UI state shared by the parts of a pane (header menus, search, drawer, composer focus requests).
 * Not persisted; a chat shown in two windows has one copy per window.
 * @typedef {{
 *   menu: import('@preact/signals').Signal<null | 'mode' | 'model' | 'more' | 'folder'>;
 *   search: import('@preact/signals').Signal<boolean>; renaming: import('@preact/signals').Signal<boolean>;
 *   drawer: import('@preact/signals').Signal<boolean>; todosOpen: import('@preact/signals').Signal<boolean>;
 *   focusComposer: import('@preact/signals').Signal<number>; jump: import('@preact/signals').Signal<{ turnId: string; blockId?: string; n: number } | null>;
 *   lastTypedAt: number; lastEscAt: number; expanded: import('@preact/signals').Signal<boolean>;
 * }} ChatUi
 */
/** @type {Map<ChatId, ChatUi>} */
const uis = new Map();
/** @param {ChatId} c @returns {ChatUi} */
export function chatUi(c) {
  let u = uis.get(c);
  if (!u) {
    u = { menu: signal(/** @type {null | 'mode' | 'model' | 'more' | 'folder'} */ (null)), search: signal(false), renaming: signal(false),
      drawer: signal(false), todosOpen: signal(false), focusComposer: signal(0),
      jump: signal(/** @type {{ turnId: string; blockId?: string; n: number } | null} */ (null)), lastTypedAt: 0, lastEscAt: 0, expanded: signal(false) };
    uis.set(c, u);
  }
  return u;
}
/** Ask the chat's composer to take the focus (after a card, a dialog, a rewind). @param {ChatId} c */
export const requestComposerFocus = (c) => { const u = chatUi(c); u.focusComposer.value = u.focusComposer.value + 1; };
/** Put text into the chat's draft (rewind / fork / edit-and-resend give the prompt back). @param {ChatId} c @param {string} text */
export function setDraftText(c, text) {
  const d = env.useChat(c).draft;
  d.value = { ...d.value, text, at: Date.now() };
  requestComposerFocus(c);
}
