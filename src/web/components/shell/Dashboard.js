// @ts-check
// src/web/components/shell/Dashboard.js — the home view: what needs you, what runs, what each account has left and what
// you touched last. Shown in the empty single pane, and as a dialog from the top bar or Ctrl+K.
// Built only from what the window already holds (hello + chat summaries): no request, no model call, no token.
import { html } from 'htm/preact';
import { t } from '../../lib/i18n.js';
import { baseName, fmtAge, fmtDate, fmtRam, fmtRel } from '../../lib/fmt.js';
import { accountById, accounts, hydrated, procs, serverNow } from '../../store.js';
import { activityByDay, asksByChat, attention, attentionReason, attentionSince, chatVolume, dayStart, isNeeds, visibleChats, windowCounts } from '../../derived.js';
import { closeOverlay, nextAttention, openChat, openOverlay } from '../../actions.js';
import { AccBadge, Glyph, UsageRows } from './common.js';
import { Icon } from '../../lib/icons.js';

/** @typedef {import('../../../shared/protocol.ts').ChatSummary} ChatSummary */
/** @typedef {import('../../../shared/protocol.ts').AccountView} AccountView */

export const DASH_DAYS = 14;
const SHOWN = 5;
const LOGIN_KEY = { connected: 'acc.connected', disconnected: 'acc.notConnected', reauth: 'acc.authError', incoherent: 'acc.incoherent' };
/** @param {string} chatId */
const go = (chatId) => { closeOverlay(); openChat(chatId); };
/** « 1 chat » / « 3 chats ». @param {number} n */
const chatsLabel = (n) => t(n === 1 ? 'dash.chats.one' : 'dash.chats', { n });

/** Stat tile: label · value · one line of context. A button when it leads somewhere. @param {{ label: string; value: string | number; sub: string; alert?: boolean; onClick?: () => void; hint?: string }} p */
function Tile({ label, value, sub, alert, onClick, hint }) {
  const body = html`<span class="dash-tile-label">${alert ? html`<span class="glyph st-needs" aria-hidden="true"><${Icon} n="alert-circle" size=${14} /></span>` : null}${label}</span>
    <span class="dash-tile-value">${value}</span><span class="dash-tile-sub">${sub}</span>`;
  return onClick ? html`<button type="button" class=${`dash-tile ${alert ? 'alert' : ''}`} title=${hint} onClick=${onClick}>${body}</button>`
    : html`<div class="dash-tile">${body}</div>`;
}

/**
 * Chats per day of last activity, one account, one colour: the card names the series, so there is no legend.
 * ponytail: values live in the native tooltip and the aria summary; a table view and a focusable hover layer if this
 * chart ever carries more than a glanceable trend.
 * @param {{ counts: number[]; now: number }} p
 */
function ActivityBars({ counts, now }) {
  const max = Math.max(...counts), sum = counts.reduce((a, b) => a + b, 0);
  if (!sum) return html`<p class="dash-none">${t('dash.activity.none', { n: DASH_DAYS })}</p>`;
  const peak = counts.indexOf(max);
  const day = (/** @type {number} */ i) => { const d = new Date(dayStart(now)); d.setDate(d.getDate() - (counts.length - 1 - i)); return d.getTime(); };
  return html`<figure class="dash-chart">
    <figcaption>${t('dash.activity', { n: DASH_DAYS })}</figcaption>
    <div class="dash-bars" role="img" aria-label=${t('dash.activity.summary', { total: chatsLabel(sum), max, jour: fmtDate(day(peak)) })}>
      ${counts.map((c, i) => html`<span key=${i} class="dash-col" title=${`${chatsLabel(c)} · ${fmtDate(day(i))}`}>
        ${i === peak ? html`<span class="dash-bar-val">${c}</span>` : null}
        ${c ? html`<i class="dash-bar" ref=${(/** @type {HTMLElement | null} */ el) => { if (el) el.style.height = `${Math.max(6, Math.round((c / max) * 100))}%`; }}></i>` : null}</span>`)}
    </div>
    <div class="dash-axis" aria-hidden="true"><span>${fmtDate(day(0))}</span><span>${t('dash.today')}</span></div>
  </figure>`;
}

/** @param {{ a: AccountView; list: ChatSummary[]; now: number }} p */
function AccountCard({ a, list, now }) {
  const mine = list.filter((s) => s.accountId === a.id && !s.archived);
  const waiting = attention.value.filter((s) => s.accountId === a.id).length;
  const running = mine.filter((s) => s.state.phase === 'running' || s.state.phase === 'starting').length;
  const connected = a.login === 'connected';
  return html`<section class=${`dash-card dash-acc acc-${a.color}`} aria-label=${a.name}>
    <header class="dash-acc-head"><${AccBadge} a=${a} /><h3>${a.name}</h3>${a.identity?.plan ? html`<span class="muted">${a.identity.plan}</span>` : null}
      <span class="grow"></span><span class=${`login-state ls-${a.login}`}>${connected ? html`<${Icon} n="dot-fill" size=${10} /> ` : null}${t(LOGIN_KEY[a.login] ?? 'acc.notConnected')}</span></header>
    ${!connected ? html`<p class="dash-none">${t('dash.acc.offline')} <button type="button" class="link" onClick=${() => openOverlay('accounts')}>${t('nav.accounts')}</button></p>`
      : a.usage?.rows.length || a.usage?.na ? html`<div class="usage"><${UsageRows} a=${a} /></div>`
      : html`<p class="dash-none">${t('dash.usage.unknown')} <button type="button" class="link" onClick=${() => openOverlay('accounts')}>${t('nav.accounts')}</button></p>`}
    <${ActivityBars} counts=${activityByDay(mine, now, DASH_DAYS)} now=${now} />
    <footer class="dash-acc-foot"><span class="muted">${chatsLabel(mine.length)} · ${t('shell.top.attention', { n: waiting })} · ${t('shell.top.running', { n: running })}</span>
      <span class="grow"></span>${connected ? html`<button type="button" class="btn sm" aria-label=${t('shell.side.newIn', { compte: a.name })}
        onClick=${() => openOverlay('newChat', { accountId: a.id })}><${Icon} n="plus" size=${13} /> ${t('nav.newChat')}</button>` : null}</footer>
  </section>`;
}

