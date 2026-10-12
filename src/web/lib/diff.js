// @ts-check
// src/web/lib/diff.js — own line LCS diff (SPEC C11, ux §6.3 / §5.4): previews of Edit/Write asks, hunks with 3 lines
// of context, word-level highlight on paired lines, and rows for tool_use_result.structuredPatch. Pure.

/** @typedef {' ' | '+' | '-'} Op */
/** @typedef {{ op: Op; text: string }} DiffOp */
/** @typedef {{ op: Op; text: string; oldNo?: number; newNo?: number }} DiffRow */
/** @typedef {{ oldStart: number; oldLines: number; newStart: number; newLines: number; rows: DiffRow[] }} Hunk */

const MAX_CELLS = 1_000_000;     // n·m above → block view (ux §6.3)

/** Lines of a text; a final newline does not create an empty last line. @param {string} s */
export function splitLines(s) {
  if (s === '') return [];
  const l = s.split(/\r?\n/);
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/** @param {string} a @param {string} b @returns {DiffOp[]} */
export function diffLines(a, b) { return diffLinesDetailed(a, b).ops; }

/**
 * Line diff. Common prefix/suffix are trimmed first; the middle is an LCS when n·m ≤ 1e6, otherwise a block
 * replacement (`block: true`, rendered as « n lignes remplacées par m »).
 * @param {string} a @param {string} b @returns {{ ops: DiffOp[]; block: boolean }}
 */
export function diffLinesDetailed(a, b) {
  const A = splitLines(a), B = splitLines(b);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const a2 = A.slice(p, A.length - s), b2 = B.slice(p, B.length - s);
  /** @type {DiffOp[]} */
  const ops = A.slice(0, p).map((text) => ({ op: /** @type {Op} */ (' '), text }));
  let block = false;
  if (a2.length * b2.length > MAX_CELLS) {
    block = true;
    for (const text of a2) ops.push({ op: '-', text });
    for (const text of b2) ops.push({ op: '+', text });
  } else {
    ops.push(...lcs(a2, b2, (x, y) => x === y).map(([op, i]) => ({ op, text: /** @type {string} */ (op === '+' ? b2[i] : a2[i]) })));
  }
  for (const text of A.slice(A.length - s)) ops.push({ op: ' ', text });
  return { ops, block };
}

/**
 * Classic LCS table, then a walk that emits deletions before insertions. Returns [op, index] where the index is in
 * `a` for ' ' and '-', in `b` for '+'.
 * @template T @param {T[]} a @param {T[]} b @param {(x: T, y: T) => boolean} eq @returns {[Op, number][]}
 */
function lcs(a, b, eq) {
  const n = a.length, m = b.length, w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = eq(/** @type {T} */ (a[i]), /** @type {T} */ (b[j]))
        ? (t[(i + 1) * w + j + 1] ?? 0) + 1
        : Math.max(t[(i + 1) * w + j] ?? 0, t[i * w + j + 1] ?? 0);
    }
  }
  /** @type {[Op, number][]} */
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(/** @type {T} */ (a[i]), /** @type {T} */ (b[j]))) { out.push([' ', i]); i++; j++; }
    else if ((t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0)) { out.push(['-', i]); i++; }
    else { out.push(['+', j]); j++; }
  }
  while (i < n) out.push(['-', i++]);
  while (j < m) out.push(['+', j++]);
  return out;
}

/** Number the rows (1-based old / new line numbers). @param {DiffOp[]} ops @param {number} [oldStart] @param {number} [newStart] */
export function numberRows(ops, oldStart = 1, newStart = 1) {
  let o = oldStart, n = newStart;
  return ops.map((r) => /** @type {DiffRow} */ (
    r.op === ' ' ? { ...r, oldNo: o++, newNo: n++ } : r.op === '-' ? { ...r, oldNo: o++ } : { ...r, newNo: n++ }));
}

