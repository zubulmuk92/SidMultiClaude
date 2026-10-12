// @ts-check
// src/web/components/chat/DiffView.js — unified / side-by-side diff (ux §5.4, §6.3): old/new line numbers, hunk headers
// « Lignes a–b », word-level highlight on paired −/+ lines (< 500 chars), collapsed above 400 lines, rendered in chunks
// of 200. Text nodes only.
import { html } from 'htm/preact';
import { useMemo, useState } from 'preact/hooks';
import { pairRows, wordDiff, numberRows, toHunks } from '../../lib/diff.js';
import { t } from './text.js';
import { UI } from './consts.js';

/** @typedef {import('../../lib/diff.js').Hunk} Hunk */
/** @typedef {import('../../lib/diff.js').DiffRow} DiffRow */
/** @typedef {import('../../lib/diff.js').DiffOp} DiffOp */

/** Hunks of a client-side preview (ops from diffLines). @param {DiffOp[]} ops */
export const opsToHunks = (ops) => toHunks(numberRows(ops), 3);

/** @param {{ segs: import('../../lib/diff.js').WordSeg[] }} p */
const Words = ({ segs }) => html`${segs.map((s) => (s.changed ? html`<mark>${s.text}</mark>` : s.text))}`;

/** @param {{ r: DiffRow; pair?: import('../../lib/diff.js').WordSeg[] | null }} p */
function Row({ r, pair }) {
  const cls = r.op === '+' ? 'd-add' : r.op === '-' ? 'd-del' : 'd-ctx';
  return html`<div class=${'d-row ' + cls}><span class="d-no">${r.oldNo ?? ''}</span><span class="d-no">${r.newNo ?? ''}</span>
    <span class="d-op" aria-hidden="true">${r.op === ' ' ? ' ' : r.op === '-' ? '−' : '+'}</span><span class="d-text">${pair ? html`<${Words} segs=${pair} />` : r.text}</span></div>`;
}

/** Word segments for every paired row of a hunk. @param {DiffRow[]} rows */
function wordPairs(rows) {
  /** @type {Map<number, import('../../lib/diff.js').WordSeg[]>} */ const m = new Map();
  for (const [d, a] of pairRows(rows)) {
    const w = wordDiff(rows[d]?.text ?? '', rows[a]?.text ?? '', UI.WORD_DIFF_MAX_CHARS);
    if (w) { m.set(d, w.a); m.set(a, w.b); }
  }
  return m;
}

/** @param {{ hunks: Hunk[]; block?: boolean; oldCount?: number; newCount?: number; path?: string }} p */
export function DiffView({ hunks, block, oldCount, newCount }) {
  const total = hunks.reduce((n, h) => n + h.rows.length, 0);
  const [open, setOpen] = useState(total <= UI.DIFF_COLLAPSE_LINES);
  const [limit, setLimit] = useState(/** @type {number} */ (UI.DIFF_CHUNK_LINES));
  const [side, setSide] = useState(false);
  const pairs = useMemo(() => hunks.map((h) => wordPairs(h.rows)), [hunks]);
  if (block) return html`<div class="d-block">${t('tool.block', { n: oldCount ?? 0, m: newCount ?? 0 })}</div>`;
  if (!open) return html`<button type="button" class="c-link" onClick=${() => setOpen(true)}>${t('tool.diff.show', { n: total })}</button>`;
  let budget = limit;
  return html`<div class=${'d-view' + (side ? ' d-side' : '')}>
    <div class="d-tools"><button type="button" class="c-mini" aria-pressed=${side} onClick=${() => setSide(!side)}>
      ${side ? t('tool.diff.unified') : t('tool.sideBySide')}</button></div>
    ${hunks.map((h, k) => {
      if (budget <= 0) return null;
      const rows = h.rows.slice(0, budget);
      budget -= rows.length;
      const m = pairs[k] ?? new Map();
      return html`<div class="d-hunk" key=${k}>
        <div class="d-head">${t('tool.diff.hunk', { a: h.newStart, b: h.newStart + Math.max(0, h.newLines - 1) })}</div>
        ${side ? html`<${SideBySide} rows=${rows} words=${m} />` : rows.map((r, i) => html`<${Row} r=${r} pair=${m.get(i) ?? null} />`)}
      </div>`;
    })}
    ${total > limit ? html`<button type="button" class="c-link" onClick=${() => setLimit(limit + UI.DIFF_CHUNK_LINES)}>${t('tool.more')}</button>` : null}
  </div>`;
}

/** Two columns: context on both sides, deletions left, additions right, paired rows on one line.
 * @param {{ rows: DiffRow[]; words: Map<number, import('../../lib/diff.js').WordSeg[]> }} p */
function SideBySide({ rows, words }) {
  /** @type {{ l: number | null; r: number | null }[]} */ const lines = [];
  let k = 0;
  while (k < rows.length) {
    const row = rows[k];
    if (row?.op === ' ') { lines.push({ l: k, r: k }); k++; continue; }
    const dels = [], adds = [];
    while (k < rows.length && rows[k]?.op === '-') dels.push(k++);
    while (k < rows.length && rows[k]?.op === '+') adds.push(k++);
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) lines.push({ l: dels[i] ?? null, r: adds[i] ?? null });
  }
  /** @param {number | null} i @param {'l' | 'r'} side */
  const cell = (i, side) => {
    if (i === null) return html`<span class="d-cell d-empty"></span>`;
    const r = /** @type {DiffRow} */ (rows[i]);
    const cls = r.op === '+' ? 'd-add' : r.op === '-' ? 'd-del' : 'd-ctx';
    const no = side === 'l' ? r.oldNo : r.newNo;
    const w = words.get(i);
    return html`<span class=${'d-cell ' + cls}><span class="d-no">${no ?? ''}</span><span class="d-text">${w ? html`<${Words} segs=${w} />` : r.text}</span></span>`;
  };
  return html`${lines.map((x) => html`<div class="d-pair">${cell(x.l, 'l')}${cell(x.r, 'r')}</div>`)}`;
}
