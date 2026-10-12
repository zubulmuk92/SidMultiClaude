// @ts-check
// src/web/components/dialogs/DirBrowser.js — server-rendered folder browser (ux §8.1 « Parcourir… »: a browser cannot
// return paths from a native dialog): drives, parent, subfolders, filter-as-you-type, S9 warnings.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { fuzzyFilter } from '../../lib/fuzzy.js';
import { listDirs } from '../../actions.js';
import { Modal } from '../shell/common.js';

/** @param {string} base @param {string} name */
export const joinPath = (base, name) => (/[\\/]$/.test(base) ? base + name : `${base}\\${name}`);

/** @param {{ start: string | null; onPick: (path: string) => void; onClose: () => void }} p */
export function DirBrowser({ start, onPick, onClose }) {
  const [path, setPath] = useState(/** @type {string | null} */ (start || null));
  const [listing, setListing] = useState(/** @type {import('../../../shared/protocol.ts').DirListing | null} */ (null));
  const [err, setErr] = useState(/** @type {string | null} */ (null));
  const [q, setQ] = useState('');
  useEffect(() => {
    let live = true;
    void listDirs(path).then((r) => {
      if (!live) return;
      if ('dirs' in r) { setListing(r); setErr(null); }
      else { setErr(r.code === 'cwd_missing' || r.code === 'not_found' ? 'new.missing' : 'shell.dir.error'); if (path !== null && !listing) setPath(null); }
    });
    return () => { live = false; };
  }, [path]);
  const dirs = listing ? fuzzyFilter(listing.dirs, q, (d) => [d]).map((x) => x.item) : [];
  const warn = listing?.warning === 'home' ? t('new.homeRefused') : listing?.warning === 'ancestor' ? t('new.ancestorWarn', { chemin: listing.path }) : null;
  const go = (/** @type {string | null} */ p) => { setQ(''); setPath(p); };
  return html`<${Modal} title=${t('new.browse')} onClose=${onClose} cls="dirbrowser"
      footer=${html`<button type="button" class="btn" onClick=${onClose}>${t('shell.cancel')}</button>
        <button type="button" class="btn primary" disabled=${!listing?.path || listing?.warning === 'home'} onClick=${() => listing && onPick(listing.path)}>${t('shell.dir.pick')}</button>`}>
    <div class="dir-path"><code>${listing?.path || t('shell.dir.drives')}</code></div>
    ${warn ? html`<p class=${listing?.warning === 'home' ? 'msg error' : 'msg warn'}>${warn}</p>` : null}
    ${err ? html`<p class="msg error">${t(err)}</p>` : null}
    <input type="search" data-autofocus class="dir-filter" placeholder=${t('shell.dir.filter')} aria-label=${t('shell.dir.filter')} value=${q}
      onInput=${(/** @type {InputEvent} */ e) => setQ(/** @type {HTMLInputElement} */ (e.target).value)}
      onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && dirs[0] && listing) { e.preventDefault(); go(joinPath(listing.path, dirs[0])); } }} />
    <ul class="dir-list" role="list">
      ${listing?.parent !== undefined || (listing && listing.path) ? html`<li><button type="button" class="dir-item" onClick=${() => go(listing?.parent ?? null)}>.. ${t('shell.dir.up')}</button></li>` : null}
      ${(listing?.drives ?? []).map((d) => html`<li key=${d}><button type="button" class="dir-item" onClick=${() => go(d)}>💽 ${d}</button></li>`)}
      ${dirs.map((d) => html`<li key=${d}><button type="button" class="dir-item" onClick=${() => listing && go(joinPath(listing.path, d))} onDblClick=${() => listing && onPick(joinPath(listing.path, d))}>📁 ${d}</button></li>`)}
    </ul>
  </${Modal}>`;
}
