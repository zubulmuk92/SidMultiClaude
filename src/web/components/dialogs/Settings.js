// @ts-check
// src/web/components/dialogs/Settings.js — « Réglages » (Ctrl+,; ux §4.6, §11, SPEC §9.2.13): Performance (veille, processus
// max 2–8, démarrage dès la saisie, binaire, isolation), Notifications (système, son + volume, uniquement quand je ne regarde
// pas, ne pas déranger, rouvrir la fenêtre), Clavier, Apparence, Sessions, Zone dangereuse. Every change is sent at once
// (settings.set, optimistic).
import { html } from 'htm/preact';
import { t, tParts } from '../../lib/i18n.js';
import { fmtTime } from '../../lib/fmt.js';
import { LIMITS, settings } from '../../store.js';
import { closeOverlay, quitApp, setSettings } from '../../actions.js';
import { Modal } from '../shell/common.js';

/** @typedef {import('../../../shared/protocol.ts').Settings} S */
const REAP = /** @type {(number | null)[]} */ ([15, 30, 60, 120, null]);

/** @param {{ k: keyof S; label: string; s: S }} p */
function Toggle({ k, label, s }) {
  return html`<label class="check"><input type="checkbox" checked=${Boolean(s[k])} onChange=${() => setSettings({ [k]: !s[k] })} />${label}</label>`;
}
/** @template T @param {{ value: T; options: [T, string][]; label: string; onPick: (v: T) => void }} p */
function Choice({ value, options, label, onPick }) {
  return html`<fieldset class="seg-field"><legend>${label}</legend><div class="seg" role="radiogroup">${options.map(([v, l]) => html`<label key=${String(v)} class=${`seg-btn ${v === value ? 'on' : ''}`}>
    <input type="radio" checked=${v === value} onChange=${() => onPick(v)} />${l}</label>`)}</div></fieldset>`;
}

