// Transcript in Edge (WP-F acceptance 5, SPEC §9.5): paging keeps the first visible turn in place (top sentinel and
// « Charger les messages précédents »), no false « Nouveaux messages » pill for older turns; the mount window follows
// the scroll (spacer jumps, moves without a jump, back to the tail); content-visibility corrections never move the view;
// ≤ 4,000 elements per pane; the position survives a tab switch; Ctrl+F goes through tx.search to the hit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bind, useHarness } from './_browser.ts';
// Callbacks passed to page.evaluate() run in the browser; this file is compiled without the DOM lib (module-local names).
declare const document: any, window: any, requestAnimationFrame: any;

const ctx = useHarness({ width: 1100, height: 900 });
const { apply, calls, clear, panes, skip } = bind(ctx);
const page = () => ctx.page;
const id = (n: number) => `perso:${String(n).padStart(8, '0')}-3333-4444-8555-666666666666`;
let seq = 1;
const para = (n: number) => Array.from({ length: n }, (_, i) => `Paragraphe ${i} avec un peu de texte pour remplir la ligne.`).join('\n\n');
const turnOf = (p: string, i: number, paras: number) => ({ id: `u:${p}${i}`, at: 1, user: { uuid: `${p}${i}`, text: `message ${i}`, origin: 'human' },
  blocks: [{ k: 'text', id: `a:${p}${i}:0`, md: para(paras) }] });
/** turn.start + block frames for turns from..to-1 of a chat. */
function frames(c: string, p: string, from: number, to: number, paras: number): unknown[] {
  const out: unknown[] = [];
  for (let i = from; i < to; i++) {
    const tr = turnOf(p, i, paras);
    out.push({ t: 'ev', c, s: seq++, ev: { k: 'turn.start', turn: { id: tr.id, at: 1, user: tr.user } } });
    out.push({ t: 'ev', c, s: seq++, ev: { k: 'block', turnId: tr.id, block: tr.blocks[0] } });
  }
  return out;
}
/** In the page: the first visible turn of the pane's scroller and its offset from the scroller's top. */
const firstVis = (c: string) => page().evaluate((x) => {
  const el = document.querySelector(`.c-pane[data-chat="${x}"] .t-scroll`);
  const box = el.getBoundingClientRect();
  for (const n of el.querySelectorAll('.t-turns > [data-turn]')) {
    const r = n.getBoundingClientRect();
    if (r.bottom > box.top + 1 && r.top < box.bottom) return { id: n.getAttribute('data-turn'), offset: Math.round(r.top - box.top) };
  }
  return null;
}, c);
/** Offset of a mounted turn from the top of its pane's scroller (null when not mounted). */
const offsetOf = (c: string, turnId: string) => page().evaluate(([x, tid]) => {
  const el = document.querySelector(`.c-pane[data-chat="${x}"] .t-scroll`), n = el.querySelector(`[data-turn="${tid}"]`);
  return n ? Math.round(n.getBoundingClientRect().top - el.getBoundingClientRect().top) : null;
}, [c, turnId] as const);
const settle = () => page().evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
/** Scrolls the pane's log to `to` px ('end' = the bottom) or by `by` px, then lets the layout settle. */
const scroll = async (c: string, o: { to?: number | 'end'; by?: number }) => {
  await page().evaluate(([x, to, by]) => {
    const el = document.querySelector(`.c-pane[data-chat="${x}"] .t-scroll`);
    el.scrollTop = to === 'end' ? el.scrollHeight : typeof to === 'number' ? to : el.scrollTop + (by ?? 0);
  }, [c, o.to ?? null, o.by ?? null] as const);
  await settle();
};

test('paging: older turns load at the top, the first visible turn stays put, and they never raise the pill', async (t) => {
  if (skip(t)) return;
  const A = id(1);
  await clear();
  await panes([A]);
  await apply(frames(A, 'p', 40, 70, 4));
  await page().evaluate(([c, pages]) => (window as any).__h.setOlder(c, pages),
    [A, [Array.from({ length: 20 }, (_, k) => turnOf('p', 20 + k, 4)), Array.from({ length: 20 }, (_, k) => turnOf('p', k, 4))]] as const);
  await settle();
  await scroll(A, { to: 0 });                                    // the top sentinel / scroll position pages one page in
  const top40 = await offsetOf(A, 'u:p40');
  await page().waitForSelector(`.c-pane[data-chat="${A}"] [data-turn="u:p20"]`);
  await settle();
  assert.equal(await offsetOf(A, 'u:p40'), top40, 'the turn that was at the top did not move');
  assert.equal(await page().locator('.t-pill').count(), 0);
  assert.equal((await calls('loadOlder')).length, 1);
  // « Charger les messages précédents » clicked while reading further down: same anchor rule, no pill
  await scroll(A, { by: 300 });
  const before = await firstVis(A);
  await page().evaluate((x) => document.querySelector(`.c-pane[data-chat="${x}"] .t-older`).click(), A);
  await page().waitForSelector(`.c-pane[data-chat="${A}"] [data-turn="u:p0"]`);
  await settle();
  assert.deepEqual(await firstVis(A), before);
  assert.equal(await page().locator('.t-pill').count(), 0);
});

