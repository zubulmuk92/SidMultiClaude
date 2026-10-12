// @ts-check
// src/web/main.js — boot: theme, store, connect, mount (SPEC §6.1).
// No inline script or style anywhere (CSP + Trusted Types): styles come from /app/styles, the only HTML sink
// is lib/md.js (used by the chat surface). Performance marks: smc:hello (first hello applied) and smc:paint (first frame after it).
import { render } from 'preact';
import { html } from 'htm/preact';
import { effect } from '@preact/signals-core';
import { App } from './components/shell/App.js';
import { applyHooks } from './apply.js';
import { actions, flushUiSave, openChat, syncView } from './actions.js';
import { connect, reconnectNow, stop } from './net.js';
import { accountById, accounts, pushToast, chats, conn, hooks, hydrated, now, settings, throttle, ui, windowState, asks } from './store.js';
import { windowCounts, windowTitle } from './derived.js';
import { setFaviconBadge } from './lib/favicon.js';
import { fmtTime } from './lib/fmt.js';
import { allowed, deliver, groupNotif, notificationFor, permission } from './lib/notify.js';
import { playChime } from './lib/sound.js';
import { notifPrompt } from './components/shell/Banners.js';
import { wireFirstRun } from './first-run.js';

function wireTheme() {
  effect(() => {
    const s = settings.value;
    const root = document.documentElement;
    if (!s || s.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', s.theme);
    root.classList.toggle('density-comfortable', s?.density === 'comfortable');
  });
}

function wireWindow() {
  const upd = () => {
    windowState.value = { visible: document.visibilityState === 'visible', focused: document.hasFocus() };
    syncView();
    if (windowState.value.visible && conn.value.status === 'reconnecting') reconnectNow();
  };
  window.addEventListener('focus', upd);
  window.addEventListener('blur', upd);
  document.addEventListener('visibilitychange', upd);
  upd();
  // a reload or a closed window must not lose the layout saved at most 1 s later
  window.addEventListener('pagehide', () => { flushUiSave(); });
}

/** Window title and favicon badge, both ≤ 1/s (ux §4.5). */
function wireBadges() {
  const paint = throttle(() => {
    const c = windowCounts.value;
    document.title = windowTitle(c);
    setFaviconBadge(c);
  }, 1000);
  effect(() => { void windowCounts.value; paint(); });
}

/** The 1 s clock runs only while something on screen shows a timer (running / needs / starting). */
function wireClock() {
  /** @type {ReturnType<typeof setInterval> | null} */
  let iv = null;
  effect(() => {
    const live = [...chats.value.values()].some((s) => s.state.phase === 'running' || s.state.phase === 'starting' || s.state.pending.count > 0);
    const want = live && windowState.value.visible;
    if (want && !iv) iv = setInterval(() => { now.value = Date.now(); }, 1000);
    else if (!want && iv) { clearInterval(iv); iv = null; now.value = Date.now(); }
  });
}

/** Looking = page visible + window focused + chat shown in a pane (ux §11). @param {string} c */
const looking = (c) => windowState.value.visible && windowState.value.focused && ui.value.panes.includes(c);

function wireNotifications() {
  let buf = { at: 0, items: /** @type {import('./lib/notify.js').Notif[]} */ ([]) };
  hooks.onSummary = (prev, next) => {
    if (!hydrated.value) return;
    const s = settings.value;
    const a = accountById.value.get(next.accountId);
    const ask = asks.value.find((x) => x.chatId === next.chatId);
    const n = notificationFor(prev, next, { looking: s?.onlyWhenAway === false ? false : looking(next.chatId), settings: s, now: Date.now(),
      monogram: a?.monogram ?? '', accountName: a?.name ?? next.accountId, ...(ask ? { ask } : {}) });
    if (!n) return;
    const ok = allowed(s, Date.now());
    if (ok.os && permission() === 'default') notifPrompt.value = true;
    const g = groupNotif(buf, n, Date.now());
    buf = g.buf;
    if (ok.os) deliver(g.show, (c) => openChat(c));
    if (ok.sound && n.sound && (g.buf.items.length < 2)) playChime(s?.volume ?? 0.6, n.sound);
  };
}

/** acc.warn80: one toast per window and account when the usage turns allowed_warning (ux §8.7). */
function wireUsageWarnings() {
  const warned = new Set();
  effect(() => {
    for (const a of accounts.value) {
      const u = a.usage;
      if (u?.status !== 'allowed_warning') { warned.delete(a.id); continue; }
      if (warned.has(a.id)) continue;
      warned.add(a.id);
      const row = u.rows.find((r) => r.headline) ?? u.rows[0];
      pushToast({ level: 'warn', key: 'acc.warn80', args: { compte: a.name, pct: Math.round(row?.pct ?? 80), quand: row?.resetsAt ? fmtTime(row.resetsAt) : '—' } });
    }
  });
}

export function boot() {
  performance.mark('smc:boot');
  wireTheme();
  wireWindow();
  wireBadges();
  wireClock();
  wireNotifications();
  wireUsageWarnings();
  wireFirstRun();
  let painted = false;
  const prevHello = applyHooks.hello;
  applyHooks.hello = (m, newBoot) => {
    prevHello(m, newBoot);
    if (painted) return;
    painted = true;
    performance.mark('smc:hello');
    requestAnimationFrame(() => { performance.mark('smc:paint'); performance.measure('smc:hello→paint', 'smc:hello', 'smc:paint'); });
  };
  applyHooks.bye = (reason) => {
    if (reason === 'quit') { stop(); return; }
    conn.value = { ...conn.value, status: 'reconnecting', since: Date.now() };
    setTimeout(reconnectNow, 500);
  };
  const root = document.getElementById('app');
  if (root) render(html`<${App} />`, root);
  connect();
  void actions;
}

if (typeof document !== 'undefined' && document.getElementById('app')) boot();
