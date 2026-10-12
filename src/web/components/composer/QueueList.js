// @ts-check
// src/web/components/composer/QueueList.js — « En file (n) » strip above the editor (ux §7.1, §7.3): one chip per queued
// message following its delivery (En file · Après ce tour · Retiré · Non envoyé · Renvoyer); a started or folded message
// leaves the strip (it is in the transcript). « Déjà pris en compte » is the toast of a take-back that came too late.
// ✎ and ↑ take a message back into the editor (cancelQueued); × removes it.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { t } from '../chat/text.js';
import { act, getEnv, useChatVM } from '../chat/env.js';
import { queueChip, takeBackable } from './logic.js';

/** @typedef {import('../../../shared/protocol.ts').QueueItem} QueueItem */

/**
 * Take queued messages back (newest last), one per line, through cancelQueued; a message already taken stays put and
 * shows « Déjà pris en compte ». Resolves with the texts that came back.
 * @param {string} chatId @param {QueueItem[]} items @returns {Promise<string[]>}
 */
export async function takeBack(chatId, items) {
  /** @type {string[]} */ const out = [];
  for (const q of items) {
    try {
      if (await act().cancelQueued(chatId, q.uuid)) out.push(q.text);
      else act().toast('queue.taken');
    } catch { /* toast shown by the store */ }
  }
  return out;
}

/** @param {{ chatId: string; onTakeBack: (texts: string[]) => void }} p */
export function QueueList({ chatId, onTakeBack }) {
  const vm = useChatVM(chatId);
  // ux §7.3: once started (or folded into the running turn) a message « moves into the transcript as a normal message »:
  // its chip leaves the strip (the message that opened the turn must not stay here as « Déjà pris en compte »)
  const items = vm.queue.value.filter((q) => q.delivery !== 'started' && q.delivery !== 'folded' && q.delivery !== 'completed');
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  if (!items.length) return null;
  const live = takeBackable(items).length;
  /** @param {QueueItem} q */
  const edit = async (q) => { setBusy(q.uuid); try { onTakeBack(await takeBack(chatId, [q])); } finally { setBusy(null); } };
  /** @param {QueueItem} q */
  const remove = async (q) => { setBusy(q.uuid); try { if (!(await act().cancelQueued(chatId, q.uuid))) act().toast('queue.taken'); } catch { /* toast */ } finally { setBusy(null); } };
  return html`<div class="q-list" role="list" aria-label=${t('queue.header', { n: live })}>
    <div class="q-head">${t('queue.header', { n: live })}</div>
    ${items.map((q) => {
      const c = queueChip(q);
      return html`<div key=${q.uuid} role="listitem" class=${'q-item q-' + q.delivery + (c.done ? ' q-done' : '')} data-uuid=${q.uuid}>
        <span class="q-text" title=${q.text}>« ${q.text.split('\n')[0]} »${q.images ? ` · 🖼 ${q.images}` : ''}</span>
        <span class="q-state">${t(c.key)}</span>
        ${c.resend ? html`<button type="button" class="c-mini" disabled=${busy === q.uuid}
          onClick=${() => { getEnv().actions.resend(chatId, q.uuid); }}>${t('composer.resend')}</button>` : null}
        ${c.editable ? html`<button type="button" class="c-icon" aria-label=${t('queue.edit')} title=${t('queue.edit')} disabled=${busy === q.uuid}
          onClick=${() => edit(q)}>✎</button>` : null}
        ${c.removable ? html`<button type="button" class="c-icon" aria-label=${t('queue.remove')} title=${t('queue.remove')} disabled=${busy === q.uuid}
          onClick=${() => remove(q)}>✕</button>` : null}
      </div>`;
    })}
  </div>`;
}
