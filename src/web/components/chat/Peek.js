// @ts-check
// src/web/components/chat/Peek.js — interactive Peek (SPEC §9.2 item 1): the last 3 exchanges (tx.page, cached) and the
// chat's top pending card, which keeps its keys 1 / 2 / 3. Entrée opens the chat; Échap ALWAYS closes (never answers a card). Peek
// never spawns a process.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, fmtTime } from './text.js';
import { act, getEnv, useChatVM } from './env.js';
import { LIMITS } from './consts.js';
import { Markdown } from './Blocks.js';
import { PendingDock } from '../dock/PendingDock.js';

/** @typedef {import('../../../shared/protocol.ts').UiTurn} UiTurn */

/** Last `n` exchanges, oldest first: the user prompt and the final reply of each turn (pure). @param {UiTurn[]} turns @param {number} n */
export function peekExchanges(turns, n) {
  return turns.filter((x) => x.user || x.blocks.some((b) => b.k === 'text')).slice(-n).map((x) => {
    const last = x.blocks.filter((b) => b.k === 'text').pop();
    return { id: x.id, at: x.at, user: x.user?.text ?? null, reply: last && last.k === 'text' ? last.md : null };
  });
}

/** @param {{ chatId: string; onClose: () => void }} p */
export function Peek({ chatId, onClose }) {
  const vm = useChatVM(chatId);
  const [turns, setTurns] = useState(/** @type {UiTurn[] | null} */ (null));
  const root = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => {
    let alive = true;
    const loaded = vm.turns.value.map((x) => x.sig.value);
    const p = getEnv().peekTurns;
    if (loaded.length || !p) setTurns(loaded);
    else p(chatId).then((x) => { if (alive) setTurns(x); }, () => { if (alive) setTurns([]); });
    root.current?.focus();
    return () => { alive = false; };
  }, [chatId]);
  const sum = vm.summary.value;
  const ex = turns ? peekExchanges(turns, LIMITS.PEEK_EXCHANGES) : [];
  /** Inside Peek, Échap ALWAYS closes the Peek and never answers a card (capture phase, before the
   * cards' own « refuser et arrêter »). @param {KeyboardEvent} e */
  const onKeyCapture = (e) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault(); e.stopPropagation(); onClose();
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.defaultPrevented) return;
    const inCard = !!(/** @type {HTMLElement} */ (e.target)).closest?.('.d-card');
    if (e.key === 'Enter' && !inCard) { e.preventDefault(); onClose(); act().openChat(chatId, 'focused'); }
  };
  return html`<div ref=${root} class="pk-peek" role="dialog" aria-label=${t('peek.title', { titre: sum.title })} tabindex="-1" onKeyDownCapture=${onKeyCapture} onKeyDown=${onKey}>
    <header class="pk-head"><strong>${t('peek.title', { titre: sum.title })}</strong>
      <button type="button" class="d-btn" onClick=${() => { onClose(); act().openChat(chatId, 'focused'); }}>${t('peek.open')} ⏎</button>
      <button type="button" class="c-icon" aria-label=${t('lightbox.close')} onClick=${onClose}>✕</button></header>
    <div class="pk-body">
      ${turns === null ? html`<p>${t('chat.loading')}</p>` : !ex.length ? html`<p>${t('chat.empty')}</p>` : ex.map((x) => html`<div class="pk-ex" key=${x.id}>
        ${x.user !== null ? html`<div class="c-user"><div class="c-user-label">${t('a11y.you')} · <time>${fmtTime(x.at)}</time></div><div class="c-user-text">${x.user}</div></div>` : null}
        ${x.reply !== null ? html`<div class="c-assistant"><${Markdown} md=${x.reply} /></div>` : null}
      </div>`)}
    </div>
    <${PendingDock} chatId=${chatId} compact=${true} />
    <p class="pk-hint">${t('peek.hint')}</p>
  </div>`;
}