/** @param {{ s: ChatSummary; sub: string; now: number; at: number }} p */
function ChatLine({ s, sub, now, at }) {
  return html`<li><button type="button" class="dash-row" onClick=${() => go(s.chatId)}>
    <${Glyph} s=${s} /><${AccBadge} a=${accountById.value.get(s.accountId)} id=${s.accountId} />
    <span class="row-main"><span class="row-title">${s.title || t('state.new')}</span><span class="dash-row-sub">${sub}</span></span>
    <span class="row-meta">${fmtAge(at, now)}</span></button></li>`;
}

/** @param {{ inDialog?: boolean }} p */
export function Dashboard({ inDialog = false }) {
  const now = serverNow();
  const list = visibleChats.value;
  const accts = accounts.value.filter((a) => !a.hidden);
  const att = attention.value;
  const c = windowCounts.value;
  const p = procs.value;
  const vol = chatVolume(list, now);
  const oldest = att.find(isNeeds) ?? att[0];
  const recent = list.filter((s) => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, SHOWN + 1);
  const actions = html`<div class="dash-actions">
    <button type="button" class="btn primary" onClick=${() => openOverlay('newChat')}><${Icon} n="plus" size=${14} /> ${t('nav.newChat')}</button>
    <button type="button" class="btn" onClick=${() => openOverlay('resume')}><${Icon} n="rotate" size=${14} /> ${t('nav.resume')}</button></div>`;
  if (hydrated.value && !accounts.value.length) {
    return html`<div class="dash" tabindex="-1"><div class="dash-inner"><section class="dash-card dash-welcome">
      <h2>${t('dash.title')}</h2><p>${t('shell.side.noAccount')}</p>
      <p><button type="button" class="btn primary" onClick=${() => openOverlay('accounts', { firstRun: true })}>${t('shell.side.noAccount.btn')}</button></p></section></div></div>`;
  }
  return html`<div class="dash" tabindex="-1"><div class="dash-inner">
    <header class="dash-head">${inDialog ? null : html`<h2>${t('dash.title')}</h2>`}<span class="grow"></span>${actions}</header>
    <div class="dash-kpis">
      <${Tile} label=${t('nav.attention')} value=${att.length} alert=${att.length > 0} hint="Alt+A" onClick=${att.length ? () => { closeOverlay(); nextAttention(); } : undefined}
        sub=${oldest ? t('dash.kpi.oldest', { quand: fmtRel(attentionSince(oldest), now) }) : t('dash.kpi.attention.none')} />
      <${Tile} label=${t('state.running')} value=${c.running} sub=${t(c.running ? 'dash.kpi.running' : 'dash.kpi.running.none')} />
      <${Tile} label=${t('dash.kpi.procs')} value=${p ? `${p.live} / ${p.effectiveMax}` : '—'}
        sub=${!p ? '' : p.lowMem ? t('dash.kpi.procs.lowMem') : p.live ? t('dash.kpi.procs.ram', { ram: fmtRam(p.estRamMB) }) : t('dash.kpi.procs.none')} />
      <${Tile} label=${t('dash.kpi.active')} value=${vol.recent} sub=${t('dash.kpi.active.total', { total: chatsLabel(vol.total) })} />
    </div>
    <div class="dash-cols">
      <div class="dash-main">
        <h3 class="dash-h">${t('nav.accounts')}</h3>
        <div class="dash-accs">${accts.map((a) => html`<${AccountCard} key=${a.id} a=${a} list=${list} now=${now} />`)}</div>
      </div>
      <div class="dash-side">
        <section class="dash-card" aria-label=${t('nav.attention')}>
          <h3 class="dash-h">${t('nav.attention')}</h3>
          ${att.length ? html`<ul class="dash-list">${att.slice(0, SHOWN).map((s) => html`<${ChatLine} key=${s.chatId} s=${s} now=${now} at=${attentionSince(s)}
              sub=${attentionReason(s, asksByChat.value.get(s.chatId)?.[0], now)} />`)}</ul>
            ${att.length > SHOWN ? html`<p class="dash-more">${t('dash.more', { n: att.length - SHOWN })}</p>` : null}`
            : html`<p class="dash-none">${t('dash.attention.none')}</p>`}
        </section>
        <section class="dash-card" aria-label=${t('dash.recent')}>
          <h3 class="dash-h">${t('dash.recent')}</h3>
          ${recent.length ? html`<ul class="dash-list">${recent.map((s) => html`<${ChatLine} key=${s.chatId} s=${s} now=${now} at=${s.updatedAt} sub=${baseName(s.cwd)} />`)}</ul>`
            : html`<p class="dash-none">${t('dash.recent.none')}</p>`}
        </section>
      </div>
    </div>
  </div></div>`;
}
