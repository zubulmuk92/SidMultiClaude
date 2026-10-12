// @ts-check
// src/web/components/chat/PaneBanners.js — banners under the pane header, stacked (ux §3.5, §8.7, §8.8; SPEC §9.2):
// bypass (red, permanent) · open elsewhere · stuck interrupt (« Forcer l'arrêt ») · rate limit (« Me prévenir à la
// réinitialisation » · « Continuer sur {compte}… » · « Ignorer »; no automatic resume in v1) · error.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { t, talt, tp, fmtTime, fmtDuration } from './text.js';
import { act, accountOf, getEnv, useChatVM } from './env.js';
import { openOverlay } from '../side/overlays.js';
import { continueTargets } from '../side/ContinueOnDialog.js';
import { Icon } from '../../lib/icons.js';

/** @typedef {import('../../../shared/protocol.ts').ChatStateView} ChatStateView */

/** i18n key + args of an error banner (pure). @param {NonNullable<ChatStateView['error']>} e @param {{ compte: string; cwd: string }} c */
export function errorBanner(e, c) {
  switch (e.code) {
    case 'auth': return { key: 'err.auth', args: { compte: c.compte }, retry: false };
    case 'billing': return { key: 'err.billing', args: { compte: c.compte }, retry: false };
    case 'overloaded': return { key: 'err.overloaded', args: {}, retry: true };
    case 'model_not_found': return { key: 'err.modelNotFound', args: {}, retry: false };
    case 'crash': return { key: 'err.crash', args: { code: e.exitCode ?? '?' }, retry: true };
    case 'startup': return { key: 'err.startup', args: { raison: e.message ?? '' }, retry: true };
    case 'breaker': return { key: 'err.breaker', args: {}, retry: true };
    case 'cwd': return { key: 'resume.cwdMissing', args: { chemin: c.cwd }, retry: false };
    default: return { key: 'exe.missing', args: {}, retry: false };
  }
}

/** Notification at the reset time (no prompt is sent: S19). @param {string} title @param {number} at */
function notifyAt(title, at) {
  setTimeout(() => {
    try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(t('notif.limitReset'), { body: title, tag: 'limit:' + title }); }
    catch { /* notifications unavailable */ }
  }, Math.max(0, at - Date.now()));
}

/**
 * « Réessayer » (0) or « Relancer » (1) of err.actions: the process died → Relancer, otherwise Réessayer. Both send
 * chat.retry (crash breaker + error state reset, no spawn; the user then re-sends). @param {ChatStateView['error']} e
 */
const retryLabel = (e) => (e && (e.code === 'crash' || e.code === 'startup') ? 1 : 0);

/** @param {{ chatId: string }} p */
export function PaneBanners({ chatId }) {
  const env = getEnv();
  const vm = useChatVM(chatId);
  const [ignored, setIgnored] = useState(/** @type {number | null} */ (null));
  const [armed, setArmed] = useState(false);
  const sum = vm.summary.value, s = sum.state;
  const mode = vm.meta.value?.mode ?? sum.mode;
  const acc = accountOf(sum.accountId);
  const limit = s.limit && s.limit.resetsAt > Date.now() ? s.limit : null;
  const other = continueTargets(env.accounts.value, sum.accountId).find((a) => a.login === 'connected');
  const err = s.phase === 'error' && s.error ? errorBanner(s.error, { compte: acc?.name ?? sum.accountId, cwd: sum.cwd }) : null;
  return html`<div class="b-stack">
    ${mode === 'bypassPermissions' ? html`<div class="b-banner b-bypass" role="alert"><${Icon} n="alert-triangle" size=${14} /> ${t('mode.bypass.banner')}</div>` : null}
    ${s.flags.external ? html`<div class="b-banner b-info" role="status"><${Icon} n="terminal" size=${14} /> ${t(`state.external.${s.flags.external.status}`)} · ${t('term.locked')}</div>` : null}
    ${s.flags.stuck ? html`<div class="b-banner b-warn" role="alert">${t('state.stuck')}
      <button type="button" class="d-btn d-danger" onClick=${() => void act().forceStop(chatId).catch(() => {})}>${t('action.forceStop')}</button></div>` : null}
    ${limit && ignored !== limit.resetsAt ? html`<div class="b-banner b-limit" role="status">
      <${Icon} n="hourglass" size=${14} /> ${talt('limit.banner', /week|seven|hebdo/i.test(limit.kind) ? 1 : 0, { compte: acc?.name ?? sum.accountId, heure: fmtTime(limit.resetsAt), 'durée': fmtDuration(limit.resetsAt - Date.now()) })}
      <button type="button" class="d-btn" disabled=${armed} onClick=${() => { notifyAt(sum.title, limit.resetsAt); setArmed(true); }}>${t('limit.notifyMe')}</button>
      ${other ? html`<button type="button" class="d-btn" onClick=${() => openOverlay({ kind: 'continue', chatId, target: other.id })}>${t('limit.continue', { compte: other.name })}</button>` : null}
      <button type="button" class="d-btn d-quiet" onClick=${() => setIgnored(limit.resetsAt)}>${t('limit.ignore')}</button></div>` : null}
    ${err ? html`<div class="b-banner b-err" role="alert"><${Icon} n="x-circle" size=${14} /> ${t(err.key, err.args)}
      ${err.retry ? html`<button type="button" class="d-btn" data-retry="1" onClick=${() => void act().retry(chatId).catch(() => {})}>${tp('err.actions', retryLabel(s.error))}</button>` : null}</div>` : null}
  </div>`;
}
