// test/e2e/shell.e2e.ts — the web shell against the REAL server: SMC_TEST=1, temp app dir and profiles,
// SMC_CLAUDE_EXE = test/fakes/fake-claude.mjs (magic prompts), random port, boot code read from stdout, installed Edge.
// Zero tokens: no real account is ever used. Flows: boot + device-token reload with 200 chats on disk · 1,000 sidebar rows
// (virtualised) · À traiter from real asks + Alt+A · Ctrl+K prefixes and actions · tabs, layouts, Alt+1…9 (AZERTY) ·
// Peek (Échap always closes, never answers) · new chat (S9, trust, create + send) · resume browser · rename (F2) ·
// accounts + login error rendered through i18n · settings · server restart (device token, layout kept) · notifications ·
// quit confirmation. The scripted variants of these flows (seq gaps, orphans, DND, fake login) run against the mock
// server in test/browser/shell/shell-mock.test.ts. Owner: M2 web integrator.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { addAllAccounts, edgeInstalled, launch, restartServer } from './harness.ts';
import type { Harness } from './harness.ts';
import { createTmpRoot } from '../helpers/tmp-profile.ts';
import type { TmpProfile, TmpRoot } from '../helpers/tmp-profile.ts';
import { connectWs } from '../helpers/ws-client.ts';
import type { WsClient } from '../helpers/ws-client.ts';
import type * as P from '../../src/shared/protocol.ts';

// DOM globals used inside page.evaluate callbacks (this file compiles without lib.dom; module-scoped declarations)
declare const window: any, document: any, localStorage: any, requestAnimationFrame: any, KeyboardEvent: any, Event: any, WebSocket: any;

const SKIP = edgeInstalled() ? false : 'Microsoft Edge is not installed';
const TITLES = ['Fix CI', 'Réparer le démarrage Edge', 'Migration DB', 'Refacto auth'];
let root: TmpRoot;
let h: Harness;
let side: WsClient;
let cwd: string;
let accounts: P.AccountView[] = [];
let big: TmpProfile;

/** Every C2S frame the page sends (parsed), kept across reloads in sessionStorage-free window state. */
const RECORDER = () => {
  const w = window as any;
  w.__sent = [];
  w.__notifs = [];
  w.Notification = class { static permission = 'granted'; static requestPermission = async () => 'granted';
    onclick: unknown = null; constructor(title: string, opts: any) { w.__notifs.push({ title, ...opts }); } close() {} };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d: any) { try { w.__sent.push(JSON.parse(String(d))); } catch { /* binary */ } return send.call(this, d); };
};

const page = (): Page => h.page;
/** Frames of type `t` the page sent since index `from` of window.__sent. */
const sent = async (t: string, from = 0): Promise<any[]> => page().evaluate(([x, f]) => (window as any).__sent.slice(f).filter((r: any) => r.t === x), [t, from] as const);
const mark = async (): Promise<number> => page().evaluate(() => (window as any).__sent.length);
/** Retries an assertion until it passes (renders are asynchronous) or `ms` elapse. */
async function eventually(check: () => Promise<void> | void, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try { await check(); return; } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 50)); }
  }
}
const titleOf = (t: string) => page().locator('.chat-row[data-chat]', { has: page().locator('.row-title', { hasText: t }) }).first();
/** chatId of the chat titled `t`, from the page's store (rows of a long list may be virtualised away). */
const idOfTitle = async (t: string): Promise<string> => page().evaluate(async (x) =>
  [...(await import('/app/store.js' as string)).chats.value.values()].find((s: any) => s.title === x)?.chatId ?? '', t);
const focusedPaneChat = () => page().locator('.pane-cell').nth(0).getAttribute('data-chat');
const problems: string[] = [];