/** In the page: scroll the pane's log `steps` times by `by` px; for each step, how far the content under the middle of
 * the viewport moved compared with the distance actually scrolled (0 = no jump). Stops at either end. */
const drifts = (c: string, by: number, steps: number) => page().evaluate(async ([x, step, n]) => {
  const el = document.querySelector(`.c-pane[data-chat="${x}"] .t-scroll`);
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out: number[] = [];
  let moves = 0, first = el.querySelector('.t-turns > [data-turn]')?.getAttribute('data-turn');
  for (let k = 0; k < n; k++) {
    const box = el.getBoundingClientRect();
    const ref = document.elementFromPoint(box.left + 40, box.top + box.height / 2)?.closest('[data-turn]');
    const y0 = ref?.getBoundingClientRect().top ?? 0, s0 = el.scrollTop;
    el.scrollTop = s0 + step;
    const d = el.scrollTop - s0;
    if (!d) break;
    await raf();
    if (ref?.isConnected) out.push(Math.round(ref.getBoundingClientRect().top - y0 + d));
    const f = el.querySelector('.t-turns > [data-turn]')?.getAttribute('data-turn');
    if (f !== first) { moves++; first = f; }
  }
  return { out, moves };
}, [c, by, steps] as const);
const paneState = (c: string) => page().evaluate((x) => {
  const p = document.querySelector(`.c-pane[data-chat="${x}"]`), ts = [...p.querySelectorAll('.t-turns > [data-turn]')];
  return { mounted: ts.length, first: ts[0]?.getAttribute('data-turn'), last: ts.at(-1)?.getAttribute('data-turn'),
    endSpacer: !!p.querySelector('.t-spacer-end'), elements: p.querySelectorAll('*').length };
}, c);

test('mount window: a jump into the spacer mounts the turns there; scrolling down moves it without a jump, back to the tail', async (t) => {
  if (skip(t)) return;
  const B = id(2);
  await panes([B]);
  await apply(frames(B, 'b', 0, 200, 1));
  await settle();
  const tail = await paneState(B);
  assert.ok(tail.mounted <= 150 && tail.first !== 'u:b0' && tail.last === 'u:b199' && !tail.endSpacer, JSON.stringify(tail));
  await scroll(B, { to: 0 });
  assert.equal((await firstVis(B))?.id, 'u:b0', 'the turns under a spacer are mounted when the user jumps there');
  assert.ok((await paneState(B)).endSpacer);
  const r = await drifts(B, 600, 200);
  assert.ok(r.out.every((d) => Math.abs(d) <= 2), `jumps while scrolling down: ${r.out.join(',')}`);
  assert.ok(r.moves >= 1, 'the window moved');
  const end = await paneState(B);
  assert.ok(end.last === 'u:b199' && !end.endSpacer, JSON.stringify(end));
  await apply(frames(B, 'b', 200, 201, 1));                         // back at the tail: stuck to the bottom again
  await settle();
  assert.equal(await page().locator(`.c-pane[data-chat="${B}"] .t-pill`).count(), 0);
  assert.ok(await page().evaluate((x) => { const el = document.querySelector(`.c-pane[data-chat="${x}"] .t-scroll`); return el.scrollHeight - el.scrollTop - el.clientHeight <= 48; }, B));
});

test('content-visibility: scrolling up through turns never painted does not move the view (scroll anchoring)', async (t) => {
  if (skip(t)) return;
  const D = id(3);
  await panes([D]);
  await apply(frames(D, 'd', 0, 40, 30));
  await scroll(D, { to: 'end' });
  await page().waitForTimeout(150);
  const r = await drifts(D, -200, 25);
  assert.ok(r.out.length >= 20 && r.out.every((d) => Math.abs(d) <= 2), `jumps while scrolling up: ${r.out.join(',')}`);
});

