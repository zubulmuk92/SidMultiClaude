// @ts-check
// src/web/components/dialogs/Login.js — « Se connecter · {compte} » (ux §9.2.2, E22). The server runs `claude auth login`
// for that profile and streams LoginStep frames: url → waiting → done (email + plan, so a wrong account shows at once) /
// error. The app never reads, stores or displays a token.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { has, t } from '../../lib/i18n.js';

/**
 * French text of a login error: the server's `key` (login.err.*) through i18n, its {detail} / {code}
 * filled with the raw CLI `message`; an unknown or missing key falls back to the message itself.
 * @param {{ message: string; key?: string }} e @returns {string}
 */
export function loginErrorText(e) {
  return e.key && has(e.key) ? t(e.key, { detail: e.message, code: e.message }) : e.message;
}
import { accounts, loginSteps } from '../../store.js';
import { accountCmd, actions, closeOverlay, copyText, openOverlay } from '../../actions.js';
import { Modal } from '../shell/common.js';
import { Icon } from '../../lib/icons.js';

/** @param {{ accountId: string }} p */
export function Login({ accountId }) {
  const a = accounts.value.find((x) => x.id === accountId);
  const step = loginSteps.value[accountId];
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  // Cancel the `claude auth login` run only when the dialog goes away unfinished. The latest values live in a ref: an
  // effect cleanup keyed on the step would also run on every step change (url → done, error → retry) and cancel the
  // login the user is in the middle of.
  const live = useRef({ requested: false, step: /** @type {string | undefined} */ (undefined) });
  live.current.step = step?.step;
  useEffect(() => () => { if (live.current.requested && live.current.step !== 'done') accountCmd.loginCancel(accountId); }, [accountId]);
  const start = async () => {
    setBusy(true);
    const n = { ...loginSteps.value }; delete n[accountId]; loginSteps.value = n;
    live.current.requested = true;
    try { await accountCmd.login(accountId, email.trim() || undefined); setStarted(true); } catch { /* toasted */ } finally { setBusy(false); }
  };
  const close = () => { closeOverlay(); if (step?.step === 'done') openOverlay('accounts'); };
  const profile = a?.configDir ?? `~\\.claude ${t('acc.profile.default')}`;
  return html`<${Modal} title=${t('login.title', { compte: a?.name ?? accountId, profil: profile })} onClose=${close} cls="login"
      footer=${html`<button type="button" class="btn" onClick=${close}>${step?.step === 'done' ? t('shell.close') : t('shell.cancel')}</button>`}>
    <p class="msg warn"><${Icon} n="alert-triangle" size=${14} /> ${t('login.browserWarn')}</p>
    ${!started || step?.step === 'error' ? html`<div class="form">
        <label class="field"><span>${t('shell.login.email')}</span><input type="email" value=${email} placeholder=${t('shell.login.emailPlaceholder')} data-autofocus
          onInput=${(/** @type {InputEvent} */ e) => setEmail(/** @type {HTMLInputElement} */ (e.target).value)} /></label>
        ${step?.step === 'error' ? html`<p class="msg error" role="alert">${loginErrorText(step)}</p>` : null}
        <p><button type="button" class="btn primary" disabled=${busy} onClick=${() => void start()}>${t('acc.login')}</button></p></div>` : null}
    ${started && step?.step === 'url' ? html`<div class="form">
        <p>${t('acc.login.step1')}</p>
        <p class="inline"><button type="button" class="btn primary" onClick=${() => actions.openExternal(step.url)}>${t('login.open')}</button>
          <button type="button" class="btn" onClick=${() => void copyText(step.url)}>${t('login.copy')}</button></p>
        <label class="field"><span>${t('login.code')}</span><span class="inline"><input class="grow mono" value=${code} spellcheck="false" autocomplete="off"
          onInput=${(/** @type {InputEvent} */ e) => setCode(/** @type {HTMLInputElement} */ (e.target).value)} />
          <button type="button" class="btn" disabled=${!code.trim()} onClick=${() => { void accountCmd.loginCode(accountId, code).catch(() => {}); setCode(''); }}>${t('shell.login.submit')}</button></span></label>
        <p class="muted"><span class="spin" aria-hidden="true"><${Icon} n="loader" size=${14} /></span> ${t('acc.login.waiting')}</p></div>` : null}
    ${started && (!step || step.step === 'waiting') ? html`<p class="muted"><span class="spin" aria-hidden="true"><${Icon} n="loader" size=${14} /></span> ${t('acc.login.waiting')}</p>` : null}
    ${started && step?.step === 'done' ? html`<div><p class="msg ok" role="status"><${Icon} n="check" size=${14} /> ${t('acc.login.done', { email: step.email, formule: step.plan })}</p>
        <p class="muted">${t('login.wrongAccount', { email: step.email })}</p></div>` : null}
  </${Modal}>`;
}
