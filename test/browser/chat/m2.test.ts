// M2 integration of the chat surface in Edge: code-fence language label (md.js stays the only sink), Peek's Échap,
// « Relancer » → chat.retry, Auto only when meta.autoAvailable, the account's model catalog in the model menu, and the
// transcript scroll position persisted through actions.saveScroll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bind, framesOf, useHarness } from './_browser.ts';
// Callbacks passed to page.evaluate() run in the browser; this file is compiled without the DOM lib (module-local names).
declare const document: any, window: any;

const ctx = useHarness();
const { apply, calls, clear, panes, skip } = bind(ctx);
const page = () => ctx.page;
const C = 'perso:22222222-2222-4333-8444-555555555555';
let s = 1;
const ev = (e: unknown, c = C) => ({ t: 'ev', c, s: s++, ev: e });
const turn = (id: string, text: string) => ev({ k: 'turn.start', turn: { id, at: Date.now(), user: { uuid: id.slice(2), text, origin: 'human' } } });
const block = (turnId: string, b: unknown) => ev({ k: 'block', turnId, block: b });
const summary = (id: string, state: Record<string, unknown>) => ({ chatId: id, accountId: id.split(':')[0], sessionId: id.split(':')[1], title: 'Chat M2',
  titleSource: 'none', cwd: 'C:\\w', origin: 'app', createdAt: 0, updatedAt: 0, size: 0, pinned: false, archived: false, muted: false, keepAlive: false,
  activity: '', expiresInDays: null, foreignOwner: false,
  state: { phase: 'idle', since: 0, flags: { live: true, unread: false, bgTasks: 0, queued: 0, external: null, stuck: false, notStarted: false }, pending: { count: 0 }, ...state } });

test('code fences carry their language label; a hostile info string gives none; the payload stays inert', async (t) => {
  if (skip(t)) return;
  const ok = await page().evaluate(() => (window as any).__h.md('```ts\nconst a = 1;\n```'));
  assert.match(ok, /<pre data-lang="ts">/);
  const bad = await page().evaluate(() => (window as any).__h.md('```"><img src=x onerror=alert(1)>\nx\n```\n\n```a<b\ny\n```'));
  assert.doesNotMatch(bad, /data-lang/);
  assert.equal(await page().evaluate(() => document.querySelectorAll('[onerror],[onload]').length), 0);
  await clear(); await panes([C]);
  await apply([turn('u:f1', 'code'), block('u:f1', { k: 'text', id: 'a:f1:0', md: 'Voici :\n\n```python\nprint(1)\n```' })]);
  const lang = page().locator('[data-block="a:f1:0"] pre .c-lang');
  await lang.waitFor();
  assert.equal(await lang.textContent(), 'python');
  assert.equal((await page().locator('[data-block="a:f1:0"] pre code').textContent())?.trim(), 'print(1)');   // the label is not code
});

test('Peek: Échap closes the Peek even on a focused card, and never answers it (lead decision)', async (t) => {
  if (skip(t)) return;
  await clear(); await panes([]);
  const ask = (await framesOf('permission')).flat().find((m: any) => m.t === 'ask').ask;
  await apply([{ t: 'ask', ask }]);
  await page().evaluate((x) => (window as any).__h.peek(x), ask.chatId);
  const card = page().locator('.pk-peek .d-card').first();
  await card.waitFor();
  await card.focus();
  await page().keyboard.press('Escape');
  await page().waitForFunction(() => !document.querySelector('.pk-peek'));
  assert.deepEqual(await calls('decide'), []);
  await apply([{ t: 'askEnd', chatId: ask.chatId, requestId: ask.requestId, reason: 'cancelled' }]);
});

