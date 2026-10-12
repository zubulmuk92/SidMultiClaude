// Chat surface in Edge (WP-F acceptance 4, 5, 6, 8): the 11 XSS payloads are inert through md.js and the streaming
// path under Trusted Types; tool output is text; error boundaries; tool cards with lazy detail; the 150-turn mount cap
// and the new-messages pill; slash palette, @ mentions, image paste chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bind, framesOf, useHarness } from './_browser.ts';
// Callbacks passed to page.evaluate() run in the browser; this file is compiled without the DOM lib (module-local names).
declare const document: any, window: any, KeyboardEvent: any, InputEvent: any, OffscreenCanvas: any, DataTransfer: any, File: any, ClipboardEvent: any, trustedTypes: any, localStorage: any;

const PAYLOADS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'harness', 'xss-payloads.json'), 'utf8')) as Record<string, string>;
const ctx = useHarness();
const { apply, calls, clear, panes, skip } = bind(ctx);
const page = () => ctx.page;
const C = 'perso:11111111-2222-4333-8444-555555555555';
let s = 1;
const ev = (e: unknown) => ({ t: 'ev', c: C, s: s++, ev: e });
const turn = (id: string, text: string) => ev({ k: 'turn.start', turn: { id, at: Date.now(), user: { uuid: id.slice(2), text, origin: 'human' } } });
const block = (turnId: string, b: unknown) => ev({ k: 'block', turnId, block: b });
const DOM_CHECK = () => {
  const d = document;
  return {
    xss: (window as any).__xss ?? null,
    on: d.querySelectorAll('[onerror],[onload],[onclick]').length,
    js: [...d.querySelectorAll('a')].filter((a) => /^(javascript|data):/i.test(a.getAttribute('href') ?? '')).length,
    frames: d.querySelectorAll('iframe, object, embed').length,
    svgScripts: d.querySelectorAll('svg script, script:not([type="importmap"]):not([src])').length,
    styled: d.querySelectorAll('.md [style]').length,
    remoteImgs: [...d.querySelectorAll('.md img')].filter((i) => /^https?:/i.test(i.getAttribute('src') ?? '')).length,
  };
};
const CLEAN = { xss: null, on: 0, js: 0, frames: 0, svgScripts: 0, styled: 0, remoteImgs: 0 };

test('hello + one pane', async (t) => {
  if (skip(t)) return;
  const hello = (await framesOf('stream'))[0]!.find((m: any) => m.t === 'hello');
  hello.chats.push({ ...hello.chats[0], chatId: C, accountId: 'perso', sessionId: C.split(':')[1], title: 'Banc' });
  await apply([hello]);
  await panes([C]);
  await page().waitForSelector(`.c-pane[data-chat="${C}"]`);
});

test('the 11 XSS payloads are inert through md.js (TrustedHTML, raw HTML shown as text, remote images and js: links stripped)', async (t) => {
  if (skip(t)) return;
  assert.equal(await page().evaluate(() => (window as any).__h.isTrusted()), true);
  for (const md of Object.values(PAYLOADS)) await page().evaluate((x) => (window as any).__h.md(x), md);
  await page().waitForTimeout(400);
  assert.deepEqual(await page().evaluate(DOM_CHECK), CLEAN);
  const probe = await page().evaluate(() => [...document.querySelectorAll('.xss-probe')].map((d) => d.textContent ?? '').join('\n'));
  assert.match(probe, /<b>gras<\/b>/);                                    // raw HTML is shown, not rendered
  const alts = await page().evaluate(() => [...document.querySelectorAll('.xss-probe img')].map((i) => [i.getAttribute('src'), i.getAttribute('alt')]));
  assert.ok(alts.some(([src, alt]) => src === null && alt === '[image distante bloquée]'));
  assert.ok(alts.some(([src]) => (src ?? '').startsWith('data:image/png')));
  // Trusted Types are enforced: a raw HTML string sink throws
  assert.equal(await page().evaluate(() => { try { document.body.innerHTML = '<b>x</b>'; return 'sink open'; } catch { return 'blocked'; } }), 'blocked');
  ctx.errors.length = 0;                                                   // that blocked sink logged an expected TT error
});

