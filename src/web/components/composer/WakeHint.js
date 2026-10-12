// @ts-check
// src/web/components/composer/WakeHint.js — zero-token hints under the editor (ux §7.8): a sleeping chat will re-cache
// ~N tokens; the cache of a live chat has expired; the context is close to the auto-compaction threshold. Hints never
// block sending.
import { html } from 'htm/preact';
import { t, fmtTokens } from '../chat/text.js';
import { useChatVM } from '../chat/env.js';
import { UI } from '../chat/consts.js';
import { contextFull, recacheEstimate } from './logic.js';

/**
 * Which hint applies (pure; unit-tested). @param {{ phase: string; live: boolean; wake?: { lastContext: number; recacheTokens: number };
 *   metrics: import('../../../shared/protocol.ts').ChatMetrics; now: number }} s
 * @returns {{ key: string; args: Record<string, string> } | null}
 */
export function wakeHint(s) {
  const full = contextFull(s.metrics);
  if (full !== null) return { key: 'composer.contextFull', args: { pct: String(full) } };
  if (!s.live || s.phase === 'cold') {
    const n = s.wake ? (s.wake.recacheTokens || recacheEstimate(s.wake.lastContext)) : 0;
    return n > UI.WAKE_HINT_MIN_TOKENS ? { key: 'composer.wake', args: { tokens: fmtTokens(n) } } : null;
  }
  const until = s.metrics.cacheWarmUntil;
  const n = recacheEstimate(s.metrics.contextTokens ?? 0);
  if (until && until < s.now && n > UI.CACHE_COLD_HINT_MIN_TOKENS) return { key: 'composer.cacheCold', args: { tokens: fmtTokens(n) } };
  return null;
}

/** @param {{ chatId: string; onCompact: () => void }} p */
export function WakeHint({ chatId, onCompact }) {
  const vm = useChatVM(chatId);
  const s = vm.summary.value;
  const h = wakeHint({ phase: s.state.phase, live: s.state.flags.live, ...(s.wake ? { wake: s.wake } : {}), metrics: vm.metrics.value, now: Date.now() });
  if (!h) return null;
  return html`<div class=${'w-hint' + (h.key === 'composer.contextFull' ? ' w-warn' : '')} role="note">${t(h.key, h.args)}
    ${h.key === 'composer.contextFull' ? html` <button type="button" class="c-link" onClick=${onCompact}>${t('header.context.compact')}</button>` : null}</div>`;
}
