// @ts-check
// src/web/components/composer/HistorySearch.js — Ctrl+R fuzzy search over prompt history (ux §7.2, §7.7): this app's
// prompts of every chat and account plus the profiles' terminal history (read-only), through prompts.search.
// Entrée inserts, Échap closes.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, fmtTime } from '../chat/text.js';
import { act } from '../chat/env.js';

/** @typedef {import('../../../shared/protocol.ts').PromptHit} PromptHit */

/** @param {{ chatId: string; onPick: (text: string) => void; onClose: () => void }} p */
export function HistorySearch({ chatId, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(/** @type {PromptHit[]} */ ([]));
  const [sel, setSel] = useState(0);
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    let alive = true;
    const id = setTimeout(() => {
      act().prompts(q, chatId).then((h) => { if (alive) { setHits(h.slice(0, 50)); setSel(0); } }, () => { if (alive) setHits([]); });
    }, 150);
    return () => { alive = false; clearTimeout(id); };
  }, [q]);
  /** @param {KeyboardEvent} e */
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, Math.min(hits.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)))); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const h = hits[sel]; if (h) onPick(h.text); else onClose(); }
  };
  return html`<div class="p-pop p-history" role="dialog" aria-label=${t('composer.history')}>
    <input ref=${input} type="text" class="p-search" placeholder=${t('composer.history')} value=${q} role="combobox"
      aria-expanded="true" aria-controls="p-history-list" aria-activedescendant=${hits.length ? 'p-history-' + sel : undefined}
      onInput=${(/** @type {any} */ e) => setQ(e.currentTarget.value)} onKeyDown=${key} onBlur=${onClose} />
    <div role="listbox" id="p-history-list">
      ${hits.length ? hits.map((h, k) => html`<div role="option" id=${'p-history-' + k} aria-selected=${k === sel}
          class=${'p-row' + (k === sel ? ' p-sel' : '')} onMouseDown=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); onPick(h.text); }}>
        <span class="p-name">${h.text.split('\n')[0]}</span>
        <span class="p-desc">${fmtTime(h.at)}${h.source === 'terminal' ? ' · ' + t('history.terminal') : ''}</span>
      </div>`) : html`<div class="p-empty">${t('history.empty')}</div>`}
    </div>
  </div>`;
}
