// Pending cards in Edge, the cases browser-dock.test.ts does not cover (WP-F acceptance 2): `not_pending` → « Déjà
// traitée ailleurs » (card disabled until its askEnd); the question form's « Autre… », free answer and « Ne pas
// répondre »; the elicitation card (form fields typed from the schema, required fields, URL mode in the user's browser);
// MultiEdit has no « Modifier avant d'accepter »; the plan editor keeps Entrée; fenced code gets « Copier »; the
// « beaucoup d'images » note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bind, framesOf, useHarness } from './_browser.ts';
// Callbacks passed to page.evaluate() run in the browser; this file is compiled without the DOM lib (module-local names).
declare const document: any, window: any, OffscreenCanvas: any, DataTransfer: any, File: any, ClipboardEvent: any;

const ctx = useHarness();
const { apply, calls, clear, panes, skip } = bind(ctx);
const page = () => ctx.page;
const firstAsk = async (name: string) => (await framesOf(name)).flat().find((m) => m.t === 'ask').ask;
const card = () => page().locator('.d-card').first();
const gone = () => page().waitForFunction(() => document.querySelectorAll('.d-card').length === 0);
const lastAnswer = async () => (await calls('decide')).at(-1).a;

test('not_pending: the click lost the race → « Déjà traitée ailleurs », the card stays disabled until its askEnd', async (t) => {
  if (skip(t)) return;
  await clear();
  const ask = { ...(await firstAsk('permission')), requestId: 'np-1' };
  await panes([ask.chatId]);
  await apply([{ t: 'ask', ask }]);
  await page().evaluate(() => (window as any).__h.notPending('np-1'));
  await card().waitFor(); await card().focus();
  await page().keyboard.press('Digit1');
  await page().waitForSelector('.d-elsewhere');
  assert.equal(await page().textContent('.d-elsewhere'), 'Déjà traitée ailleurs');
  assert.equal(await page().locator('.d-card fieldset[disabled]').count(), 1);
  await page().keyboard.press('Digit3');                              // a disabled card ignores further keys
  assert.equal((await calls('decide')).length, 1);
  await apply([{ t: 'askEnd', chatId: ask.chatId, requestId: 'np-1', reason: 'answered' }]);
  await gone();
  assert.equal(await page().locator('.d-gone').count(), 0, 'answered elsewhere is not a withdrawal');
});

test('question form: « Autre… » free text, « Répondre librement », « Ne pas répondre »', async (t) => {
  if (skip(t)) return;
  await clear();
  const ask = await firstAsk('question');
  const q = ask.questions;
  await panes([ask.chatId]);
  await apply([{ t: 'ask', ask: { ...ask, requestId: 'q-1' } }]);
  await card().waitFor();
  await page().locator('[data-q="0"] [data-opt="0"]').focus();
  await page().keyboard.press('Digit3');                             // last number = « Autre… » → its field
  await page().waitForFunction(() => document.activeElement?.matches('.d-other input'));
  await page().keyboard.type('Vert sapin');
  await page().locator('[data-q="1"] [data-opt="2"]').click();
  await page().locator('.d-card button', { hasText: 'Envoyer les réponses' }).click();
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'answers', answers: { [q[0].question]: 'Vert sapin', [q[1].question]: 'Aide' } });

  await apply([{ t: 'ask', ask: { ...ask, requestId: 'q-2' } }]);
  await card().waitFor();
  await page().locator('.d-card button', { hasText: 'Répondre librement' }).click();
  await page().locator('.d-card .d-field textarea').fill('Fais au plus simple.');
  await page().locator('.d-card .d-field button').click();
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'answers', answers: {}, response: 'Fais au plus simple.' });

  await apply([{ t: 'ask', ask: { ...ask, requestId: 'q-3' } }]);
  await card().waitFor();
  await page().locator('.d-card button', { hasText: 'Ne pas répondre' }).click();
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'skip-question' });
});

test('elicitation: a form typed from the schema (required fields checked), and the URL mode in the user\'s browser', async (t) => {
  if (skip(t)) return;
  await clear();
  const base = await firstAsk('permission');
  const schema = { type: 'object', required: ['projet', 'quota'], properties: {
    projet: { type: 'string', title: 'Projet' }, quota: { type: 'integer', title: 'Quota' }, prive: { type: 'boolean', title: 'Privé' },
    region: { type: 'string', title: 'Région', enum: ['eu', 'us'] } } };
  const ask = { ...base, requestId: 'el-1', kind: 'elicitation', toolName: 'mcp__notes__ask', offerAlways: false, alwaysRules: [], input: {},
    elicitation: { mode: 'form', server: 'notes', message: 'Paramètres de la note', schema } };
  await panes([ask.chatId]);
  await apply([{ t: 'ask', ask }]);
  await card().waitFor();
  assert.match(await card().textContent() ?? '', /Le serveur MCP « notes » demande des informations/);
  await page().locator('.d-card button', { hasText: 'Envoyer' }).click();
  await page().waitForSelector('.d-card .d-warn');                   // required fields are empty: nothing is sent
  assert.equal((await calls('decide')).length, 0);
  const field = (label: string) => page().locator('.d-card label.d-field', { hasText: label });
  await field('Projet').locator('input').fill('Alpha');
  await field('Quota').locator('input').fill('2,5');                  // an integer field refuses a decimal
  await field('Privé').locator('input').check();
  await field('Région').locator('select').selectOption('us');
  await page().locator('.d-card button', { hasText: 'Envoyer' }).click();
  await page().waitForSelector('.d-card .d-warn');
  assert.equal((await calls('decide')).length, 0);
  await field('Quota').locator('input').fill('3');
  await page().locator('.d-card button', { hasText: 'Envoyer' }).click();
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'elicit', action: 'accept', content: { projet: 'Alpha', quota: 3, prive: true, region: 'us' } });

  const url = { ...ask, requestId: 'el-2', elicitation: { mode: 'url', server: 'notes', message: 'Connexion', url: 'https://example.com/auth' } };
  await apply([{ t: 'ask', ask: url }]);
  await card().waitFor();
  await page().locator('.d-card button', { hasText: 'Ouvrir la page' }).click();
  assert.deepEqual((await calls('openExternal')).at(-1), { u: 'https://example.com/auth' });
  await page().locator('.d-card button', { hasText: "J'ai terminé" }).click();
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'elicit', action: 'accept' });
  await apply([{ t: 'ask', ask: { ...url, requestId: 'el-3' } }]);
  await card().waitFor(); await card().focus();
  await page().keyboard.press('Escape');
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'elicit', action: 'cancel' });
});