before(async () => {
  if (SKIP) return;
  root = createTmpRoot('shell-e2e');
  cwd = root.cwd('demo-app');
  const def = root.defaultProfile({ login: 'connected' });
  const pro = root.profile('pro', { login: 'connected' });
  big = root.profile('big', { login: 'connected' });
  root.profile('perso2', { login: 'disconnected' });
  def.trust(cwd); pro.trust(cwd);
  const t0 = Date.UTC(2026, 9, 1, 8, 0, 0);
  const dirs = Array.from({ length: 5 }, (_, i) => root.cwd(`proj-${i}`));
  for (let i = 0; i < 199; i++) {
    pro.addSession({ cwd: dirs[i % 5]!, title: `${TITLES[i % 4]} ${i}`, startedAt: t0 + i * 60_000, mtime: new Date(t0 + i * 60_000),
      turns: [{ user: `Regarde le module ${i}`, assistant: `Réponse ${i}` }] });
  }
  pro.addSession({ cwd, title: 'Doc install', startedAt: t0 + 300 * 60_000, mtime: new Date(t0 + 300 * 60_000),
    turns: [{ user: 'Comment installer ?', assistant: 'Réponse : npm ci' }] });
  for (let i = 0; i < 800; i++) big.addSession({ cwd: dirs[i % 5]!, title: `Archive ${i}`, startedAt: t0 - (i + 1) * 60_000, mtime: new Date(t0 - (i + 1) * 60_000) });
  h = await launch({ root, viewport: { width: 1400, height: 900 }, beforeGoto: async (c) => { await c.addInitScript(RECORDER); } });
  page().on('console', (msg) => { if (msg.type() === 'error' && !/favicon/i.test(msg.text())) problems.push(msg.text()); });
  page().on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page().waitForFunction(() => !!localStorage.getItem('smc.device'), null, { timeout: 15_000 });
  const token = await page().evaluate(() => localStorage.getItem('smc.device')) ?? '';
  side = await connectWs({ port: h.server.port, token });
  await side.next((m) => m.t === 'hello', 10_000);
  accounts = await addAllAccounts(side, { '': { name: 'Perso', monogram: 'P' }, '.claude-pro': { name: 'Pro', monogram: 'W' },
    '.claude-perso2': { name: 'Perso 2', monogram: '2' } }, ['', '.claude-pro', '.claude-perso2']);
  // up to 8 live chats: the asks of this suite stay pending while panes open other chats (the cap has its own E2E in chat.e2e.ts)
  assert.ok((await side.request({ t: 'settings.set', patch: { maxLive: 8 } })).ok);
  await eventually(async () => { assert.ok(await page().locator('.chat-row[data-chat]').count() > 20); }, 20_000);
});
afterEach(() => {
  assert.deepEqual(problems.splice(0).filter((p) => /Content Security Policy|TrustedHTML|Trusted Type|pageerror/i.test(p)), []);
});
after(async () => { await side?.close().catch(() => {}); await h?.close(); root?.dispose(); });

test('boot: hello → paint < 300 ms with 200 chats on disk; #boot dropped; reload works with the device token', { skip: SKIP }, async () => {
  assert.equal(new URL(page().url()).hash, '', 'boot code removed from the URL');
  await page().reload();
  await page().locator('.chat-row').first().waitFor();
  // the measure is taken in the requestAnimationFrame after the paint: wait for it (it could be read one frame early: -1)
  await page().waitForFunction(() => performance.getEntriesByName('smc:hello→paint').length > 0, null, { timeout: 5_000 });
  const ms = await page().evaluate(() => performance.getEntriesByName('smc:hello→paint')[0]?.duration ?? -1);
  console.log(`# paint: hello→paint ${ms.toFixed(1)} ms (200 chats, real server)`);
  assert.ok(ms >= 0 && ms < 300, `hello→paint ${ms} ms`);
  await eventually(async () => { assert.equal(await page().locator('.statusbar').getByText('Serveur local connecté').count(), 1); });
  await titleOf('Doc install').waitFor();
  assert.ok(await page().locator('.chat-row[data-chat]').count() >= 20, 'rows painted');
});

