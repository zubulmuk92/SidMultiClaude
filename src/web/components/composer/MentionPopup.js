// @ts-check
// src/web/components/composer/MentionPopup.js — « @ » file picker (ux §7.5): up to 50 hits from the server's per-folder
// index (fs.mentions, zero tokens), folders with a trailing « / ». Keys are driven by the composer.
import { html } from 'htm/preact';
import { useEffect, useRef } from 'preact/hooks';
import { t } from '../chat/text.js';

/** @typedef {import('../../../shared/protocol.ts').FileHit} FileHit */

/** Highlight the query's letters in a path (text nodes and <mark> only). @param {string} path @param {string} q */
export function markMatches(path, q) {
  if (!q) return [path];
  const lower = path.toLowerCase(), ql = q.toLowerCase();
  /** @type {(string | import('preact').VNode)[]} */ const out = [];
  let i = 0, buf = '';
  for (let k = 0; k < path.length; k++) {
    if (i < ql.length && lower[k] === ql[i]) {
      if (buf) { out.push(buf); buf = ''; }
      out.push(html`<mark>${path[k]}</mark>`); i++;
    } else buf += path[k];
  }
  if (buf) out.push(buf);
  return out;
}

/** @param {{ hits: FileHit[]; q: string; sel: number; loading: boolean; onPick: (h: FileHit) => void; onHover: (k: number) => void }} p */
export function MentionPopup({ hits, q, sel, loading, onPick, onHover }) {
  const list = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel, hits]);
  return html`<div ref=${list} class="p-pop p-mention" role="listbox" id="p-mention" aria-label="@">
    ${hits.length ? hits.slice(0, 50).map((h, k) => html`<div role="option" id=${'p-mention-' + k} aria-selected=${k === sel}
        class=${'p-row' + (k === sel ? ' p-sel' : '')} onMouseDown=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); onPick(h); }}
        onMouseEnter=${() => onHover(k)}>
      <span class="p-icon" aria-hidden="true">${h.dir ? '▸' : '·'}</span>
      <span class="p-name">${markMatches(h.path.replace(/\\/g, '/') + (h.dir ? '/' : ''), q)}</span>
    </div>`) : html`<div class="p-empty">${loading ? t('chat.loading') : t('mention.empty')}</div>`}
  </div>`;
}
