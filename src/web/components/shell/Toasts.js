// @ts-check
// src/web/components/shell/Toasts.js — toast host (bottom right, role="status"; never takes focus; optional undo action).
// Approvals never appear in toasts (S7).
import { html } from 'htm/preact';
import { t, has } from '../../lib/i18n.js';
import { dismissToast, toasts } from '../../store.js';
import { Icon } from '../../lib/icons.js';

/** Keys like « Chat archivé · Annuler » carry their action label: drop it when the button shows it. @param {import('../../store.js').Toast} x */
function textOf(x) {
  const s = has(x.key) ? t(x.key, x.args) : x.key;
  return x.action && s.includes(' · ') ? s.slice(0, s.lastIndexOf(' · ')) : s;
}

export function Toasts() {
  const list = toasts.value;
  return html`<div class="toasts" role="status" aria-live="polite">
    ${list.map((x) => html`<div key=${x.id} class=${`toast ${x.level}`}>
      <span class="toast-text">${x.text ?? textOf(x)}</span>
      ${x.action ? html`<button type="button" class="btn sm" onClick=${() => { x.action?.run(); dismissToast(x.id); }}>${has(x.action.label) ? t(x.action.label) : x.action.label}</button>` : null}
      <button type="button" class="icon-btn sm" tabindex="-1" aria-label=${t('shell.close')} onClick=${() => dismissToast(x.id)}><${Icon} n="x" /></button>
    </div>`)}
  </div>`;
}
