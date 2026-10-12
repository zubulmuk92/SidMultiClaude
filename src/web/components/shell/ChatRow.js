// @ts-check
// src/web/components/shell/ChatRow.js — one sidebar chat row (ux §3.3): account stripe · state glyph · title · meta
// (running timer or age) · unread dot · flag badges (⌨ ⌛ ⇄ ⚙n ≡n); hover ☆ and ⋯. Fixed height (virtualisation).
import { html } from 'htm/preact';
import { t } from '../../lib/i18n.js';
import { fmtAge, fmtTimer, baseName } from '../../lib/fmt.js';
import { accountById, now, serverNow } from '../../store.js';
import { activityText } from '../../derived.js';
import { actions, copyText, deleteChat, openChat, openTerminal, setFlags } from '../../actions.js';
import { openOverlay as openChatOverlay } from '../side/overlays.js';
import { Glyph } from './common.js';

/** @typedef {import('../../../shared/protocol.ts').ChatSummary} ChatSummary */
/** @typedef {import('./common.js').MenuItem} MenuItem */

/** The ⋯ / right-click menu of a chat (sidebar, tabs). @param {ChatSummary} s @param {(c: string) => void} [rename] @returns {MenuItem[]} */
export function chatMenuItems(s, rename) {
  const c = s.chatId;
  const live = s.state.flags.live;
  return [
    { label: t('shell.row.openPane'), run: () => openChat(c, 'newPane'), hint: 'Ctrl+⏎' },
    { label: t('menu.terminal'), run: () => { void openTerminal(c, false).catch(() => {}); } },
    { label: t('header.rename'), run: () => rename?.(c), hint: 'F2', disabled: !rename || Boolean(s.state.flags.external) },
    { label: t(s.pinned ? 'chat.unpin' : 'chat.pin'), run: () => { void setFlags(c, { pinned: !s.pinned }).catch(() => {}); } },
    { label: t('shell.row.fork'), run: () => { void actions.fork(c, {}).then((id) => openChat(id)).catch(() => {}); } },
    { label: t('shell.row.continue'), run: () => openChatOverlay({ kind: 'continue', chatId: c }) },
    { label: t('menu.sleep'), run: () => { void actions.sleep(c).catch(() => {}); }, disabled: !live },
    { label: t('shell.row.keepAlive'), checked: s.keepAlive, run: () => { void setFlags(c, { keepAlive: !s.keepAlive }).catch(() => {}); } },
    { label: t(s.muted ? 'shell.row.unmute' : 'shell.row.mute'), run: () => { void setFlags(c, { muted: !s.muted }).catch(() => {}); } },
    { sep: true, label: '' },
    { label: t(s.archived ? 'shell.row.unarchive' : 'chat.archive'), run: () => { void setFlags(c, { archived: !s.archived }).catch(() => {}); }, hint: 'Suppr' },
    { label: t('chat.delete'), danger: true, disabled: live, run: () => { void deleteChat(c).catch(() => {}); } },
    { label: t('chat.copyId'), run: () => { void copyText(s.sessionId); } },
  ];
}

/**
 * @param {{ s: ChatSummary; reason?: string; depth: number; focused: boolean; active: boolean; editing: boolean;
 *   onRenameDone: (title: string | null) => void; onMenu: (e: MouseEvent | KeyboardEvent, s: ChatSummary) => void;
 *   onHover: (c: string | null) => void; idx: number }} p
 */
