// @ts-check
// src/web/lib/stream-md.js — streaming markdown (ux §12.2): the text up to the last blank line OUTSIDE an open code
// fence is "settled" (parsed once by lib/md.js, the only HTML sink, then frozen); the rest is the "tail", re-parsed at
// most every 100 ms, or shown as plain text in a <pre> while it sits inside an open fence.
// Pure module (no DOM): the fence state is tracked incrementally, so each delta only scans the new complete lines.

/** @typedef {{ inFence: boolean; fenceChar: string; fenceLen: number; fenceLang: string }} FenceState */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Advance a fence state over one line (without its newline). Mutates and returns `st`.
 * @param {FenceState} st @param {string} line */
export function fenceStep(st, line) {
  const m = FENCE_RE.exec(line);
  if (!m) return st;
  const run = /** @type {string} */ (m[1]), rest = /** @type {string} */ (m[2]);
  if (!st.inFence) {
    if (run[0] === '`' && rest.includes('`')) return st;      // not a fence: backticks in the info string
    st.inFence = true; st.fenceChar = run[0] ?? '`'; st.fenceLen = run.length; st.fenceLang = rest.trim().split(/\s+/)[0] ?? '';
  } else if (run[0] === st.fenceChar && run.length >= st.fenceLen && rest.trim() === '') {
    st.inFence = false; st.fenceChar = ''; st.fenceLen = 0; st.fenceLang = '';
  }
  return st;
}

/** @returns {FenceState} */
export const newFenceState = () => ({ inFence: false, fenceChar: '', fenceLen: 0, fenceLang: '' });

/** One-shot split (tests, non-incremental callers).
 * @param {string} md @returns {{ settled: string; tail: string }} */
export function splitSettled(md) {
  const s = createSplitter();
  const r = s.push(md);
  return { settled: md.slice(0, r.settledEnd), tail: r.tail };
}

/**
 * Incremental splitter for one live text block. `push(full)` takes the WHOLE text so far (append-only deltas) and
 * returns the newly settled chunk (to parse once), the current tail and whether the tail is inside an open fence.
 * If the text is not an extension of what was seen (block replaced), the splitter starts over (`reset: true`).
 */
export function createSplitter() {
  let seen = '';          // text already scanned up to `scanPos`
  let scanPos = 0;        // start of the first line not yet scanned (always at a line start)
  let settledEnd = 0;     // end of the settled prefix (just after a blank line outside a fence)
  let st = newFenceState();  // fence state at scanPos (closed at settledEnd, by construction)
  return {
    /** @param {string} full */
    push(full) {
      let reset = false;
      if (!full.startsWith(seen.slice(0, scanPos))) {
        scanPos = 0; settledEnd = 0; st = newFenceState(); reset = true;
      }
      seen = full;
      const before = settledEnd;
      let i = scanPos;
      for (;;) {
        const nl = full.indexOf('\n', i);
        if (nl < 0) break;
        const line = full.slice(i, nl).replace(/\r$/, '');
        const wasIn = st.inFence;
        fenceStep(st, line);
        if (!wasIn && !st.inFence && line.trim() === '') settledEnd = nl + 1;
        i = nl + 1;
      }
      scanPos = i;
      // The fence state of the tail includes its last, incomplete line (an opening ``` being typed counts).
      const tailState = { ...st };
      const partial = full.slice(scanPos);
      if (partial) fenceStep(tailState, partial.replace(/\r$/, ''));
      return {
        reset,
        chunk: full.slice(before, settledEnd),   // '' when nothing new settled
        settledEnd,
        tail: full.slice(settledEnd),
        inFence: st.inFence || tailState.inFence,
        fenceLang: st.inFence ? st.fenceLang : tailState.fenceLang,
      };
    },
  };
}

/**
 * Plain-text view of a tail that is inside an open fence: the text before the fence (markdown, may be empty) and the
 * code typed so far (shown with textContent in a <pre>, never parsed).
 * @param {string} tail @returns {{ before: string; code: string; lang: string }}
 */
export function splitOpenFence(tail) {
  const lines = tail.split('\n');
  const st = newFenceState();
  let openAt = -1, lang = '';
  for (let k = 0; k < lines.length; k++) {
    const was = st.inFence;
    fenceStep(st, (lines[k] ?? '').replace(/\r$/, ''));
    if (!was && st.inFence) { openAt = k; lang = st.fenceLang; }
  }
  if (!st.inFence || openAt < 0) return { before: tail, code: '', lang: '' };
  return { before: lines.slice(0, openAt).join('\n'), code: lines.slice(openAt + 1).join('\n'), lang };
}
