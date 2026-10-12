// @ts-check
// src/web/lib/modal.js — « is a modal surface open? » for keyboard arbitration between the shell and the chat
// surface: the shell overlay (dialogs, switcher, Peek), the orphans dialog, the chat overlays (Rewind,
// ContinueOn, Wake, ModelSwitchConfirm, Lightbox, AgentsDrawer, info), and any aria-modal element in the page.
// While one is open, global shell keys do nothing and an async composer focus request never steals the focus.
import { orphans, overlay as shellOverlay } from '../store.js';
import { overlay as chatOverlay } from '../components/side/overlays.js';

/** @returns {boolean} */
export function modalOpen() {
  if (shellOverlay.peek() || chatOverlay.peek() || orphans.peek()) return true;
  return typeof document !== 'undefined' && typeof document.querySelector === 'function' && !!document.querySelector('[aria-modal="true"]');
}