test('DOM budget: a long, realistic transcript keeps the pane under 4,000 elements (≤ 150 mounted turns)', async (t) => {
  if (skip(t)) return;
  const R = id(7);
  await panes([R]);
  const md = 'Voici **le plan** :\n\n- un\n- deux\n- trois\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\nEt une conclusion.';
  const tool = (tid: string, name: string) => ({ k: 'tool', id: `t:${tid}`, toolUseId: tid, name, status: 'ok', result: { isError: false, summary: 'ok', head: 'ok' },
    input: { summary: 'x', fields: name === 'Bash' ? { command: 'npm test', description: 'Tests' } : { file_path: 'C:\\w\\src\\a.ts' } } });
  const f: unknown[] = [];
  const ev = (e: unknown) => f.push({ t: 'ev', c: R, s: seq++, ev: e });
  for (let i = 0; i < 160; i++) {
    ev({ k: 'turn.start', turn: { id: `u:r${i}`, at: 1, user: { uuid: `r${i}`, text: `message ${i}`, origin: 'human' } } });
    ev({ k: 'block', turnId: `u:r${i}`, block: { k: 'thinking', id: `a:rt${i}:0`, chars: 300, tokens: 80 } });
    for (const [k, n] of [['r', 'Read'], ['g', 'Grep'], ['b', 'Bash']] as const) ev({ k: 'block', turnId: `u:r${i}`, block: tool(`${k}${i}`, n) });
    ev({ k: 'block', turnId: `u:r${i}`, block: { k: 'text', id: `a:r${i}:1`, md } });
    ev({ k: 'turn.end', turnId: `u:r${i}`, footer: { durationMs: 1000, input: 10, cacheRead: 100, cacheWrite: 0, output: 50, models: ['x'] } });
  }
  await apply(f);
  await settle(); await settle();
  const s = await paneState(R);
  assert.ok(s.elements <= 4000 && s.mounted <= 150 && s.mounted >= 20 && s.last === 'u:r159', JSON.stringify(s));
});

test('a tab switch keeps the scroll position of the chat', async (t) => {
  if (skip(t)) return;
  const E = id(4), F = id(5);
  await panes([E]);
  await apply(frames(E, 'e', 0, 60, 3));
  await settle();
  await scroll(E, { to: 2500 });
  const before = await firstVis(E);
  assert.ok(before && before.id !== 'u:e59');
  await panes([F]);
  await settle();
  await panes([E]);
  await settle();
  assert.deepEqual(await firstVis(E), before);
});

test('Ctrl+F searches through tx.search, mounts the hit and marks it', async (t) => {
  if (skip(t)) return;
  const G = id(6);
  await clear();
  await panes([G]);
  await apply(frames(G, 'g', 0, 40, 3));
  await settle();
  await page().evaluate(() => (window as any).__h.setSearchHits([{ turnId: 'u:g3', blockId: 'a:g3:0', snippet: 'message 3' }]));
  await page().locator(`.c-pane[data-chat="${G}"] textarea.k-input`).focus();
  await page().keyboard.press('Control+f');
  await page().waitForFunction(() => document.activeElement?.matches('.t-search input'));
  await page().keyboard.type('message 3');
  await page().keyboard.press('Enter');
  await page().waitForSelector(`.c-pane[data-chat="${G}"] [data-turn="u:g3"] .c-hit`);
  assert.deepEqual((await calls('search')).at(-1), { c: G, q: 'message 3' });
  assert.equal(await page().textContent('.t-search-n'), '1 / 1');
  await settle();
  assert.ok(await page().evaluate((x) => {
    const el = document.querySelector(`.c-pane[data-chat="${x}"] .t-scroll`), h = el.querySelector('.c-hit').getBoundingClientRect(), b = el.getBoundingClientRect();
    return h.bottom > b.top && h.top < b.bottom;
  }, G), 'the hit is in view');
  await page().keyboard.press('Escape');
  assert.equal(await page().locator('.t-search').count(), 0);
});

test('error boundary per turn: an unreadable turn renders « Bloc illisible » and the other turns stay', async (t) => {
  if (skip(t)) return;
  const H = id(8);
  await panes([H]);
  await apply([...frames(H, 'h', 0, 3, 1), { t: 'ev', c: H, s: seq++, ev: { k: 'turn.start', turn: { id: 'u:hbad', at: 1, user: null, blocks: null } } },
    ...frames(H, 'h', 3, 5, 1)]);
  await settle();
  assert.equal(await page().locator(`.c-pane[data-chat="${H}"] .c-unreadable`).count(), 1);
  assert.equal(await page().locator(`.c-pane[data-chat="${H}"] .t-turns > [data-turn]`).count(), 5);
  assert.equal(await page().locator(`.c-pane[data-chat="${H}"] textarea.k-input`).count(), 1, 'the composer survives a malformed turn');
});
