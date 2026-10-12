// @ts-check
// src/web/components/dialogs/Confirm.js — confirmation dialog (delete, logout, quit, sleep with tasks…), optionally with a
// typed confirmation word. Opened through actions.confirmBox(); resolves true/false exactly once.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, has } from '../../lib/i18n.js';
import { closeOverlay } from '../../actions.js';
import { Modal } from '../shell/common.js';

/** @param {{ title?: string; body: string; args?: Record<string, string | number>; ok?: string; cancel?: string; danger?: boolean; typed?: string; resolve?: (v: boolean) => void }} p */
export function Confirm({ title, body, args, ok, cancel, danger, typed, resolve }) {
  const [word, setWord] = useState('');
  const done = useRef(false);
  /** @param {boolean} v */
  const finish = (v) => { if (done.current) return; done.current = true; closeOverlay(); resolve?.(v); };
  useEffect(() => () => { if (!done.current) { done.current = true; resolve?.(false); } }, []);
  const tx = (/** @type {string | undefined} */ k, /** @type {string} */ fb) => (k ? (has(k) ? t(k, args) : k) : t(fb));
  const blocked = Boolean(typed) && word !== typed;
  return html`<${Modal} title=${tx(title, 'shell.confirm.title')} onClose=${() => finish(false)} cls="confirm"
      footer=${html`<button type="button" class="btn" onClick=${() => finish(false)}>${tx(cancel, 'shell.cancel')}</button>
        <button type="button" class=${`btn ${danger ? 'danger' : 'primary'}`} disabled=${blocked} data-autofocus=${typed ? undefined : ''}
          onClick=${() => finish(true)}>${tx(ok, 'shell.ok')}</button>`}>
    <p class="confirm-body">${tx(body, 'shell.confirm.title')}</p>
    ${typed ? html`<label class="field"><span>${t('shell.confirm.typed', { mot: typed })}</span>
      <input data-autofocus value=${word} onInput=${(/** @type {InputEvent} */ e) => setWord(/** @type {HTMLInputElement} */ (e.target).value)}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && !blocked) finish(true); }} /></label>` : null}
  </${Modal}>`;
}