test('sidebar: 1,000 chats (a third account added live) filter < 50 ms and are virtualised above 300 rows', { skip: SKIP }, async () => {
  accounts = await addAllAccounts(side, { '.claude-big': { name: 'Archives', monogram: 'A' } }, ['.claude-big']);
  await eventually(async () => {
    const n = await page().evaluate(async () => (await import('/app/store.js' as string)).chats.value.size ?? 0);
    assert.ok(n >= 1000, `${n} chats`);
  }, 20_000);
  const res = await page().evaluate(async () => {
    const input = document.querySelector('.side-filter');
    const t0 = performance.now();
    input.value = 'e';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return { ms: performance.now() - t0, dom: document.querySelectorAll('.side-list .row').length, h: document.querySelector('.side-inner').offsetHeight };
  });
  console.log(`# paint: 1,000-row filter ${res.ms.toFixed(1)} ms, ${res.dom} rows mounted, list height ${res.h} px (real server)`);
  assert.ok(res.ms < 50, `${res.ms} ms`);
  assert.ok(res.dom < 120, `virtualised: ${res.dom} rows in the DOM`);
  assert.ok(res.h > 28 * 300, 'full scroll height kept');
  await page().locator('.side-list').evaluate((el) => { el.scrollTop = 20_000; });
  await eventually(async () => { assert.ok(await page().locator('.side-list .chat-row').count() > 10, 'rows rendered after scrolling'); });
  await page().evaluate(() => { const i = document.querySelector('.side-filter'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page().locator('.side-list').evaluate((el) => { el.scrollTop = 0; });
});

const pro = (): string => accounts.find((a) => a.name === 'Pro')?.id ?? '';
/** A chat created by a side client (not opened in a pane): its first prompt is sent at once. */
async function sideChat(title: string, prompt: string): Promise<string> {
  const r = await side.request({ t: 'chat.create', accountId: pro(), cwd, title, mode: 'default', trust: true });
  assert.ok(r.ok, `chat.create: ${JSON.stringify(r)}`);
  const chatId = (r.data as { chatId: string }).chatId;
  // exceed: a machine low on free memory caps live chats at 2 (pool lowMem) and pending asks are never evicted
  const s = await side.request({ t: 'chat.send', chatId, uuid: crypto.randomUUID(), text: prompt, exceed: true }, 15_000);
  assert.ok(s.ok, `chat.send: ${JSON.stringify(s)}`);
  return chatId;
}
const waitReason = (id: string) => page().locator(`.chat-row.with-reason[data-chat="${id}"]`).first().waitFor({ timeout: 30_000 });
let askId = '';
let questionId = '';

test('À traiter: real asks (permission, then question) listed oldest first; Alt+A cycles; title !2', { skip: SKIP }, async () => {
  askId = await sideChat('Attente permission', 'ASK:npm ci');
  await waitReason(askId);
  questionId = await sideChat('Attente question', 'QUESTION:Quelle couleur ?');
  await waitReason(questionId);
  const att = await page().locator('.chat-row.with-reason').evaluateAll((els) => els.map((e) => e.getAttribute('data-chat')));
  assert.deepEqual(att.slice(0, 2), [askId, questionId], 'needs_permission (older) before needs_answer');
  await eventually(async () => { assert.match(await page().locator(`.chat-row.with-reason[data-chat="${askId}"] .row-sub`).first().innerText(), /Bash · npm ci/); });
  await page().locator('.side-filter').focus();
  await page().keyboard.press('Alt+a');
  await eventually(async () => { assert.equal(await focusedPaneChat(), askId); });
  await page().keyboard.press('Alt+a');
  await eventually(async () => { assert.equal(await focusedPaneChat(), questionId); });
  await eventually(async () => { assert.match(await page().title(), /^!2 .*SidMultiClaude$/); }, 5000);
});

test('Ctrl+K: e: lists the waiting chats, a fuzzy query + Entrée opens, > runs an action (theme)', { skip: SKIP }, async () => {
  await page().keyboard.press('Control+k');
  const input = page().locator('.sw-input');
  await input.waitFor();
  await input.fill('e:attente');
  await eventually(async () => { assert.deepEqual((await page().locator('.sw-item .sw-title').allInnerTexts()).sort(), ['Attente permission', 'Attente question']); });
  await input.fill('demarrage edge 13');
  await eventually(async () => { assert.match(await page().locator('.sw-item.sel .sw-title, .sw-item[aria-selected="true"] .sw-title').first().innerText(), /démarrage Edge/); });
  await page().keyboard.press('Enter');
  const opened = await idOfTitle('Réparer le démarrage Edge 13');
  await eventually(async () => { assert.equal(await focusedPaneChat(), opened); });
  const from = await mark();
  await page().keyboard.press('Control+k');
  await page().locator('.sw-input').fill('>sombre');
  await page().keyboard.press('Enter');
  await page().waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  assert.equal((await sent('settings.set', from)).at(-1)?.patch.theme, 'dark');
  await page().keyboard.press('Control+k');
  await page().locator('.sw-input').fill('>thème du système');
  await page().keyboard.press('Enter');
  await page().waitForFunction(() => !document.documentElement.hasAttribute('data-theme'));
});

/** Closes every tab and goes back to one pane (Claude keeps running: closing a tab never stops it). */
async function resetTabs(): Promise<void> {
  await page().evaluate(async () => {
    const a = await import('/app/actions.js' as string); const s = await import('/app/store.js' as string);
    for (const c of [...s.ui.value.tabs]) a.closeTab(c);
    a.setLayout(1);
  });
  await eventually(async () => { assert.equal(await page().locator('.tab').count(), 0); });
}

test('tabs and layouts: Ctrl+click = new pane, Alt+L, Alt+1…9 on event.code (AZERTY key), Alt+W keeps Claude running', { skip: SKIP }, async () => {
  await resetTabs();
  const rows = page().locator('.side-list .chat-row[data-chat]');
  await rows.nth(5).click();
  await rows.nth(6).click({ modifiers: ['Control'] });
  await eventually(async () => { assert.equal(await page().locator('.panegrid.layout-2').count(), 1); });
  await eventually(async () => { assert.equal(await page().locator('.tab').count(), 2); });
  await page().keyboard.press('Alt+l');
  await eventually(async () => { assert.equal(await page().locator('.panegrid.layout-3').count(), 1); });
  const tabs = await page().locator('.tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-chat')));
  await page().evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '&', code: 'Digit1', altKey: true, bubbles: true, cancelable: true })));
  await eventually(async () => { assert.equal(await page().locator('.tab.active').getAttribute('data-chat'), tabs[0]); });
  await page().evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'é', code: 'Digit2', altKey: true, bubbles: true, cancelable: true })));
  await eventually(async () => { assert.equal(await page().locator('.tab.active').getAttribute('data-chat'), tabs[1]); });
  const from = await mark();
  await page().keyboard.press('Alt+w');
  await eventually(async () => { assert.equal(await page().locator('.tab').count(), 1); });
  assert.equal((await sent('chat.sleep', from)).length + (await sent('chat.interrupt', from)).length, 0, 'closing a tab never stops Claude');
  await page().keyboard.press('Alt+z');
  await eventually(async () => { assert.equal(await page().locator('.tab').count(), 2); });
});

