// test/browser/shell/shell-mock.test.ts — the web shell in headless Edge against test/fakes/mock-server.mjs (SPEC §11):
// boot and device-token reload · hello→paint with 200 chats · 1,000 sidebar rows and virtualisation · À traiter + Alt+A ·
// Ctrl+K prefixes · tabs, layouts and Alt+1…9 (AZERTY key values) · Peek + hover prefetch · new chat (S9 error, trust) ·
// resume browser · rename (F2) · accounts + fake login · settings · reconnect (same / new boot) · notification rules,
// window title · orphans · quit. Every page also asserts no CSP / Trusted Types violation and no page error.
// M2: moved from test/e2e (browser tier, npm run test:browser). The scripted mock world reaches states the real server
// only reaches slowly or not at all (seq gaps, orphans, DND, a fake login); the same flows against the REAL server are
// test/e2e/shell.e2e.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { edgeInstalled, openBrowser } from '../../e2e/harness.ts';
// @ts-expect-error plain ESM test fake without declarations
import { startMockServer } from '../../fakes/mock-server.mjs';

// DOM globals used inside page.evaluate callbacks (this file compiles without lib.dom; module-scoped declarations)
declare const window: any, document: any, localStorage: any, requestAnimationFrame: any, KeyboardEvent: any, Event: any;

type Mock = { port: number; origin: string; world: any; requests: any[]; url(code?: string): string; push(f: unknown[]): void;
  drop(): void; restart(): void; boot(): string; waitFor(pred: (r: any) => boolean, ms?: number): Promise<any>; close(): Promise<void> };
const SKIP = edgeInstalled() ? false : 'Microsoft Edge is not installed';
let m: Mock;
let browser: Browser;
const opened: { page: Page; problems: string[] }[] = [];

/** Opens the app on a fresh boot code; collects console errors, CSP reports and page errors. */
async function openApp(mock: Mock = m, o: { notifications?: boolean } = {}): Promise<{ page: Page; problems: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-FR' });
  await context.grantPermissions(['notifications'], { origin: mock.origin });
  if (o.notifications) {
    await context.addInitScript(() => {
      const w = window as any;
      w.__notifs = [];
      w.Notification = class { static permission = 'granted'; static requestPermission = async () => 'granted';
        onclick: unknown = null; constructor(title: string, opts: any) { w.__notifs.push({ title, ...opts }); } close() {} };
    });
  }
  mock.world.ui = null;                       // every page starts from the default layout
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error' && !/favicon/i.test(msg.text())) problems.push(msg.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(mock.url());
  await page.locator('.chat-row').first().waitFor({ timeout: 10_000 });
  const r = { page, problems };
  opened.push(r);
  return r;
}
/** Retries an assertion until it passes (renders are asynchronous) or 3 s elapse. */
async function eventually(check: () => Promise<void> | void, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try { await check(); return; } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 50)); }
  }
}
const sent = (t: string, from = 0) => m.requests.slice(from).filter((r) => r.t === t);
const chatIdOf = (title: string) => [...m.world.chats.values()].find((s: any) => s.title === title)?.chatId as string;
const focusedPaneChat = (page: Page) => page.locator('.pane-cell').nth(0).getAttribute('data-chat');

before(async () => {
  if (SKIP) return;
  m = await startMockServer({ chats: 200 });
  ({ browser } = await openBrowser(m.origin));
});
afterEach(async () => {
  // close every page of the test (a page left open would keep saving its UiState into the shared mock world)
  const list = opened.splice(0);
  for (const o of list) await o.page.context().close().catch(() => {});
  for (const o of list) assert.deepEqual(o.problems.filter((p) => /Content Security Policy|TrustedHTML|Trusted Type|pageerror/i.test(p)), []);
});
after(async () => {
  await browser?.close().catch(() => {});
  await m?.close();
});