test('error banner: « Relancer » sends chat.retry (never prespawn); stuck → « Forcer l\'arrêt » → forceStop', async (t) => {
  if (skip(t)) return;
  const id = 'perso:33333333-2222-4333-8444-555555555555';
  await clear(); await panes([id]);
  await apply([{ t: 'chats', upsert: [summary(id, { phase: 'error', error: { code: 'crash', exitCode: 3 } })], remove: [] }]);
  const btn = page().locator('.b-err button[data-retry]');
  await btn.waitFor();
  assert.equal((await btn.textContent())?.trim(), 'Relancer');
  await btn.click();
  assert.deepEqual(await calls('retry'), [{ c: id }]);
  assert.deepEqual(await calls('prespawn'), []);
  await apply([{ t: 'chats', upsert: [summary(id, { phase: 'error', error: { code: 'overloaded' } })], remove: [] }]);
  await page().waitForFunction(() => document.querySelector('.b-err button[data-retry]')?.textContent?.trim() === 'Réessayer');
  await apply([{ t: 'chats', upsert: [summary(id, { phase: 'interrupting', flags: { live: true, unread: false, bgTasks: 0, queued: 0, external: null, stuck: true, notStarted: false } })], remove: [] }]);
  await page().locator('.b-warn .d-danger').click();
  assert.deepEqual(await calls('forceStop'), [{ c: id }]);
});

test('header menus: Auto only when meta.autoAvailable; the model menu lists the account catalog (aliases otherwise)', async (t) => {
  if (skip(t)) return;
  const id = 'pro:44444444-2222-4333-8444-555555555555';
  await clear(); await panes([id]);
  await page().evaluate(() => { (window as any).__h.store.accounts.value = [{ id: 'pro', name: 'Pro', color: 2, monogram: 'P', login: 'connected',
    models: [{ value: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'high'] }, { value: 'sonnet', label: 'Sonnet', efforts: [] }] }]; });
  await apply([ev({ k: 'meta', meta: { model: 'claude-opus-5-5', mode: 'default' } }, id)]);
  const items = async (cls: string) => {
    await page().locator(`.${cls}`).first().click();
    const out = await page().locator('[role="menu"] [role^="menuitem"]').allTextContents();
    await page().keyboard.press('Escape');
    return out.map((x: string) => x.trim());
  };
  assert.ok(!(await items('h-mode')).some((x) => x.startsWith('Auto')), 'no Auto without autoAvailable');
  await apply([ev({ k: 'meta', meta: { model: 'claude-opus-5-5', mode: 'default', autoAvailable: true } }, id)]);
  assert.ok((await items('h-mode')).some((x) => x.startsWith('Auto')), 'Auto with autoAvailable');
  const models = await items('h-model');
  assert.ok(models.includes('Opus 5.5') && models.includes('Sonnet'), models.join(' | '));
  assert.ok(!models.includes('haiku'), 'catalog replaces the aliases');
});

test('scroll: the position left in a long transcript is saved through actions.saveScroll (UiState.scroll)', async (t) => {
  if (skip(t)) return;
  const id = 'perso:55555555-2222-4333-8444-555555555555';
  await clear(); await panes([id]);
  const frames: unknown[] = [];
  for (let k = 0; k < 40; k++) frames.push(ev({ k: 'turn.start', turn: { id: `u:s${k}`, at: k, user: { uuid: `s${k}`, text: `Question ${k}`, origin: 'human' } } }, id),
    ev({ k: 'block', turnId: `u:s${k}`, block: { k: 'text', id: `a:s${k}:0`, md: `Réponse ${k}\n\n` + 'ligne\n\n'.repeat(6) } }, id));
  await apply(frames as any[]);
  await page().locator('[data-turn="u:s39"]').waitFor();
  await page().evaluate(() => { const el = document.querySelector('.t-scroll'); el.dispatchEvent(new (window as any).WheelEvent('wheel')); el.scrollTop = 200; });
  await page().waitForFunction(() => (window as any).__h.calls('saveScroll').some((x: any) => x.anchor), null, { timeout: 5000 });
  const last = (await calls('saveScroll')).filter((x: any) => x.anchor).at(-1);
  assert.equal(last.c, id);
  assert.match(last.anchor.turnId, /^u:s\d+$/);
});
