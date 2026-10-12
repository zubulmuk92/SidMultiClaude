// @ts-check
// src/web/components/dock/QuestionForm.js — AskUserQuestion form (ux §6.4): single / multi choice, « Autre… » free
// text, notes, previews (markdown shown as text in <pre>), « Répondre librement », « Ne pas répondre ».
// Keys: ↑↓ options · Espace toggle · 1–4 pick (last number = Autre…) · Tab / Maj+Tab question · Ctrl+Entrée send.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../chat/text.js';
import { inTextField } from '../../lib/keymap.js';
import { buildAnswers, initQuestions, pickOption } from './logic.js';
import { CardFrame, Kbd, useDecide } from './Card.js';

/** @typedef {import('../../../shared/protocol.ts').PendingAsk} PendingAsk */
/** @typedef {import('../../../shared/protocol.ts').AskQuestion} AskQuestion */

/** @param {PendingAsk} ask @returns {AskQuestion[]} */
export function questionsOf(ask) {
  if (ask.questions?.length) return ask.questions;
  const q = ask.input['questions'];
  return Array.isArray(q) ? /** @type {AskQuestion[]} */ (q) : [];
}

/** @param {{ chatId: string; ask: PendingAsk; index: number; total: number; autoFocus?: boolean }} p */
export function QuestionForm({ chatId, ask, index, total, autoFocus }) {
  const qs = questionsOf(ask);
  const { busy, elsewhere, decide } = useDecide(chatId, ask);
  const [st, setSt] = useState(() => initQuestions(qs));
  const [qi, setQi] = useState(0);
  const [preview, setPreview] = useState(/** @type {string | null} */ (null));
  const [free, setFree] = useState(/** @type {string | null} */ (null));
  const [notes, setNotes] = useState(/** @type {boolean[]} */ (qs.map(() => false)));
  const root = useRef(/** @type {HTMLDivElement | null} */ (null));
  const focusQ = (/** @type {number} */ k) => /** @type {HTMLElement | null} */ (root.current?.querySelector(`[data-q="${k}"] [data-opt]`) ?? null)?.focus();
  useEffect(() => { if (autoFocus && !root.current?.closest('.d-card')?.contains(document.activeElement)) focusQ(0); }, [autoFocus]);
  const answers = buildAnswers(qs, st);
  /** @param {number} k @param {number} o */
  const pick = (k, o) => {
    const q = qs[k], s = st[k];
    if (!q || !s) return;
    const next = pickOption(q, s, o);
    setSt(st.map((x, j) => (j === k ? next : x)));
    setQi(k);
    if (o === q.options.length && (next.otherOn)) setTimeout(() => /** @type {HTMLElement | null} */ (root.current?.querySelector(`[data-q="${k}"] .d-other input`) ?? null)?.focus(), 0);
  };
  /** @param {number} k @param {Partial<import('./logic.js').QState>} patch */
  const patch = (k, patch) => setSt(st.map((x, j) => (j === k ? { ...x, ...patch } : x)));
  const submit = () => { if (answers) void decide(answers); };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); e.stopPropagation(); if (free !== null && free.trim()) void decide({ kind: 'answers', answers: {}, response: free.trim() }); else submit(); return; }
    if (inTextField(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
    const q = qs[qi];
    const d = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (d && q) { const o = Number(d[1]) - 1; if (o <= q.options.length) { e.preventDefault(); pick(qi, o); } return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const opts = [...(root.current?.querySelectorAll(`[data-q="${qi}"] [data-opt]`) ?? [])];
      const i = opts.indexOf(/** @type {Element} */ (document.activeElement));
      /** @type {HTMLElement | undefined} */ (opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length])?.focus();
      e.preventDefault(); return;
    }
    if (e.key === 'Tab') {
      const k = qi + (e.shiftKey ? -1 : 1);
      if (k >= 0 && k < qs.length) { e.preventDefault(); setQi(k); focusQ(k); }
    }
  };
  return html`<${CardFrame} ask=${ask} icon="?" title=${t('ask.title', { n: qs.length })} index=${index} total=${total}
      busy=${busy} elsewhere=${elsewhere} onKey=${onKey} cls="d-question">
    <div ref=${root} class="d-qs">
      ${qs.map((q, k) => { const s = st[k] ?? initQuestions([q])[0]; return html`<div class=${'d-q' + (k === qi ? ' d-q-active' : '')} data-q=${k}
          role=${q.multiSelect ? 'group' : 'radiogroup'} aria-label=${q.question}>
        <div class="d-q-head"><span class="c-badge">${q.header}</span> ${q.question} ${q.multiSelect ? html`<small>${t('ask.multi')}</small>` : null}</div>
        <div class="d-opts">
          ${q.options.map((o, j) => html`<button type="button" data-opt=${j} role=${q.multiSelect ? 'checkbox' : 'radio'}
              aria-checked=${s?.selected.includes(j) ?? false} class=${'d-opt' + (s?.selected.includes(j) ? ' d-on' : '')}
              onClick=${() => pick(k, j)} onFocus=${() => { setQi(k); setPreview(o.preview ?? null); }} onMouseEnter=${() => setPreview(o.preview ?? null)}>
            <${Kbd} k=${String(j + 1)} /><span class="d-opt-label">${o.label}</span><small>${o.description}</small></button>`)}
          <span class="d-other">
            <button type="button" data-opt=${q.options.length} role=${q.multiSelect ? 'checkbox' : 'radio'} aria-checked=${s?.otherOn ?? false}
              class=${'d-opt' + (s?.otherOn ? ' d-on' : '')} onClick=${() => pick(k, q.options.length)}><${Kbd} k=${String(q.options.length + 1)} />${t('ask.other')}</button>
            ${s?.otherOn ? html`<input type="text" aria-label=${t('ask.other')} placeholder=${t('ask.other.placeholder')} value=${s.other}
              onInput=${(/** @type {any} */ e) => patch(k, { other: e.currentTarget.value })} />` : null}
          </span>
        </div>
        ${notes[k] ? html`<input type="text" class="d-note" aria-label=${t('ask.note')} placeholder=${t('ask.note.placeholder')} value=${s?.note ?? ''}
            onInput=${(/** @type {any} */ e) => patch(k, { note: e.currentTarget.value })} />`
          : html`<button type="button" class="c-link" onClick=${() => setNotes(notes.map((x, j) => (j === k ? true : x)))}>+ ${t('ask.note')}</button>`}
      </div>`; })}
      ${preview ? html`<div class="d-preview"><div class="d-preview-title">${t('ask.preview')}</div><pre>${preview}</pre></div>` : null}
    </div>
    ${free !== null ? html`<label class="d-field"><span>${t('ask.free')}</span>
      <textarea rows="3" placeholder=${t('ask.free.placeholder')} value=${free} onInput=${(/** @type {any} */ e) => setFree(e.currentTarget.value)}></textarea>
      <button type="button" class="d-btn d-primary" disabled=${!free.trim()} onClick=${() => decide({ kind: 'answers', answers: {}, response: free.trim() })}>${t('ask.free.send')}</button>
    </label>` : null}
    <div class="d-actions">
      <button type="button" class="d-btn d-primary" disabled=${!answers} onClick=${submit}>${t('ask.submit')}</button>
      <button type="button" class="d-btn" onClick=${() => setFree(free === null ? '' : null)}>${t('ask.free')}</button>
      <button type="button" class="d-btn d-quiet" onClick=${() => decide({ kind: 'skip-question' })}>${t('ask.skip')}</button>
    </div>
  <//>`;
}
