// @ts-check
// src/web/components/shell/TabStrip.js — the working set of open chats (ux §3.4, role="tablist"): glyph · account bar +
// monogram · title · pane number · close. Click shows the chat in the focused pane (or focuses the pane that already
// shows it); middle-click closes; drag to reorder or drop on a pane; overflow ⌄ lists every tab. Closing a tab never
// stops Claude.
import { html } from 'htm/preact';
import { t } from '../../lib/i18n.js';
import { accountById, chats, placeholderSummary, ui } from '../../store.js';
import { closeTab, moveTab, openChat, openOverlay } from '../../actions.js';
import { chatMenuItems } from './ChatRow.js';
import { Glyph, openMenu, openMenuAt } from './common.js';
import { Icon } from '../../lib/icons.js';

export const TAB_MIME = 'application/x-smc-chat';

export function TabStrip() {
  const u = ui.value;
  const focused = u.panes[u.focusedPane] ?? null;
  /** @param {MouseEvent} e */
  const overflow = (e) => openMenuAt(/** @type {Element} */ (e.currentTarget), u.tabs.map((c) => {
    const s = chats.value.get(c);
    return { label: s?.title || c, checked: c === focused, run: () => openChat(c) };
  }), t('shell.tabs.more'));
  /** @param {KeyboardEvent} e @param {number} i */
  const onKey = (e, i) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const els = /** @type {HTMLElement[]} */ ([.../** @type {HTMLElement} */ (e.currentTarget).parentElement?.querySelectorAll('[role="tab"]') ?? []]);
    els[(i + d + els.length) % els.length]?.focus();
  };
  return html`<div class="tabstrip">
    <div class="tabs" role="tablist" aria-label=${t('shell.tabs.label')}>
      ${u.tabs.map((c, i) => {
        const s = chats.value.get(c) ?? placeholderSummary(c);
        const a = accountById.value.get(s.accountId);
        const pane = u.panes.indexOf(c);
        const sel = c === focused;
        return html`<div key=${c} role="tab" aria-selected=${String(sel)} tabindex=${sel || (!focused && i === 0) ? 0 : -1} data-chat=${c}
            class=${`tab acc-${a?.color ?? 8} ${sel ? 'active' : ''} ${s.state.flags.unread ? 'unread' : ''}`} draggable="true" title=${s.title}
            onClick=${() => openChat(c)} onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(c); } else onKey(e, i); }}
            onAuxClick=${(/** @type {MouseEvent} */ e) => { if (e.button === 1) { e.preventDefault(); closeTab(c); } }}
            onMouseDown=${(/** @type {MouseEvent} */ e) => { if (e.button === 1) e.preventDefault(); }}
            onContextMenu=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }, chatMenuItems(s), s.title); }}
            onDragStart=${(/** @type {DragEvent} */ e) => { e.dataTransfer?.setData(TAB_MIME, JSON.stringify({ c, i })); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver=${(/** @type {DragEvent} */ e) => { if (e.dataTransfer?.types.includes(TAB_MIME)) e.preventDefault(); }}
            onDrop=${(/** @type {DragEvent} */ e) => { const d = e.dataTransfer?.getData(TAB_MIME); if (d) { e.preventDefault(); moveTab(JSON.parse(d).i, i); } }}>
          <${Glyph} s=${s} />
          <span class="tab-bar" aria-hidden="true"></span><span class="tab-mono" aria-hidden="true">${a?.monogram ?? ''}</span>
          <span class="tab-title">${s.title || t('state.new')}</span>
          ${pane >= 0 && u.layout > 1 ? html`<span class="tab-pane" title=${t('shell.tabs.inPane', { n: pane + 1 })}>${pane + 1}</span>` : null}
          <button type="button" class="tab-x" tabindex="-1" aria-label=${t('tabs.close')} title=${`${t('tabs.close')} (Alt+W)`}
            onClick=${(/** @type {MouseEvent} */ e) => { e.stopPropagation(); closeTab(c); }}><${Icon} n="x" size=${12} /></button>
        </div>`;
      })}
    </div>
    ${u.tabs.length > 1 ? html`<button type="button" class="icon-btn" aria-label=${t('shell.tabs.more')} aria-haspopup="menu" onClick=${overflow}><${Icon} n="chevron-down" /></button>` : null}
    <button type="button" class="icon-btn" aria-label=${t('shell.tabs.new')} title=${t('shell.tabs.new')} onClick=${() => openOverlay('newChat')}><${Icon} n="plus" /></button>
  </div>`;
}
