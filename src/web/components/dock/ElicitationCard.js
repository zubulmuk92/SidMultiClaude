// @ts-check
// src/web/components/dock/ElicitationCard.js — MCP elicitation (ux §6.6): form mode builds fields from the requested
// schema (text, number, boolean, enum); URL mode opens the page in the user's browser (never in the app). The server
// name is untrusted text.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../chat/text.js';
import { act } from '../chat/env.js';
import { elicitContent, elicitFields } from './logic.js';
import { CardFrame, useDecide } from './Card.js';

/** @typedef {import('../../../shared/protocol.ts').PendingAsk} PendingAsk */

/** @param {{ chatId: string; ask: PendingAsk; index: number; total: number; autoFocus?: boolean }} p */
export function ElicitationCard({ chatId, ask, index, total, autoFocus }) {
  const { busy, elsewhere, decide } = useDecide(chatId, ask);
  const el = ask.elicitation ?? { mode: 'form', server: ask.mcpServer?.name ?? ask.toolName, message: ask.description ?? '' };
  const fields = elicitFields(el.schema);
  const [vals, setVals] = useState(/** @type {Record<string, string | boolean>} */ ({}));
  const [invalid, setInvalid] = useState(false);
  const root = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => { if (autoFocus && !root.current?.closest('.d-card')?.contains(document.activeElement)) /** @type {HTMLElement | null} */ (root.current?.querySelector('input, select, button') ?? null)?.focus(); }, [autoFocus]);
  /** @param {string} k @param {string | boolean} v */
  const set = (k, v) => { setVals({ ...vals, [k]: v }); setInvalid(false); };
  const submit = () => {
    const content = elicitContent(fields, vals);
    if (!content) { setInvalid(true); return; }
    void decide({ kind: 'elicit', action: 'accept', content });
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); e.stopPropagation(); if (el.mode === 'form') submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void decide({ kind: 'elicit', action: 'cancel' }); }
  };
  const title = el.mode === 'url' ? t('elicit.url', { nom: el.server }) : t('elicit.title', { nom: el.server });
  return html`<${CardFrame} ask=${ask} icon="⇄" title=${title} index=${index} total=${total} busy=${busy} elsewhere=${elsewhere}
      onKey=${onKey} cls="d-elicit">
    <div ref=${root}>
      ${el.message ? html`<p class="d-wants">${el.message}</p>` : null}
      ${el.mode === 'url' ? html`
        ${el.url ? html`<p><code>${el.url}</code></p>` : null}
        <div class="d-actions">
          <button type="button" class="d-btn d-primary" disabled=${!el.url} onClick=${() => el.url && act().openExternal(el.url)}>${t('elicit.open')}</button>
          <button type="button" class="d-btn" onClick=${() => decide({ kind: 'elicit', action: 'accept' })}>${t('elicit.done')}</button>
          <button type="button" class="d-btn d-quiet" onClick=${() => decide({ kind: 'elicit', action: 'cancel' })}>${t('elicit.cancel')}</button>
        </div>` : html`
        <div class="d-form">${fields.map((f) => html`<label class="d-field">
          <span>${f.label}${f.required ? ' *' : ''}</span>
          ${f.type === 'boolean' ? html`<input type="checkbox" checked=${vals[f.name] === true} onChange=${(/** @type {any} */ e) => set(f.name, e.currentTarget.checked)} />`
            : f.type === 'enum' ? html`<select value=${String(vals[f.name] ?? '')} onChange=${(/** @type {any} */ e) => set(f.name, e.currentTarget.value)}>
                <option value="">—</option>${(f.options ?? []).map((o) => html`<option value=${o}>${o}</option>`)}</select>`
            : html`<input type=${f.type === 'number' ? 'text' : 'text'} inputmode=${f.type === 'number' ? 'decimal' : 'text'} value=${String(vals[f.name] ?? '')}
                onInput=${(/** @type {any} */ e) => set(f.name, e.currentTarget.value)} />`}
          ${f.description ? html`<small>${f.description}</small>` : null}
        </label>`)}</div>
        ${invalid ? html`<p class="d-warn" role="alert">${t('elicit.invalid')}</p>` : null}
        <div class="d-actions">
          <button type="button" class="d-btn d-primary" onClick=${submit}>${t('elicit.submit')}</button>
          <button type="button" class="d-btn" onClick=${() => decide({ kind: 'elicit', action: 'decline' })}>${t('elicit.decline')}</button>
        </div>`}
    </div>
  <//>`;
}
