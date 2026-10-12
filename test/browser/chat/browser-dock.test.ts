// Pending dock in Edge (WP-F acceptance 2): permission keys incl. defaultToNo and the ←/→ scope, deny with a message,
// Échap = deny and stop, the stack header, withdrawal (« Demande annulée »), the question form, the plan card from
// ask.plan with its model badge, the Edit preview and « Modifier avant d'accepter ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bind, framesOf, useHarness } from './_browser.ts';
// Callbacks passed to page.evaluate() run in the browser; this file is compiled without the DOM lib (module-local names).
declare const document: any, window: any, KeyboardEvent: any, InputEvent: any, OffscreenCanvas: any, DataTransfer: any, File: any, ClipboardEvent: any, trustedTypes: any, localStorage: any;

const ctx = useHarness();
const { apply, calls, clear, panes, skip } = bind(ctx);
const page = () => ctx.page;
const firstAsk = async (name: string) => (await framesOf(name)).flat().find((m) => m.t === 'ask').ask;
const card = () => page().locator('.d-card').first();
const gone = () => page().waitForFunction(() => document.querySelectorAll('.d-card').length === 0);
const lastAnswer = async () => (await calls('decide')).at(-1).a;

test('permission: 1 allows once; →/← change the scope of 2; 3 asks for a message; Échap denies and stops', async (t) => {
  if (skip(t)) return;
  await clear();
  const ask = await firstAsk('permission');
  await panes([ask.chatId]);
  await apply([{ t: 'ask', ask }]);
  await card().waitFor();
  assert.match(await card().textContent() ?? '', /Autorisation requise · Bash/);
  assert.match(await page().textContent('.d-subject') ?? '', /\$ npm ci/);
  await card().focus();
  await page().keyboard.press('Digit1');
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'allow-once' });

  await apply([{ t: 'ask', ask: { ...ask, requestId: 'r-2' } }]);
  await card().waitFor(); await card().focus();
  await page().keyboard.press('ArrowRight');
  assert.match(await page().textContent('.d-scope') ?? '', /pour ce projet \(local, non partagé\)/);
  await page().keyboard.press('Digit2');
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'allow-always', scope: 'localSettings' });

  await apply([{ t: 'ask', ask: { ...ask, requestId: 'r-3' } }]);
  await card().waitFor(); await card().focus();
  await page().keyboard.press('Digit3');
  await page().waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
  await page().keyboard.type('Utilise pnpm');
  await page().keyboard.press('Enter');
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'deny', message: 'Utilise pnpm' });

  await apply([{ t: 'ask', ask: { ...ask, requestId: 'r-4' } }]);
  await card().waitFor(); await card().focus();
  await page().keyboard.press('Escape');
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'deny', message: "L'utilisateur a refusé.", stopTurn: true });
});

test('permission: defaultToNo disables 1, the stack shows « 1 sur 2 », a withdrawn ask collapses to « Demande annulée »', async (t) => {
  if (skip(t)) return;
  await clear();
  const ask = await firstAsk('permission');
  await panes([ask.chatId]);
  await apply([{ t: 'ask', ask: { ...ask, requestId: 'n-1', defaultToNo: true } }, { t: 'ask', ask: { ...ask, requestId: 'n-2' } }]);
  await card().waitFor(); await card().focus();
  assert.match(await page().textContent('.d-card-meta') ?? '', /^1 sur 2 · en attente depuis/);
  await page().keyboard.press('Digit1');
  await page().waitForTimeout(150);
  assert.equal((await calls('decide')).length, 0);
  await apply([{ t: 'ev', c: ask.chatId, s: 200, ev: { k: 'turn.start', turn: { id: 'u:w', at: 1, user: null } } },
    { t: 'ev', c: ask.chatId, s: 201, ev: { k: 'block', turnId: 'u:w', block: { k: 'tool', id: 't:' + ask.toolUseId, toolUseId: ask.toolUseId, name: 'Bash',
      input: { summary: 'npm ci', fields: { command: 'npm ci' } }, status: 'withdrawn', result: { isError: true, summary: '', denial: 'withdrawn' } } } }]);
  await apply([{ t: 'askEnd', chatId: ask.chatId, requestId: 'n-1', reason: 'cancelled' }, { t: 'askEnd', chatId: ask.chatId, requestId: 'n-2', reason: 'cancelled' }]);
  await page().waitForSelector('.d-gone');
  assert.equal(await page().textContent('.d-gone'), 'Demande annulée (tour interrompu)');
});

