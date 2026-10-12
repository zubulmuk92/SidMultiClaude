// @ts-check
// src/web/lib/fuzzy.js — accent- and case-insensitive fuzzy matcher for the quick switcher, the sidebar filter and the
// resume browser (« demarrage » and « reparer » must both find « Réparer le démarrage Edge »).
// About 60 lines instead of a dependency. Each space-separated query token must match (any order); within a token the
// characters must appear in order. Score: contiguous runs and word starts score higher; shorter texts win ties.

/** @type {Map<string, string>} */
const foldCache = new Map();
/** Lower case, accents stripped (NFD + combining marks removed), œ/æ expanded. @param {string} s @returns {string} */
export function fold(s) {
  let r = foldCache.get(s);
  if (r !== undefined) return r;
  r = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae');
  if (foldCache.size > 20_000) foldCache.clear();
  foldCache.set(s, r);
  return r;
}

const isWordStart = (/** @type {string} */ t, /** @type {number} */ i) => i === 0 || /[\s\\/._\-:·«»"'()[\]]/.test(t[i - 1] ?? ' ');

/** Score of one folded token against folded text, or null. @param {string} q @param {string} t @returns {number | null} */
function tokenScore(q, t) {
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return 100 + q.length * 10 + (isWordStart(t, direct) ? 50 : 0) - Math.min(direct, 40);
  let score = 0, ti = 0, run = 0, first = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) if (t[j] === c) { found = j; break; }
    if (found < 0) return null;
    if (first < 0) first = found;
    run = found === ti && qi > 0 ? run + 1 : 0;
    score += 1 + run * 3 + (isWordStart(t, found) ? 6 : 0);
    ti = found + 1;
  }
  return score - Math.min(first, 20) * 0.5;
}

/** @param {string} query @param {string} text @returns {number | null} score, null when no match */
export function fuzzyScore(query, text) {
  return scoreFolded(queryTokens(query), fold(text));
}
/** Folded tokens of a query (compute once per keystroke, then scoreFolded per item). @param {string} query @returns {string[]} */
export function queryTokens(query) { return fold(query).split(/\s+/).filter(Boolean); }
/** Same score as fuzzyScore, for an already folded text. @param {string[]} tokens @param {string} t @returns {number | null} */
export function scoreFolded(tokens, t) {
  if (!tokens.length) return 0;
  let total = 0;
  for (const tok of tokens) {
    const s = tokenScore(tok, t);
    if (s === null) return null;
    total += s;
  }
  return total - t.length * 0.01;
}

/**
 * Filters and ranks items (stable for equal scores). `keys` gives the searchable strings of an item; the best key wins.
 * @template T @param {T[]} items @param {string} query @param {(it: T) => string[]} keys @param {number} [limit]
 * @returns {{ item: T; score: number }[]}
 */
export function fuzzyFilter(items, query, keys, limit = Infinity) {
  if (!query.trim()) return items.slice(0, limit === Infinity ? items.length : limit).map((item) => ({ item, score: 0 }));
  /** @type {{ item: T; score: number; i: number }[]} */
  const out = [];
  items.forEach((item, i) => {
    let best = null;
    for (const k of keys(item)) {
      if (!k) continue;
      const s = fuzzyScore(query, k);
      if (s !== null && (best === null || s > best)) best = s;
    }
    // multi-token queries may spread over several keys (« pro fix » = account + title)
    if (best === null) best = fuzzyScore(query, keys(item).join(' \u0001 '));
    if (best !== null) out.push({ item, score: best, i });
  });
  out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out.slice(0, limit).map(({ item, score }) => ({ item, score }));
}
