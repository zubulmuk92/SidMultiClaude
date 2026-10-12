// @ts-check
// src/web/lib/notify.js — desktop notifications (ux §11, SPEC S17).
// - Only when the user is not looking: looking = page visible AND window focused AND the chat shown in a pane.
// - Tag `chatId:kind` (a newer one replaces the older); never an action button; minimal text: state · account monogram ·
//   chat title (no prompt, no tool input, no model output); silent:true (the app plays its own sound).
// - Several within 3 s → one grouped notification (notif.multi). DND (settings.dndUntil), muted chats and terminal-held
//   chats (`external`: the terminal already signals it) never notify.
// notificationFor() is pure (unit-tested); deliver() talks to the Notification API.
import { t, tTitleBody } from './i18n.js';

/** @typedef {import('../../shared/protocol.ts').ChatSummary} ChatSummary */
/** @typedef {import('../../shared/protocol.ts').Settings} Settings */
/** @typedef {import('../../shared/protocol.ts').PendingAsk} PendingAsk */
/** @typedef {{ tag: string; title: string; body: string; chatId: string; sound: 'chime' | 'tick' | 'low' | null }} Notif */
/** @typedef {{ looking: boolean; settings: Settings | null; now: number; monogram: string; accountName: string; ask?: PendingAsk }} NotifCtx */

const NEEDS = new Set(['needs_permission', 'needs_answer', 'needs_plan']);
export const DONE_MIN_MS = 10_000;
export const GROUP_WINDOW_MS = 3_000;

/** @param {Settings | null} s @param {number} now */
export const dndActive = (s, now) => Boolean(s && s.dndUntil !== null && s.dndUntil > now);

/**
 * Decides the notification for one summary change (null = none).
 * @param {ChatSummary | undefined} prev @param {ChatSummary} next @param {NotifCtx} ctx @returns {Notif | null}
 */
export function notificationFor(prev, next, ctx) {
  const st = next.state;
  const was = prev?.state;
  if (!prev || !was) return null;                       // first sight (hello / new chat): never notify
  if (ctx.looking || next.muted || st.flags.external) return null;
  const titre = next.title || t('state.new');
  const compte = ctx.monogram || ctx.accountName;
  const tag = (/** @type {string} */ kind) => `${next.chatId}:${kind}`;
  if (NEEDS.has(st.phase) && (st.phase !== was.phase || (st.pending.count > was.pending.count))) {
    if (st.phase === 'needs_permission') {
      const { title } = tTitleBody('notif.perm', { compte, titre, outil: '', 'résumé': '' });
      return { tag: tag('perm'), title, body: ctx.ask ? (ctx.ask.displayName ?? ctx.ask.toolName) : '', chatId: next.chatId, sound: 'chime' };
    }
    if (st.phase === 'needs_answer') return { tag: tag('ask'), title: t('notif.ask', { titre }), body: '', chatId: next.chatId, sound: 'chime' };
    return { tag: tag('plan'), title: t('notif.plan', { titre }), body: '', chatId: next.chatId, sound: 'chime' };
  }
  if (st.phase === 'error' && was.phase !== 'error') return { tag: tag('error'), title: t('notif.error', { titre }), body: '', chatId: next.chatId, sound: 'low' };
  if (st.phase === 'rate_limited' && was.phase !== 'rate_limited') {
    const { title } = tTitleBody('notif.limit', { compte: ctx.accountName, heure: '' });
    return { tag: tag('limit'), title, body: '', chatId: next.chatId, sound: 'low' };
  }
  if (st.phase === 'idle' && st.flags.unread && !was.flags.unread && was.phase === 'running' && st.since - was.since >= DONE_MIN_MS) {
    const { title } = tTitleBody('notif.done', { titre, extrait: '' });
    return { tag: tag('done'), title, body: '', chatId: next.chatId, sound: 'tick' };
  }
  return null;
}

/** Whether a decided notification is shown / sounded under the settings. @param {Settings | null} s @param {number} now */
export function allowed(s, now) {
  if (!s || dndActive(s, now)) return { os: false, sound: false };
  return { os: s.notifications, sound: s.sound };
}

/**
 * Groups notifications that arrive within GROUP_WINDOW_MS into one notif.multi. Pure state machine.
 * @param {{ at: number; items: Notif[] }} buf @param {Notif} n @param {number} now
 * @returns {{ buf: { at: number; items: Notif[] }; show: Notif }}
 */
export function groupNotif(buf, n, now) {
  const items = now - buf.at <= GROUP_WINDOW_MS ? [...buf.items.filter((x) => x.tag !== n.tag), n] : [n];
  const at = items.length === 1 ? now : buf.at;
  if (items.length < 2) return { buf: { at, items }, show: n };
  const chatsN = new Set(items.map((x) => x.chatId)).size;
  return { buf: { at, items }, show: { tag: MULTI_TAG, title: t('notif.multi', { n: chatsN }), body: '', chatId: n.chatId, sound: n.sound } };
}

// ------------------------------------------------------------------ browser side
/** @returns {'granted' | 'denied' | 'default' | 'unsupported'} */
export function permission() {
  try { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; } catch { return 'unsupported'; }
}
/** @returns {Promise<string>} */
export async function requestPermission() {
  try { return typeof Notification === 'undefined' ? 'unsupported' : await Notification.requestPermission(); } catch { return 'denied'; }
}
/** Notifications on screen, by tag: the grouped one (smc:multi) closes the singles it replaces. */
const shown = /** @type {Map<string, { close: () => void }>} */ (new Map());
/** Tag of the grouped notification (groupNotif). */
export const MULTI_TAG = 'smc:multi';
/**
 * Shows one notification (no buttons, silent). Click → focus the window and open the chat. Only ONE is ever on screen
 * for a burst: the grouped « notif.multi » closes the single notifications it stands for.
 * @param {Notif} n @param {(chatId: string) => void} onClick @returns {boolean}
 */
export function deliver(n, onClick) {
  if (permission() !== 'granted') return false;
  try {
    if (n.tag === MULTI_TAG) for (const [tag, x] of shown) if (tag !== MULTI_TAG) { shown.delete(tag); try { x.close(); } catch { /* gone */ } }
    const note = new Notification(n.title, { body: n.body, tag: n.tag, silent: true });
    shown.set(n.tag, note);
    note.onclose = () => { if (shown.get(n.tag) === note) shown.delete(n.tag); };
    note.onclick = () => { try { window.focus(); } catch { /* */ } onClick(n.chatId); note.close(); };
    return true;
  } catch { return false; }
}
