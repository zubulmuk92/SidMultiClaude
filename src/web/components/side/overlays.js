// @ts-check
// src/web/components/side/overlays.js — one signal for the chat overlays mounted once by ChatOverlays() (contract.d.ts):
// Rewind, ContinueOn, Wake, ModelSwitchConfirm, CapChoice, Lightbox, AgentsDrawer, session info.
// The process-cap choice is not an overlay: composer/CapChoice.js renders it inline from env.sendIssue (the store's sendIssues).
import { signal } from '@preact/signals';

/** @typedef {import('../../../shared/protocol.ts').ChatId} ChatId */
/** @typedef {import('../../../shared/protocol.ts').Uuid} Uuid */
/** @typedef {import('../../../shared/protocol.ts').CapCandidate} CapCandidate */
/** @typedef {import('../../../shared/protocol.ts').Effort} Effort */
/** @typedef {import('../../../shared/protocol.ts').ImageInput} ImageInput */

/**
 * @typedef {{ kind: 'rewind'; chatId: ChatId; uuid?: Uuid }
 *   | { kind: 'continue'; chatId: ChatId; target?: string }
 *   | { kind: 'wake'; chatId: ChatId; text: string; images?: ImageInput[] }
 *   | { kind: 'model'; chatId: ChatId; model: string | null; effort: Effort | null; effortOnly?: boolean }
 *   | { kind: 'cap'; chatId: ChatId; uuid?: Uuid; candidates: CapCandidate[]; text?: string }
 *   | { kind: 'lightbox'; chatId: ChatId; ref?: string; mediaType?: string; dataUrl?: string }
 *   | { kind: 'agents'; chatId: ChatId }
 *   | { kind: 'info'; chatId: ChatId; what: 'session' | 'context' }
 *   | { kind: 'confirm'; chatId: ChatId; title: string; body: string; ok: string; danger?: boolean; typed?: string; onOk: () => void }} Overlay
 */

/** The open overlay (one at a time; opening another replaces it). */
export const overlay = signal(/** @type {Overlay | null} */ (null));
/** Element focused before the overlay opened (restored on close, ux §10.4). */
let opener = /** @type {Element | null} */ (null);

/** @param {Overlay} o */
export function openOverlay(o) {
  if (!overlay.value && typeof document !== 'undefined') opener = document.activeElement;
  overlay.value = o;
}
export function closeOverlay() {
  overlay.value = null;
  const el = /** @type {HTMLElement | null} */ (opener);
  opener = null;
  if (el && typeof el.focus === 'function' && el.isConnected) el.focus();
}
