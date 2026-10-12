// @ts-check
// src/web/components/side/WakeDialog.js — first send to a chat idle > 1 h with > 100 k context (ux §7.8, SPEC §2.10,
// CLI parity): « Reprendre tel quel » or « Reprendre depuis un résumé » (/compact first, then the message, 'later').
// « Ne plus demander » sets settings.wakeNeverAsk. Annuler gives the message back to the composer.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { t, fmtTokens, fmtDuration } from '../chat/text.js';
import { act, getEnv, setDraftText, useChatVM } from '../chat/env.js';
import { attachmentsOf } from '../composer/Attachments.js';
import { recacheEstimate } from '../composer/logic.js';
import { closeOverlay } from './overlays.js';
import { Modal } from './Popovers.js';
import { Icon } from '../../lib/icons.js';

/** @typedef {import('../../../shared/protocol.ts').ImageInput} ImageInput */

/** @param {{ chatId: string; text: string; images?: ImageInput[] }} p */
export function WakeDialog({ chatId, text, images }) {
  const vm = useChatVM(chatId);
  const sum = vm.summary.value;
  const w = sum.wake ?? { lastContext: 0, recacheTokens: 0, idleMs: 0, dialog: true };
  const [choice, setChoice] = useState(/** @type {'asIs' | 'summary'} */ ('asIs'));
  const [never, setNever] = useState(false);
  const send = () => {
    if (never) getEnv().actions.setSettings({ wakeNeverAsk: true });
    act().send(chatId, text, { ...(images?.length ? { images } : {}), wake: choice });
    closeOverlay();
  };
  const cancel = () => {
    closeOverlay();
    setDraftText(chatId, text);
    if (images?.length) attachmentsOf(chatId).value = images.map((im, k) => ({ name: `image-${k + 1}`, mediaType: im.mediaType, base64: im.base64 }));
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    const d = /^(?:Digit|Numpad)([12])$/.exec(e.code);
    if (d) { setChoice(d[1] === '1' ? 'asIs' : 'summary'); return true; }
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { send(); return true; }
    return false;
  };
  const footer = html`<button type="button" class="d-btn d-quiet" onClick=${cancel}>${t('cap.cancel')}</button>
    <button type="button" class="d-btn d-primary" onClick=${send}>${t('wake.send')} <${Icon} n="enter" size=${14} /></button>`;
  return html`<${Modal} title=${t('wake.title', { titre: sum.title })} onClose=${cancel} onKey=${onKey} cls="s-wake" footer=${footer}>
    <p>${t('wake.body', { 'durée': fmtDuration(w.idleMs), contexte: fmtTokens(w.lastContext) })}</p>
    <div role="radiogroup" aria-label=${t('wake.title', { titre: sum.title })}>
      <label class="s-radio"><input type="radio" name="wake" checked=${choice === 'asIs'} onChange=${() => setChoice('asIs')} />
        (1) ${t('wake.asIs', { tokens: fmtTokens(w.recacheTokens || recacheEstimate(w.lastContext)) })}</label>
      <label class="s-radio"><input type="radio" name="wake" checked=${choice === 'summary'} onChange=${() => setChoice('summary')} />
        (2) ${t('wake.summary')}</label>
    </div>
    <label class="s-check"><input type="checkbox" checked=${never} onChange=${(/** @type {any} */ e) => setNever(e.currentTarget.checked)} /> ${t('wake.never')}</label>
  <//>`;
}