test('boot: hello → paint < 300 ms with 200 chats; #boot dropped; reload works with the device token', { skip: SKIP }, async () => {
  const { page, problems } = await openApp();
  assert.equal(new URL(page.url()).hash, '', 'boot code removed from the URL');
  const ms = await page.evaluate(() => performance.getEntriesByName('smc:hello→paint')[0]?.duration ?? -1);
  console.log(`# paint: hello→paint ${ms.toFixed(1)} ms (200 chats)`);
  assert.ok(ms >= 0 && ms < 300, `hello→paint ${ms} ms`);
  await eventually(async () => { assert.ok(await page.evaluate(() => Boolean(localStorage.getItem('smc.device')))); });
  await page.reload();
  await page.locator('.chat-row').first().waitFor();
  await eventually(async () => { assert.equal(await page.locator('.statusbar').getByText('Serveur local connecté').count(), 1); });
  assert.deepEqual(problems, []);
});

test('sidebar: 1,000 chats render < 50 ms and are virtualised above 300 rows', { skip: SKIP }, async () => {
  const big: Mock = await startMockServer({ chats: 1000 });
  try {
    const { page } = await openApp(big);
    const res = await page.evaluate(async () => {
      const input = document.querySelector('.side-filter');
      const t0 = performance.now();
      input.value = 'e';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      return { ms: performance.now() - t0, dom: document.querySelectorAll('.side-list .row').length, h: document.querySelector('.side-inner').offsetHeight };
    });
    console.log(`# paint: 1,000-row filter ${res.ms.toFixed(1)} ms, ${res.dom} rows mounted, list height ${res.h} px`);
    assert.ok(res.ms < 50, `${res.ms} ms`);
    assert.ok(res.dom < 120, `virtualised: ${res.dom} rows in the DOM`);
    assert.ok(res.h > 28 * 300, 'full scroll height kept');
    await page.locator('.side-list').evaluate((el) => { el.scrollTop = 20_000; });
    await page.waitForTimeout(100);
    await eventually(async () => { assert.ok(await page.locator('.side-list .chat-row').count() > 10, 'rows rendered after scrolling'); });
  } finally { await big.close(); }
});

test('À traiter: oldest need first; Alt+A cycles through it', { skip: SKIP }, async () => {
  const { page } = await openApp();
  const att = await page.locator('.chat-row.with-reason .row-title').allInnerTexts();
  assert.deepEqual(att.slice(0, 2), ['Fix CI', 'Réparer le démarrage Edge'], 'needs_permission (2 min) before needs_answer (1 min)');
  await eventually(async () => { assert.match(await page.locator('.chat-row.with-reason .row-sub').first().innerText(), /Bash · npm ci/); });
  await page.keyboard.press('Alt+a');
  assert.equal(await focusedPaneChat(page), chatIdOf('Fix CI'));
  await page.keyboard.press('Alt+a');
  assert.equal(await focusedPaneChat(page), chatIdOf('Réparer le démarrage Edge'));
  await page.waitForTimeout(1100);
  await eventually(async () => { assert.match(await page.title(), /^!2 ✕1 ✓1 · SidMultiClaude$/); });
});