test('Peek on a chat with a pending card: Échap closes the Peek and never answers it; Entrée opens the chat', { skip: SKIP }, async () => {
  await resetTabs();
  const row = page().locator(`.chat-row[data-chat="${askId}"]`).first();
  await row.focus();
  const from = await mark();
  await page().keyboard.press('Space');
  await page().locator('.peek').waitFor();
  await eventually(async () => { assert.match(await page().locator('.peek .pk-head').innerText(), /^Aperçu · /); });
  await page().locator('.peek .d-card').first().waitFor({ timeout: 10_000 });
  await page().locator('.peek .d-card').first().focus();
  await page().keyboard.press('Escape');
  await eventually(async () => { assert.equal(await page().locator('.peek').count(), 0); });
  assert.deepEqual(await sent('chat.decide', from), [], 'Échap in Peek never answers a card (lead decision)');
  assert.equal((await sent('chat.prespawn', from)).length, 0, 'Peek never spawns');
  await eventually(async () => { assert.equal(await page().evaluate(() => document.activeElement?.getAttribute('data-chat')), askId, 'focus back on the row'); });
  await page().locator(`.chat-row.with-reason[data-chat="${askId}"]`).first().waitFor();
  await row.focus();
  await page().keyboard.press('Space');
  await page().locator('.peek').waitFor();
  await page().keyboard.press('Enter');
  await eventually(async () => { assert.equal(await focusedPaneChat(), askId); });
  await eventually(async () => { assert.equal(await page().locator('.peek').count(), 0); });
  // both asks done with: put them to sleep, so the UI sends below never meet the (low-memory) process cap
  for (const c of [askId, questionId]) assert.ok((await side.request({ t: 'chat.sleep', chatId: c, force: true }, 15_000)).ok);
  await eventually(async () => { assert.equal(await page().evaluate(async () => (await import('/app/store.js' as string)).procs.value?.live), 0); }, 15_000);
});

