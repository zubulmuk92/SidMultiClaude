// test/e2e/chat.e2e.ts — chat surface against the integrated app (SPEC §12.6), run at M2: real server in test mode
// (temp app dir and profiles), SMC_CLAUDE_EXE = test/fakes/fake-claude.mjs (magic prompts, SPEC §12.2 b), installed
// Edge through playwright-core. Zero tokens: no real account is ever used.
// Setup: one "connected" synthetic default profile and one named profile, a trusted work folder; chats are created
// through a side WebSocket client (the device token of the page) and opened in panes through the shell's actions.
import { after, afterEach, before, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { addAllAccounts, edgeInstalled, launch, restartServer } from './harness.ts';
import type { Harness } from './harness.ts';
import { createTmpRoot } from '../helpers/tmp-profile.ts';
import type { TmpRoot } from '../helpers/tmp-profile.ts';
import { connectWs } from '../helpers/ws-client.ts';
import type { WsClient } from '../helpers/ws-client.ts';
import type * as P from '../../src/shared/protocol.ts';
// Callbacks passed to page.evaluate() run in the browser; this file is compiled without the DOM lib (module-local names).
declare const document: any, window: any, KeyboardEvent: any, InputEvent: any, OffscreenCanvas: any, DataTransfer: any, File: any, ClipboardEvent: any, trustedTypes: any, localStorage: any;

const SKIP = edgeInstalled() ? false : 'Microsoft Edge is not installed';
/** Every test of this file drives Edge: each one is skipped with a reason when Edge is not installed. */
const test = (name: string, ...rest: any[]): Promise<void> =>
  nodeTest(name, { ...(typeof rest[0] === 'object' ? rest.shift() : {}), skip: SKIP }, rest[0]);

let root: TmpRoot;
let h: Harness;
let side: WsClient;
let cwd: string;
let accounts: P.AccountView[] = [];
const page = (): Page => h.page;

before(async () => {
  if (SKIP) return;
  root = createTmpRoot('chat-e2e');
  cwd = root.cwd('demo-app');
  const def = root.defaultProfile({ login: 'connected' });
  const pro = root.profile('pro', { login: 'connected' });
  def.trust(cwd); pro.trust(cwd);
  h = await launch({ root, viewport: { width: 1600, height: 1000 } });
  await page().waitForFunction(() => !!localStorage.getItem('smc.device'), null, { timeout: 15_000 });
  const token = await page().evaluate(() => localStorage.getItem('smc.device')) ?? '';
  side = await connectWs({ port: h.server.port, token });
  await side.next<Extract<P.S2C, { t: 'hello' }>>((m) => m.t === 'hello', 10_000);
  // the real server starts with no account: register both temp profiles (default = Perso, .claude-pro = Pro)
  accounts = await addAllAccounts(side, { '': { name: 'Perso', monogram: 'P' }, '.claude-pro': { name: 'Pro', monogram: 'W' } });
});
after(async () => { await side?.close().catch(() => {}); await h?.close(); root?.dispose(); });
/** Chats created by the running test: put back to sleep afterwards, so the next test never meets the process cap. */
const created: string[] = [];
afterEach(async () => {
  for (const c of created.splice(0)) await side.request({ t: 'chat.sleep', chatId: c, force: true }, 15_000).catch(() => {});
  // the ack comes before the process is gone: wait until the page's procs (hello + procs frames) count no live chat
  // (bounded). The page, not the side client: a side client reconnected after a restart may not have a procs frame yet.
  for (let i = 0; i < 60; i++) {
    const live = await page().evaluate(async (url) => (await import(url as string)).procs.value?.live ?? 1, '/app/store.js').catch(() => 1);
    if (live === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
});

/** Creates a chat on the account (default: the first connected one) and opens it in the focused pane. */
async function openNewChat(title: string, accountId = accounts.find((a) => a.login === 'connected')?.id ?? ''): Promise<string> {
  const r = await side.request({ t: 'chat.create', accountId, cwd, title, mode: 'default', trust: true });
  assert.ok(r.ok, `chat.create: ${JSON.stringify(r)}`);
  const chatId = (r.data as { chatId: string }).chatId;
  created.push(chatId);
  await page().evaluate(async ([c, url]) => { const m = await import(url as string); m.actions.openChat(c, 'newPane'); }, [chatId, '/app/actions.js']);
  await page().waitForSelector(`.c-pane[data-chat="${chatId}"] textarea.k-input`);
  return chatId;
}
const pane = (c: string) => page().locator(`.c-pane[data-chat="${c}"]`);
async function say(c: string, text: string, key = 'Enter'): Promise<void> {
  const box = pane(c).locator('textarea.k-input');
  await box.fill(text);
  await box.press(key);
}
const idle = (c: string) => page().waitForFunction((id) => /Prêt|Terminé/.test(document.querySelector(`.c-pane[data-chat="${id}"] .h-state`)?.textContent ?? ""), c, { timeout: 30_000 });
const card = (c: string) => pane(c).locator('.d-card').first();

test('stream: ECHO streams settled + tail and freezes into markdown with a footer', async () => {
  const c = await openNewChat('Écho');
  await say(c, 'ECHO: Bonjour **monde**\n\n```ts\nconst a = 1;\n```');
  await pane(c).locator('.c-text:not(.c-live) .md strong').waitFor({ timeout: 30_000 });
  assert.equal(await pane(c).locator('.c-text .md strong').first().textContent(), 'monde');
  await idle(c);
  assert.match(await pane(c).locator('.c-footer').last().textContent() ?? '', /entrée/);
});

test('permission: allow once, always (session), deny with a message', async () => {
  const c = await openNewChat('Autorisations');
  await say(c, 'ASK: npm ci');
  await card(c).waitFor({ timeout: 30_000 });
  // M3 (real run, screenshot 04): the CLI's decisionReason in French, the raw text in the tooltip
  const why = card(c).locator('.d-reason');
  assert.equal(await why.textContent(), 'Raison : Cette commande nécessite votre accord.');
  assert.equal(await why.getAttribute('title'), 'This command requires approval');
  await card(c).focus(); await page().keyboard.press('Digit1');
  await idle(c);
  await say(c, 'ASK: npm ci');
  await card(c).waitFor(); await card(c).focus(); await page().keyboard.press('Digit2');
  await idle(c);
  await say(c, 'ASK: rm -rf build');
  await card(c).waitFor(); await card(c).focus(); await page().keyboard.press('Digit3');
  await page().waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
  await page().keyboard.type('Pas maintenant'); await page().keyboard.press('Enter');
  await idle(c);
  assert.match(await pane(c).textContent() ?? '', /Refusé par vous/);
});

test('question and plan cards', async () => {
  const c = await openNewChat('Questions');
  await say(c, 'QUESTION: couleur');
  await card(c).waitFor({ timeout: 30_000 });
  await pane(c).locator('[data-q="0"] [data-opt="0"]').focus();
  for (let q = 0; q < (await pane(c).locator('[data-q]').count()); q++) { await page().keyboard.press('Digit1'); await page().keyboard.press('Tab'); }
  await page().keyboard.press('Control+Enter');
  await idle(c);
  await say(c, 'PLAN: fichier');
  await pane(c).locator('.d-plan').waitFor({ timeout: 30_000 });
  await card(c).focus(); await page().keyboard.press('Digit2');               // Manuel
  await idle(c);
});
test('Échap interrupts a slow turn (« Interrompu par vous »); the queue: fold, Alt+Entrée, ↑ takes back', async () => {
  const c = await openNewChat('File');
  await say(c, 'SLOW:400');                                                 // 16 s: still streaming when Échap comes
  await pane(c).locator('.c-live').waitFor({ timeout: 30_000 });
  await say(c, 'suite pendant le tour');                                    // folded at the next tool boundary
  await say(c, 'après ce tour', 'Alt+Enter');
  await pane(c).locator('.q-item', { hasText: 'après ce tour' }).locator('.q-state', { hasText: 'Après ce tour' }).waitFor();
  const box = pane(c).locator('textarea.k-input');
  await box.fill('');
  await box.press('ArrowUp');                                               // takes the waiting message back
  await page().waitForFunction((id) => (document.querySelector(`.c-pane[data-chat="${id}"] textarea.k-input`) as any).value.includes('après ce tour'), c);
  await box.fill('');
  await box.press('Escape');
  await pane(c).getByText('Interrompu par vous').waitFor({ timeout: 15_000 });
  await idle(c);
});

test('two panes stream at the same time', async () => {
  const a = await openNewChat('Volet A');
  const b = await openNewChat('Volet B');
  // 6 s each (was 1.6 s): under load the second spawn can take longer than the whole first stream (auditor M2 de-flake)
  await say(a, 'SLOW:150'); await say(b, 'SLOW:150');
  await page().waitForFunction(([x, y]) => !!document.querySelector(`.c-pane[data-chat="${x}"] .c-live`) && !!document.querySelector(`.c-pane[data-chat="${y}"] .c-live`), [a, b], { timeout: 30_000 });
  await idle(a); await idle(b);
});

test('sleep and wake: « Mettre en veille » then a send relaunches Claude', async () => {
  const c = await openNewChat('Veille');
  await say(c, 'ECHO: un'); await idle(c);
  await pane(c).locator('.h-more .c-menu-btn').click();
  await page().getByRole('menuitem', { name: 'Mettre en veille' }).click();
  await page().waitForFunction((id) => /En veille/.test(document.querySelector(`.c-pane[data-chat="${id}"] .h-state`)?.textContent ?? ''), c, { timeout: 30_000 });
  await say(c, 'ECHO: deux');
  await pane(c).getByText('deux', { exact: false }).last().waitFor({ timeout: 30_000 });
  await idle(c);
});

test('process cap: the 3rd live chat with maxLive 2 offers « Mettre en veille … » and sends after the choice', async () => {
  const r = await side.request({ t: 'settings.set', patch: { maxLive: 2 } });
  assert.ok(r.ok);
  try {
    const ids = [await openNewChat('Cap 1'), await openNewChat('Cap 2')];
    for (const c of ids) { await say(c, 'ECHO: chaud'); await idle(c); }
    // a chat shown in a pane is protected from eviction (pool.ts): close both tabs, Claude keeps running warm
    await page().evaluate(async ([x, url]) => { const m = await import(url as string); for (const c of x as string[]) m.closeTab(c); }, [ids, '/app/actions.js']);
    const third = await openNewChat('Cap 3');
    await say(third, 'ECHO: troisième');
    await pane(third).locator('.k-cap').waitFor({ timeout: 30_000 });
    await pane(third).locator('.k-cap button').first().click();
    await pane(third).getByText('troisième').last().waitFor({ timeout: 30_000 });
  } finally { await side.request({ t: 'settings.set', patch: { maxLive: 4 } }); }
});

test('crash with a pending ask: the card is withdrawn, the error banner shows, a queued message becomes « Non envoyé · Renvoyer »', async () => {
  const c = await openNewChat('Crash');
  await say(c, 'ASKCRASH:3');
  // queued at once, while the turn starts: the fake exits 150 ms after its ask, and a message typed after the crash would
  // simply relaunch Claude (a new process, no error banner) instead of being returned
  await say(c, 'en attente', 'Alt+Enter');
  await card(c).waitFor({ timeout: 5_000 }).catch(() => {});        // may already be withdrawn
  // the proof: the tool row of the transcript says « Demande annulée » (the dock's transient .d-gone line only shows when
  // the card had been rendered: an ask added and withdrawn within one render never had a card; auditor M2 de-flake)
  await pane(c).locator('.c-denial', { hasText: 'Demande annulée' }).first().waitFor({ timeout: 30_000 });
  await pane(c).locator('.b-err').waitFor();
  await pane(c).locator('.q-returned').waitFor({ timeout: 30_000 });
  await pane(c).locator('.q-returned button', { hasText: 'Renvoyer' }).click();
  // « Renvoyer » on a message the SERVER handed back really re-sends it (it used to do nothing: the client
  // only knew its own refused chips); the chip leaves the strip, the message runs in a new process
  await pane(c).locator('.c-user', { hasText: 'en attente' }).first().waitFor({ timeout: 30_000 });
  await idle(c);
  assert.equal(await pane(c).locator('.q-returned').count(), 0);
});

test('fork and « Continuer sur un autre compte » show the history at once; the first send goes on from it', async () => {
  // the named profile writes transcripts (CLAUDE_CONFIG_DIR is a temp dir); its projects folder did not exist at boot
  const c = await openNewChat('Origine', accounts.find((a) => a.name === 'Pro')?.id);
  await say(c, 'ECHO: histoire'); await idle(c);
  const forked = await page().evaluate(async ([x, url]) => (await import(url as string)).actions.fork(x, {}), [c, '/app/actions.js']) as string;
  created.push(forked);
  await page().evaluate(async ([x, url]) => { (await import(url as string)).actions.openChat(x, 'newPane'); }, [forked, '/app/actions.js']);
  await pane(forked).locator('.c-assistant', { hasText: 'histoire' }).first().waitFor({ timeout: 15_000 });   // before any send
  await say(forked, 'ECHO: suite'); await idle(forked);
  const perso = accounts.find((a) => a.name === 'Perso')!.id;
  const cont = await page().evaluate(async ([x, a, url]) => (await import(url as string)).actions.fork(x, { accountId: a }), [c, perso, '/app/actions.js']) as string;
  created.push(cont);
  assert.ok(cont.startsWith(`${perso}:`));
  await page().evaluate(async ([x, url]) => { (await import(url as string)).actions.openChat(x, 'newPane'); }, [cont, '/app/actions.js']);
  await pane(cont).locator('.c-assistant', { hasText: 'histoire' }).first().waitFor({ timeout: 15_000 });
  await say(cont, 'ECHO: ailleurs');
  await pane(cont).locator('.c-assistant', { hasText: 'ailleurs' }).first().waitFor({ timeout: 30_000 });
  await idle(cont);
});

test('cap_busy (every live chat on screen) offers « Dépasser la limite » inline, never a dead end', async () => {
  assert.ok((await side.request({ t: 'settings.set', patch: { maxLive: 2 } })).ok);
  try {
    const ids = [await openNewChat('Écran 1'), await openNewChat('Écran 2')];
    for (const x of ids) { await say(x, 'ECHO: chaud'); await idle(x); }
    const third = await openNewChat('Écran 3');                              // three panes: nothing may sleep
    await say(third, 'ECHO: quand même');
    await pane(third).locator('.k-cap').waitFor({ timeout: 30_000 });
    assert.match(await pane(third).locator('.k-cap').textContent() ?? '', /aucun ne peut être mis en veille/);
    await pane(third).getByRole('button', { name: /Dépasser la limite/ }).click();
    await pane(third).locator('.c-assistant', { hasText: 'quand même' }).first().waitFor({ timeout: 30_000 });
  } finally { await side.request({ t: 'settings.set', patch: { maxLive: 4 } }); }
});

test('a rejected plan reads « Plan proposé · <feedback> · Refusé par vous », an approved one « Plan approuvé » (no CLI English)', async () => {
  const c = await openNewChat('Plan refusé');
  await say(c, 'PLAN: fichier');
  await pane(c).locator('.d-plan').waitFor({ timeout: 30_000 });
  await card(c).focus(); await page().keyboard.press('Digit3');
  await page().waitForFunction(() => !!document.activeElement?.closest?.('.d-reject'));
  await page().keyboard.type('Ajoute des tests'); await page().keyboard.press('Enter');
  await pane(c).locator('.c-tool-denied', { hasText: 'Plan proposé · Ajoute des tests' }).locator('.c-denial', { hasText: 'Refusé par vous' }).waitFor({ timeout: 15_000 });
  await pane(c).locator('.d-plan').waitFor({ timeout: 15_000 });                 // the revised plan
  await card(c).focus(); await page().keyboard.press('Digit2');
  await idle(c);
  await pane(c).locator('.c-tool', { hasText: 'Plan approuvé' }).first().waitFor();
  assert.doesNotMatch(await pane(c).textContent() ?? '', /User has|Échec de ExitPlanMode/);
});

test('server restart on the same data dir: the window reconnects with its device token, hello resyncs, the chat goes on', async () => {
  // the named profile: its CLAUDE_CONFIG_DIR is the temp one, so fake-claude writes the transcript there (with the default
  // profile, CLAUDE_CONFIG_DIR is unset and the fake never writes under the real home)
  const c = await openNewChat('Redémarrage', accounts.find((a) => a.name === 'Pro')?.id);
  await say(c, 'ECHO: avant'); await idle(c);
  const token = await page().evaluate(() => localStorage.getItem('smc.device'));
  // the store module (same instance as the app's) on window: waitForFunction predicates must be synchronous
  await page().evaluate(async (url) => { (window as any).__smcStore = await import(url); }, '/app/store.js');
  const bootBefore = await page().evaluate(() => (window as any).__smcStore.conn.value.boot);
  await side.close().catch(() => {});
  await restartServer(h);                                                     // hard stop (tree) + new process, same port
  // the page was never reloaded: it reconnects by itself with the device token (no boot code any more) and gets a new hello
  await page().waitForFunction((b) => { const s = (window as any).__smcStore.conn.value; return s.status === 'open' && s.boot !== b; }, bootBefore, { timeout: 30_000 });
  assert.equal(await page().evaluate(() => localStorage.getItem('smc.device')), token, 'same device token');
  side = await connectWs({ port: h.server.port, token: token ?? '' });
  await side.next((m) => m.t === 'hello', 10_000);
  // the pane is still there although the hard-killed server may have lost the last ui.save (auditor M2: the window keeps
  // its newer layout after a restart) and the transcript is reloaded from disk
  await pane(c).locator('.c-assistant', { hasText: 'avant' }).first().waitFor({ timeout: 30_000 });
  await say(c, 'ECHO: après');                                                // resumes the session in a new process
  await pane(c).locator('.c-assistant', { hasText: 'après' }).first().waitFor({ timeout: 30_000 });
  await idle(c);
});

test('4-pane performance trace (SPEC §9.5): no long task over 50 ms while 4 chats stream; typing stays under 16 ms', async () => {
  const ids = [await openNewChat('Perf 1'), await openNewChat('Perf 2'), await openNewChat('Perf 3'), await openNewChat('Perf 4')];
  await page().evaluate(() => {
    (window as any).__longs = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as any).__longs.push(e.duration); }).observe({ type: 'longtask' } as any);
  });
  // sent by the side client with exceed: a machine low on free memory caps live chats at 2 (pool lowMem); the trace is
  // about four panes rendering streams, not about the cap (its own test above)
  for (const c of ids) assert.ok((await side.request({ t: 'chat.send', chatId: c, uuid: crypto.randomUUID(), text: 'SLOW:200', exceed: true }, 15_000)).ok);
  await page().waitForFunction((x) => x.every((id: string) => !!document.querySelector(`.c-pane[data-chat="${id}"] .c-live`)), ids, { timeout: 30_000 });
  const lat = await page().evaluate(async (id) => {
    const box = document.querySelector(`.c-pane[data-chat="${id}"] textarea.k-input`) as any;
    const out: number[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 70));
      const t0 = performance.now();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
      box.value += 'x'; box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      out.push(performance.now() - t0);
    }
    return out.sort((a, b) => a - b);
  }, ids[0]!);
  const longs = await page().evaluate(() => (window as any).__longs as number[]);
  assert.deepEqual(longs.filter((d) => d > 50), []);
  assert.ok((lat[Math.floor(lat.length * 0.9)] ?? 0) < 16, `p90 ${lat.join(' ')}`);
  for (const c of ids) await pane(c).locator('textarea.k-input').fill('');
  const nodes = await page().evaluate((x) => x.map((id: string) => document.querySelector(`.c-pane[data-chat="${id}"]`)?.querySelectorAll('*').length ?? 0), ids);
  assert.ok(nodes.every((n: number) => n <= 4000), `DOM nodes per pane ${nodes.join(', ')}`);
});