test('Ctrl+K: prefixes e: and >, Entrée opens; theme action applies', { skip: SKIP }, async () => {
  const { page } = await openApp();
  const first = page.locator('.chat-row[data-chat]').first();
  await first.focus();
  const opener = await first.getAttribute('data-chat');
  await page.keyboard.press('Control+k');
  await page.locator('.sw-input').waitFor();
  await page.keyboard.press('Escape');
  await eventually(async () => { assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-chat')), opener, 'focus restored on close'); });
  await page.keyboard.press('Control+k');
  const input = page.locator('.sw-input');
  await input.waitFor();
  await input.fill('e:attente');
  await eventually(async () => { assert.deepEqual((await page.locator('.sw-item .sw-title').allInnerTexts()).sort(), ['Fix CI', 'Réparer le démarrage Edge']); });
  await input.fill('c:acme migration');
  await eventually(async () => { assert.ok((await page.locator('.sw-item').count()) >= 1); });
  await input.fill('demarrage edge');
  await page.keyboard.press('Enter');
  await eventually(async () => { assert.equal(await focusedPaneChat(page), chatIdOf('Réparer le démarrage Edge')); });
  await page.keyboard.press('Control+k');
  await page.locator('.sw-input').fill('>sombre');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  assert.equal(sent('settings.set').at(-1).patch.theme, 'dark');
  await page.keyboard.press('Control+k');
  await page.locator('.sw-input').fill('>thème du système');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme'));
});

test('tabs and layouts: Ctrl+click = new pane, Alt+L, Alt+1…9 on event.code (AZERTY key), Alt+W keeps Claude running', { skip: SKIP }, async () => {
  const { page } = await openApp();
  const rows = page.locator('.chat-row[data-chat]');
  await rows.nth(5).click();
  await rows.nth(6).click({ modifiers: ['Control'] });
  await eventually(async () => { assert.equal(await page.locator('.panegrid.layout-2').count(), 1); });
  await eventually(async () => { assert.equal(await page.locator('.tab').count(), 2); });
  await page.keyboard.press('Alt+l');
  await eventually(async () => { assert.equal(await page.locator('.panegrid.layout-3').count(), 1); });
  const tabs = await page.locator('.tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-chat')));
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '&', code: 'Digit1', altKey: true, bubbles: true, cancelable: true })));
  await eventually(async () => { assert.equal(await page.locator('.tab.active').getAttribute('data-chat'), tabs[0]); });
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'é', code: 'Digit2', altKey: true, bubbles: true, cancelable: true })));
  await eventually(async () => { assert.equal(await page.locator('.tab.active').getAttribute('data-chat'), tabs[1]); });
  const before = m.requests.length;
  await page.keyboard.press('Alt+w');
  await eventually(async () => { assert.equal(await page.locator('.tab').count(), 1); });
  assert.equal(sent('chat.sleep', before).length + sent('chat.interrupt', before).length, 0, 'closing a tab never stops Claude');
  await page.keyboard.press('Alt+z');
  await eventually(async () => { assert.equal(await page.locator('.tab').count(), 2); });
});

