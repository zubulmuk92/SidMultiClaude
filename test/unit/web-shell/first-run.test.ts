// test/unit/web-shell/first-run.test.ts — M3 (real run, screenshot 01): with zero accounts the « Comptes » panel opens
// by itself once per window session (welcome form), closes if accounts arrive from elsewhere, and the add card
// pre-selects the connected profiles (first run only) with the server's suggested names and colours.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './setup.ts';
// @ts-expect-error browser module without declarations (checked by tsconfig.web.json)
import * as firstRunM from '../../../src/web/first-run.js';
// @ts-expect-error browser module
import * as storeM from '../../../src/web/store.js';
// @ts-expect-error browser module
import * as accountsM from '../../../src/web/components/dialogs/Accounts.js';

const fr: any = firstRunM, store: any = storeM, A: any = accountsM;
const welcome = { kind: 'accounts', props: { firstRun: true } };

test('firstRunDecision: opens once with zero accounts after the hello, never over another dialog, closes when accounts arrive', () => {
  const d = fr.firstRunDecision;
  assert.equal(d({ hydrated: false, accounts: 0, overlay: null, shown: false }), null);          // before the hello
  assert.equal(d({ hydrated: true, accounts: 0, overlay: null, shown: false }), 'open');
  assert.equal(d({ hydrated: true, accounts: 0, overlay: null, shown: true }), null);            // once per window session
  assert.equal(d({ hydrated: true, accounts: 0, overlay: { kind: 'settings' }, shown: false }), null);
  assert.equal(d({ hydrated: true, accounts: 2, overlay: null, shown: false }), null);
  assert.equal(d({ hydrated: true, accounts: 1, overlay: welcome, shown: true }), 'close');      // added from another window
  assert.equal(d({ hydrated: true, accounts: 1, overlay: { kind: 'accounts' }, shown: true }), null);   // added here: cards stay
});

test('wireFirstRun: hello with zero accounts opens the welcome; a later accounts frame closes it; never twice', () => {
  try { globalThis.sessionStorage?.removeItem('smc.firstRunShown'); } catch { /* none in Node */ }
  store.overlay.value = null;
  store.accounts.value = [];
  store.hydrated.value = false;
  const stop = fr.wireFirstRun();
  try {
    assert.equal(store.overlay.value, null);
    store.hydrated.value = true;
    assert.deepEqual(store.overlay.value, welcome);
    store.accounts.value = [{ id: 'perso' }];
    assert.equal(store.overlay.value, null);
    store.accounts.value = [];
    assert.equal(store.overlay.value, null, 'not reopened in the same window session');
  } finally { stop(); store.hydrated.value = false; store.overlay.value = null; }
});

test('add card: connected profiles pre-selected on a first run only, suggested names / colours; monogram follows the name', () => {
  const cands = [
    { configDir: null, login: 'connected', added: false, suggested: { name: 'Perso', color: 1, monogram: 'P' } },
    { configDir: 'C:\\u\\.claude-pro', login: 'connected', added: false, suggested: { name: 'ACME', color: 2, monogram: 'A' } },
    { configDir: 'C:\\u\\.claude-perso', login: 'disconnected', added: false, suggested: { name: 'Perso 2', color: 3, monogram: 'P2' } },
  ];
  assert.deepEqual(A.initialPicks(cands, true), {
    '': { on: true, name: 'Perso', color: 1 }, 'C:\\u\\.claude-pro': { on: true, name: 'ACME', color: 2 }, 'C:\\u\\.claude-perso': { on: false, name: 'Perso 2', color: 3 },
  });
  assert.equal(Object.values(A.initialPicks(cands, false)).some((p: any) => p.on), false);
  assert.equal(A.monogramOf('Perso 2'), 'P2');
  assert.equal(A.monogramOf('acme'), 'A');
});