test('MultiEdit: no « Modifier avant d\'accepter » (button or E); the plan editor keeps Entrée; code blocks get « Copier »', async (t) => {
  if (skip(t)) return;
  await clear();
  const base = await firstAsk('permission');
  const multi = { ...base, requestId: 'me-1', toolName: 'MultiEdit', displayName: 'MultiEdit', offerAlways: false, alwaysRules: [],
    input: { file_path: 'C:\\w\\a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] } };
  await panes([multi.chatId]);
  await apply([{ t: 'ask', ask: multi }]);
  await card().waitFor();
  assert.equal(await page().locator('.d-card button', { hasText: "Modifier avant d'accepter" }).count(), 0);
  await card().focus();
  await page().keyboard.press('e');
  assert.equal(await page().locator('.d-card textarea').count(), 0);
  await page().keyboard.press('Digit1');
  await gone();

  const plan = await firstAsk('plan');
  await apply([{ t: 'ask', ask: { ...plan, chatId: multi.chatId, requestId: 'pl-9' } }]);
  await card().waitFor(); await card().focus();
  await page().keyboard.press('Digit3');                             // « Non, continuer à planifier… » field
  await page().waitForFunction(() => document.activeElement?.matches('.d-reject textarea'));
  await page().locator('.d-card').focus();
  await page().keyboard.press('m');                                  // then the plan editor
  await page().waitForFunction(() => document.activeElement?.matches('.d-plan-edit'));
  await page().keyboard.press('End');
  await page().keyboard.press('Enter');                              // a new line in the plan, not the rejection
  assert.equal((await calls('decide')).length, 1);
  await page().locator('.d-reject textarea').fill('Ajoute des tests');
  await page().locator('.d-reject textarea').press('Enter');
  await gone();
  assert.deepEqual(await lastAnswer(), { kind: 'plan-reject', feedback: 'Ajoute des tests' });

  const C = multi.chatId;
  await apply([{ t: 'ev', c: C, s: 900, ev: { k: 'turn.start', turn: { id: 'u:cp', at: 1, user: { uuid: 'cp', text: 'code', origin: 'human' } } } },
    { t: 'ev', c: C, s: 901, ev: { k: 'block', turnId: 'u:cp', block: { k: 'text', id: 'a:cp:0', md: 'Voici :\n\n```ts\nconst a = 1;\nconst b = 2;\n```' } } }]);
  const btn = page().locator('[data-block="a:cp:0"] pre .c-copy');
  await btn.waitFor();
  assert.equal(await btn.textContent(), 'Copier');
  assert.equal(await btn.getAttribute('title'), '2 lignes');
});

test('composer: from 10 images in the conversation a note warns before sending (ux §7.6)', async (t) => {
  if (skip(t)) return;
  await clear();
  const C = 'perso:0000000b-3333-4444-8555-666666666666';
  await panes([C]);
  const images = Array.from({ length: 9 }, (_, k) => ({ ref: `img${k}`, mediaType: 'image/png' }));
  await apply([{ t: 'ev', c: C, s: 1, ev: { k: 'turn.start', turn: { id: 'u:im', at: 1, user: { uuid: 'im', text: 'captures', origin: 'human', images } } } }]);
  const box = page().locator(`.c-pane[data-chat="${C}"] textarea.k-input`);
  await box.focus();
  await page().evaluate(async (c) => {
    const cv = new OffscreenCanvas(40, 30); const g = cv.getContext('2d'); g.fillStyle = '#06c'; g.fillRect(0, 0, 40, 30);
    const dt = new DataTransfer(); dt.items.add(new File([await cv.convertToBlob({ type: 'image/png' })], 'capture.png', { type: 'image/png' }));
    document.querySelector(`.c-pane[data-chat="${c}"] textarea.k-input`).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, C);
  await page().waitForSelector(`.c-pane[data-chat="${C}"] .a-chip img`);
  assert.match(await page().textContent(`.c-pane[data-chat="${C}"] .w-hint.w-warn`) ?? '', /Beaucoup d'images/);
  await box.fill('Et celle-ci');
  await box.press('Enter');
  await page().waitForFunction(() => (window as any).__h.calls('send').length > 0);
  await page().waitForTimeout(150);
  assert.equal((await calls('send')).length, 1);
  assert.equal(await page().locator(`.c-pane[data-chat="${C}"] .w-hint.w-warn`).count(), 0);
});