test('the same payloads streamed through stream-md (settled + tail, then frozen) stay inert; tool output is text', async (t) => {
  if (skip(t)) return;
  const all = Object.values(PAYLOADS).join('\n\n');
  await apply([turn('u:x1', 'payloads'), block('u:x1', { k: 'text', id: 'a:x1:0', md: '', live: true })]);
  for (let i = 0; i < all.length; i += 37) await apply([ev({ k: 'delta', parts: [['a:x1:0', all.slice(i, i + 37)]] })]);
  await page().waitForTimeout(150);
  assert.deepEqual(await page().evaluate(DOM_CHECK), CLEAN);
  await apply([block('u:x1', { k: 'text', id: 'a:x1:0', md: all })]);
  await apply([block('u:x1', { k: 'tool', id: 't:x', toolUseId: 'x', name: 'Bash', input: { summary: 'echo', fields: { command: 'echo' } }, status: 'error',
    result: { isError: true, summary: '<img src=x onerror="window.__xss=9">', head: '<img src=x onerror="window.__xss=9">' } })]);
  await page().waitForTimeout(400);
  assert.deepEqual(await page().evaluate(DOM_CHECK), CLEAN);
  assert.match(await page().textContent(`.c-pane [data-block="t:x"]`) ?? '', /<img src=x onerror/);
});

test('error boundary: an unreadable block renders « Bloc illisible », logs, and the rest of the turn stays', async (t) => {
  if (skip(t)) return;
  await apply([turn('u:e1', 'casse'), block('u:e1', { k: 'tool', id: 't:bad', toolUseId: 'bad', name: 'Read', input: null, status: 'ok' }),
    block('u:e1', { k: 'text', id: 'a:e1:0', md: 'Toujours là' })]);
  await page().waitForSelector('.c-unreadable');
  assert.match(await page().textContent('.c-unreadable') ?? '', /Bloc illisible/);
  assert.match(await page().textContent('[data-turn="u:e1"]') ?? '', /Toujours là/);
  assert.ok((await page().evaluate(() => (window as any).__h.logs)).some((l: any) => l.level === 'error' && /render/.test(l.msg)));
});
test('tool cards: Bash tail of 8 lines + « Afficher tout » fetches the full output lazily; Edit renders structuredPatch', async (t) => {
  if (skip(t)) return;
  await clear();
  const out = Array.from({ length: 12 }, (_, i) => `ligne ${i + 1}`).join('\n');
  await apply([turn('u:t1', 'outils'), block('u:t1', { k: 'tool', id: 't:b1', toolUseId: 'b1', name: 'Bash', input: { summary: 'npm test', fields: { command: 'npm test', description: 'Tests' } },
    status: 'ok', result: { isError: false, summary: 'ok', head: out, tail: out, totalLines: 400, truncated: true } }),
    block('u:t1', { k: 'text', id: 'a:t1:0', md: 'entre deux' }),
    block('u:t1', { k: 'tool', id: 't:e1', toolUseId: 'e1', name: 'Edit', input: { summary: 'a.ts', fields: { file_path: 'C:\\w\\a.ts' } }, status: 'ok',
      result: { isError: false, summary: '', patch: [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [' x', '-old', '+new'] }] } })]);
  const bash = page().locator('[data-block="t:b1"]');
  assert.match(await bash.textContent() ?? '', /A exécuté : Tests/);
  await bash.locator('.c-disclosure').click();
  assert.equal((await bash.locator('.c-out pre').textContent())?.split('\n').length, 8);
  await bash.getByText('Afficher tout (400 lignes)').click();
  await page().waitForFunction(() => document.querySelector('[data-block="t:b1"] .c-out pre')?.textContent === 'détail complet');
  assert.deepEqual((await calls('detail')).at(-1), { c: C, id: 't:b1', f: 'output' });
  const edit = page().locator('[data-block="t:e1"]');
  assert.match(await edit.textContent() ?? '', /a\.ts \(\+1 −1\)/);
  await edit.locator('.c-disclosure').click();
  assert.deepEqual(await edit.locator('.d-row .d-no').allTextContents(), ['10', '10', '11', '', '', '11']);
});