test('Peek: hover prefetches tx.page after 150 ms; Espace opens, Échap closes, Entrée opens the chat', { skip: SKIP }, async () => {
  const { page } = await openApp();
  const id = chatIdOf('Doc install');                // a chat without a pending card (Échap closes the Peek even on a card: test/browser/chat/m2.test.ts)
  const row = page.locator(`.chat-row[data-chat="${id}"]`).first();
  const from = m.requests.length;
  await row.hover();
  await m.waitFor((r) => r.t === 'tx.page' && r.chatId === id && m.requests.indexOf(r) >= from, 2000);
  await row.focus();
  await page.keyboard.press('Space');
  await page.locator('.peek').waitFor();
  await eventually(async () => { assert.match(await page.locator('.peek .pk-head').innerText(), /^Aperçu · /); });
  assert.equal(await page.locator('.peek .pk-head').count(), 1, 'one panel: the shell frame adds no second header');
  assert.equal(sent('chat.prespawn', from).length, 0, 'Peek never spawns');
  assert.equal(sent('tx.page', from).filter((r) => r.chatId === id).length, 1, 'prefetched once, not asked again on Espace');
  await page.keyboard.press('Escape');
  await eventually(async () => { assert.equal(await page.locator('.peek').count(), 0); });
  await eventually(async () => { assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-chat')), id, 'focus back on the row'); });
  await row.focus();
  await page.keyboard.press('Space');
  await page.locator('.peek').waitFor();
  await page.keyboard.press('Enter');
  await eventually(async () => { assert.equal(await focusedPaneChat(page), id); });
});

test('new chat: S9 refusal inline, trust step, create and send', { skip: SKIP }, async () => {
  const { page } = await openApp();
  await page.keyboard.press('Alt+n');
  const cwd = page.locator('#nc-cwd');
  await cwd.waitFor();
  await cwd.fill('C:\\Users\\me');
  await page.getByText('Votre dossier personnel entier ne peut pas servir de dossier de travail', { exact: false }).waitFor();
  await cwd.fill('C:\\Users\\me\\proj\\introuvable');
  await page.getByText('Ce dossier n\'existe pas.').waitFor();
  await cwd.fill('C:\\Users\\me\\proj\\nouveau');
  await page.waitForTimeout(400);
  await page.locator('.nc-prompt').fill('Bonjour @src/app.ts\nsuite');
  const from = m.requests.length;
  await page.locator('.nc-prompt').press('Enter');
  await page.locator('.trust').waitFor();
  assert.equal(sent('chat.create', from)[0].trust, undefined, 'first create without trust');
  await page.getByRole('button', { name: 'Faire confiance' }).click();
  const create = await m.waitFor((r) => r.t === 'chat.create' && r.trust === true);
  assert.equal(create.cwd, 'C:\\Users\\me\\proj\\nouveau');
  assert.equal(create.title, 'Bonjour suite'.slice(0, 7), 'title from the first line, @mention removed');
  assert.equal('model' in create, false, '« Par défaut » omits the model (token parity)');
  const send = await m.waitFor((r) => r.t === 'chat.send' && r.text.startsWith('Bonjour'));
  assert.equal(await focusedPaneChat(page), send.chatId);
  await page.locator(`.chat-row[data-chat="${send.chatId}"]`).first().waitFor();
});

test('resume browser: search, preview through tx.page, Entrée opens', { skip: SKIP }, async () => {
  const { page } = await openApp();
  await page.keyboard.press('Alt+r');
  const input = page.getByPlaceholder('Rechercher (titre, dossier, branche, premier message)…');
  await input.fill('migration db 3');
  await page.locator('.resume-row.sel').waitFor();
  const title = await page.locator('.resume-row.sel .r-title').innerText();
  assert.match(title, /^Migration DB/);
  await page.locator('.resume-preview').waitFor();
  await eventually(async () => { assert.match(await page.locator('.resume-preview').innerText(), /Réponse/); });
  await input.press('Enter');
  assert.equal(await focusedPaneChat(page), chatIdOf(title));
});

test('rename with F2 in the sidebar sends chat.rename and updates every row', { skip: SKIP }, async () => {
  const { page } = await openApp();
  const row = page.locator('.chat-row[data-chat]').nth(10);
  const id = await row.getAttribute('data-chat');
  await row.focus();
  await page.keyboard.press('F2');
  const edit = page.locator('.row-edit');
  await edit.fill('Titre renommé');
  await edit.press('Enter');
  const r = await m.waitFor((q) => q.t === 'chat.rename' && q.chatId === id);
  assert.equal(r.title, 'Titre renommé');
  await page.locator(`.chat-row[data-chat="${id}"] .row-title`, { hasText: 'Titre renommé' }).first().waitFor();
});

test('accounts panel and the fake login flow (url → code → done)', { skip: SKIP }, async () => {
  m.world.accounts.push({ ...m.world.accounts[0], id: 'perso2', name: 'Perso 2', color: 3, monogram: '2', configDir: 'C:\\Users\\me\\.claude-perso',
    isDefault: false, login: 'disconnected', identity: undefined, usage: undefined });
  try {
    const { page } = await openApp();
    await page.keyboard.press('Alt+c');
    await page.locator('.acc-card').first().waitFor();
    await eventually(async () => { assert.equal(await page.locator('.acc-card:not(.add-card)').count(), 3); });
    await page.locator('.add-card code', { hasText: 'claude-perso' }).waitFor();
    await page.locator('.acc-card', { hasText: 'Perso 2' }).getByRole('button', { name: 'Se connecter' }).click();
    const from = m.requests.length;
    await page.locator('.login').getByRole('button', { name: 'Se connecter' }).click();
    // the mock sends `url` and `waiting` in one frame, like the real LoginService: the URL and the code field must stay
    await page.getByRole('button', { name: 'Ouvrir la page de connexion' }).waitFor();
    await page.locator('.login input.mono').fill('code#state');
    await page.getByRole('button', { name: 'Valider' }).click();
    await page.getByText('Connecté en tant que perso2@example.invalid (Max)').waitFor();
    assert.equal(sent('account.loginCode').at(-1).code, 'code#state');
    await page.locator('.login').getByRole('button', { name: 'Fermer' }).first().click();
    await page.locator('.acc-card').first().waitFor();
    assert.equal(sent('account.loginCancel', from).length, 0, 'a login in progress or done is never cancelled by the dialog itself');
  } finally { m.world.accounts.pop(); }
});

test('settings: Ctrl+, opens; changes are sent at once (settings.set) and applied (theme, density)', { skip: SKIP }, async () => {
  const { page } = await openApp();
  await page.keyboard.press('Control+,');
  await page.locator('.settings').waitFor();
  await page.locator('.settings label', { hasText: 'Sombre' }).click();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  await page.locator('.settings label', { hasText: 'Confortable' }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains('density-comfortable'));
  assert.equal(sent('settings.set').at(-1).patch.density, 'comfortable');
  await page.locator('.settings label', { hasText: 'Compacte' }).click();
  await page.locator('.settings label', { hasText: 'Clair' }).click();
  await page.keyboard.press('Escape');
  await eventually(async () => { assert.equal(await page.locator('.settings').count(), 0); });
});

test('reconnect: same boot → banner, view re-sent, no duplicate rows; new boot → hello again, caches dropped', { skip: SKIP }, async () => {
  const { page } = await openApp();
  const rows = await page.locator('.chat-row[data-chat]').count();
  const id = chatIdOf('Doc install');
  await page.locator(`.chat-row[data-chat="${id}"]`).first().click();
  await m.waitFor((r) => r.t === 'view' && r.full.includes(id));
  let from = m.requests.length;
  // a seq gap (an ev lost) → the same view is sent again, which the server answers with a fresh snap (§6.2)
  m.push([{ t: 'ev', c: id, s: 1_000_000, ev: { k: 'todos', todos: null } }]);
  const resync = await m.waitFor((r) => r.t === 'view' && m.requests.indexOf(r) >= from, 5000);
  assert.deepEqual(resync.full, [id]);
  from = m.requests.length;
  m.drop();
  await page.getByText('Connexion au serveur local perdue — reconnexion…').waitFor();
  await page.getByText('Reconnecté').waitFor({ timeout: 10_000 });
  await m.waitFor((r) => r.t === 'view' && r.full.includes(id) && m.requests.indexOf(r) >= from, 10_000);
  await eventually(async () => { assert.equal(await page.locator('.chat-row[data-chat]').count(), rows); });
  from = m.requests.length;
  m.restart();
  await m.waitFor((r) => r.t === 'view' && m.requests.indexOf(r) >= from, 10_000);
  await m.waitFor((r) => r.t === 'tx.page' && r.chatId === id && m.requests.indexOf(r) >= from, 10_000);
  await eventually(async () => { assert.equal(await page.locator('.chat-row[data-chat]').count(), rows); });
  assert.equal(await focusedPaneChat(page), id, 'layout kept across a server restart');
});

test('notifications: only when not looking, tag chatId:kind, no input text; DND silences; title !n', { skip: SKIP }, async () => {
  const { page } = await openApp(m, { notifications: true });
  const id = chatIdOf('Doc install');
  const s0 = m.world.chats.get(id);
  const needs = { ...s0, state: { ...s0.state, phase: 'needs_permission', since: Date.now(), flags: { ...s0.state.flags, live: true }, pending: { count: 1, oldestAt: Date.now(), kind: 'permission' } } };
  const ask = { chatId: id, requestId: 'n-1', toolUseId: 'tu-n1', kind: 'permission', toolName: 'Bash', input: { command: 'cat secret.txt' },
    offerAlways: false, alwaysRules: [], offerAuto: false, defaultToNo: false, since: Date.now() };
  m.push([{ t: 'ask', ask }, { t: 'chats', upsert: [needs], remove: [] }]);
  await eventually(async () => { assert.equal(await page.evaluate(() => (window as any).__notifs.length), 1); });
  const n = await page.evaluate(() => (window as any).__notifs[0]);
  assert.equal(n.tag, `${id}:perm`);
  assert.equal(n.silent, true);
  assert.doesNotMatch(`${n.title} ${n.body}`, /secret/, 'no tool input in notifications (S17)');
  assert.equal(n.actions, undefined, 'never an approve button');
  await eventually(async () => { assert.match(await page.title(), /^!3 /); });
  // looking at it: shown in a pane of a focused, visible window → no notification
  await page.locator(`.chat-row[data-chat="${id}"]`).first().click();
  await page.evaluate(() => { (window as any).__notifs.length = 0; });
  m.push([{ t: 'chats', upsert: [{ ...needs, state: { ...needs.state, phase: 'idle', pending: { count: 0 } } }], remove: [] }]);
  m.push([{ t: 'chats', upsert: [{ ...needs, state: { ...needs.state, pending: { count: 1, oldestAt: Date.now() } } }], remove: [] }]);
  const focused = await page.evaluate(() => document.hasFocus());
  await page.waitForTimeout(300);
  if (focused) assert.equal(await page.evaluate(() => (window as any).__notifs.length), 0, 'looking: no notification');
  // DND
  const other = chatIdOf('Bug login 2');
  const o0 = m.world.chats.get(other);
  await page.evaluate(() => { (window as any).__notifs.length = 0; });
  m.world.settings.dndUntil = Date.now() + 3_600_000;
  m.push([{ t: 'settings', settings: m.world.settings }]);
  m.push([{ t: 'chats', upsert: [{ ...o0, state: { ...o0.state, phase: 'error', since: Date.now() } }], remove: [] }]);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => (window as any).__notifs.length), 0, 'DND: nothing');
  m.world.settings.dndUntil = null;
  m.push([{ t: 'settings', settings: m.world.settings }, { t: 'askEnd', chatId: id, requestId: 'n-1', reason: 'answered' }, { t: 'chats', upsert: [s0, o0], remove: [] }]);
});

test('orphans dialog kills exactly the listed pids; quit asks for confirmation when chats are live', { skip: SKIP }, async () => {
  const { page } = await openApp();
  m.push([{ t: 'orphans', items: [{ pid: 4242, name: 'node.exe' }, { pid: 4343, name: 'python.exe' }] }]);
  await page.getByText('Des processus lancés par Claude tournent encore (node.exe, python.exe). Les arrêter ?').waitFor();
  await page.getByRole('button', { name: 'Arrêter', exact: true }).click();
  const kill = await m.waitFor((r) => r.t === 'orphans.kill');
  assert.deepEqual(kill.pids, [4242, 4343]);
  await page.keyboard.press('Control+k');
  await page.locator('.sw-input').fill('>quitter');
  await page.keyboard.press('Enter');
  await page.getByText(/chat\(s\) actif\(s\)\. Quitter les arrêtera/).waitFor();
  await page.getByRole('button', { name: 'Annuler' }).click();
  assert.equal(m.requests.filter((r) => r.t === 'app.quit' && r.force).length, 0, 'cancel: no forced quit');
});
