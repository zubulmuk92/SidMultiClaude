// @ts-check
// src/web/components/composer/logic.js — pure composer logic (ux §7, SPEC §2.4 / §9.2–9.3): send keys, queue chips,
// slash palette, @ mentions, invisible characters, image budget, token hints.

/** @typedef {import('../../../shared/protocol.ts').QueueItem} QueueItem */
/** @typedef {import('../../../shared/protocol.ts').SlashCommandView} SlashCommandView */

/**
 * What a key press in the editor means (SPEC §9.3). Enter = send (or fold while running); Shift+Enter = newline;
 * Alt+Enter = « après ce tour » (priority later) while running, plain send otherwise; Ctrl+Enter = « maintenant »
 * only with the interrupt_send_now_v1 capability, otherwise the same as Enter. With the « Envoyer avec Ctrl+Entrée »
 * setting, Enter inserts a newline and Ctrl+Enter sends.
 * @param {{ key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey?: boolean; isComposing?: boolean }} e
 * @param {{ running: boolean; canSendNow: boolean; ctrlEnterSends: boolean; popupOpen: boolean }} s
 * @returns {'send' | 'later' | 'now' | 'newline' | null}
 */
export function sendKey(e, s) {
  if (e.key !== 'Enter' || e.isComposing) return null;
  if (s.popupOpen && !e.ctrlKey && !e.altKey && !e.shiftKey) return null;   // the popup takes Enter
  if (e.shiftKey) return 'newline';
  if (e.altKey && !e.ctrlKey) return s.running ? 'later' : 'send';
  if (e.ctrlKey) return s.running && s.canSendNow ? 'now' : 'send';
  return s.ctrlEnterSends ? 'newline' : 'send';
}

/** Chip state of a queue item (ux §7.3, SPEC §9.2 item 6).
 * @param {QueueItem} q @returns {{ key: string; removable: boolean; editable: boolean; resend: boolean; done: boolean }} */
export function queueChip(q) {
  switch (q.delivery) {
    case 'pending': case 'queued':
      return { key: q.priority === 'later' ? 'queue.later' : 'queue.item', removable: true, editable: true, resend: false, done: false };
    case 'started': case 'folded': case 'completed':
      return { key: 'queue.taken', removable: false, editable: false, resend: false, done: true };
    case 'cancelled': case 'refused':
      return { key: 'queue.removed', removable: false, editable: false, resend: false, done: true };
    case 'returned':
      return { key: 'queue.returned', removable: true, editable: true, resend: true, done: false };
    default:
      return { key: 'queue.item', removable: false, editable: false, resend: false, done: false };
  }
}

/** Items `↑` takes back into the editor (still waiting, oldest first). @param {QueueItem[]} q */
export const takeBackable = (q) => q.filter((i) => i.delivery === 'queued' || i.delivery === 'pending' || i.delivery === 'returned');

/** @param {string} s */
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Subsequence score (higher is better; -1 = no match). Prefix and word-start bonuses. @param {string} q @param {string} s */
export function fuzzyScore(q, s) {
  if (!q) return 0;
  const Q = fold(q), S = fold(s);
  if (S.startsWith(Q)) return 1000 - S.length;
  const at = S.indexOf(Q);
  if (at >= 0) return 500 - at;
  let i = 0, score = 0, last = -2;
  for (let k = 0; k < S.length && i < Q.length; k++) {
    if (S[k] === Q[i]) { score += last === k - 1 ? 5 : (k === 0 || /[\s/_.-]/.test(S[k - 1] ?? '') ? 3 : 1); last = k; i++; }
  }
  return i === Q.length ? score : -1;
}

/** Slash query when the caret is in the first token and the text starts with '/'. @param {string} text @param {number} caret */
export function slashQuery(text, caret) {
  if (!text.startsWith('/')) return null;
  const end = text.search(/\s/);
  if (end >= 0 && caret > end) return null;
  return text.slice(1, end < 0 ? text.length : end);
}

const GROUP_ORDER = /** @type {const} */ (['builtin', 'skill', 'plugin', 'mcp']);
/** Commands that have a native UI control: intercepted instead of sent (ux §7.4). */
export const INTERCEPTED = Object.freeze(['model', 'effort', 'rewind', 'clear']);
/**
 * Terminal-only commands, never offered (ux §7.4: init.terminal_slash_commands — doctor, color, focus, reload-plugins —
 * plus the TUI-only ones that make no sense in this window: the app has its own login, theme, terminal).
 */
