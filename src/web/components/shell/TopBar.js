// @ts-check
// src/web/components/shell/TopBar.js — 44 px top bar (ux §3.2): ☰ (Alt+B) · name (opens the dashboard) · search field that opens the quick
// switcher (Ctrl+K) · « ! n à traiter » (click = Alt+A) · « ◐ n en cours » · one usage ring per logged-in account ·
// Do-not-disturb bell · ⚙ Réglages.
import { html } from 'htm/preact';
import { t, tParts } from '../../lib/i18n.js';
import { fmtTime } from '../../lib/fmt.js';
import { accounts, now, settings } from '../../store.js';
import { windowCounts } from '../../derived.js';
import { nextAttention, openOverlay, setSettings, toggleSidebar } from '../../actions.js';
import { openMenuAt } from './common.js';
import { Icon } from '../../lib/icons.js';

/** @param {{ a: import('../../../shared/protocol.ts').AccountView }} p */
function Ring({ a }) {
  const row = a.usage?.rows.find((r) => r.headline) ?? a.usage?.rows[0];
  const pct = row ? Math.max(0, Math.min(100, Math.round(row.pct))) : null;
  const label = pct === null ? a.name : t('shell.top.usage', { compte: a.name, pct: `${pct} %` });
  return html`<button type="button" class=${`ring acc-${a.color} sev-${row?.severity ?? 'normal'} ${a.usage?.stale ? 'stale' : ''}`} title=${label} aria-label=${label}
      onClick=${() => openOverlay('accounts')}>
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" class="ring-bg" />
      ${pct !== null ? html`<circle cx="10" cy="10" r="8" class="ring-fg" pathLength="100" stroke-dasharray=${`${pct} 100`} transform="rotate(-90 10 10)" />` : null}
    </svg><span class="ring-mono">${a.monogram}</span>${pct !== null ? html`<span class="ring-pct">${pct}</span>` : null}</button>`;
}

export function TopBar() {
  const c = windowCounts.value;
  const s = settings.value;
  const dnd = s?.dndUntil && s.dndUntil > now.value ? s.dndUntil : null;
  /** @param {MouseEvent} e */
  const dndMenu = (e) => {
    const [, h1, tomorrow, off] = tParts('notif.dnd');
    const tmr = new Date(); tmr.setDate(tmr.getDate() + 1); tmr.setHours(8, 0, 0, 0);
    openMenuAt(/** @type {Element} */ (e.currentTarget), [
      { label: h1 ?? '1 h', run: () => setSettings({ dndUntil: Date.now() + 3_600_000 }) },
      { label: tomorrow ?? '', run: () => setSettings({ dndUntil: tmr.getTime() }) },
      { label: off ?? '', checked: !dnd, run: () => setSettings({ dndUntil: null }) },
    ], t('shell.top.dnd'));
  };
  return html`<header class="topbar" data-region="topbar">
    <button type="button" class="icon-btn" aria-label=${t('shell.top.sidebar')} title=${t('shell.top.sidebar')} onClick=${toggleSidebar}><${Icon} n="menu" /></button>
    <button type="button" class="app-name" title=${t('dash.open')} onClick=${() => openOverlay('dashboard')}>${t('shell.appName')}</button>
    <button type="button" class="search-trigger" onClick=${() => openOverlay('switcher')} aria-keyshortcuts="Control+K">
      <span>${t('search.placeholder')}</span><kbd>Ctrl+K</kbd></button>
    <span class="top-spacer"></span>
    ${c.needs + c.errors > 0 || c.done > 0 ? html`<button type="button" class="counter needs" onClick=${() => nextAttention()} aria-keyshortcuts="Alt+A" title="Alt+A">
      <span class="glyph st-needs" aria-hidden="true"><${Icon} n="alert-circle" size=${14} /></span> ${t('shell.top.attention', { n: c.needs + c.errors + c.done })}</button>` : null}
    ${c.running ? html`<span class="counter running"><span class="glyph st-running" aria-hidden="true"><${Icon} n="loader" size=${14} /></span> ${t('shell.top.running', { n: c.running })}</span>` : null}
    <span class="rings">${accounts.value.filter((a) => !a.hidden && a.login === 'connected').map((a) => html`<${Ring} key=${a.id} a=${a} />`)}</span>
    <button type="button" class=${`icon-btn ${dnd ? 'on' : ''}`} aria-label=${dnd ? t('shell.top.dndOn', { heure: fmtTime(dnd) }) : t('shell.top.dnd')}
      title=${dnd ? t('shell.top.dndOn', { heure: fmtTime(dnd) }) : t('shell.top.dnd')} aria-haspopup="menu" onClick=${dndMenu}><${Icon} n=${dnd ? 'bell-off' : 'bell'} /></button>
    <button type="button" class="icon-btn" aria-label=${t('nav.settings')} title=${`${t('nav.settings')} (Ctrl+,)`} onClick=${() => openOverlay('settings')}><${Icon} n="settings" /></button>
  </header>`;
}
