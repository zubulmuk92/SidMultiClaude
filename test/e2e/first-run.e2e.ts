// test/e2e/first-run.e2e.ts — M3 (lead's real run, screenshots 01 and 02) against the REAL server: temp profiles, fake
// Claude, installed Edge, zero tokens.
//  1. first run: with zero accounts the « Comptes » panel opens by itself in its welcome form (connected profiles
//     pre-selected, suggested names « Perso » / « ACME », never "<email>'s Organization"), the sidebar shows a call to
//     action, and nothing is added before « Ajouter la sélection ».
//  3. stale limits: transcripts whose tail holds a rate limit reset weeks ago (and an old authentication_failed on a
//     connected account) stay out of « À traiter », the window title and the favicon; a limit still ahead is listed.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { edgeInstalled, launch } from './harness.ts';
import type { Harness } from './harness.ts';
import { createTmpRoot } from '../helpers/tmp-profile.ts';
import type { TmpRoot } from '../helpers/tmp-profile.ts';

declare const document: any;
const SKIP = edgeInstalled() ? false : 'Microsoft Edge is not installed';
let root: TmpRoot;
let h: Harness;
let persoProfile: ReturnType<TmpRoot['profile']>;
const page = (): Page => h.page;
const sid = (n: number): string => `7c0f3a59-0a8e-4c55-8a51-${String(n).padStart(12, '0')}`;
const AUG_27 = Date.UTC(2026, 7, 27, 10, 0, 0);

before(async () => {
  if (SKIP) return;
  root = createTmpRoot('first-run-e2e');
  const cwd = root.cwd('old-project');
  const def = root.defaultProfile({ login: 'connected', account: { organizationName: "someone@example.invalid's Organization", organizationType: 'claude_max' } });
  const pro = root.profile('pro', { login: 'connected', account: { organizationName: 'ACME', organizationType: 'claude_team' } });
  const perso = root.profile('perso', { login: 'disconnected', catalog: false });
  persoProfile = perso;
  // M3 verifier: an old auth failure on an account that is disconnected NOW (added by the third test)
  perso.addSession({ cwd, sessionId: sid(5), title: 'Erreur auth compte déconnecté', startedAt: AUG_27, turns: [{ user: 'e', error: 'authentication_failed' }] });
  // stale: rate limits that reset on Aug 27 / 28 (epoch seconds, like quotaLimits.resetsAt) and an old auth failure
  def.addSession({ cwd, sessionId: sid(1), title: 'Ancienne limite A', startedAt: AUG_27, turns: [{ user: 'a', error: 'rate_limit', resetsAt: Math.floor(AUG_27 / 1000) + 5 * 3600 }] });
  def.addSession({ cwd, sessionId: sid(2), title: 'Ancienne limite B', startedAt: AUG_27 + 86_400_000, turns: [{ user: 'b', error: 'rate_limit', resetsAt: Math.floor(AUG_27 / 1000) + 86_400 + 3600 }] });
  def.addSession({ cwd, sessionId: sid(3), title: 'Ancienne erreur auth', startedAt: AUG_27, turns: [{ user: 'c', error: 'authentication_failed' }] });
  // still ahead: one hour from now
  pro.addSession({ cwd, sessionId: sid(4), title: 'Limite en cours', startedAt: Date.now() - 60_000, turns: [{ user: 'd', error: 'rate_limit', resetsAt: Math.floor(Date.now() / 1000) + 3600 }] });
  h = await launch({ root, viewport: { width: 1400, height: 900 } });
});
after(async () => { await h?.close(); root?.dispose(); });