/** Group numbered rows into hunks with `context` lines around each change (unified diff). @param {DiffRow[]} rows @param {number} [context] @returns {Hunk[]} */
export function toHunks(rows, context = 3) {
  /** @type {Hunk[]} */
  const hunks = [];
  const changed = rows.map((r) => r.op !== ' ');
  let k = 0;
  while (k < rows.length) {
    if (!changed[k]) { k++; continue; }
    let start = Math.max(0, k - context), end = k;
    // extend while the next change is within 2·context lines
    for (;;) {
      let next = end + 1;
      while (next < rows.length && !changed[next]) next++;
      if (next < rows.length && next - end <= 2 * context) end = next; else break;
    }
    const stop = Math.min(rows.length, end + context + 1);
    const slice = rows.slice(start, stop);
    const first = slice[0];
    hunks.push({
      oldStart: first?.oldNo ?? slice.find((r) => r.oldNo)?.oldNo ?? 0,
      newStart: first?.newNo ?? slice.find((r) => r.newNo)?.newNo ?? 0,
      oldLines: slice.filter((r) => r.op !== '+').length,
      newLines: slice.filter((r) => r.op !== '-').length,
      rows: slice,
    });
    k = stop;
  }
  return hunks;
}

/** Rows of a tool_use_result.structuredPatch (lines prefixed ' ', '+', '-'; '\' lines dropped).
 * @param {import('../../shared/protocol.ts').PatchHunk[]} patch @returns {Hunk[]} */
export function patchToHunks(patch) {
  return patch.map((h) => {
    const ops = h.lines.filter((l) => !l.startsWith('\\')).map((l) => ({
      op: /** @type {Op} */ (l[0] === '+' || l[0] === '-' ? l[0] : ' '), text: l.slice(1) }));
    return { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, rows: numberRows(ops, h.oldStart, h.newStart) };
  });
}

/** @param {{ op: Op }[]} rows */
export function countChanges(rows) {
  let added = 0, removed = 0;
  for (const r of rows) { if (r.op === '+') added++; else if (r.op === '-') removed++; }
  return { added, removed };
}

/** @typedef {{ text: string; changed: boolean }} WordSeg */
/**
 * Word-level highlight of a paired −/+ line (only below 500 chars, ux §5.4).
 * @param {string} a @param {string} b @returns {{ a: WordSeg[]; b: WordSeg[] } | null}
 */
export function wordDiff(a, b, maxChars = 500) {
  if (a.length >= maxChars || b.length >= maxChars) return null;
  const tok = (/** @type {string} */ s) => s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
  const A = tok(a), B = tok(b);
  /** @type {WordSeg[]} */ const ra = [];
  /** @type {WordSeg[]} */ const rb = [];
  const push = (/** @type {WordSeg[]} */ arr, /** @type {string} */ text, /** @type {boolean} */ changed) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text; else arr.push({ text, changed });
  };
  for (const [op, i] of lcs(A, B, (x, y) => x === y)) {
    if (op === ' ') { push(ra, A[i] ?? '', false); push(rb, A[i] ?? '', false); }
    else if (op === '-') push(ra, A[i] ?? '', true);
    else push(rb, B[i] ?? '', true);
  }
  return { a: ra, b: rb };
}

/** Pair consecutive '-' runs with the '+' run that follows (for word highlight and side-by-side).
 * @param {DiffRow[]} rows @returns {Map<number, number>} index of a '-' row → index of its paired '+' row */
export function pairRows(rows) {
  /** @type {Map<number, number>} */
  const pairs = new Map();
  let k = 0;
  while (k < rows.length) {
    if (rows[k]?.op !== '-') { k++; continue; }
    const ds = k; while (k < rows.length && rows[k]?.op === '-') k++;
    const as = k; while (k < rows.length && rows[k]?.op === '+') k++;
    for (let x = 0; x < Math.min(as - ds, k - as); x++) pairs.set(ds + x, as + x);
  }
  return pairs;
}
