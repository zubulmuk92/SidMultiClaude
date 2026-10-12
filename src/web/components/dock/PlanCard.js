// @ts-check
// src/web/components/dock/PlanCard.js — ExitPlanMode approval (ux §6.5, SPEC §2.5): the plan comes from the ask
// (input.plan / planFilePath), never from the assistant frame copy; « planifié avec Sonnet » badge when the planning
// requests ran on another model (SPEC §9.2 item 11). Keys: 1 2 3 · M edit · Ctrl+Entrée confirm focus.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../chat/text.js';
import { getEnv, useChatVM } from '../chat/env.js';
import { inTextField } from '../../lib/keymap.js';
import { Markdown } from '../chat/Blocks.js';
import { planOptions, planText } from './logic.js';
import { CardFrame, Kbd, useDecide } from './Card.js';

/** @typedef {import('../../../shared/protocol.ts').PendingAsk} PendingAsk */

/** « claude-sonnet-5-5 » → « Sonnet ». @param {string | undefined} m */
export function modelName(m) {
  if (!m) return '';
  const k = /(opus|sonnet|haiku|fable)/i.exec(m);
  return k?.[1] ? k[1][0]?.toUpperCase() + k[1].slice(1).toLowerCase() : m;
}

/** @param {{ chatId: string; ask: PendingAsk; index: number; total: number; autoFocus?: boolean }} p */
export function PlanCard({ chatId, ask, index, total, autoFocus }) {
  const vm = useChatVM(chatId);
  const { busy, elsewhere, decide } = useDecide(chatId, ask);
  const [edit, setEdit] = useState(/** @type {string | null} */ (null));
  const [reject, setReject] = useState(/** @type {string | null} */ (null));
  const [full, setFull] = useState(false);
  const first = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const field = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  useEffect(() => { if (autoFocus && !first.current?.closest('.d-card')?.contains(document.activeElement)) first.current?.focus(); }, [autoFocus]);
  useEffect(() => { if (reject !== null || edit !== null) field.current?.focus(); }, [reject !== null, edit !== null]);

  let plan = planText(ask), reconstructed = false;
  if (!plan) {           // last resort (ux §6.5): the turn's last assistant text
    const turns = vm.turns.value;
    const last = turns[turns.length - 1]?.sig.value.blocks.filter((b) => b.k === 'text').pop();
    if (last && last.k === 'text') { plan = last.md; reconstructed = true; }
  }
  const tool = vm.blocks(`t:${ask.toolUseId}`)?.value;
  const planModel = tool && tool.k === 'tool' ? tool.model : undefined;
  const chatModel = vm.meta.value?.model;
  const badge = planModel && chatModel && modelName(planModel) !== modelName(chatModel) ? t('plan.modelBadge', { 'modèle': modelName(planModel) }) : null;
  const opts = planOptions({ autoAvailable: useChatVM(chatId).autoAvailable.value, bypassAllowed: false });
  /** @param {(typeof opts)[number]['nextMode']} nextMode */
  const approve = (nextMode) => decide({ kind: 'plan-approve', nextMode, ...(edit !== null && edit !== plan ? { editedPlan: edit } : {}) });
  const sendReject = () => { if (reject?.trim()) void decide({ kind: 'plan-reject', feedback: reject.trim() }); };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault(); e.stopPropagation();
      if (reject !== null && (/** @type {HTMLElement} */ (e.target)).closest?.('.d-reject')) sendReject();
      else /** @type {HTMLElement | null} */ (document.activeElement)?.click?.();
      return;
    }
    if (inTextField(e.target)) {
      const inReject = !!(/** @type {HTMLElement} */ (e.target)).closest?.('.d-reject');
      if (e.key === 'Enter' && !e.shiftKey && inReject) { e.preventDefault(); sendReject(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (inReject) setReject(null); first.current?.focus(); }
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const d = /^(?:Digit|Numpad)([1-3])$/.exec(e.code);
    if (d) { e.preventDefault(); const n = Number(d[1]); if (n === 3) setReject(reject ?? ''); else { const o = opts[n - 1]; if (o) void approve(o.nextMode); } return; }
    if (e.key.toLowerCase() === 'm') { e.preventDefault(); setEdit(edit ?? plan); }
  };
  const tools = html`<span class="d-card-tools">
    ${badge ? html`<span class="c-badge" title=${t('warn.haikuPlan')}>${badge}</span>` : null}
    <button type="button" class="c-mini" onClick=${() => setEdit(edit === null ? plan : null)}>${edit === null ? t('plan.edit') : t('plan.edit.done')}</button>
    <button type="button" class="c-mini" aria-pressed=${full} onClick=${() => setFull(!full)}>${t('plan.full')}</button></span>`;
  return html`<${CardFrame} ask=${ask} icon="≡" title=${t('plan.title')} index=${index} total=${total} full=${full}
      busy=${busy} elsewhere=${elsewhere} onKey=${onKey} cls="d-plan" tools=${tools}>
    ${reconstructed ? html`<p class="d-warn">${t('plan.reconstructed')}</p>` : null}
    ${edit !== null ? html`<textarea ref=${field} class="d-mono d-plan-edit" rows="14" aria-label=${t('plan.edit')} value=${edit}
        onInput=${(/** @type {any} */ e) => setEdit(e.currentTarget.value)}></textarea>`
      : html`<div class="d-plan-text"><${Markdown} md=${plan} /></div>`}
    <div class="d-actions d-actions-col">
      ${opts.map((o, k) => html`<button type="button" ref=${k === 0 ? first : undefined} class=${'d-btn' + (k === 0 ? ' d-primary' : '')}
        onClick=${() => approve(o.nextMode)}><${Kbd} k=${String(k + 1)} />${t(o.key)}</button>`)}
      <button type="button" class="d-btn" onClick=${() => setReject(reject ?? '')}><${Kbd} k="3" />${t('plan.no')}</button>
      ${reject !== null ? html`<span class="d-reject">
        <textarea ref=${edit === null ? field : undefined} rows="2" placeholder=${t('plan.no.placeholder')} aria-label=${t('plan.no')} value=${reject}
          onInput=${(/** @type {any} */ e) => setReject(e.currentTarget.value)}></textarea>
        <button type="button" class="d-btn" disabled=${!reject.trim()} onClick=${sendReject}>${t('plan.send')}</button></span>` : null}
    </div>
  <//>`;
}