test('new chat: S9 refusal inline (the home folder), missing folder, trust step, create and send', { skip: SKIP }, async () => {
  const fresh = root.cwd('nouveau');                       // exists, never trusted by any profile
  await page().keyboard.press('Alt+n');
  const box = page().locator('#nc-cwd');
  await box.waitFor();
  await box.fill(root.home);
  await page().getByText('Votre dossier personnel entier ne peut pas servir de dossier de travail', { exact: false }).waitFor();
  await box.fill(`${fresh}\introuvable`);
  await page().getByText('Ce dossier n\'existe pas.').waitFor();
  await box.fill(fresh);
  await page().waitForTimeout(400);
  await page().locator('.nc-prompt').fill('ECHO: Bonjour @src/app.ts\nsuite');
  const from = await mark();
  await page().locator('.nc-prompt').press('Enter');
  await page().locator('.trust').waitFor({ timeout: 10_000 });
  assert.equal((await sent('chat.create', from))[0]?.trust, undefined, 'first create without trust');
  await page().getByRole('button', { name: 'Faire confiance' }).click();
  await eventually(async () => { assert.equal((await sent('chat.create', from)).filter((r) => r.trust === true).length, 1); });
  const create = (await sent('chat.create', from)).find((r) => r.trust === true);
  assert.equal(create.cwd.toLowerCase(), fresh.toLowerCase());
  assert.equal('model' in create, false, '« Par défaut » omits the model (token parity)');
  let send: any;
  await eventually(async () => { send = (await sent('chat.send', from)).find((r) => r.text.startsWith('ECHO: Bonjour')); assert.ok(send); }, 15_000);
  await eventually(async () => { assert.equal(await focusedPaneChat(), send.chatId); });
  await page().locator(`.c-pane[data-chat="${send.chatId}"] .c-assistant`, { hasText: 'Bonjour' }).first().waitFor({ timeout: 30_000 });
  await page().locator(`.chat-row[data-chat="${send.chatId}"]`).first().waitFor();
});

test('resume browser: search, preview through tx.page (from disk), Entrée opens', { skip: SKIP }, async () => {
  await page().keyboard.press('Alt+r');
  const input = page().getByPlaceholder('Rechercher (titre, dossier, branche, premier message)…');
  await input.fill('doc install');
  await page().locator('.resume-row.sel').waitFor();
  assert.equal(await page().locator('.resume-row.sel .r-title').innerText(), 'Doc install');
  await page().locator('.resume-preview').waitFor();
  await eventually(async () => { assert.match(await page().locator('.resume-preview').innerText(), /npm ci/); }, 10_000);
  await input.press('Enter');
  await eventually(async () => { assert.equal(await focusedPaneChat(), await idOfTitle('Doc install')); });
});

test('rename with F2 in the sidebar: chat.rename reaches the server and every row shows the new title', { skip: SKIP }, async () => {
  const row = page().locator('.side-list .chat-row[data-chat]').nth(10);
  const id = await row.getAttribute('data-chat');
  await row.focus();
  await page().keyboard.press('F2');
  const edit = page().locator('.row-edit');
  await edit.fill('Titre renommé');
  await edit.press('Enter');
  await page().locator(`.chat-row[data-chat="${id}"] .row-title`, { hasText: 'Titre renommé' }).first().waitFor({ timeout: 10_000 });
  await eventually(async () => { assert.ok(side.all('chats').some((f) => f.upsert.some((s) => s.chatId === id && s.title === 'Titre renommé')), 'server-side summary renamed'); });
});