test('question form: digits pick, Tab moves to the next question, Ctrl+Entrée sends the answers keyed by question', async (t) => {
  if (skip(t)) return;
  await clear();
  const ask = await firstAsk('question');
  await panes([ask.chatId]);
  await apply([{ t: 'ask', ask }]);
  await card().waitFor();
  assert.match(await card().textContent() ?? '', /Claude vous pose 2 question/);
  await page().locator('[data-q="0"] [data-opt="0"]').focus();
  await page().keyboard.press('Digit2');
  await page().keyboard.press('Tab');
  await page().keyboard.press('Digit1');
  await page().keyboard.press('Digit3');
  await page().keyboard.press('Control+Enter');
  await gone();
  const q = ask.questions;
  assert.deepEqual(await lastAnswer(), { kind: 'answers', answers: { [q[0].question]: 'Bleu', [q[1].question]: 'Accueil, Aide' } });
});

test('plan card: plan from the ask as markdown, « planifié avec Sonnet », 1 approves into Auto', async (t) => {
  if (skip(t)) return;
  await clear();
  const ask = await firstAsk('plan');
  await panes([ask.chatId]);
  await apply([{ t: 'ev', c: ask.chatId, s: 1, ev: { k: 'meta', meta: { model: 'claude-haiku-5-5', mode: 'plan', autoAvailable: true } } },   // M2: Auto only when the model supports it
    { t: 'ev', c: ask.chatId, s: 2, ev: { k: 'turn.start', turn: { id: 'u:p', at: 1, user: { uuid: 'p', text: 'Planifie', origin: 'human' } } } },
    { t: 'ev', c: ask.chatId, s: 3, ev: { k: 'block', turnId: 'u:p', block: { k: 'tool', id: 't:' + ask.toolUseId, toolUseId: ask.toolUseId,
      name: 'ExitPlanMode', input: { summary: 'Plan', fields: {} }, status: 'asking', model: 'claude-sonnet-5-5' } } }, { t: 'ask', ask }]);
  await card().waitFor();
  assert.match(await page().textContent('.d-plan-text') ?? '', /Écrire plan\.txt dans le dossier courant/);
  assert.match(await card().textContent() ?? '', /planifié avec Sonnet/);
  await card().focus();
  await page().keyboard.press('Digit1');
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'plan-approve', nextMode: 'auto' });
});

test('Edit ask: LCS preview with word highlight; E edits before accepting (allow-edited)', async (t) => {
  if (skip(t)) return;
  await clear();
  const base = await firstAsk('permission');
  const ask = { ...base, requestId: 'e-1', toolName: 'Edit', displayName: 'Edit', offerAlways: false, alwaysRules: [],
    input: { file_path: 'C:\\w\\src\\auth.ts', old_string: 'const a = 1;\nif (!token) return null;', new_string: 'const a = 1;\nif (!token) throw new Error();' } };
  await panes([ask.chatId]);
  await apply([{ t: 'ask', ask }]);
  await card().waitFor();
  assert.match(await card().textContent() ?? '', /Modifier auth\.ts/);
  assert.equal(await page().locator('.d-card .d-row.d-del').count(), 1);
  assert.ok(await page().locator('.d-card .d-row.d-add mark').count() > 0);
  await card().focus();
  await page().keyboard.press('e');
  await page().locator('.d-card textarea').fill('const a = 2;');
  await page().keyboard.press('Control+Enter');
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'allow-edited', input: { ...ask.input, new_string: 'const a = 2;' } });
  assert.deepEqual(ctx.errors, []);
});
