// @ts-check
// src/web/components/dialogs/Accounts.js — « Comptes » panel (Alt+C; ux §9): one card per account (login state, identity,
// profile, usage gauges with freshness, chats, colour / name / monogram, defaults, diagnostics, login / logout / hide)
// plus « Ajouter un compte » with the detected profiles. Usage refresh and baseline run only on an explicit click
// (they start a short-lived process that runs the profile's hooks).
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { fmtRel, fmtTime, fmtTokens } from '../../lib/fmt.js';
import { accounts, chats } from '../../store.js';
import { accountCmd, closeOverlay, copyText, openOverlay } from '../../actions.js';
import { Modal } from '../shell/common.js';

/** @typedef {import('../../../shared/protocol.ts').AccountView} AccountView */
const MODES = /** @type {const} */ (['default', 'acceptEdits', 'plan', 'auto']);
const MODE_KEY = { default: 'mode.default', acceptEdits: 'mode.acceptEdits', plan: 'mode.plan', auto: 'mode.auto' };
const ALIASES = [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' }];
/**
 * Default-model choices of an account (never free text): its catalog (AccountView.models), else the aliases; a saved
 * value outside the list stays selectable. @param {import('../../../shared/protocol.ts').AccountView} a @param {string | null | undefined} cur
 */
function modelOptions(a, cur) {
  const list = a.models?.length ? a.models.map((m) => ({ value: m.value, label: m.label || m.value })) : ALIASES;
  return cur && !list.some((m) => m.value === cur) ? [...list, { value: cur, label: cur }] : list;
}
const EFFORTS = /** @type {const} */ (['low', 'medium', 'high', 'xhigh', 'max']);
const LOGIN_KEY = { connected: 'acc.connected', disconnected: 'acc.notConnected', reauth: 'acc.authError', incoherent: 'acc.incoherent' };

/** @param {{ a: AccountView }} p */
function Usage({ a }) {
  const [busy, setBusy] = useState(false);
  const u = a.usage;
  const refresh = async () => { setBusy(true); try { await accountCmd.usage(a.id); } catch { /* toasted */ } finally { setBusy(false); } };
  const fresh = !u ? '' : u.source === 'snapshot' ? t('acc.usage.snapshot', { heure: fmtTime(u.at) }) : t('acc.usage.updated', { quand: fmtRel(u.at, Date.now()) });
  return html`<div class="usage">
    ${u?.na ? html`<p class="muted">${t('acc.usage.na')}</p>` : (u?.rows ?? []).map((r) => html`<div key=${r.key} class=${`usage-row sev-${r.severity} ${u?.stale ? 'stale' : ''}`}>
      <span class="u-label">${r.label}</span><span class="u-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(r.pct)} aria-label=${r.label}>
        <i ref=${(/** @type {HTMLElement | null} */ el) => { if (el) el.style.width = `${Math.max(0, Math.min(100, r.pct))}%`; }}></i></span>
      <span class="u-pct">${Math.round(r.pct)} %</span>${r.resetsAt ? html`<span class="u-reset muted">↻ ${fmtTime(r.resetsAt)}</span>` : null}</div>`)}
    <p class="muted small">${fresh}${u?.stale ? ` · ${t('acc.usage.stale')}` : ''}
      ${a.login === 'connected' ? html` <button type="button" class="btn sm" disabled=${busy} onClick=${() => void refresh()}>${t('acc.usage.refresh')}</button>` : null}</p>
  </div>`;
}

/** @param {{ a: AccountView }} p */
function Diag({ a }) {
  const d = a.diag;
  const [base, setBase] = useState(/** @type {number | null} */ (d.baselineTokens ?? null));
  const line = '"cleanupPeriodDays": 365';
  return html`<details class="diag"><summary>${t('shell.acc.diag')}</summary>
    ${!a.isDefault && d.leakFiles.length ? html`<p class=${d.leakExcluded ? 'muted' : 'msg warn'}>⚠ ${t('acc.leak', { fichier: d.leakFiles.join(', ') })}
      <label class="check"><input type="checkbox" checked=${d.leakExcluded} onChange=${() => void accountCmd.update(a.id, { excludeForeignClaudeMd: !d.leakExcluded }).catch(() => {})} />${t('acc.leak.fix')}</label></p>` : null}
    ${d.duplicateOf ? html`<p class="msg warn">${t('acc.dup', { nom: accounts.value.find((x) => x.id === d.duplicateOf)?.name ?? d.duplicateOf })}</p>` : null}
    ${d.mcp ? html`<p>${t('acc.mcp', { ok: d.mcp.ok, auth: d.mcp.auth })}</p>` : null}
    ${d.cliVersion ? html`<p class="muted">Claude Code ${d.cliVersion}${d.defaultMode ? ` · ${t('new.mode')} : ${d.defaultMode}` : ''}</p>` : null}
    <p>${t('acc.retention', { n: d.cleanupDays, m: d.expiringSoon })}</p>
    ${d.expiringSoon > 0 ? html`<p class="muted small">${t('acc.retention.fix')} <code>${line}</code>
      <button type="button" class="btn sm" onClick=${() => void copyText(line)}>${t('term.copy')}</button></p>` : null}
    <p>${base !== null ? t('acc.baseline', { tokens: fmtTokens(base) }) : null}
      ${a.login === 'connected' ? html` <button type="button" class="btn sm" onClick=${() => void accountCmd.baseline(a.id).then((s) => setBase(/** @type {{ total: number }} */ (s).total)).catch(() => {})}>${t('shell.acc.baseline')}</button>` : null}</p>
  </details>`;
}

/** @param {{ a: AccountView }} p */
function Card({ a }) {
  const mine = [...chats.value.values()].filter((s) => s.accountId === a.id);
  const running = mine.filter((s) => s.state.phase === 'running').length;
  const needs = mine.filter((s) => s.state.pending.count > 0).length;
  /** @param {import('../../../shared/protocol.ts').AccountPatch} patch */
  const upd = (patch) => void accountCmd.update(a.id, patch).catch(() => {});
  const def = a.defaults;
  return html`<article class=${`acc-card acc-${a.color} ${a.hidden ? 'hidden-acc' : ''}`} aria-label=${a.name}>
    <header class="inline"><span class=${`acc-badge acc-${a.color}`}>${a.monogram}</span><h3 class="grow">${a.name}</h3>
      <span class=${`login-state ls-${a.login}`}>● ${t(LOGIN_KEY[a.login])}</span></header>
    ${a.identity ? html`<p>${a.identity.email} · ${a.identity.plan}${a.identity.org ? ` (${a.identity.org})` : ''}</p>` : null}
    <p class="muted small">${t('acc.profile', { chemin: a.configDir ?? `~\\.claude ${t('acc.profile.default')}` })}</p>
    <${Usage} a=${a} />
    <p class="small">${t('acc.chats', { 'détail': `◐ ${running} · ! ${needs} · ${t('shell.acc.total', { n: mine.length })}` })}</p>
    <div class="inline wrap"><span>${t('acc.color')}</span>${[1, 2, 3, 4, 5, 6, 7, 8].map((c) => html`<button type="button" key=${c} class=${`swatch acc-${c} ${c === a.color ? 'on' : ''}`}
        aria-label=${`${t('acc.color')} ${c}`} aria-pressed=${String(c === a.color)} onClick=${() => upd({ color: c })}></button>`)}</div>
    <div class="inline wrap"><label class="field"><span>${t('acc.name')}</span><input value=${a.name} maxlength="40" onChange=${(/** @type {Event} */ e) => { const v = /** @type {HTMLInputElement} */ (e.target).value.trim(); if (v) upd({ name: v }); }} /></label>
      <label class="field narrow"><span>${t('acc.monogram')}</span><input value=${a.monogram} maxlength="2" onChange=${(/** @type {Event} */ e) => { const v = /** @type {HTMLInputElement} */ (e.target).value.trim(); if (v) upd({ monogram: v }); }} /></label></div>
    <details><summary>${t('acc.defaults')}</summary><div class="inline wrap">
      <label class="field"><span>${t('new.model')}</span><select value=${def.model ?? ''} onChange=${(/** @type {Event} */ e) => upd({ defaults: { model: /** @type {HTMLSelectElement} */ (e.target).value || null } })}>
        <option value="">${t('shell.new.modelDefault')}</option>${modelOptions(a, def.model).map((m) => html`<option key=${m.value} value=${m.value}>${m.label}</option>`)}</select></label>
      <label class="field"><span>${t('header.effort')}</span><select value=${def.effort ?? ''} onChange=${(/** @type {Event} */ e) => upd({ defaults: { effort: /** @type {any} */ (/** @type {HTMLSelectElement} */ (e.target).value || null) } })}>
        <option value="">${t('shell.new.effortDefault')}</option>${EFFORTS.map((x) => html`<option value=${x}>${t(`shell.effort.${x}`)}</option>`)}</select></label>
      <label class="field"><span>${t('new.mode')}</span><select value=${def.mode ?? ''} onChange=${(/** @type {Event} */ e) => upd({ defaults: { mode: /** @type {any} */ (/** @type {HTMLSelectElement} */ (e.target).value || null) } })}>
        <option value="">${t('shell.new.effortDefault')}</option>${MODES.map((m) => html`<option value=${m}>${t(MODE_KEY[m])}</option>`)}</select></label></div></details>
    <${Diag} a=${a} />
    <footer class="inline wrap">
      ${a.login !== 'connected' ? html`<button type="button" class="btn primary" onClick=${() => openOverlay('login', { accountId: a.id })}>${t(a.login === 'disconnected' ? 'acc.login' : 'acc.relogin')}</button>`
        : html`<button type="button" class="btn" onClick=${() => void accountCmd.logout(a.id).catch(() => {})}>${t('acc.logout')}</button>`}
      <button type="button" class="btn" onClick=${() => upd({ hidden: !a.hidden })}>${a.hidden ? t('shell.acc.show') : t('acc.hide')}</button>
    </footer>
  </article>`;
}

/** Monogram that follows the name (same rule as the server): initial + trailing number (« Perso 2 » → « P2 »). @param {string} name */
export function monogramOf(name) {
  const n = name.trim();
  const first = ([...n][0] ?? '?').toUpperCase();
  const d = /\s(\d)\d*$/.exec(n);
  return d ? `${first}${d[1]}` : first;
}
/** @typedef {import('../../../shared/protocol.ts').AccountCandidate} AccountCandidate */
/** @typedef {{ on: boolean; name: string; color: number }} CandPick */
/** @param {AccountCandidate} c */
const keyOf = (c) => c.configDir ?? '';
/**
 * Initial choices: the suggested name / colour (server), the connected profiles pre-selected on a first run only.
 * @param {AccountCandidate[]} free @param {boolean} firstRun @returns {Record<string, CandPick>}
 */
export function initialPicks(free, firstRun) {
  /** @type {Record<string, CandPick>} */
  const out = {};
  free.forEach((c, i) => {
    const name = c.suggested?.name ?? t('shell.acc.personal');
    out[keyOf(c)] = { on: firstRun && c.login === 'connected', name, color: c.suggested?.color ?? ((i % 8) + 1) };
  });
  return out;
}

/** « Ajouter un compte »: detected profiles, each with a check box, a name and a colour; one confirmation adds them. @param {{ firstRun: boolean }} p */
function AddCard({ firstRun }) {
  const [cands, setCands] = useState(/** @type {AccountCandidate[] | null} */ (null));
  const [picks, setPicks] = useState(/** @type {Record<string, CandPick>} */ ({}));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void accountCmd.candidates().then((c) => { setCands(c); setPicks(initialPicks(c.filter((x) => !x.added), firstRun)); });
  }, [accounts.value.length]);
  const free = (cands ?? []).filter((c) => !c.added);
  /** @param {AccountCandidate} c @param {Partial<CandPick>} patch */
  const set = (c, patch) => setPicks({ ...picks, [keyOf(c)]: { ...(picks[keyOf(c)] ?? { on: false, name: '', color: 1 }), ...patch } });
  const chosen = free.filter((c) => picks[keyOf(c)]?.on && picks[keyOf(c)]?.name.trim());
  const addAll = async () => {
    setBusy(true);
    // the welcome turns into the ordinary panel: the cards (and « Se connecter ») stay on screen after the confirmation
    if (firstRun) openOverlay('accounts');
    try {
      for (const c of chosen) {
        const pk = /** @type {CandPick} */ (picks[keyOf(c)]);
        const name = pk.name.trim().slice(0, 40);
        const monogram = c.suggested && name === c.suggested.name ? c.suggested.monogram : monogramOf(name);
        await accountCmd.add({ configDir: c.configDir, name, color: pk.color, monogram }).catch(() => {});
      }
    } finally { setBusy(false); }
  };
  return html`<article class=${`acc-card add-card ${firstRun ? 'first-run' : ''}`}><h3>+ ${t('acc.add')}</h3>
    <p class="muted">${t('acc.detected')} : ${cands === null ? t('shell.loading') : free.length ? '' : '—'}</p>
    ${cands !== null && !free.length && firstRun ? html`<p class="msg">${t('acc.first.none')}</p>` : null}
    <ul class="cand-list">${free.map((c) => {
      const pk = picks[keyOf(c)] ?? { on: false, name: '', color: 1 };
      const where = c.configDir ?? '~\\.claude';
      return html`<li key=${keyOf(c) || 'default'} class=${`cand ${pk.on ? 'on' : ''}`} data-cand=${where}>
        <label class="check inline"><input type="checkbox" checked=${pk.on} aria-label=${t('acc.pick', { chemin: where })}
          onChange=${() => set(c, { on: !pk.on })} /><code class="grow">${where}</code></label>
        <span class="muted small">${c.email ? `${c.email}${c.plan ? ` · ${c.plan}` : ''}${c.org ? ` (${c.org})` : ''}` : t(LOGIN_KEY[c.login])}</span>
        <div class="inline wrap"><span class=${`acc-badge acc-${pk.color}`} aria-hidden="true">${monogramOf(pk.name || '?')}</span>
          <label class="field"><span>${t('acc.name')}</span><input value=${pk.name} maxlength="40"
            onInput=${(/** @type {Event} */ e) => set(c, { name: /** @type {HTMLInputElement} */ (e.target).value })} /></label>
          ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => html`<button type="button" key=${n} class=${`swatch sm acc-${n} ${n === pk.color ? 'on' : ''}`}
            aria-label=${`${t('acc.color')} ${n}`} aria-pressed=${String(n === pk.color)} onClick=${() => set(c, { color: n })}></button>`)}</div>
      </li>`;
    })}</ul>
    ${free.length ? html`<button type="button" class="btn primary" data-autofocus=${firstRun ? '' : undefined} disabled=${busy || !chosen.length}
      onClick=${() => void addAll()}>${t('acc.addSelected', { n: chosen.length })}</button>` : null}
  </article>`;
}

/** @param {{ firstRun?: boolean }} p */
export function Accounts({ firstRun = false }) {
  const first = firstRun && accounts.value.length === 0;
  return html`<${Modal} title=${first ? t('acc.first.title') : t('nav.accounts')} onClose=${closeOverlay} wide=${true} cls="accounts">
    ${first ? html`<p class="first-run-intro">${t('acc.first.intro')}</p>` : null}
    <div class="acc-grid">${accounts.value.map((a) => html`<${Card} key=${a.id} a=${a} />`)}<${AddCard} firstRun=${first} /></div>
  </${Modal}>`;
}
