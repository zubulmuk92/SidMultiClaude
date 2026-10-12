// @ts-check
// src/web/components/chat/SystemRow.js — system rows (ux §5.5): compaction separator, interruption, crash, server
// restart, retry, notices, cache miss, /clear separator, hooks and mode changes (Détaillé only). Text nodes only.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { hasKey, t, talt, fmtTokens, fmtDuration } from './text.js';
import { act } from './env.js';
import { Markdown } from './Blocks.js';

/** @typedef {import('../../../shared/protocol.ts').UiSystemRow} UiSystemRow */

/** @param {UiSystemRow} row @returns {string} */
export function systemText(row) {
  const x = row.data ?? {};
  switch (row.kind) {
    case 'compact':
      if (row.text) return row.text;
      return talt('sys.compacted', x['trigger'] === 'manual' ? 1 : 0, {
        avant: fmtTokens(Number(x['preTokens'] ?? 0)), 'après': fmtTokens(Number(x['postTokens'] ?? 0)), 'durée': fmtDuration(Number(x['durationMs'] ?? 0)) });
    case 'interrupted': return t('sys.interrupted');                    // row.text is the CLI's English marker ([Request interrupted by user])
    case 'cleared': return t('sys.cleared');
    case 'crash': return row.text || t('sys.crash');
    case 'cacheMiss': return row.text || t('sys.cacheMiss', { n: fmtTokens(Number(x['tokens'] ?? 0)), cause: String(x['cause'] ?? '') });
    case 'refusal': return row.text || t('sys.refusal', { m1: String(x['from'] ?? ''), m2: String(x['to'] ?? '') });
    default:
      if (row.kind === 'notice' && x['reason'] === 'serverRestart') return t('sys.serverRestart');
      if (typeof x['key'] === 'string' && hasKey(x['key'])) {              // server notices carry an i18n key + data
        /** @type {Record<string, string | number>} */ const args = {};
        for (const [k, v] of Object.entries(x)) if (typeof v === 'string' || typeof v === 'number') args[k] = v;
        return t(x['key'], args);
      }
      return row.text ?? row.kind;
  }
}

/** Rows shown only in Détaillé (ux §5.5). @param {UiSystemRow} row */
export const detailedOnly = (row) => row.kind === 'hook' || row.kind === 'modeChange' || (row.kind === 'notice' && row.data?.['level'] === 'info');

/** @param {{ chatId: string; id: string; row: UiSystemRow }} p */
export function SystemRow({ chatId, id, row }) {
  const [summary, setSummary] = useState(/** @type {string | null} */ (null));
  const text = systemText(row);
  const tone = row.kind === 'crash' || row.kind === 'error' ? 'c-sys-err'
    : row.kind === 'cacheMiss' || row.kind === 'rateLimit' || row.kind === 'retry' || (row.kind === 'notice' && (row.data?.['level'] === 'warning' || row.data?.['level'] === 'suggestion')) ? 'c-sys-warn'
    : row.kind === 'compact' || row.kind === 'cleared' ? 'c-sys-sep' : 'c-sys';
  if (row.kind === 'local' && row.text) return html`<div class="c-sys-local" data-block=${id}><${Markdown} md=${row.text} /></div>`;
  return html`<div class=${'c-sysrow ' + tone} data-block=${id} role=${row.kind === 'crash' || row.kind === 'error' ? 'alert' : undefined}>
    <span>${text}</span>
    ${row.kind === 'compact' ? html`<button type="button" class="c-link" onClick=${() => act().detail(chatId, id, 'raw').then((d) => setSummary(d.text ?? ''), () => setSummary(t('tool.detail.error')))}>${t('sys.summary')}</button>` : null}
    ${summary !== null ? html`<div class="c-sys-summary"><${Markdown} md=${summary} /></div>` : null}
  </div>`;
}
