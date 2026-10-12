// @ts-check
// src/web/components/dock/Card.js — shared frame and decision hook of the pending cards (ux §6.1, SPEC §9.2 item 9):
// a click disables the card until its ack; `not_pending` → « Déjà traitée ailleurs ».
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { t, fmtDuration } from '../chat/text.js';
import { act } from '../chat/env.js';

/** @typedef {import('../../../shared/protocol.ts').PendingAsk} PendingAsk */
/** @typedef {import('../../../shared/protocol.ts').UiAnswer} UiAnswer */

/** requestIds this window answered (no withdrawal notice for them). */
export const answered = new Set();

/** Re-render every `ms` while mounted (waiting timers). @param {number} ms */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

/** @param {string} chatId @param {PendingAsk} ask */
export function useDecide(chatId, ask) {
  const [busy, setBusy] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  /** @param {UiAnswer} a */
  const decide = async (a) => {
    if (busy || elsewhere) return;
    setBusy(true);
    answered.add(ask.requestId);
    try {
      const r = await act().decide(chatId, ask.requestId, a);
      if (r === 'not_pending') setElsewhere(true);
    } catch {
      answered.delete(ask.requestId);
      setBusy(false);                     // the store already showed the error toast; the card stays usable
    }
  };
  return { busy, elsewhere, decide };
}

/**
 * Card frame: role=group labelled by its title, focusable (tabindex -1) so the keys act on it, `data-dock-card` for the
 * shell (Alt+A lands here). Shows « i sur n » and « en attente depuis … ».
 * @param {{ ask: PendingAsk; icon: string; title: string; index: number; total: number; cls?: string; full?: boolean;
 *   busy?: boolean; elsewhere?: boolean; onKey?: (e: KeyboardEvent) => void; tools?: import('preact').ComponentChildren;
 *   children?: import('preact').ComponentChildren }} p
 */
export function CardFrame({ ask, icon, title, index, total, cls, full, busy, elsewhere, onKey, tools, children }) {
  const now = useNow();
  const id = `card-${ask.requestId}`;
  const wait = t('state.waiting', { 'durée': fmtDuration(Math.max(0, now - ask.since)) });
  return html`<div class=${'d-card ' + (cls ?? '') + (full ? ' d-full' : '') + (busy ? ' d-busy' : '')} role="group"
      aria-labelledby=${id} tabindex="-1" data-dock-card=${ask.requestId} data-chat=${ask.chatId} onKeyDown=${onKey}>
    <div class="d-card-head">
      <span class="d-card-icon" aria-hidden="true">${icon}</span>
      <strong id=${id} class="d-card-title">${title}</strong>
      ${tools ?? null}
      <span class="d-card-meta">${total > 1 ? t('perm.stack', { i: index + 1, n: total }) + ' · ' : ''}${wait}</span>
    </div>
    ${elsewhere ? html`<div class="d-elsewhere" role="status">${t('perm.elsewhere')}</div>` : null}
    <fieldset class="d-card-body" disabled=${!!busy || !!elsewhere}>${children}</fieldset>
  </div>`;
}

/** Key hint inside a button label (« 1 », « O »). @param {{ k: string }} p */
export const Kbd = ({ k }) => html`<kbd class="d-kbd" aria-hidden="true">${k}</kbd>`;
