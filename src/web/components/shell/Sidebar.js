// @ts-check
// src/web/components/shell/Sidebar.js — the chat tree (ux §3.3, role="tree", roving tabindex): filter, *À traiter*,
// *Épinglés*, Account › Folder › Chat (or by folder / by state), footer. Rows have fixed heights per kind, so the list is
// virtualised above SIDEBAR_VIRTUALISE_ABOVE rows with prefix sums. Keys: ↑↓→← · Entrée · Ctrl+Entrée · Maj+Entrée ·
// Espace (Peek) · F2 · Suppr · Maj+F10. Hover / arrow focus prefetches the row's tx.page (150 ms debounce).
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t, tParts } from '../../lib/i18n.js';
import { LIMITS, accounts, asks, chats, focusedChat, hydrated, now, settings, ui } from '../../store.js';
import { buildSidebar } from '../../derived.js';
import { actions, openChat, openOverlay, patchSidebar, prefetch, setFlags, setSettings } from '../../actions.js';
import { ChatRow, chatMenuItems } from './ChatRow.js';
import { openMenu, openMenuAt } from './common.js';
import { Icon } from '../../lib/icons.js';

/** @typedef {import('../../derived.js').SideRow} SideRow */
/** Row heights in px (must match shell.css). */
export const ROW_H = { section: 30, account: 36, folder: 28, more: 26, chat: 30, chat2: 44 };
/** @param {SideRow} r @param {boolean} comfy */
export const rowHeight = (r, comfy) => (r.kind === 'chat' ? (comfy || r.reason ? ROW_H.chat2 : ROW_H.chat) : ROW_H[r.kind]);

/** First index whose bottom is below y. @param {number[]} tops @param {number} y */
function findRow(tops, y) {
  let lo = 0, hi = tops.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((tops[mid] ?? 0) <= y) lo = mid; else hi = mid - 1; }
  return lo;
}

/** @param {{ a: import('../../../shared/protocol.ts').AccountView }} p */
function UsageBar({ a }) {
  const row = a.usage?.rows.find((r) => r.headline) ?? a.usage?.rows[0];
  if (!row || a.usage?.na) return null;
  const segs = Math.round(Math.min(100, row.pct) / 20);
  return html`<span class=${`usage-bar sev-${row.severity}`} title=${`${row.label} : ${Math.round(row.pct)} %`}>
    ${[0, 1, 2, 3, 4].map((i) => html`<i class=${i < segs ? 'on' : ''}></i>`)}<b>${Math.round(row.pct)} %</b></span>`;
}

