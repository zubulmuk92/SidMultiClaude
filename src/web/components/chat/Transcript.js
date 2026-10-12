// @ts-check
// src/web/components/chat/Transcript.js — the scroller (ux §5, §12.3; SPEC §9.5): role=log, one memoised Turn per turn
// signal (a delta re-renders one block, never this list). Mount window: at most 150 turns AND about 3,200 elements
// (≤ 4,000 nodes per pane): it adapts to the measured elements per turn, the turns outside it become measured spacers
// above and below, and it follows the scroll position (scrollbar jumps included). Paging (top sentinel) and every window
// move keep the first visible turn in place; the browser's scroll anchoring absorbs content-visibility size changes.
// Stick to the bottom within 48 px (never while selecting or scrolling), « ↓ Nouveaux messages (n) » pill, scroll
// position kept per chat across tab switches, Ctrl+F through tx.search (store, not DOM).
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from './text.js';
import { act, chatUi, getEnv, useChatVM, viewModeOf } from './env.js';
import { LIMITS, UI } from './consts.js';
import { mountWindow, nearBottom } from './model.js';
import { Turn } from './Turn.js';
import { Icon } from '../../lib/icons.js';

/** @typedef {import('../../../shared/protocol.ts').SearchHit} SearchHit */
/** @typedef {{ id: string; offset: number; first: string | null; win: string; at: number; force?: boolean }} Restore */

/** Scroller element and « go to the bottom » of each mounted chat (message navigation, Ctrl+Fin). */
const scrollers = /** @type {Map<string, { el: HTMLElement; bottom: () => void }>} */ (new Map());
/** Scroll position of each chat while its pane is unmounted (tab switch): first visible turn + offset; null = bottom. */
const memory = /** @type {Map<string, { turnId: string; offset: number } | null>} */ (new Map());
/** Persisted copy of `memory` (UiState.scroll, through actions.saveScroll), written 1 s after the last move. */
const saveTimers = /** @type {Map<string, ReturnType<typeof setTimeout>>} */ (new Map());
const SCROLL_SAVE_MS = 1000;
/** @param {string} chatId @param {{ turnId: string; offset: number } | null} v */
function remember(chatId, v) {
  const prev = memory.get(chatId);
  memory.set(chatId, v);
  if (prev !== undefined && (prev === v || (prev && v && prev.turnId === v.turnId && Math.abs(prev.offset - v.offset) < 1))) return;
  const old = saveTimers.get(chatId);
  if (old) clearTimeout(old);
  saveTimers.set(chatId, setTimeout(() => { saveTimers.delete(chatId); try { act().saveScroll(chatId, memory.get(chatId) ?? null); } catch { /* never */ } }, SCROLL_SAVE_MS));
}
/** Keys that scroll the log: a scroll the user is making is never overridden by stick-to-bottom. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ']);

/** Alt+↑ / Alt+↓: previous / next user message of the chat's transcript. @param {string} chatId @param {1 | -1} dir */
export function navigateMessage(chatId, dir) {
  const sc = scrollers.get(chatId)?.el;
  if (!sc) return;
  const heads = [.../** @type {NodeListOf<HTMLElement>} */ (sc.querySelectorAll('.c-turn .c-user-head'))];
  const top = sc.getBoundingClientRect().top + 8;
  const pos = heads.map((h) => h.getBoundingClientRect().top - top);
  const k = dir < 0 ? pos.map((p, i) => [p, i]).filter(([p]) => (p ?? 0) < -4).pop()?.[1] : pos.findIndex((p) => p > 4);
  if (k !== undefined && k >= 0) heads[k]?.scrollIntoView({ block: 'start' });
}
/** Ctrl+Fin: mounts the last turns and sticks to the bottom. @param {string} chatId */
export function scrollToBottom(chatId) { scrollers.get(chatId)?.bottom(); }

/** First (at least partly) visible mounted turn of a scroller: its id and its offset from the scroller's top.
 * @param {HTMLElement} el @returns {{ id: string; offset: number } | null} */