export function ChatRow({ s, reason, depth, focused, active, editing, onRenameDone, onMenu, onHover, idx }) {
  const a = accountById.value.get(s.accountId);
  const st = s.state;
  const running = st.phase === 'running' || st.phase === 'starting';
  const needs = st.pending.count > 0;
  const tnow = Math.max(now.value, Date.now());
  const meta = running || needs ? fmtTimer(serverNow() - (needs ? (st.pending.oldestAt ?? st.since) : st.since)) : (s.updatedAt ? fmtAge(s.updatedAt, tnow) : '');
  const title = s.title || t('state.new');
  const ext = st.flags.external;
  const second = reason ?? [baseName(s.cwd), s.branch ? `⎇ ${s.branch}` : '', activityText(s)].filter(Boolean).join(' · ');
  return html`<div role="treeitem" id=${`row-${idx}`} aria-level=${depth + 1} aria-selected=${active ? 'true' : 'false'}
      tabindex=${focused ? 0 : -1} data-chat=${s.chatId} data-idx=${idx}
      class=${`row chat-row depth-${depth} acc-${a?.color ?? 8} ${st.flags.unread ? 'unread' : ''} ${st.phase === 'cold' ? 'is-cold' : ''} ${active ? 'active' : ''} ${reason ? 'with-reason' : ''}`}
      title=${`${title}\n${s.cwd}`}
      onMouseEnter=${() => onHover(s.chatId)} onMouseLeave=${() => onHover(null)}
      onContextMenu=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); onMenu(e, s); }}
      onClick=${(/** @type {MouseEvent} */ e) => { if (!editing) openChat(s.chatId, e.ctrlKey ? 'newPane' : e.shiftKey ? 'background' : 'focused'); }}>
    <span class="stripe" aria-hidden="true"></span>
    <${Glyph} s=${s} />
    <span class="row-main">
      ${editing ? html`<input class="row-edit" data-autofocus value=${s.title} aria-label=${t('header.rename')}
          ref=${(/** @type {HTMLInputElement | null} */ el) => { if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
          onClick=${(/** @type {Event} */ e) => e.stopPropagation()}
          onKeyDown=${(/** @type {KeyboardEvent} */ e) => { e.stopPropagation(); if (e.key === 'Enter') onRenameDone(/** @type {HTMLInputElement} */ (e.target).value); else if (e.key === 'Escape') onRenameDone(null); }}
          onBlur=${(/** @type {FocusEvent} */ e) => onRenameDone(/** @type {HTMLInputElement} */ (e.target).value)} />`
        : html`<span class="row-title">${!reason && depth === 0 && a ? html`<span class=${`mono acc-${a.color}`}>${a.monogram}</span>` : null}${title}</span>`}
      <span class="row-sub">${second}</span>
    </span>
    <span class="row-flags">
      ${ext ? html`<span class="flag" title=${t(`state.external.${ext.status}`)}>⌨</span>` : null}
      ${s.expiresInDays !== null && s.expiresInDays <= 5 ? html`<span class="flag" title=${t('flag.expiring', { n: s.expiresInDays })}>⌛</span>` : null}
      ${s.foreignOwner ? html`<span class="flag" title=${t('flag.foreignOwner')}>⇄</span>` : null}
      ${st.flags.bgTasks ? html`<span class="flag" title=${t('shell.row.bg', { n: st.flags.bgTasks })}>⚙${st.flags.bgTasks}</span>` : null}
      ${st.flags.queued ? html`<span class="flag" title=${t('shell.row.queued', { n: st.flags.queued })}>≡${st.flags.queued}</span>` : null}
    </span>
    <span class="row-meta">${meta}</span>
    ${st.flags.unread ? html`<span class="dot" aria-hidden="true"></span>` : null}
    <span class="row-hover">
      <button type="button" class="icon-btn sm" tabindex="-1" aria-label=${t(s.pinned ? 'chat.unpin' : 'chat.pin')}
        onClick=${(/** @type {MouseEvent} */ e) => { e.stopPropagation(); void setFlags(s.chatId, { pinned: !s.pinned }).catch(() => {}); }}>${s.pinned ? '★' : '☆'}</button>
      <button type="button" class="icon-btn sm" tabindex="-1" aria-label=${t('shell.row.menu')}
        onClick=${(/** @type {MouseEvent} */ e) => { e.stopPropagation(); onMenu(e, s); }}>⋯</button>
    </span>
  </div>`;
}
