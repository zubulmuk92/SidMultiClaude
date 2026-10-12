// @ts-check
// src/web/components/composer/CapChoice.js — inline process-cap choice (ux §4.2, §15.2; SPEC §6.3): shown in the composer
// area when a chat.send came back `cap` (candidates to put to sleep, each with its re-cache cost), `cap_busy` (none can
// sleep now: exceed or cancel) or `external` (the session is open elsewhere). The message stays as a chip until the
// user picks.
import { html } from 'htm/preact';
import { t, fmtTokens } from '../chat/text.js';
import { getEnv } from '../chat/env.js';

/** @param {{ chatId: string }} p */
export function CapChoice({ chatId }) {
  const env = getEnv();
  const issue = env.sendIssue(chatId);
  if (!issue) return null;
  /** @param {string} c @param {import('../../contract.d.ts').SendChoice} choice */
  const resolve = (c, choice) => env.actions.resolveSend(c, choice);
  const err = issue.err;
  if (err.code === 'cap') {
    const n = env.procs.value?.effectiveMax ?? env.procs.value?.max ?? err.candidates.length;
    const first = err.candidates[0];
    return html`<div class="k-cap" role="alertdialog" aria-label=${t('cap.title')}>
      <p>${first ? t('cap.choice', { n, titre: first.title, tokens: fmtTokens(first.recacheTokens) }) : t('cap.title')}</p>
      <div class="d-actions">
        ${err.candidates.map((c, k) => html`<button type="button" class=${'d-btn' + (k === 0 ? ' d-primary' : '')}
            title=${t('cap.candidate', { min: c.warmMin, tokens: fmtTokens(c.recacheTokens) })} onClick=${() => resolve(chatId, { evict: c.chatId })}>
          ${t('cap.sleep', { titre: c.title })}<small> · ~${fmtTokens(c.recacheTokens)}</small></button>`)}
        <button type="button" class="d-btn" onClick=${() => resolve(chatId, { exceed: true })}>${t('cap.exceed')}</button>
        <button type="button" class="d-btn d-quiet" onClick=${() => resolve(chatId, 'cancel')}>${t('cap.cancel')}</button>
      </div>
    </div>`;
  }
  if (err.code === 'cap_busy') {          // no chat can be put to sleep now: exceed the cap, or cancel
    return html`<div class="k-cap" role="alertdialog" aria-label=${t('cap.title')}>
      <p>${t('cap.busy')}</p>
      <div class="d-actions">
        <button type="button" class="d-btn d-primary" onClick=${() => resolve(chatId, { exceed: true })}>${t('cap.exceed')}</button>
        <button type="button" class="d-btn d-quiet" onClick=${() => resolve(chatId, 'cancel')}>${t('cap.cancel')}</button>
      </div>
    </div>`;
  }
  if (err.code === 'external') {
    return html`<div class="k-cap" role="alertdialog" aria-label=${t('state.external')}>
      <p>${t(`state.external.${err.holder.status}`)} · ${t('term.locked')}</p>
      <div class="d-actions">
        <button type="button" class="d-btn" onClick=${() => resolve(chatId, { force: true })}>${t('term.force')}</button>
        <button type="button" class="d-btn d-quiet" onClick=${() => resolve(chatId, 'cancel')}>${t('cap.cancel')}</button>
      </div>
    </div>`;
  }
  return null;
}
