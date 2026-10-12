// Streaming budget in Edge (WP-F acceptance 1, SPEC §9.5): 4 panes, each streaming 20 delta frames/s for 2 s, while
// the user types in a composer: no long task > 50 ms, key handling < 16 ms. Also: interactive Peek with its card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bind, framesOf, useHarness } from './_browser.ts';
// Callbacks passed to page.evaluate() run in the browser; this file is compiled without the DOM lib (module-local names).
declare const document: any, window: any, KeyboardEvent: any, InputEvent: any, OffscreenCanvas: any, DataTransfer: any, File: any, ClipboardEvent: any, trustedTypes: any, localStorage: any;

const ctx = useHarness({ width: 1600, height: 1000 });
const { apply, calls, clear, panes, skip } = bind(ctx);
const page = () => ctx.page;
const IDS = [1, 2, 3, 4].map((n) => `perso:0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`);

test('4 panes streaming at 20 frames/s: no long task over 50 ms, keystrokes handled under 16 ms', async (t) => {
  if (skip(t)) return;
  const hello = (await framesOf('stream'))[0]!.find((m: any) => m.t === 'hello');
  hello.chats = IDS.map((c, i) => ({ ...hello.chats[0], chatId: c, accountId: 'perso', sessionId: c.split(':')[1], title: `Volet ${i + 1}` }));
  await apply([hello]);
  await panes(IDS);
  const start: unknown[] = [];
  for (const c of IDS) {
    for (let k = 0; k < 20; k++) {               // some history: 20 settled turns per pane
      start.push({ t: 'ev', c, s: 0, ev: { k: 'turn.start', turn: { id: `u:h${k}`, at: 1, user: { uuid: `h${k}`, text: `question ${k}`, origin: 'human' } } } });
      start.push({ t: 'ev', c, s: 0, ev: { k: 'block', turnId: `u:h${k}`, block: { k: 'text', id: `a:h${k}:0`, md: `## Réponse ${k}\n\n- point\n- point\n\n\`\`\`ts\nconst x = ${k};\n\`\`\`` } } });
    }
    start.push({ t: 'ev', c, s: 0, ev: { k: 'turn.start', turn: { id: 'u:live', at: 2, user: { uuid: 'live', text: 'Écris beaucoup', origin: 'human' } } } });
    start.push({ t: 'ev', c, s: 0, ev: { k: 'block', turnId: 'u:live', block: { k: 'text', id: 'a:live:0', md: '', live: true } } });
  }
  await apply(start);
  await page().waitForFunction(() => document.querySelectorAll('.c-live').length === 4);
  const r = await page().evaluate(async (ids) => {
    const longs: number[] = [];
    const evs: number[] = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(e.duration); }).observe({ type: 'longtask', buffered: false } as any);
    new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (e.name === 'keydown') evs.push(e.processingEnd - e.processingStart); })
      .observe({ type: 'event', durationThreshold: 16, buffered: false } as any);
    const h = (window as any).__h;
    const words = 'Le parseur lit chaque ligne, puis valide le fuseau. ';
    let tick = 0;
    const timer = setInterval(() => {
      tick++;
      const md = tick % 15 === 0 ? '\n\n```ts\nconst y = 1;\n' : tick % 15 === 5 ? '\n```\n\n' : words;
      h.apply(ids.map((c: string) => ({ t: 'ev', c, s: 0, ev: { k: 'delta', parts: [['a:live:0', md]] } })));
    }, 50);
    const box = document.querySelector('textarea.k-input') as any;
    box.focus();
    const lat: number[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 90));
      const t0 = performance.now();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
      box.value += 'a'; box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      lat.push(performance.now() - t0);
    }
    clearInterval(timer);
    await new Promise((res) => setTimeout(res, 300));
    return { longs, evs, lat, chars: [...document.querySelectorAll('.c-live')].map((e) => e.textContent?.length ?? 0) };
  }, IDS);
  assert.ok(r.chars.every((n: number) => n > 1000), `every pane streamed (${r.chars.join(', ')})`);
  assert.deepEqual(r.longs.filter((d: number) => d > 50), [], `long tasks: ${r.longs.map((d: number) => d.toFixed(0)).join(', ')}`);
  const sorted = [...r.lat].sort((a: number, b: number) => a - b);
  assert.ok((sorted[Math.floor(sorted.length * 0.9)] ?? 0) < 16, `key handling p90 ${sorted.map((x: number) => x.toFixed(1)).join(' ')}`);
  assert.deepEqual(ctx.errors, []);
});

test('Peek: last exchanges and the top pending card, which keeps its keys; Entrée opens the chat', async (t) => {
  if (skip(t)) return;
  await clear();
  const ask = (await framesOf('permission')).flat().find((m) => m.t === 'ask').ask;
  const c = IDS[0]!;
  await apply([{ t: 'ask', ask: { ...ask, chatId: c, requestId: 'pk-1' } }]);
  await page().evaluate((x) => (window as any).__h.peek(x), c);
  await page().waitForSelector('.pk-peek .d-card');
  assert.match(await page().textContent('.pk-peek') ?? '', /Aperçu · Volet 1/);
  await page().waitForFunction(() => /question 19/.test(document.querySelector('.pk-peek .pk-body')?.textContent ?? ''));   // turns come from an effect
  assert.match(await page().textContent('.pk-peek .pk-body') ?? '', /question 19/);
  await page().locator('.pk-peek .d-card').focus();
  await page().keyboard.press('Digit1');
  await page().waitForFunction(() => !document.querySelector('.pk-peek .d-card'));
  assert.deepEqual((await calls('decide')).at(-1).a, { kind: 'allow-once' });
  await page().locator('.pk-peek').focus();
  await page().keyboard.press('Enter');
  assert.deepEqual((await calls('openChat')).at(-1), { c, w: 'focused' });
  assert.equal(await page().locator('.pk-peek').count(), 0);
});
