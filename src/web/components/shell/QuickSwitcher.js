// @ts-check
// src/web/components/shell/QuickSwitcher.js — Ctrl+K (ux §10.1): in-memory index of chats, folders, accounts and app
// actions; ranking = attention, then fuzzy score, then recency; prefixes `>` `c:` `d:` `e:` (combinable).
// ⏎ open · Ctrl+⏎ new pane · Maj+⏎ background tab · Alt+⏎ on a folder = new chat there · Échap.
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t, tParts } from '../../lib/i18n.js';
import { baseName, fmtAge } from '../../lib/fmt.js';
import { accountById, accounts, chats, now } from '../../store.js';
import { attentionReason, switcherResults } from '../../derived.js';
import { closeOverlay, openChat, openOverlay, quitApp, reopenTab, setLayout, setSettings, toggleSidebar, actions } from '../../actions.js';
import { AccBadge, Glyph, trapFocus } from './common.js';
import { Icon } from '../../lib/icons.js';

/** @typedef {{ id: string; label: string; keywords?: string; run: () => void }} ActionItem */

/** @returns {ActionItem[]} */
export function appActions() {
  const layouts = tParts('layout.n');
  /** @type {ActionItem[]} */
  const list = accounts.value.filter((a) => !a.hidden).map((a) => ({ id: `new:${a.id}`, label: t('shell.act.newOn', { compte: a.name }), keywords: 'nouveau chat', run: () => openOverlay('newChat', { accountId: a.id }) }));
  list.push(
    ...[1, 2, 3, 4].map((n) => ({ id: `layout:${n}`, label: t('shell.act.layout', { n: layouts[n - 1] ?? n }), keywords: 'volets disposition', run: () => setLayout(/** @type {1 | 2 | 3 | 4} */ (n)) })),
    { id: 'dnd1h', label: t('shell.act.dnd1h'), run: () => setSettings({ dndUntil: Date.now() + 3_600_000 }) },
    { id: 'dndOff', label: t('shell.act.dndOff'), run: () => setSettings({ dndUntil: null }) },
    { id: 'dark', label: t('shell.act.themeDark'), run: () => setSettings({ theme: 'dark' }) },
    { id: 'light', label: t('shell.act.themeLight'), run: () => setSettings({ theme: 'light' }) },
    { id: 'system', label: t('shell.act.themeSystem'), run: () => setSettings({ theme: 'system' }) },
    { id: 'reopen', label: t('tabs.reopen'), keywords: 'onglet', run: () => reopenTab() },
    { id: 'resume', label: t('nav.resume'), run: () => openOverlay('resume') },
    { id: 'dashboard', label: t('dash.title'), keywords: 'accueil usage kpi', run: () => openOverlay('dashboard') },
    { id: 'accounts', label: t('nav.accounts'), run: () => openOverlay('accounts') },
    { id: 'settings', label: t('nav.settings'), run: () => openOverlay('settings') },
    { id: 'help', label: t('shell.act.help'), keywords: 'aide clavier', run: () => openOverlay('help') },
    { id: 'sidebar', label: t('shell.act.sidebar'), run: () => toggleSidebar() },
    { id: 'stopAll', label: t('shell.act.stopAll'), run: () => { for (const s of chats.value.values()) if (s.state.phase === 'running') actions.interrupt(s.chatId); } },
    { id: 'quit', label: t('shell.act.quit'), run: () => { void quitApp(); } },
  );
  return list;
}

const GROUP_KEY = { attention: 'shell.sw.attention', chats: 'shell.sw.chats', folders: 'shell.sw.folders', actions: 'shell.sw.actions' };

