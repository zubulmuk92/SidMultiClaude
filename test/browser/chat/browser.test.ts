// Chat surface in a real browser (installed Edge, headless, through playwright-core): the harness page mounts the real
// components on a stub store fed with the protocol fixtures, under the app's CSP with Trusted Types enforced.
// Skipped (not failed) when Edge cannot be launched on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bind, framesOf, useHarness } from './_browser.ts';
// Callbacks passed to page.evaluate() run in the browser; this file is compiled without the DOM lib (module-local names).
declare const document: any, window: any, KeyboardEvent: any, InputEvent: any, OffscreenCanvas: any, DataTransfer: any, File: any, ClipboardEvent: any, trustedTypes: any, localStorage: any;

const ctx = useHarness();
const { apply, calls, skip } = bind(ctx);
const errors = ctx.errors;
let page = ctx.page;
test('setup', () => { page = ctx.page; });

test('the harness loads under the production CSP with no error', (t) => {
  if (skip(t)) return;
  assert.deepEqual(errors, []);
});

const STREAM_CHAT = 'travail:4adf4c63-b504-4be1-804b-92a88963e275';
const seqOf = (f: any[]) => Math.max(-1, ...f.filter((m) => m.t === 'ev').map((m) => m.s as number));

test('stream: settled chunks + a plain-text tail inside an open fence, then one frozen block with its footer', async (t) => {
  if (skip(t)) return;
  const frames = await framesOf('stream', { 'A.text': 'Pourquoi le test échoue ?' });
  await page.evaluate((c) => (window as any).__h.setPanes([c]), STREAM_CHAT);
  const cut = frames.findIndex((f) => seqOf(f) === 13);
  for (const f of frames.slice(0, cut + 1)) await apply(f);
  await page.waitForSelector('.c-live pre.c-livecode');
  assert.match(await page.textContent('.c-live pre.c-livecode') ?? '', /parseDate\('2026-10-08', \{ tz: 'Europe\/Paris' \}/);
  assert.match(await page.textContent('.c-live .md') ?? '', /attend un fuseau/);            // the settled first paragraph
  assert.equal(await page.locator('.c-caret').count(), 1);
  for (const f of frames.slice(cut + 1)) await apply(f);
  await page.waitForSelector('.c-text:not(.c-live) .md pre code');
  assert.equal(await page.locator('.c-caret').count(), 0);
  assert.match(await page.textContent('.c-text .md') ?? '', /Je corrige l'appel et je relance les tests\./);
  assert.match(await page.textContent('.c-user-head .c-user-text') ?? '', /Pourquoi le test échoue/);
  assert.match(await page.textContent('.c-footer') ?? '', /entrée \(100 % cache\)/);
  assert.match(await page.textContent('.c-thinking') ?? '', /Réflexion · 203 tokens/);
  assert.deepEqual(errors, []);
});

test('composer: Entrée sends; while running Alt+Entrée = later; Ctrl+Entrée without the capability is a plain send', async (t) => {
  if (skip(t)) return;
  await page.evaluate(() => (window as any).__h.clearCalls());
  const box = page.locator(`.c-pane[data-chat="${STREAM_CHAT}"] textarea.k-input`);
  await box.fill('Bonjour');
  await box.press('Enter');
  let sent = await calls('send');
  assert.deepEqual(sent.at(-1), { c: STREAM_CHAT, text: 'Bonjour', o: {} });
  assert.equal(await box.inputValue(), '');
  const running = { phase: 'running', since: 0, sub: 'writing', flags: { live: true, unread: false, bgTasks: 0, queued: 0, external: null, stuck: false, notStarted: false }, pending: { count: 0 } };
  await apply([{ t: 'ev', c: STREAM_CHAT, s: 100, ev: { k: 'state', state: running } }]);
  await box.fill('Après');
  await box.press('Alt+Enter');
  await box.fill('Maintenant');
  await box.press('Control+Enter');
  sent = await calls('send');
  assert.deepEqual(sent.slice(-2).map((x) => [x.text, x.o.priority ?? null]), [['Après', 'later'], ['Maintenant', null]]);
  await apply([{ t: 'ev', c: STREAM_CHAT, s: 101, ev: { k: 'meta', meta: { capabilities: ['interrupt_send_now_v1'] } } }]);
  await box.fill('Vite');
  await box.press('Control+Enter');
  assert.equal((await calls('send')).at(-1).o.priority, 'now');
  // Échap while running interrupts; a second press within 600 ms is swallowed (never a rewind)
  await box.press('Escape'); await box.press('Escape');
  assert.equal((await calls('interrupt')).length, 1);
  assert.equal(await page.locator('.s-rewind').count(), 0);
});

test('queue chips follow delivery (folded, later, returned) and ↑ takes waiting messages back', async (t) => {
  if (skip(t)) return;
  await page.evaluate(() => (window as any).__h.clearCalls());
  await apply([{ t: 'ev', c: STREAM_CHAT, s: 102, ev: { k: 'queue', items: [
    { uuid: 'q1', text: 'Utilise vitest', images: 0, delivery: 'queued' },
    { uuid: 'q2', text: 'Ensuite le README', images: 0, priority: 'later', delivery: 'queued' },
    { uuid: 'q3', text: 'Pris', images: 0, delivery: 'folded' },
    { uuid: 'q4', text: 'Perdu', images: 0, delivery: 'returned' }] } }]);
  const states = await page.locator(`.c-pane[data-chat="${STREAM_CHAT}"] .q-item .q-state`).allTextContents();
  // the folded message (q3) left the strip: it is in the transcript (ux §7.3)
  assert.deepEqual(states, ['En file · ↑ pour reprendre', 'Après ce tour', 'Non envoyé · Renvoyer']);
  await page.locator('.q-returned button', { hasText: 'Renvoyer' }).click();
  assert.deepEqual((await calls('resend')).at(-1), { c: STREAM_CHAT, uuid: 'q4' });
  const box = page.locator(`.c-pane[data-chat="${STREAM_CHAT}"] textarea.k-input`);
  await box.fill('');
  await box.press('ArrowUp');
  await page.waitForFunction(() => (document.querySelector('textarea.k-input') as any).value.includes('README'));
  assert.deepEqual((await calls('cancelQueued')).map((x) => x.uuid), ['q1', 'q2', 'q4']);
  assert.equal(await box.inputValue(), 'Utilise vitest\nEnsuite le README\nPerdu');
  await apply([{ t: 'ev', c: STREAM_CHAT, s: 103, ev: { k: 'queue', items: [] } }]);
  await box.fill('');
});

test('stream: settled chunks are never re-rendered, the open-fence box matches the settled code, freezing moves nothing', async (t) => {
  if (skip(t)) return;
  const C = 'perso:0000000a-3333-4444-8555-666666666666';
  let s = 1;
  const ev = (e: unknown) => ({ t: 'ev', c: C, s: s++, ev: e });
  await page.evaluate((c) => (window as any).__h.setPanes([c]), C);
  const long = 'const s = ' + JSON.stringify('x'.repeat(220)) + ';';
  const code = '```ts\n' + long + '\nconst y = 2;\n';
  const md = 'Premier paragraphe.\n\n' + code + '```\n\nUne liste :\n\n- un\n- deux\n\nFin du message.';
  await apply([ev({ k: 'turn.start', turn: { id: 'u:sf', at: 1, user: { uuid: 'sf', text: 'q', origin: 'human' } } }),
    ev({ k: 'block', turnId: 'u:sf', block: { k: 'text', id: 'a:sf:0', md: '', live: true } }),
    ev({ k: 'turn.start', turn: { id: 'u:sf2', at: 2, user: { uuid: 'sf2', text: 'suivant', origin: 'human' } } })]);
  const block = '[data-block="a:sf:0"]';
  const push = async (text: string) => { for (let i = 0; i < text.length; i += 23) await apply([ev({ k: 'delta', parts: [['a:sf:0', text.slice(i, i + 23)]] })]); };
  await push('Premier paragraphe.\n\n');
  await page.waitForSelector(`${block} .md`);
  await page.evaluate((b) => { document.querySelector(`${b} .md`).dataset.mark = 'settled'; }, block);
  await push(code);
  await page.waitForTimeout(150);
  const live = await page.evaluate((b) => Math.round(document.querySelector(`${b} pre.c-livecode`).getBoundingClientRect().height), block);
  await push(md.slice('Premier paragraphe.\n\n'.length + code.length));
  await page.waitForTimeout(250);
  const r = await page.evaluate((b) => ({
    mark: document.querySelector(`${b} .md`)?.dataset.mark ?? null,
    pre: Math.round(document.querySelector(`${b} .md pre`).getBoundingClientRect().height),
    h: Math.round(document.querySelector(b).getBoundingClientRect().height),
    next: Math.round(document.querySelector('[data-turn="u:sf2"]').getBoundingClientRect().top),
  }), block);
  assert.equal(r.mark, 'settled', 'the first settled chunk is still the same DOM node');
  assert.ok(Math.abs(r.pre - live) <= 1, `open-fence box ${live} px, settled code ${r.pre} px`);
  await apply([ev({ k: 'block', turnId: 'u:sf', block: { k: 'text', id: 'a:sf:0', md } })]);    // freeze: one full parse
  await page.waitForSelector(`${block}:not(.c-live)`);
  await page.waitForTimeout(100);
  const f = await page.evaluate((b) => ({ h: Math.round(document.querySelector(b).getBoundingClientRect().height),
    next: Math.round(document.querySelector('[data-turn="u:sf2"]').getBoundingClientRect().top) }), block);
  assert.ok(Math.abs(f.h - r.h) <= 1 && Math.abs(f.next - r.next) <= 1, `before ${JSON.stringify(r)} after ${JSON.stringify(f)}`);
  assert.deepEqual(errors, []);
});