test('transcript: at most 150 mounted turns, a spacer for the rest; new turns while scrolled up raise the pill', async (t) => {
  if (skip(t)) return;
  const frames: unknown[] = [];
  for (let i = 0; i < 200; i++) { frames.push(turn(`u:m${i}`, `message ${i}`)); frames.push(block(`u:m${i}`, { k: 'text', id: `a:m${i}:0`, md: `réponse ${i}` })); }
  await apply(frames);
  await page().waitForFunction(() => document.querySelectorAll('.c-turn').length > 0);
  assert.ok(await page().locator('.c-turn').count() <= 150);
  assert.equal(await page().locator('.t-spacer').count(), 1);
  const sc = page().locator('.t-scroll');
  assert.ok(await sc.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48), 'stuck to the bottom');
  await sc.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await apply([turn('u:new', 'nouveau'), block('u:new', { k: 'text', id: 'a:new:0', md: 'arrivé' })]);
  await page().waitForSelector('.t-pill');
  assert.equal(await page().textContent('.t-pill'), '↓ Nouveaux messages (1)');
  await page().click('.t-pill');
  await page().waitForFunction(() => { const el = document.querySelector('.t-scroll')!; return el.scrollHeight - el.scrollTop - el.clientHeight <= 48; });
});

test('composer: slash palette from meta.commands (local badge), @ mentions, Ctrl+R history', async (t) => {
  if (skip(t)) return;
  await clear();
  await apply([ev({ k: 'meta', meta: { commands: [
    { name: 'compact', description: 'Compacter la conversation', group: 'builtin', local: false },
    { name: 'context', description: 'Occupation du contexte', group: 'builtin', local: true },
    { name: 'code-review', description: 'Revue du diff', group: 'skill', local: false }] } })]);
  const box = page().locator(`.c-pane[data-chat="${C}"] textarea.k-input`);
  await box.fill('');
  await box.pressSequentially('/co');
  await page().waitForSelector('#p-slash');
  assert.deepEqual(await page().locator('#p-slash .p-group').allTextContents(), ['Commandes intégrées', 'Skills']);
  assert.match(await page().textContent('#p-slash [role="option"]:has-text("/context")') ?? '', /local/);
  await box.press('ArrowDown');
  await box.press('Enter');
  assert.equal(await box.inputValue(), '/context ');
  await box.fill('');
  await box.pressSequentially('voir @pa');
  await page().waitForSelector('#p-mention [role="option"]');
  await box.press('Enter');
  assert.equal(await box.inputValue(), 'voir @src/parser.ts ');
  assert.deepEqual((await calls('mentions')).at(-1), { c: C, q: 'pa' });
  await box.fill('');
  await box.press('Control+r');
  await page().waitForSelector('.p-history [role="option"]');
  await page().keyboard.press('Enter');
  assert.equal(await box.inputValue(), 'Ancien prompt');
  await box.fill('');
});

