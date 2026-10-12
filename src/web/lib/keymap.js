// @ts-check
// src/web/lib/keymap.js — keyboard map (SPEC §9.3): digits on event.code, letters on event.key.
// Pure: actionFor(e) maps a keydown to an action id (or null). The shell handles the global ids; the chat ids are exported
// for the chat surface (it may call actionFor in its own handlers). Never bound: Ctrl+N/T/W/Tab/PgUp/PgDn/1…9, Ctrl+Maj+…, Ctrl+Alt+…
// (AltGr on AZERTY), Alt+Maj+…, Alt+F/E/D/←/→, F12. Single letters and `?` never act inside text fields.

/** @typedef {{ key: string; code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean; target?: EventTarget | null; isComposing?: boolean }} KeyLike */

/** Global actions, handled by the shell. */
export const GLOBAL = Object.freeze({
  switcher: 'switcher', newChat: 'newChat', resume: 'resume', accounts: 'accounts', nextAttention: 'nextAttention',
  tabNext: 'tabNext', tabPrev: 'tabPrev', closeTab: 'closeTab', reopenTab: 'reopenTab', layout: 'layout', sidebar: 'sidebar',
  regionNext: 'regionNext', regionPrev: 'regionPrev', help: 'help', settings: 'settings',
});
/** Chat actions (focused pane, chat surface). */
export const CHAT = Object.freeze({
  view: 'chat.view', search: 'chat.search', rename: 'chat.rename', background: 'chat.background', mode: 'chat.mode',
  model: 'chat.model', tasks: 'chat.tasks', agents: 'chat.agents', prevMsg: 'chat.prevMsg', nextMsg: 'chat.nextMsg', bottom: 'chat.bottom',
});

/** True when the event target is a text field (input, textarea, select, contenteditable). @param {EventTarget | null | undefined} t */
export function inTextField(t) {
  const el = /** @type {HTMLElement | null} */ (/** @type {unknown} */ (t ?? null));
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  const tag = String(el.tagName).toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(/** @type {HTMLInputElement} */ (el).type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return Boolean(el.isContentEditable);
}

/** Digit 1–9 from event.code (Digit1 / Numpad1), whatever the layout. @param {KeyLike} e @returns {number | null} */
export function digitOf(e) {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code ?? '');
  return m ? Number(m[1]) : null;
}

/** @param {KeyLike} e @returns {string | null} action id */
export function actionFor(e) {
  if (e.isComposing) return null;
  const ctrl = Boolean(e.ctrlKey), alt = Boolean(e.altKey), shift = Boolean(e.shiftKey), meta = Boolean(e.metaKey);
  if (meta || (ctrl && alt)) return null;                  // Ctrl+Alt = AltGr on AZERTY: never ours
  if (alt && shift) return null;                           // Alt+Maj switches the input language
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const text = inTextField(e.target);
  if (alt) {
    const d = digitOf(e);
    if (d !== null && d >= 1) return `tab:${d}`;
    switch (key) {
      case 'n': return GLOBAL.newChat;
      case 'r': return GLOBAL.resume;
      case 'c': return GLOBAL.accounts;
      case 'a': return GLOBAL.nextAttention;
      case 'w': return GLOBAL.closeTab;
      case 'z': return GLOBAL.reopenTab;
      case 'l': return GLOBAL.layout;
      case 'b': return GLOBAL.sidebar;
      case 'PageDown': return GLOBAL.tabNext;
      case 'PageUp': return GLOBAL.tabPrev;
      case 'm': return CHAT.mode;
      case 'p': return CHAT.model;
      case 't': return CHAT.tasks;
      case 'g': return CHAT.agents;
      case 'ArrowUp': return text ? null : CHAT.prevMsg;
      case 'ArrowDown': return text ? null : CHAT.nextMsg;
      default: return null;
    }
  }
  if (ctrl) {
    if (shift) return null;
    switch (key) {
      case 'k': return GLOBAL.switcher;
      case ',': return GLOBAL.settings;
      case 'o': return CHAT.view;
      case 'f': return CHAT.search;
      case 'b': return text ? null : CHAT.background;
      case 'End': return text ? null : CHAT.bottom;
      default: return null;
    }
  }
  if (key === 'F6') return shift ? GLOBAL.regionPrev : GLOBAL.regionNext;
  if (shift) return key === '?' && !text ? GLOBAL.help : null;
  if (key === 'F1') return GLOBAL.help;
  if (key === 'F2') return CHAT.rename;
  if (key === '?' && !text) return GLOBAL.help;
  return null;
}

/** Ids handled by the shell itself (tab:n included). @param {string | null} id */
export function isGlobal(id) { return id !== null && (id.startsWith("tab:") || /** @type {string[]} */ (Object.values(GLOBAL)).includes(id)); }