export function Sidebar() {
  const u = ui.value;
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState(/** @type {Set<string>} */ (new Set()));
  const [expanded, setExpanded] = useState(/** @type {Set<string>} */ (new Set()));
  const [focusIdx, setFocusIdx] = useState(0);
  const [editing, setEditing] = useState(/** @type {string | null} */ (null));
  const [scroll, setScroll] = useState({ top: 0, h: 800 });
  const listRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const comfy = settings.value?.density === 'comfortable';
  const minute = Math.floor(now.value / 60_000);
  const rows = useMemo(() => buildSidebar({
    list: [...chats.value.values()], accounts: accounts.value, grouping: u.sidebar.grouping, showArchived: u.sidebar.showArchived,
    showOther: settings.value?.showOtherOrigins ?? true, filter, collapsed, expanded, asks: asks.value, now: Date.now(),
  }), [chats.value, accounts.value, asks.value, u.sidebar.grouping, u.sidebar.showArchived, settings.value?.showOtherOrigins, filter, collapsed, expanded, minute]);
  const tops = useMemo(() => { const a = []; let y = 0; for (const r of rows) { a.push(y); y += rowHeight(r, comfy); } a.push(y); return a; }, [rows, comfy]);
  const total = tops[tops.length - 1] ?? 0;
  const virtual = rows.length > LIMITS.SIDEBAR_VIRTUALISE_ABOVE;
  const fi = Math.min(focusIdx, Math.max(0, rows.length - 1));
  let start = 0, end = rows.length;
  if (virtual) { start = Math.max(0, findRow(tops, scroll.top) - 8); end = Math.min(rows.length, findRow(tops, scroll.top + scroll.h) + 9); }
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll({ top: el.scrollTop, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const active = focusedChat.value;

  /** @param {number} i */
  const focusRow = (i) => {
    const j = Math.max(0, Math.min(rows.length - 1, i));
    setFocusIdx(j);
    const el = listRef.current;
    const top = tops[j] ?? 0, h = rows[j] ? rowHeight(/** @type {SideRow} */ (rows[j]), comfy) : 0;
    if (el && (top < el.scrollTop || top + h > el.scrollTop + el.clientHeight)) el.scrollTop = top < el.scrollTop ? top : top + h - el.clientHeight;
    requestAnimationFrame(() => /** @type {HTMLElement | null} */ (el?.querySelector(`[data-idx="${j}"]`) ?? null)?.focus());
    const r = rows[j];
    prefetch(r?.kind === 'chat' ? r.s.chatId : null);
  };
  /** @param {string} key */
  const toggle = (key) => { const n = new Set(collapsed); if (n.has(key)) n.delete(key); else n.add(key); setCollapsed(n); };
  // the edit ends once: Entrée / Échap, or blur — a blur fired when the field is removed after Échap must not rename
  const editingRef = useRef(/** @type {string | null} */ (null));
  /** @param {string} c */
  const startRename = (c) => { editingRef.current = c; setEditing(c); };
  /** @param {MouseEvent | KeyboardEvent} e @param {import('../../../shared/protocol.ts').ChatSummary} s */
  const onMenu = (e, s) => {
    const items = chatMenuItems(s, startRename);
    if ('clientX' in e && e.clientX) openMenu({ x: e.clientX, y: e.clientY }, items, s.title);
    else openMenuAt(/** @type {Element} */ (e.currentTarget ?? e.target), items, s.title);
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (editing || e.target instanceof HTMLInputElement) return;
    // the row is the one that has the focus: the focusIdx state may not be rendered yet (focus moved a moment ago)
    const own = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target.closest('[data-idx]') : null);
    const at = own ? Number(own.dataset['idx']) : fi;
    if (at !== fi) setFocusIdx(at);
    const r = rows[at];
    const k = e.key;
    let handled = true;
    if (k === 'ArrowDown') focusRow(at + 1);
    else if (k === 'ArrowUp') focusRow(at - 1);
    else if (k === 'Home') focusRow(0);
    else if (k === 'End') focusRow(rows.length - 1);
    else if (!r) handled = false;
    else if (k === 'ArrowRight' && (r.kind === 'account' || r.kind === 'folder')) { if (r.collapsed) toggle(r.kind === 'folder' ? r.key.slice(2) : r.key); else focusRow(at + 1); }
    else if (k === 'ArrowLeft' && (r.kind === 'account' || r.kind === 'folder') && !r.collapsed) toggle(r.kind === 'folder' ? r.key.slice(2) : r.key);
    else if (k === 'ArrowLeft') { for (let j = at - 1; j >= 0; j--) { const p = rows[j]; if (p && (p.kind === 'folder' || p.kind === 'account' || p.kind === 'section')) { focusRow(j); break; } } }
    else if (k === 'Enter' && r.kind === 'chat') openChat(r.s.chatId, e.ctrlKey ? 'newPane' : e.shiftKey ? 'background' : 'focused');
    else if ((k === 'Enter' || k === ' ') && (r.kind === 'account' || r.kind === 'folder')) toggle(r.kind === 'folder' ? r.key.slice(2) : r.key);
    else if ((k === 'Enter' || k === ' ') && r.kind === 'more') setExpanded(new Set([...expanded, r.group]));
    else if (k === ' ' && r.kind === 'chat') openOverlay('peek', { chatId: r.s.chatId });
    else if (k === 'F2' && r.kind === 'chat' && !r.s.state.flags.external) startRename(r.s.chatId);
    else if (k === 'Delete' && r.kind === 'chat') void setFlags(r.s.chatId, { archived: !r.s.archived }).catch(() => {});
    else if ((k === 'F10' && e.shiftKey) || k === 'ContextMenu') { if (r.kind === 'chat') onMenu(e, r.s); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };
  /** @param {string | null} title */
  const renameDone = (title) => {
    const c = editingRef.current;
    editingRef.current = null;
    setEditing(null);
    if (!c) return;
    const s = c ? chats.value.get(c) : undefined;
    if (c && s && title !== null && title.trim() && title.trim() !== s.title) void actions.rename(c, title).catch(() => {});
    requestAnimationFrame(() => /** @type {HTMLElement | null} */ (listRef.current?.querySelector(`[data-idx="${fi}"]`) ?? null)?.focus());
  };
  const groupingMenu = (/** @type {MouseEvent} */ e) => {
    const g = u.sidebar.grouping;
    openMenuAt(/** @type {Element} */ (e.currentTarget), [
      { label: t('shell.grouping.account'), checked: g === 'account', run: () => patchSidebar({ grouping: 'account' }) },
      { label: t('shell.grouping.folder'), checked: g === 'folder', run: () => patchSidebar({ grouping: 'folder' }) },
      { label: t('shell.grouping.state'), checked: g === 'state', run: () => patchSidebar({ grouping: 'state' }) },
      { sep: true, label: '' },
      { label: t('nav.showArchived'), checked: u.sidebar.showArchived, run: () => patchSidebar({ showArchived: !u.sidebar.showArchived }) },
      { label: t(comfy ? 'shell.density.compact' : 'shell.density.comfortable'), run: () => setSettings({ density: comfy ? 'compact' : 'comfortable' }) },
    ], t('shell.side.menu'));
  };
  void tParts;
  return html`<nav class="sidebar" aria-label=${t('shell.side.label')} data-region="sidebar"
    ref=${(/** @type {HTMLElement | null} */ el) => { if (el) el.style.width = `${u.sidebar.width}px`; }}>
    <div class="side-head">
      <input class="side-filter" type="search" placeholder=${t('nav.filter')} aria-label=${t('nav.filter')} value=${filter}
        onInput=${(/** @type {InputEvent} */ e) => { setFilter(/** @type {HTMLInputElement} */ (e.target).value); setFocusIdx(0); }}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(0); } else if (e.key === 'Escape' && filter) { e.preventDefault(); e.stopPropagation(); setFilter(''); } }} />
      <button type="button" class="icon-btn" aria-label=${t('shell.side.menu')} aria-haspopup="menu" onClick=${groupingMenu}><${Icon} n="more" /></button>
    </div>
    <div ref=${listRef} class="side-list" role="tree" aria-label=${t('shell.side.label')} onKeyDown=${onKey}
      onFocusIn=${(/** @type {FocusEvent} */ e) => { const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-idx]')); if (el) setFocusIdx(Number(el.dataset['idx'])); }}
      onScroll=${(/** @type {Event} */ e) => { const el = /** @type {HTMLElement} */ (e.currentTarget); if (virtual) setScroll({ top: el.scrollTop, h: el.clientHeight }); }}>
      ${!rows.length && !accounts.value.length && hydrated.value && !filter
        ? html`<div class="side-empty side-onboard" data-onboard="">
            <p>${t('shell.side.noAccount')}</p>
            <button type="button" class="btn primary" onClick=${() => openOverlay('accounts', { firstRun: true })}>${t('shell.side.noAccount.btn')}</button>
          </div>`
        : !rows.length ? html`<p class="side-empty">${t(filter ? 'shell.side.noMatch' : 'shell.side.empty')}</p>` : null}
      <div class="side-inner" ref=${(/** @type {HTMLElement | null} */ el) => { if (el) el.style.height = `${total}px`; }}>
        <div class="side-win" ref=${(/** @type {HTMLElement | null} */ el) => { if (el) el.style.transform = `translateY(${tops[start] ?? 0}px)`; }}>
          ${rows.slice(start, end).map((r, k) => renderRow(r, start + k))}
        </div>
      </div>
    </div>
    <div class="side-foot">
      <button type="button" class="side-btn" onClick=${() => openOverlay('newChat')}><span><${Icon} n="plus" size=${14} /> ${t('nav.newChat')}</span><kbd>Alt+N</kbd></button>
      <button type="button" class="side-btn" onClick=${() => openOverlay('resume')}><span><${Icon} n="rotate" size=${14} /> ${t('nav.resume')}</span><kbd>Alt+R</kbd></button>
    </div>
    <div class="side-resize" role="separator" aria-orientation="vertical" aria-label=${t('shell.side.resize')} tabindex="0"
      aria-valuemin=${LIMITS.SIDEBAR_WIDTH_MIN_PX} aria-valuemax=${LIMITS.SIDEBAR_WIDTH_MAX_PX} aria-valuenow=${u.sidebar.width}
      onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); resizeTo(u.sidebar.width + (e.key === 'ArrowLeft' ? -20 : 20)); } }}
      onPointerDown=${startDrag}></div>
  </nav>`;

  /** @param {SideRow} r @param {number} i */
  function renderRow(r, i) {
    const focused = i === fi;
    const common = { 'data-idx': i, tabindex: focused ? 0 : -1 };
    if (r.kind === 'chat') {
      return html`<${ChatRow} key=${r.key} s=${r.s} reason=${r.reason} depth=${r.depth} focused=${focused} idx=${i}
        active=${active === r.s.chatId} editing=${editing === r.s.chatId} onRenameDone=${renameDone} onMenu=${onMenu} onHover=${prefetch} />`;
    }
    if (r.kind === 'section') return html`<div key=${r.key} ...${common} role="treeitem" aria-level="1" class="row sec-row">${r.label} (${r.count})</div>`;
    if (r.kind === 'more') return html`<div key=${r.key} ...${common} role="treeitem" class=${`row more-row depth-${r.depth}`} onClick=${() => setExpanded(new Set([...expanded, r.group]))}>${t('nav.showMore', { n: r.n })}</div>`;
    if (r.kind === 'folder') {
      return html`<div key=${r.key} ...${common} role="treeitem" aria-expanded=${String(!r.collapsed)} class=${`row folder-row depth-${r.depth}`} title=${r.path}
        onClick=${() => toggle(r.key.slice(2))}><span class="caret" aria-hidden="true"><${Icon} n=${r.collapsed ? 'chevron-right' : 'chevron-down'} size=${12} /></span><span class="row-title">${r.label}</span>${r.collapsed ? html`<span class="row-meta">(${r.count})</span>` : null}</div>`;
    }
    const a = r.a;
    const login = a.login === 'connected' ? '' : t(a.login === 'disconnected' ? 'acc.notConnected' : a.login === 'reauth' ? 'acc.authError' : 'acc.incoherent');
    return html`<div key=${r.key} ...${common} role="treeitem" aria-level="1" aria-expanded=${String(!r.collapsed)} class=${`row acc-row acc-${a.color}`} onClick=${() => toggle(r.key)}>
      <span class="caret" aria-hidden="true"><${Icon} n=${r.collapsed ? 'chevron-right' : 'chevron-down'} size=${12} /></span><span class=${`acc-badge acc-${a.color}`}>${a.monogram}</span>
      <span class="row-title acc-name">${a.name}${a.identity?.plan ? html` <small>· ${a.identity.plan}</small>` : null}</span>
      ${login ? html`<span class="acc-login">${login}</span>` : html`<${UsageBar} a=${a} />`}
      <button type="button" class="icon-btn sm" tabindex="-1" aria-label=${t('shell.side.newIn', { compte: a.name })}
        onClick=${(/** @type {MouseEvent} */ e) => { e.stopPropagation(); openOverlay('newChat', { accountId: a.id }); }}><${Icon} n="plus" size=${14} /></button></div>`;
  }
}

/** @param {number} w */
function resizeTo(w) { patchSidebar({ width: Math.max(LIMITS.SIDEBAR_WIDTH_MIN_PX, Math.min(LIMITS.SIDEBAR_WIDTH_MAX_PX, Math.round(w))) }); }
/** @param {PointerEvent} e */
function startDrag(e) {
  const el = /** @type {HTMLElement} */ (e.currentTarget);
  const nav = /** @type {HTMLElement | null} */ (el.parentElement);
  el.setPointerCapture(e.pointerId);
  const x0 = e.clientX, w0 = nav?.getBoundingClientRect().width ?? 280;
  const move = (/** @type {PointerEvent} */ m) => { if (nav) nav.style.width = `${Math.max(LIMITS.SIDEBAR_WIDTH_MIN_PX, Math.min(LIMITS.SIDEBAR_WIDTH_MAX_PX, w0 + m.clientX - x0))}px`; };
  const up = (/** @type {PointerEvent} */ m) => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); resizeTo(w0 + m.clientX - x0); };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}
