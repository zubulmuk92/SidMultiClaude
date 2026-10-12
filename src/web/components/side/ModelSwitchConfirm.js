// @ts-check
// src/web/components/side/ModelSwitchConfirm.js — model / effort switch (ux §3.5, E3): while the chat's cache is warm a
// model switch asks first, because the next message re-reads the whole conversation without cache. Effort changes ask
// only when the engine flags a cache break (not exposed in v1: they apply directly).
import { html } from 'htm/preact';
import { t, fmtTokens } from '../chat/text.js';
import { act, useChatVM } from '../chat/env.js';
import { modelName } from '../dock/PlanCard.js';
import { closeOverlay, openOverlay } from './overlays.js';
import { Modal } from './Popovers.js';

/** @typedef {import('../../../shared/protocol.ts').Effort} Effort */

/**
 * Whether a switch needs the confirmation (pure). @param {{ cacheWarmUntil?: number }} m @param {number} now
 * @param {{ modelChanges: boolean }} o
 */
export const needsModelConfirm = (m, now, o) => o.modelChanges && !!m.cacheWarmUntil && m.cacheWarmUntil > now;

/** Ask (or apply directly) a model / effort switch. @param {string} chatId @param {string | null} model @param {Effort | null} effort
 * @param {{ cacheWarmUntil?: number }} metrics @param {boolean} modelChanges */
export function switchModel(chatId, model, effort, metrics, modelChanges) {
  if (needsModelConfirm(metrics, Date.now(), { modelChanges })) openOverlay({ kind: 'model', chatId, model, effort });
  else void act().setModel(chatId, model, effort).catch(() => {});
}

/** @param {{ chatId: string; model: string | null; effort: Effort | null }} p */
export function ModelSwitchConfirm({ chatId, model, effort }) {
  const vm = useChatVM(chatId);
  const m = vm.metrics.value;
  const min = Math.max(0, Math.round(((m.cacheWarmUntil ?? 0) - Date.now()) / 60_000));
  const ok = () => { closeOverlay(); void act().setModel(chatId, model, effort).catch(() => {}); };
  const footer = html`<button type="button" class="d-btn d-quiet" onClick=${closeOverlay}>${t('cap.cancel')}</button>
    <button type="button" class="d-btn d-primary" onClick=${ok}>${t('model.confirm.ok')}</button>`;
  return html`<${Modal} title=${t('model.confirm.title')} onClose=${closeOverlay} cls="s-model" footer=${footer}>
    <p>${t('model.confirm.body', { min, 'modèle': model ? modelName(model) : t('model.default'), tokens: fmtTokens(m.contextTokens ?? 0) })}</p>
  <//>`;
}