test('first run: the welcome opens by itself, connected profiles pre-selected with suggested names; nothing added before confirming', { skip: SKIP }, async () => {
  const dlg = page().getByRole('dialog');
  await dlg.waitFor({ timeout: 15_000 });
  assert.match(await dlg.textContent() ?? '', /Bienvenue/);
  // sidebar call to action, behind the dialog
  assert.match(await page().locator('[data-onboard]').textContent() ?? '', /Ajoutez un compte Claude pour commencer/);
  const cand = (where: RegExp) => dlg.locator('li[data-cand]').filter({ hasText: where });
  await cand(/\.claude-pro/).waitFor({ timeout: 10_000 });
  const def = dlg.locator('li[data-cand="~\\\\.claude"]');
  assert.equal(await def.locator('input[type="checkbox"]').isChecked(), true);
  assert.equal(await cand(/\.claude-pro/).locator('input[type="checkbox"]').isChecked(), true);
  assert.equal(await cand(/\.claude-perso/).locator('input[type="checkbox"]').isChecked(), false);
  assert.equal(await def.locator('input:not([type])').inputValue(), 'Perso');
  assert.equal(await cand(/\.claude-pro/).locator('input:not([type])').inputValue(), 'ACME');
  assert.doesNotMatch(await dlg.textContent() ?? '', /'s Organization/);
  // nothing is added yet
  const n0 = await page().evaluate(async () => (await import('/app/store.js' as string)).accounts.value.length);
  assert.equal(n0, 0);
  await dlg.getByRole('button', { name: /Ajouter la sélection \(2\)/ }).click();
  let accs: string[] = [];
  for (let i = 0; i < 60 && accs.length < 2; i++) {          // (waitForFunction would take an async predicate's promise as truthy)
    accs = await page().evaluate(async () => (await import('/app/store.js' as string)).accounts.value.map((a: any) => `${a.name}/${a.monogram}/${a.color}`));
    if (accs.length < 2) await new Promise((r) => setTimeout(r, 250));
  }
  assert.deepEqual(accs.sort(), ['ACME/A/2', 'Perso/P/1']);
  await dlg.getByRole('heading', { name: 'ACME' }).waitFor();                     // the panel stays, now with the cards
  await page().keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  assert.equal(await page().locator('[data-onboard]').count(), 0);
});

test('stale limits: old transcript tails stay out of « À traiter », the title and the favicon; a limit still ahead is listed', { skip: SKIP }, async () => {
  const sec = page().locator('.sec-row', { hasText: 'À traiter' });
  await sec.waitFor({ timeout: 15_000 });
  assert.match(await sec.textContent() ?? '', /\(1\)/);
  const attention = await page().locator('.chat-row.with-reason').allTextContents();
  assert.equal(attention.length, 1, attention.join(' | '));
  assert.match(attention[0] ?? '', /Limite en cours/);
  for (const n of [1, 2, 3]) {
    const st = await page().evaluate(async (id) => (await import('/app/store.js' as string)).chats.value.get(id)?.state, `perso:${sid(n)}`);
    assert.ok(st, `chat ${n} listed`);
    assert.equal(st.phase, 'cold', `chat ${n}: ${JSON.stringify(st)}`);
    assert.equal(st.limit, undefined);
    assert.equal(st.error, undefined);
  }
  await page().waitForFunction(() => document.title === '✕1 · SidMultiClaude', null, { timeout: 5_000 });
});

test('M3 verifier: an old auth error counts while its account is disconnected, and leaves once it is connected again (no restart)', { skip: SKIP }, async () => {
  const where = persoProfile.configDir;
  await page().evaluate(async (dir) => {
    const a = await import('/app/actions.js' as string);
    await a.accountCmd.add({ configDir: dir, name: 'Perso 2', color: 3, monogram: 'P2' });
  }, where);
  const chat = `perso-2:${sid(5)}`;
  const state = () => page().evaluate(async (id) => (await import('/app/store.js' as string)).chats.value.get(id)?.state ?? null, chat);
  await page().waitForFunction(() => document.title === '✕2 · SidMultiClaude', null, { timeout: 15_000 });
  assert.equal((await state())?.error?.code, 'auth', 'disconnected now: the old auth failure is shown');
  assert.match(await page().locator('.sec-row', { hasText: 'À traiter' }).textContent() ?? '', /\(2\)/);
  persoProfile.setLogin('connected');                       // the user logged in (temp profile only)
  await page().waitForFunction(() => document.title === '✕1 · SidMultiClaude', null, { timeout: 15_000 });
  const st = await state();
  assert.equal(st?.phase, 'cold', JSON.stringify(st));
  assert.equal(st?.error, undefined);
  assert.match(await page().locator('.sec-row', { hasText: 'À traiter' }).textContent() ?? '', /\(1\)/);
});