export const TERMINAL_ONLY = Object.freeze(new Set(['doctor', 'color', 'focus', 'reload-plugins', 'exit', 'quit', 'vim',
  'terminal-setup', 'theme', 'statusline', 'login', 'logout', 'ide', 'upgrade', 'install-github-app', 'keybindings']));

/**
 * Palette rows grouped (builtin, skill, plugin, mcp), fuzzy on names, aliases and descriptions; terminal-only commands hidden.
 * @param {SlashCommandView[]} cmds @param {string} q @returns {{ group: SlashCommandView['group']; items: SlashCommandView[] }[]}
 */
export function slashResults(cmds, q, max = 40) {
  const scored = cmds.filter((c) => !TERMINAL_ONLY.has(c.name)).map((c) => {
    const s = Math.max(fuzzyScore(q, c.name) * 2, ...(c.aliases ?? []).map((a) => fuzzyScore(q, a) * 2), q ? fuzzyScore(q, c.description) - 400 : 0);
    return { c, s };
  }).filter((x) => x.s >= 0 && (q === '' || x.s > -1));
  scored.sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name));
  const top = scored.slice(0, max).map((x) => x.c);
  return GROUP_ORDER.map((group) => ({ group, items: top.filter((c) => c.group === group) })).filter((g) => g.items.length);
}

/** `@` token before the caret → { start, q } (start = index of '@'). @param {string} text @param {number} caret */
export function mentionQuery(text, caret) {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - (m[2] ?? '').length - 1, q: m[2] ?? '' };
}

/** Insert `@path ` in place of the mention token. @param {string} text @param {{ start: number }} at @param {number} caret @param {string} path @param {boolean} dir */
export function insertMention(text, at, caret, path, dir) {
  const ins = '@' + path.replace(/\\/g, '/') + (dir && !path.endsWith('/') ? '/' : '') + ' ';
  return { text: text.slice(0, at.start) + ins + text.slice(caret), caret: at.start + ins.length };
}

/** Zero-width and bidi control characters removed from pasted text (ux §7.6). @param {string} s */
export function stripInvisible(s) {
  const re = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
  const removed = (s.match(re) ?? []).length;
  return { text: removed ? s.replace(re, '') : s, removed };
}

/** UTF-8 byte length. @param {string} s */
export const utf8Bytes = (s) => new TextEncoder().encode(s).length;

/** ≈ tokens of an image (w·h/750, ux §5.3). @param {number} w @param {number} h */
export const imageTokens = (w, h) => Math.round((w * h) / 750);

/**
 * Image budget: one message's images must fit MAX_IMAGES_TOTAL_BYTES (sum of base64 lengths) and each must fit
 * MAX_IMAGE_BYTES. Returns the per-image byte target (base64 length) the encoder must reach; images already under
 * their target are left untouched (sent as pasted). Targets share the budget in proportion to the current sizes.
 * @param {number[]} sizes base64 lengths @param {{ perImage: number; total: number }} lim @returns {number[]} targets
 */
export function imageTargets(sizes, lim) {
  const sum = sizes.reduce((a, b) => a + b, 0);
  const capped = sizes.map((s) => Math.min(s, lim.perImage));
  const cappedSum = capped.reduce((a, b) => a + b, 0);
  if (cappedSum <= lim.total) return capped;
  const ratio = lim.total / Math.max(1, sum);
  return capped.map((s, k) => Math.min(s, Math.floor((sizes[k] ?? 0) * ratio)));
}

/** Tokens to re-cache when waking (ux §7.8): max(0, lastContext − 19 k). @param {number} lastContext */
export const recacheEstimate = (lastContext) => Math.max(0, lastContext - 19_000);

/** Context almost full: within 5 % of the window below the auto-compaction threshold.
 * @param {{ contextTokens?: number; contextWindow?: number; autoCompactAt?: number }} m */
export function contextFull(m) {
  if (!m.contextTokens || !m.contextWindow) return null;
  const at = m.autoCompactAt ?? m.contextWindow - 33_000;
  return m.contextTokens >= at - 0.05 * m.contextWindow ? Math.round((m.contextTokens / m.contextWindow) * 100) : null;
}