function firstVisible(el) {
  const box = el.getBoundingClientRect();
  for (const n of el.querySelectorAll('.t-turns > [data-turn]')) {
    const r = n.getBoundingClientRect();
    if (r.bottom > box.top + 1) return r.top < box.bottom ? { id: n.getAttribute('data-turn') ?? '', offset: r.top - box.top } : null;
  }
  return null;
}

/** @param {{ chatId: string }} p */
export function Transcript({ chatId }) {
  const vm = useChatVM(chatId);
  const u = chatUi(chatId);
  const view = viewModeOf(chatId).value;
  const turns = vm.turns.value;
  const [anchorId, setAnchorId] = useState(/** @returns {string | null} */ () => {     // a remembered position far up
    const m = memory.get(chatId), all = vm.turns.value;
    const i = m ? all.findIndex((x) => x.id === m.turnId) : -1;
    return m && i >= 0 && i < all.length - LIMITS.MOUNTED_TURNS_MAX ? m.turnId : null;
  });
  const [maxTurns, setMaxTurns] = useState(/** @type {number} */ (LIMITS.MOUNTED_TURNS_MAX));
  const [unseen, setUnseen] = useState(0);
  const [hit, setHit] = useState(/** @type {string | null} */ (null));
  const sc = useRef(/** @type {HTMLDivElement | null} */ (null));
  const inner = useRef(/** @type {HTMLDivElement | null} */ (null));
  const top = useRef(/** @type {HTMLDivElement | null} */ (null));
  const st = useRef({ stick: true, userScrollAt: 0, heights: /** @type {Map<string, number>} */ (new Map()), lastId: /** @type {string | null} */ (null),
    restore: /** @type {Restore & { kind: 'mount' | 'older' | 'win' } | null} */ (null), raf: 0, toTail: false, gap: 16, above: 0,
    win: { start: 0, end: 0 }, anchorId: /** @type {string | null} */ (null), maxTurns: 0,
    // after a reload: the persisted position (UiState.scroll), applied once its turn is loaded unless the user scrolls first
    saved: /** @type {{ turnId: string; offset: number } | null} */ (memory.has(chatId) ? null : getEnv().savedScroll(chatId) ?? null), mountedAt: Date.now() });
  const ai = anchorId === null ? -1 : turns.findIndex((x) => x.id === anchorId);
  const win = mountWindow(turns.length, maxTurns, ai >= 0 ? ai : null);
  const est = (/** @type {string} */ id) => st.current.heights.get(id) ?? UI.EST_TURN_PX + st.current.gap;
  let above = 0, below = 0;
  for (let k = 0; k < win.start; k++) above += est(turns[k]?.id ?? '');
  for (let k = win.end; k < turns.length; k++) below += est(turns[k]?.id ?? '');
  const winKey = `${win.start}:${win.end}`;
  Object.assign(st.current, { win, above, anchorId, maxTurns });

  const toBottom = () => { const el = sc.current; if (el) el.scrollTop = el.scrollHeight; };
  const selecting = () => { const s = window.getSelection(); return !!s && !s.isCollapsed && !!sc.current?.contains(s.anchorNode); };
  /** The next layout keeps the first visible turn where it is. @param {'older' | 'win'} kind */
  const keepVisible = (kind) => {
    const el = sc.current, v = el ? firstVisible(el) : null;
    st.current.restore = v ? { kind, id: v.id, offset: v.offset, first: vm.turns.value[0]?.id ?? null, win: `${st.current.win.start}:${st.current.win.end}`, at: Date.now() } : null;
  };
  const loadOlder = () => {
    if (!vm.hasMore.value || vm.loading.value) return;
    keepVisible('older');
    void act().loadOlder(chatId).catch(() => {});
  };
  /** Moves the mount window so that turn `i` is mounted (the tail when it is among the last turns). @param {number} i @param {boolean} atEnd */
  const shiftTo = (i, atEnd) => {
    const s = st.current, all = vm.turns.value;
    const next = i >= all.length - s.maxTurns ? null : all[Math.max(0, i)]?.id ?? null;
    if (next === s.anchorId) return;
    keepVisible('win');
    if (next === null && atEnd) { s.stick = true; s.toTail = true; }
    setAnchorId(next);
  };
  /** After a scroll (one per frame): remember the position, page older turns in, move the window if needed. */
  const checkWindow = () => {
    const s = st.current;
    s.raf = 0;
    const el = sc.current, inn = inner.current;
    if (!el || !inn) return;
    const all = vm.turns.value, w = s.win;
    if (w.start === 0 && el.scrollTop < 200) loadOlder();
    if (s.stick) { remember(chatId, null); return; }  // stuck to the tail (streaming scrolls every frame): nothing more
    const v = firstVisible(el);
    remember(chatId, v ? { turnId: v.id, offset: v.offset } : null);
    if (all.length <= w.end - w.start) return;
    let i = v ? all.findIndex((x) => x.id === v.id) : -1;
    if (i < 0) {                       // the viewport is inside a spacer (scrollbar jump): find the turn there by height
      const top0 = el.getBoundingClientRect().top;
      let y = inn.getBoundingClientRect().top - s.above;
      i = 0;
      while (i < all.length - 1 && y + est(all[i]?.id ?? '') <= top0) { y += est(all[i]?.id ?? ''); i++; }
    }
    const edge = (w.start > 0 && i - w.start < UI.WINDOW_EDGE_TOP) || (w.end < all.length && w.end - 1 - i < UI.WINDOW_EDGE_BOTTOM);
    if (i < w.start || i >= w.end || edge) shiftTo(i, nearBottom(el, LIMITS.STICK_TO_BOTTOM_PX));
  };
  const goBottom = () => {
    const s = st.current;
    s.stick = true; s.toTail = true; s.restore = null;
    setUnseen(0);
    if (s.anchorId !== null) setAnchorId(null); else requestAnimationFrame(toBottom);
  };
  const api = useRef({ goBottom, loadOlder });
  api.current = { goBottom, loadOlder };

  useEffect(() => {
    const el = sc.current, s = st.current;
    if (!el) return undefined;
    scrollers.set(chatId, { el, bottom: () => api.current.goBottom() });
    // streaming grows blocks without re-rendering this list: follow size changes while stuck to the bottom
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (s.stick && !selecting() && Date.now() - s.userScrollAt > 150) toBottom();
    });
    if (inner.current) ro?.observe(inner.current);
    ro?.observe(el);
    // paging: when the oldest loaded turns are mounted and come near the top, load 20 more (anchor kept)
    const io = typeof IntersectionObserver === 'undefined' || !top.current ? null : new IntersectionObserver((ents) => {
      if (ents.some((e) => e.isIntersecting) && s.win.start === 0) api.current.loadOlder();
    }, { root: el, rootMargin: '200px 0px 0px 0px' });
    if (top.current) io?.observe(top.current);
    return () => {
      ro?.disconnect(); io?.disconnect(); scrollers.delete(chatId);
      if (s.raf) cancelAnimationFrame(s.raf);
    };
  }, []);
  useLayoutEffect(() => {                  // mount: back to this chat's remembered position (tab switch), else the bottom
    const m = memory.get(chatId), el = sc.current, s = st.current;
    if (m && vm.turns.value.some((x) => x.id === m.turnId)) {
      s.stick = false;
      s.restore = { kind: 'mount', id: m.turnId, offset: m.offset, first: null, win: '', at: Date.now() };
    }
    return () => {                        // a layout cleanup runs while the DOM is still attached (passive ones run later)
      const v = el ? firstVisible(el) : null;
      remember(chatId, s.saved ?? (s.stick || !v ? null : { turnId: v.id, offset: v.offset }));   // a pending reload position is kept
    };
  }, []);
  useLayoutEffect(() => {
    const s = st.current, el = sc.current, inn = inner.current;
    if (!el || !inn) return;
    const nodes = /** @type {HTMLElement[]} */ ([...inn.querySelectorAll(':scope > [data-turn]')]);
    if (nodes[0]) s.gap = parseFloat(getComputedStyle(nodes[0]).marginBottom) || 0;
    nodes.forEach((n, k) => { const nx = nodes[k + 1]; s.heights.set(n.getAttribute('data-turn') ?? '', nx ? nx.offsetTop - n.offsetTop : n.offsetHeight + s.gap); });
    const first = turns[0]?.id ?? null, last = turns[turns.length - 1]?.id ?? null;
    if (s.saved && !s.restore) {           // reload: back to the persisted position once its turn is there
      const sv = s.saved, i = turns.findIndex((x) => x.id === sv.turnId);
      if (s.userScrollAt > s.mountedAt) s.saved = null;
      else if (i >= 0 && (i < win.start || i >= win.end)) { if (i < turns.length - maxTurns) setAnchorId(sv.turnId); else s.saved = null; }
      else if (i >= 0) {
        s.saved = null; s.stick = false;
        s.restore = { kind: 'mount', id: sv.turnId, offset: sv.offset, first: null, win: '', at: Date.now() };
      } else if (turns.length && !vm.loading.value && !vm.hasMore.value) s.saved = null;
      else if (turns.length && !vm.loading.value && Date.now() - s.mountedAt > 5000) s.saved = null;
    }
    const r = s.restore;
    if (r && r.kind === 'win' && r.win === winKey) s.restore = null;    // the move did not change the window: nothing to keep
    else if (r && (r.kind === 'mount' || (r.kind === 'older' ? r.first !== first : r.win !== winKey))) {
      const put = () => {
        const n = el.querySelector(`.t-turns > [data-turn="${CSS.escape(r.id)}"]`);
        if (n) el.scrollTop += n.getBoundingClientRect().top - el.getBoundingClientRect().top - r.offset;
      };
      put();
      s.restore = null;
      // a fresh mount sizes every turn at its contain-intrinsic-size until content-visibility paints the visible ones:
      // put the remembered turn back once they are painted, unless the user scrolls first
      if (r.kind === 'mount') requestAnimationFrame(() => requestAnimationFrame(() => { if (s.userScrollAt < r.at) put(); }));
    } else if (r && Date.now() - r.at > 5000) s.restore = null;
    if (last !== s.lastId || s.toTail) {
      if ((s.stick || s.toTail) && !selecting()) toBottom();
      else if (s.lastId !== null) {
        const i = turns.findIndex((x) => x.id === s.lastId);
        if (i >= 0 && i < turns.length - 1) setUnseen((n) => n + turns.length - 1 - i);
      }
    }
    s.toTail = false;
    s.lastId = last;
    // SPEC §9.5: ≤ 4,000 nodes per pane. Measure the elements per mounted turn and size the window to the budget.
    const mounted = win.end - win.start;
    if (mounted >= UI.MIN_MOUNTED_TURNS) {
      const per = inn.getElementsByTagName('*').length / mounted;
      const m = Math.max(UI.MIN_MOUNTED_TURNS, Math.min(LIMITS.MOUNTED_TURNS_MAX, Math.floor(UI.TRANSCRIPT_NODE_BUDGET / Math.max(1, per))));
      if (m < maxTurns - 2 || m > maxTurns + 10) {
        const v = firstVisible(el), i = v ? turns.findIndex((x) => x.id === v.id) : -1;
        if (!s.stick) keepVisible('win');
        if (anchorId !== null && i >= 0) setAnchorId(i >= turns.length - m ? null : v?.id ?? null);
        setMaxTurns(m);
      }
    }
  }, [turns, view, anchorId, maxTurns]);

  const onScroll = () => {
    const el = sc.current, s = st.current;
    if (!el) return;
    s.stick = s.win.end >= vm.turns.value.length && nearBottom(el, LIMITS.STICK_TO_BOTTOM_PX);
    if (s.stick) setUnseen(0);
    if (!s.raf) s.raf = requestAnimationFrame(checkWindow);
  };
  const userScroll = () => { st.current.userScrollAt = Date.now(); };
  /** @param {SearchHit} h */
  const goHit = async (h) => {
    for (let k = 0; k < 40 && !vm.turns.value.some((x) => x.id === h.turnId) && vm.hasMore.value; k++) await act().loadOlder(chatId).catch(() => {});
    const all = vm.turns.value, i = all.findIndex((x) => x.id === h.turnId);
    if (i < 0) return;
    const s = st.current;
    s.stick = false; s.restore = null;
    setAnchorId(i >= all.length - s.maxTurns ? null : h.turnId);
    setHit(h.blockId ?? h.turnId);
    requestAnimationFrame(() => sc.current?.querySelector(`[data-block="${CSS.escape(h.blockId ?? '')}"], [data-turn="${CSS.escape(h.turnId)}"]`)?.scrollIntoView({ block: 'center' }));
  };
  const summary = vm.summary.value;
  return html`<div class="t-wrap">
    ${u.search.value ? html`<${SearchBar} chatId=${chatId} onHit=${goHit} onClose=${() => { u.search.value = false; setHit(null); }} />` : null}
    <div ref=${sc} class="t-scroll" role="log" aria-live="off" aria-label=${t('chat.region', { titre: summary.title, compte: summary.accountId })}
        tabindex="0" onScroll=${onScroll} onWheel=${userScroll} onPointerDown=${userScroll} onTouchStart=${userScroll}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (SCROLL_KEYS.has(e.key)) userScroll(); }}>
      <div ref=${top} class="t-sentinel" aria-hidden="true"></div>
      ${vm.loading.value ? html`<div class="t-loading">${t('chat.loading')}</div>` : null}
      ${vm.hasMore.value && !vm.loading.value && win.start === 0 ? html`<button type="button" class="c-link t-older" onClick=${loadOlder}>${t('chat.loadOlder')}</button>` : null}
      ${above ? html`<div class="t-spacer" style=${{ height: `${above}px` }}></div>` : null}
      <div ref=${inner} class="t-turns">
        ${turns.slice(win.start, win.end).map((x) => html`<${Turn} key=${x.id} chatId=${chatId} sig=${x.sig} view=${view} hit=${hit} />`)}
        ${!turns.length && !vm.loading.value ? html`<p class="t-empty">${t('chat.empty')}</p>` : null}
      </div>
      ${below ? html`<div class="t-spacer t-spacer-end" style=${{ height: `${below}px` }}></div>` : null}
    </div>
    ${unseen ? html`<button type="button" class="t-pill" onClick=${goBottom}><${Icon} n="arrow-down" size=${14} /> ${t('sys.newMessages', { n: unseen })}</button>` : null}
  </div>`;
}