test('accounts panel; a login error arrives as a key (login.err.*) and renders in French', { skip: SKIP }, async () => {
  await page().keyboard.press('Alt+c');
  await page().locator('.acc-card').first().waitFor();
  await eventually(async () => { assert.ok(await page().locator('.acc-card:not(.add-card)').count() >= 3); });
  await page().locator('.acc-card', { hasText: 'Perso 2' }).getByRole('button', { name: 'Se connecter' }).click();
  const from = await mark();
  await page().locator('.login').getByRole('button', { name: 'Se connecter' }).click();
  await eventually(async () => { assert.equal((await sent('account.login', from)).length, 1); });
  const acc = accounts.find((a) => a.name === 'Perso 2')!.id;
  const stepOf = async (): Promise<any> => page().evaluate(async (a) => (await import('/app/store.js' as string)).loginSteps.value[a], acc);
  // Under SMC_CLAUDE_EXE=fake-claude.mjs, `auth login` runs the fake under node.exe: the run waits for a code and a cancel
  // from another window ends it (login.err.cancelled). Should the spawn fail, the key is login.err.spawn.
  await page().waitForTimeout(500);
  if ((await stepOf())?.step !== 'error') assert.ok((await side.request({ t: 'account.loginCancel', accountId: acc })).ok);
  await eventually(async () => { assert.equal((await stepOf())?.step, 'error'); }, 10_000);
  const step = await stepOf();
  const french: Record<string, string> = { 'login.err.spawn': 'Impossible de lancer claude.exe pour la connexion.', 'login.err.cancelled': 'Connexion annulée.' };
  assert.ok(step.key in french, `key ${step.key}`);
  await page().locator('.login .msg.error', { hasText: french[step.key] }).waitFor({ timeout: 10_000 });
  assert.doesNotMatch(await page().locator('.login .msg.error').innerText(), /spawn refused|absolute/, 'the raw CLI detail is not the message shown');
  await page().keyboard.press('Escape');
  await eventually(async () => { assert.equal(await page().locator('.login').count(), 0); });
});

test('login end to end with the fake CLI: URL step, code pasted, done, the account turns connected', { skip: SKIP }, async () => {
  await page().keyboard.press('Alt+c');
  const card = page().locator('.acc-card', { hasText: 'Perso 2' });
  await card.waitFor();
  await card.getByRole('button', { name: 'Se connecter' }).click();
  await page().locator('.login input[type="email"]').fill('perso2@example.invalid');
  await page().locator('.login').getByRole('button', { name: 'Se connecter' }).click();
  const code = page().locator('.login input.mono');                         // never click « Ouvrir la page »: no real browser
  await code.waitFor({ timeout: 15_000 });
  await code.fill('fake-code#s1');
  const from = await mark();
  await page().locator('.login').getByRole('button', { name: 'Valider' }).click();
  await eventually(async () => { assert.equal((await sent('account.loginCode', from)).length, 1); });
  await page().locator('.login .msg.ok', { hasText: 'perso2@example.invalid' }).waitFor({ timeout: 15_000 });
  const acc = accounts.find((a) => a.name === 'Perso 2')!.id;
  await eventually(async () => {
    const v = side.all('accounts').flatMap((f) => f.accounts).filter((a) => a.id === acc).at(-1);
    assert.equal(v?.login, 'connected');
    assert.equal(v?.identity?.email, 'perso2@example.invalid');
  }, 15_000);
  await page().keyboard.press('Escape');                                    // closes the login, back to the accounts panel
  await eventually(async () => { assert.equal(await page().locator('.login').count(), 0); });
  await page().locator('.acc-card', { hasText: 'Perso 2' }).waitFor();
  await page().keyboard.press('Escape');
  await eventually(async () => { assert.equal(await page().locator('.acc-card').count(), 0); });
});