test('composer: a pasted image becomes a chip and is sent as an image block (L1 budget respected)', async (t) => {
  if (skip(t)) return;
  await clear();
  const box = page().locator(`.c-pane[data-chat="${C}"] textarea.k-input`);
  await box.focus();
  await page().evaluate(async () => {
    const c = new OffscreenCanvas(40, 30); const g = c.getContext('2d')!; g.fillStyle = '#c00'; g.fillRect(0, 0, 40, 30);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'capture.png', { type: 'image/png' }));
    document.querySelector('textarea.k-input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page().waitForSelector('.a-chip img');
  await box.fill('Regarde');
  await box.press('Enter');
  await page().waitForFunction(() => (window as any).__h.calls('send').length > 0);
  const sent = (await calls('send')).at(-1);
  assert.equal(sent.text, 'Regarde');
  assert.equal(sent.o.images.length, 1);
  assert.equal(sent.o.images[0].mediaType, 'image/png');
  assert.equal(await page().locator('.a-chip').count(), 0);
});
test('L1: oversized pasted images are re-encoded / downscaled until each ≤ 5 MiB and all ≤ 12 MiB, with a notice', async (t) => {
  if (skip(t)) return;
  await clear();
  await page().locator(`.c-pane[data-chat="${C}"] textarea.k-input`).focus();
  await page().evaluate(async () => {
    const dt = new DataTransfer();
    for (let k = 0; k < 3; k++) {
      const c = new OffscreenCanvas(1800, 1800); const g = c.getContext('2d')!;
      const im = g.createImageData(1800, 1800);
      for (let i = 0; i < im.data.length; i++) im.data[i] = (Math.random() * 256) | 0;
      g.putImageData(im, 0, 0);
      dt.items.add(new File([await c.convertToBlob({ type: 'image/png' })], `bruit-${k}.png`, { type: 'image/png' }));
    }
    document.querySelector('textarea.k-input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page().waitForFunction(() => document.querySelectorAll('.a-chip').length === 3, null, { timeout: 20_000 });
  const box = page().locator(`.c-pane[data-chat="${C}"] textarea.k-input`);
  await box.fill('trois images');
  await box.press('Enter');
  await page().waitForFunction(() => (window as any).__h.calls('send').length > 0, null, { timeout: 30_000 });
  const sizes = await page().evaluate(() => (window as any).__h.store.calls.filter((c: any) => c.name === 'send').at(-1).args.o.images.map((i: any) => [i.mediaType, i.base64.length]));
  assert.equal(sizes.length, 3);
  assert.ok(sizes.every(([, n]: [string, number]) => n <= 5 * 2 ** 20));
  assert.ok(sizes.reduce((a: number, [, n]: [string, number]) => a + n, 0) <= 12 * 2 ** 20);
  assert.ok(sizes.some(([m]: [string, number]) => m === 'image/jpeg'));
  assert.match(await page().textContent('.k-notice') ?? '', /Images réduites/);
});

test('dialogs: Échap Échap (idle, empty) → Revenir à… (dry run, 2 = conversation, prompt back in the composer)', async (t) => {
  if (skip(t)) return;
  await clear();
  const box = page().locator(`.c-pane[data-chat="${C}"] textarea.k-input`);
  await box.fill('');
  await box.press('Escape'); await box.press('Escape');
  await page().waitForSelector('.s-rewind');
  await page().waitForFunction(() => !/Simulation…/.test(document.querySelector('.s-rewind')?.textContent ?? ''));   // the dry run is async
  assert.match(await page().textContent('.s-rewind') ?? '', /Simulation : 1 fichier\(s\) restauré\(s\) \(\+0 −4\)/);
  assert.match(await page().textContent('.s-rewind') ?? '', /ne sont pas annulés/);
  await page().keyboard.press('Digit2');
  await page().keyboard.press('Enter');
  await page().waitForFunction(() => !document.querySelector('.s-rewind'));
  const rw = (await calls('rewind')).filter((x) => !x.d).at(-1);
  assert.deepEqual([rw.a, rw.d], ['conv', false]);
  assert.equal(await box.inputValue(), 'nouveau');                          // the newest prompt went back to the composer
  await box.fill('');
});

test('dialogs: Continuer sur un autre compte shows the cost and the instructions note, then forks onto the target', async (t) => {
  if (skip(t)) return;
  await clear();
  await page().click(`.c-pane[data-chat="${C}"] .h-more .c-menu-btn`);
  await page().getByRole('menuitem', { name: 'Continuer sur un autre compte…' }).click();
  await page().waitForSelector('.s-continue');
  const txt = await page().textContent('.s-continue') ?? '';
  assert.match(txt, /Une copie du chat est créée sur Travail/);
  assert.match(txt, /instructions du compte d'origine/);
  await page().getByRole('button', { name: /Continuer sur Travail/ }).click();
  await page().waitForFunction(() => !document.querySelector('.s-continue'));
  assert.deepEqual((await calls('fork')).at(-1), { c: C, o: { accountId: 'travail' } });
  assert.equal((await calls('openChat')).at(-1).w, 'focused');
});

test('dialogs: wake (idle > 1 h, > 100 k) sends with wake:summary; a model switch on a warm cache asks first', async (t) => {
  if (skip(t)) return;
  await clear();
  const sum = await page().evaluate((c) => (window as any).__h.store.chats.value.get(c), C);
  await apply([{ t: 'chats', remove: [], upsert: [{ ...sum, wake: { lastContext: 182_000, recacheTokens: 163_000, idleMs: 3 * 3600_000, dialog: true },
    state: { ...sum.state, phase: 'cold', flags: { ...sum.state.flags, live: false } } }] }]);
  const box = page().locator(`.c-pane[data-chat="${C}"] textarea.k-input`);
  await box.fill('On reprend');
  await box.press('Enter');
  await page().waitForSelector('.s-wake');
  await page().waitForFunction(() => !!document.querySelector('.s-wake')?.contains(document.activeElement));
  assert.match(await page().textContent('.s-wake') ?? '', /inactif depuis 3 h 00/);
  await page().keyboard.press('Digit2');
  await page().locator('.s-wake').getByRole('button', { name: /Envoyer/ }).click();
  assert.deepEqual((await calls('send')).at(-1), { c: C, text: 'On reprend', o: { wake: 'summary' } });
  await apply([{ t: 'chats', remove: [], upsert: [sum] }, ev({ k: 'metrics', metrics: { contextTokens: 84_000, cacheWarmUntil: Date.now() + 40 * 60_000 } })]);
  await box.focus();
  await page().keyboard.press('Alt+p');
  await page().getByRole('menuitemradio', { name: 'opus' }).click();
  await page().waitForSelector('.s-model');
  assert.match(await page().textContent('.s-model') ?? '', /Le cache de ce chat est chaud encore (39|40) min/);
  await page().getByRole('button', { name: 'Changer quand même' }).click();
  assert.deepEqual((await calls('setModel')).at(-1), { c: C, model: 'opus', effort: null });
});

test('cap choice: a `cap` refusal offers to put a candidate to sleep (evict), exceed or cancel', async (t) => {
  if (skip(t)) return;
  await clear();
  await page().evaluate((c) => (window as any).__h.setIssue(c, { uuid: 'u1', text: 'x', err: { code: 'cap', candidates: [
    { chatId: 'perso:aaaaaaaa-0000-4000-8000-000000000001', title: 'Lecture du rapport', warmMin: 20, recacheTokens: 31_400, stable: true }] } }), C);
  await page().waitForSelector('.k-cap');
  await page().getByRole('button', { name: /Mettre en veille « Lecture du rapport »/ }).click();
  assert.deepEqual((await calls('resolveSend')).at(-1), { c: C, choice: { evict: 'perso:aaaaaaaa-0000-4000-8000-000000000001' } });
  assert.equal(await page().locator('.k-cap').count(), 0);
  assert.deepEqual(ctx.errors, []);
});

test('a `cap_busy` refusal (nothing can sleep) offers « Dépasser la limite » or « Annuler », never a dead end', async (t) => {
  if (skip(t)) return;
  await clear();
  await page().evaluate((c) => (window as any).__h.setIssue(c, { uuid: 'u2', text: 'y', err: { code: 'cap_busy' } }), C);
  await page().waitForSelector('.k-cap');
  assert.match(await page().locator('.k-cap p').textContent() ?? '', /aucun ne peut être mis en veille maintenant/);
  await page().getByRole('button', { name: /Dépasser la limite/ }).click();
  assert.deepEqual((await calls('resolveSend')).at(-1), { c: C, choice: { exceed: true } });
  assert.equal(await page().locator('.k-cap').count(), 0);
  assert.deepEqual(ctx.errors, []);
});

test('markdown links open in the browser of the user (open url), never inside the app window', async (t) => {
  if (skip(t)) return;
  await clear();
  const url = page().url();
  await apply([turn('u:l1', 'lien'), block('u:l1', { k: 'text', id: 'a:l1:0', md: 'Voir [la doc](https://example.com/doc) ici.' })]);
  await page().locator('[data-block="a:l1:0"] .md a').click();
  assert.deepEqual((await calls('openExternal')).at(-1), { u: 'https://example.com/doc' });
  assert.equal(page().url(), url);
  assert.equal(await page().locator('[data-block="a:l1:0"] .md a').getAttribute('rel'), 'noopener noreferrer');
});
