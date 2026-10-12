// @ts-check
// src/web/components/shell/StatusBar.js — 26 px status bar (ux §3.2): « n processus actifs ≈ x Go (max N) » (click: process
// list with *Mettre en veille*) · server connection · view mode · theme.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { fmtRam, fmtTimer } from '../../lib/fmt.js';
import { chats, conn, focusedChat, procs, serverNow, settings, ui } from '../../store.js';
import { actions, openChat, setSettings } from '../../actions.js';

export function StatusBar() {
  const p = procs.value;
  const s = settings.value;
  const [open, setOpen] = useState(false);
  const procText = !p ? '' : p.live === 0 ? t('shell.status.procs.none', { max: p.effectiveMax })
    : t((p.lowMem ? 'status.procs.lowMem' : 'status.procs') + (p.live === 1 ? '.one' : ''), { n: p.live, ram: fmtRam(p.estRamMB), max: p.effectiveMax });
  const fc = focusedChat.value;
  const view = (fc && ui.value.views[fc]) || s?.defaultView || 'normal';
  const theme = s?.theme ?? 'system';
  const nextTheme = /** @type {const} */ ({ system: 'light', light: 'dark', dark: 'system' })[theme];
  return html`<footer class="statusbar">
    <button type="button" class="status-item" aria-expanded=${String(open)} onClick=${() => setOpen(!open)}>${procText}${p?.isolation === 'plain' ? html` · <span class="muted">${t('shell.status.isolation.plain')}</span>` : null}</button>
    <span class=${`status-item conn-${conn.value.status}`}><span class="dot-conn" aria-hidden="true"></span>${t(`shell.status.conn.${conn.value.status}`)}</span>
    <span class="top-spacer"></span>
    <span class="status-item">${t('shell.status.view', { vue: t(`shell.view.${view}`) })}</span>
    <button type="button" class="status-item" onClick=${() => setSettings({ theme: nextTheme })}>${t('shell.status.theme', { 'thème': t(`shell.theme.${theme}`) })}</button>
    ${open && p ? html`<div class="procs-pop" role="dialog" aria-label=${t('shell.status.procs.title')}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
      <h3>${t('shell.status.procs.title')}</h3>
      ${p.items.length ? null : html`<p class="muted">${t('shell.status.procs.none', { max: p.effectiveMax })}</p>`}
      <ul>${p.items.map((it) => {
        const c = chats.value.get(it.chatId);
        return html`<li key=${it.chatId}>
          <button type="button" class="link" onClick=${() => { setOpen(false); openChat(it.chatId); }}>${c?.title || it.chatId}</button>
          <span class="muted">${it.pid ? `pid ${it.pid} · ` : ''}${fmtTimer(serverNow() - it.since)}${it.protected ? ` · ${t('shell.status.procs.protected')}` : ''}</span>
          <button type="button" class="btn sm" onClick=${() => { void actions.sleep(it.chatId).catch(() => {}); }}>${t('shell.status.procs.sleep')}</button></li>`;
      })}</ul></div>` : null}
  </footer>`;
}