test('settings: Ctrl+, opens; changes are sent at once and come back from the server (theme, density)', { skip: SKIP }, async () => {
  await page().keyboard.press('Control+,');
  await page().locator('.settings').waitFor();
  await page().locator('.settings label', { hasText: 'Sombre' }).click();
  await page().waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  await page().locator('.settings label', { hasText: 'Confortable' }).click();
  await page().waitForFunction(() => document.documentElement.classList.contains('density-comfortable'));
  await eventually(async () => { assert.ok(side.all('settings').some((f) => f.settings.density === 'comfortable' && f.settings.theme === 'dark'), 'persisted by the server'); });
  await page().locator('.settings label', { hasText: 'Compacte' }).click();
  await page().locator('.settings label', { hasText: 'Clair' }).click();
  await page().keyboard.press('Escape');
  await eventually(async () => { assert.equal(await page().locator('.settings').count(), 0); });
});

test('notifications: a real ask in a chat not looked at notifies once, tag chatId:perm, no tool input; title !1', { skip: SKIP }, async () => {
  await resetTabs();
  const before = await page().evaluate(() => (window as any).__notifs.length);
  const id = await sideChat('Notifiée', 'ASK:cat secret.txt');
  await waitReason(id);
  await eventually(async () => { assert.equal(await page().evaluate(() => (window as any).__notifs.length), before + 1); }, 10_000);
  await page().waitForTimeout(1500);                       // a burst would replace it with notif.multi, never add a second one
  const list = await page().evaluate((b) => (window as any).__notifs.slice(b), before);
  assert.equal(list.length, 1, `one notification: ${JSON.stringify(list)}`);
  const n = list[0];
  assert.equal(n.tag, `${id}:perm`);
  assert.equal(n.silent, true);
  assert.doesNotMatch(`${n.title} ${n.body}`, /secret/, 'no tool input in notifications (S17)');
  assert.equal(n.actions, undefined, 'never an approve button');
  await eventually(async () => { assert.match(await page().title(), /^!1 /); });
});

test('quit asks for confirmation while chats are live; Annuler sends nothing', { skip: SKIP }, async () => {
  const from = await mark();
  await page().keyboard.press('Control+k');
  await page().locator('.sw-input').fill('>quitter');
  await page().keyboard.press('Enter');
  await page().getByText(/chat\(s\) actif\(s\)\. Quitter les arrêtera/).waitFor();
  await page().getByRole('button', { name: 'Annuler' }).click();
  await page().waitForTimeout(300);
  assert.equal((await sent('app.quit', from)).filter((r) => r.force).length, 0, 'cancel: no forced quit');
});

test('server restart on the same data dir: device token reconnect, hello resync, rows and layout kept', { skip: SKIP }, async () => {
  await resetTabs();
  const doc = await idOfTitle('Doc install');
  await page().evaluate(async (c) => { (await import('/app/actions.js' as string)).openChat(c, 'focused'); }, doc);
  await eventually(async () => { assert.equal(await focusedPaneChat(), doc); });
  const count = async (): Promise<number> => page().evaluate(async () => (await import('/app/store.js' as string)).chats.value.size);
  const rows = await count();
  const token = await page().evaluate(() => localStorage.getItem('smc.device'));
  await page().evaluate(async () => { (window as any).__smcStore = await import('/app/store.js' as string); });
  const bootBefore = await page().evaluate(() => (window as any).__smcStore.conn.value.boot);
  await side.close().catch(() => {});
  await restartServer(h);
  await page().waitForFunction((b) => { const s = (window as any).__smcStore.conn.value; return s.status === 'open' && s.boot !== b; }, bootBefore, { timeout: 30_000 });
  assert.equal(await page().evaluate(() => localStorage.getItem('smc.device')), token, 'same device token');
  side = await connectWs({ port: h.server.port, token: token ?? '' });
  await side.next((m) => m.t === 'hello', 10_000);
  await eventually(async () => { assert.equal(await count(), rows); }, 20_000);
  assert.equal(await focusedPaneChat(), doc, 'layout kept across a server restart');
  await page().locator(`.c-pane[data-chat="${doc}"] .c-assistant`, { hasText: 'npm ci' }).first().waitFor({ timeout: 15_000 });
  await eventually(async () => { assert.equal(await page().locator('.statusbar').getByText('Serveur local connecté').count(), 1); });
});