export function Settings() {
  const s = settings.value;
  if (!s) return null;
  const [notifL, soundL, volL, awayL] = tParts('set.notifs');
  const theme = tParts('set.theme'), density = tParts('set.density'), view = tParts('set.view');
  const exe = tParts('set.exe'), iso = tParts('set.isolation');
  const dndOn = s.dndUntil !== null && s.dndUntil > Date.now();
  const dnd = tParts('notif.dnd');
  return html`<${Modal} title=${t('nav.settings')} onClose=${closeOverlay} wide=${true} cls="settings">
    <section><h3>${t('set.perf')}</h3>
      <label class="field"><span>${t('set.reap', { n: s.reapMin ?? '∞' })}</span><select value=${String(s.reapMin)} onChange=${(/** @type {Event} */ e) => { const v = /** @type {HTMLSelectElement} */ (e.target).value; setSettings({ reapMin: v === 'null' ? null : Number(v) }); }}>
        ${REAP.map((r) => html`<option value=${String(r)}>${r === null ? t('shell.set.never') : `${r} min`}</option>`)}</select></label>
      ${s.reapMin !== null && s.reapMin < LIMITS.REAP_WARN_BELOW_MIN ? html`<p class="msg warn">${t('set.reap.warn')}</p>` : null}
      <label class="field"><span>${t('set.maxProcs')}</span><input type="number" min=${LIMITS.MAX_LIVE_MIN} max=${LIMITS.MAX_LIVE_MAX} value=${s.maxLive}
        onChange=${(/** @type {Event} */ e) => { const v = Math.round(Number(/** @type {HTMLInputElement} */ (e.target).value)); if (v >= LIMITS.MAX_LIVE_MIN && v <= LIMITS.MAX_LIVE_MAX) setSettings({ maxLive: v }); }} /></label>
      <${Toggle} k="prespawn" label=${t('set.prespawn')} s=${s} />
      <${Choice} label=${exe[0]?.split(' : ')[0] ?? ''} value=${s.exe} options=${[['installed', (exe[0] ?? '').split(' : ')[1] ?? 'installed'], ['bundled', exe[1] ?? 'bundled']]} onPick=${(/** @type {S['exe']} */ v) => setSettings({ exe: v })} />
      <${Choice} label=${iso[0]?.split(' : ')[0] ?? ''} value=${s.isolation} options=${[['job', (iso[0] ?? '').split(' : ')[1] ?? 'job'], ['plain', iso[1] ?? 'plain']]} onPick=${(/** @type {S['isolation']} */ v) => setSettings({ isolation: v })} />
    </section>
    <section><h3>${t('shell.set.notifs')}</h3>
      <${Toggle} k="notifications" label=${notifL ?? ''} s=${s} />
      <div class="inline"><${Toggle} k="sound" label=${soundL ?? ''} s=${s} />
        <label class="field inline"><span>${volL}</span><input type="range" min="0" max="1" step="0.1" value=${s.volume} disabled=${!s.sound}
          onChange=${(/** @type {Event} */ e) => setSettings({ volume: Number(/** @type {HTMLInputElement} */ (e.target).value) })} /></label></div>
      <${Toggle} k="onlyWhenAway" label=${awayL ?? ''} s=${s} />
      <${Toggle} k="reopenWindowOnAttention" label=${t('set.reopen')} s=${s} />
      <p class="inline"><span>${dnd[0]}${dndOn && s.dndUntil ? ` · ${t('shell.top.dndOn', { heure: fmtTime(s.dndUntil) })}` : ''}</span>
        <button type="button" class="btn sm" onClick=${() => setSettings({ dndUntil: Date.now() + 3_600_000 })}>${dnd[1]}</button>
        <button type="button" class="btn sm" disabled=${!dndOn} onClick=${() => setSettings({ dndUntil: null })}>${dnd[3]}</button></p>
    </section>
    <section><h3>${t('shell.set.keyboard')}</h3>
      <${Toggle} k="ctrlEnterSends" label=${t('set.ctrlEnter')} s=${s} />
      <${Toggle} k="shiftTabModes" label=${t('set.shiftTab')} s=${s} />
    </section>
    <section><h3>${t('shell.set.appearance')}</h3>
      <${Choice} label=${(theme[0] ?? '').split(' : ')[0] ?? ''} value=${s.theme} options=${[['system', (theme[0] ?? '').split(' : ')[1] ?? ''], ['light', theme[1] ?? ''], ['dark', theme[2] ?? '']]} onPick=${(/** @type {S['theme']} */ v) => setSettings({ theme: v })} />
      <${Choice} label=${(density[0] ?? '').split(' : ')[0] ?? ''} value=${s.density} options=${[['compact', (density[0] ?? '').split(' : ')[1] ?? ''], ['comfortable', density[1] ?? '']]} onPick=${(/** @type {S['density']} */ v) => setSettings({ density: v })} />
      <${Choice} label=${(view[0] ?? '').split(' : ')[0] ?? ''} value=${s.defaultView} options=${[['normal', (view[0] ?? '').split(' : ')[1] ?? ''], ['detailed', view[1] ?? ''], ['focus', view[2] ?? '']]} onPick=${(/** @type {S['defaultView']} */ v) => setSettings({ defaultView: v })} />
    </section>
    <section><h3>${t('shell.set.sessions')}</h3>
      <${Toggle} k="showOtherOrigins" label=${t('shell.set.showOther')} s=${s} />
      <${Toggle} k="aiTitles" label=${t('set.aiTitles')} s=${s} />
      <${Toggle} k="wakeNeverAsk" label=${t('wake.never')} s=${s} />
      <p class="muted small">${t('shell.set.port', { port: s.port })} · ${s.browser === 'edge' ? 'Edge' : 'Chrome'}</p>
    </section>
    <section class="danger-zone"><h3>${t('shell.set.danger')}</h3>
      <${Toggle} k="allowBypass" label=${t('set.bypass')} s=${s} />
      <p><button type="button" class="btn danger" onClick=${() => { closeOverlay(); void quitApp(); }}>${t('shell.act.quit')}</button></p>
    </section>
  </${Modal}>`;
}