export function QuickSwitcher() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const acts = useMemo(appActions, [accounts.value]);
  const hits = useMemo(() => switcherResults(q, [...chats.value.values()], accounts.value, acts, 40), [q, chats.value, accounts.value, acts]);
  const i = Math.min(sel, Math.max(0, hits.length - 1));
  useEffect(() => { box.current?.querySelector(`#sw-${i}`)?.scrollIntoView({ block: 'nearest' }); }, [i]);   // ↑↓ past the visible part
  /** @param {number} k @param {{ ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }} e @param {typeof hits} [list] */
  const run = (k, e, list = hits) => {
    const h = list[k];
    if (!h) return;
    closeOverlay();
    if (h.group === 'actions') h.action.run();
    else if (h.group === 'folders') openOverlay('newChat', { accountId: h.accountId, cwd: h.path });
    else openChat(h.s.chatId, e.ctrlKey ? 'newPane' : e.shiftKey ? 'background' : 'focused');
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSel((i + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(1, hits.length)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // typed faster than the last render: rank the current text now rather than act on stale results
      const live = /** @type {HTMLInputElement} */ (e.target).value;
      if (live === q) run(i, e);
      else run(0, e, switcherResults(live, [...chats.value.values()], accounts.value, acts, 40));
    }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeOverlay(); }
  };
  const box = useRef(/** @type {HTMLDivElement | null} */ (null));
  // read at the first render: the input's ref focuses it at commit, before any effect runs (ux §10.4: restore on close)
  const opener = useRef(/** @type {Element | null} */ (document.activeElement));
  // layout effect: set up at commit, so an Échap pressed before the next paint still restores the focus
  useLayoutEffect(() => {
    const stop = trapFocus(box.current);
    return () => { stop(); const o = opener.current; if (o instanceof HTMLElement && o.isConnected) o.focus(); };
  }, []);
  let lastGroup = '';
  return html`<div class="ov-backdrop top" onMouseDown=${(/** @type {MouseEvent} */ e) => { if (e.target === e.currentTarget) closeOverlay(); }}>
    <div ref=${box} class="switcher" role="dialog" aria-modal="true" aria-label=${t('shell.sw.label')} tabindex="-1">
      <input class="sw-input" data-autofocus type="text" role="combobox" aria-expanded="true" aria-controls="sw-list" aria-activedescendant=${hits.length ? `sw-${i}` : undefined}
        placeholder=${t('search.placeholder')} value=${q} spellcheck="false"
        ref=${(/** @type {HTMLInputElement | null} */ el) => { if (el && !el.dataset['f']) { el.dataset['f'] = '1'; el.focus(); } }}
        onInput=${(/** @type {InputEvent} */ e) => { setQ(/** @type {HTMLInputElement} */ (e.target).value); setSel(0); }} onKeyDown=${onKey} />
      <ul id="sw-list" class="sw-list" role="listbox" aria-label=${t('shell.sw.label')}>
        ${!hits.length ? html`<li class="sw-empty">${t('shell.sw.none')}</li>` : null}
        ${hits.map((h, k) => {
          const head = h.group !== lastGroup ? html`<li class="sw-group" role="presentation">${t(GROUP_KEY[h.group])}</li>` : null;
          lastGroup = h.group;
          let body;
          if (h.group === 'actions') body = html`<span class="sw-glyph"><${Icon} n="chevron-right" size=${14} /></span><span class="sw-title">${h.action.label}</span>`;
          else if (h.group === 'folders') body = html`<span class="sw-glyph"><${Icon} n="folder" size=${14} /></span><span class="sw-title">${baseName(h.path)} (${accountById.value.get(h.accountId)?.name ?? h.accountId})</span><span class="sw-meta">${t('shell.sw.folderHint')}</span>`;
          else {
            const s = h.s;
            const meta = h.group === 'attention' ? attentionReason(s, undefined, now.value) : fmtAge(s.updatedAt, Date.now());
            body = html`<${Glyph} s=${s} /><${AccBadge} a=${accountById.value.get(s.accountId)} id=${s.accountId} /><span class="sw-title">${s.title || t('state.new')}</span>
              <span class="sw-meta">${baseName(s.cwd)} · ${meta}</span>`;
          }
          return html`${head}<li id=${`sw-${k}`} role="option" aria-selected=${String(k === i)} class=${`sw-item ${k === i ? 'sel' : ''}`}
            onMouseMove=${() => { if (k !== i) setSel(k); }} onClick=${(/** @type {MouseEvent} */ e) => run(k, e)}>${body}</li>`;
        })}
      </ul>
      <footer class="sw-foot"><span>${t('shell.sw.hint')}</span><span class="muted">${t('shell.sw.prefixes')}</span></footer>
    </div></div>`;
}