/** Ctrl+F bar: searches the transcript through tx.search, Entrée / Maj+Entrée walk the hits, Échap closes.
 * @param {{ chatId: string; onHit: (h: SearchHit) => void; onClose: () => void }} p */
function SearchBar({ chatId, onHit, onClose }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(/** @type {SearchHit[] | null} */ (null));
  const [i, setI] = useState(0);
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  useEffect(() => { input.current?.focus(); }, []);
  const run = async () => {
    const h = q.trim() ? await getEnv().actions.search(chatId, q.trim()).catch(() => []) : [];
    setHits(h); setI(0);
    if (h[0]) onHit(h[0]);
  };
  /** @param {KeyboardEvent} e */
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!hits || !hits.length) { void run(); return; }
    const n = (i + (e.shiftKey ? -1 : 1) + hits.length) % hits.length;
    setI(n); const h = hits[n]; if (h) onHit(h);
  };
  return html`<div class="t-search" role="search">
    <input ref=${input} type="search" placeholder=${t('chat.search.placeholder')} aria-label=${t('chat.search.placeholder')} value=${q}
      onInput=${(/** @type {any} */ e) => { setQ(e.currentTarget.value); setHits(null); }} onKeyDown=${key} />
    <span class="t-search-n" role="status">${hits ? (hits.length ? t('chat.search.count', { i: i + 1, n: hits.length }) : t('chat.search.none')) : ''}</span>
    <button type="button" class="c-icon" aria-label=${t('chat.search.close')} onClick=${onClose}><${Icon} n="x" /></button>
  </div>`;
}
