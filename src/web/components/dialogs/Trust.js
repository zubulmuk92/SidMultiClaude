// @ts-check
// src/web/components/dialogs/Trust.js — « Faire confiance à ce dossier ? » (ux §8.1; CLI parity: the terminal asks too).
// Rendered inside NewChat (and by itself through the overlay host). Folders trusted here are stored in the app's
// metadata by the server (chat.create trust:true), never in the profile.
import { html } from 'htm/preact';
import { t } from '../../lib/i18n.js';
import { Modal } from '../shell/common.js';

/** @param {{ path: string; onAnswer: (ok: boolean) => void }} p */
export function Trust({ path, onAnswer }) {
  return html`<${Modal} title=${t('trust.title')} onClose=${() => onAnswer(false)} cls="trust"
      footer=${html`<button type="button" class="btn" onClick=${() => onAnswer(false)}>${t('trust.cancel')}</button>
        <button type="button" class="btn primary" data-autofocus onClick=${() => onAnswer(true)}>${t('trust.ok')}</button>`}>
    <p>${t('trust.body', { chemin: path })}</p>
  </${Modal}>`;
}
