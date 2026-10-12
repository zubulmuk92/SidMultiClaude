// test/unit/web-shell/fuzzy-keymap.test.ts — lib/fuzzy.js (platform accent cases) and lib/keymap.js (SPEC §9.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser module without declarations (checked by tsconfig.web.json)
import * as fuzzyMod from '../../../src/web/lib/fuzzy.js';
// @ts-expect-error browser module without declarations
import * as keymapMod from '../../../src/web/lib/keymap.js';
import { budget } from '../../helpers/perf.ts';

type Hit<T> = { item: T; score: number };
const fz = fuzzyMod as {
  fold(s: string): string; fuzzyScore(q: string, t: string): number | null;
  fuzzyFilter<T>(items: T[], q: string, keys: (it: T) => string[], limit?: number): Hit<T>[];
};
const km = keymapMod as {
  actionFor(e: Record<string, unknown>): string | null; isGlobal(id: string | null): boolean; digitOf(e: { code?: string }): number | null;
  GLOBAL: Record<string, string>; CHAT: Record<string, string>;
};
const TITLE = 'Réparer le démarrage Edge';

test('fuzzy: accent- and case-insensitive (platform §2.1 cases)', () => {
  assert.notEqual(fz.fuzzyScore('demarrage', TITLE), null);
  assert.notEqual(fz.fuzzyScore('reparer', TITLE), null);
  assert.notEqual(fz.fuzzyScore('RÉPARER edge', TITLE), null);
  assert.notEqual(fz.fuzzyScore('edge reparer', TITLE), null, 'tokens match in any order');
  assert.notEqual(fz.fuzzyScore('rpr dmrg', TITLE), null, 'subsequence inside a token');
  assert.equal(fz.fuzzyScore('demarrages', TITLE), null);
  assert.equal(fz.fuzzyScore('xyz', TITLE), null);
  assert.equal(fz.fold('Œuvre Ça Été'), 'oeuvre ca ete');
});

test('fuzzy: ranking prefers contiguous word-start matches, then shorter texts', () => {
  const items = ['Mise à jour du parseur', 'Parseur', 'Rapport annuel', 'Préparer le serveur'];
  const r = fz.fuzzyFilter(items, 'parseur', (x) => [x]).map((h) => h.item);
  assert.equal(r[0], 'Parseur');
  assert.equal(r[1], 'Mise à jour du parseur');
  assert.ok(!r.includes('Rapport annuel'));
  assert.equal(fz.fuzzyFilter(items, '', (x) => [x]).length, 4, 'empty query keeps everything');
});

test('fuzzy: 5,000 items filter in well under 50 ms', () => {
  const items = Array.from({ length: 5000 }, (_, i) => `Chat ${i} réparation démarrage ${i % 7 ? 'api' : 'edge'}`);
  fz.fuzzyFilter(items, 'demar edge', (x) => [x]);
  // best of 3: the parallel unit suite's CPU load must not fail the budget; a real regression fails every run (auditor, M2)
  let best = Infinity;
  for (let i = 0; i < 3 && best >= 50; i++) {
    const t0 = performance.now();
    const r = fz.fuzzyFilter(items, 'demar edge', (x) => [x]);
    best = Math.min(best, performance.now() - t0);
    assert.ok(r.length > 0);
  }
  assert.ok(best < budget(50), `took ${best} ms`);
});

const key = (k: string, o: Record<string, unknown> = {}) => ({ key: k, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, target: null, ...o });
const textarea = { tagName: 'TEXTAREA' };

test('keymap: global bindings', () => {
  assert.equal(km.actionFor(key('k', { ctrlKey: true })), km.GLOBAL['switcher']);
  assert.equal(km.actionFor(key('K', { ctrlKey: true })), km.GLOBAL['switcher'], 'caps lock');
  assert.equal(km.actionFor(key('n', { altKey: true })), km.GLOBAL['newChat']);
  assert.equal(km.actionFor(key('r', { altKey: true })), km.GLOBAL['resume']);
  assert.equal(km.actionFor(key('c', { altKey: true })), km.GLOBAL['accounts']);
  assert.equal(km.actionFor(key('a', { altKey: true })), km.GLOBAL['nextAttention']);
  assert.equal(km.actionFor(key('w', { altKey: true })), km.GLOBAL['closeTab']);
  assert.equal(km.actionFor(key('z', { altKey: true })), km.GLOBAL['reopenTab']);
  assert.equal(km.actionFor(key('l', { altKey: true })), km.GLOBAL['layout']);
  assert.equal(km.actionFor(key('b', { altKey: true })), km.GLOBAL['sidebar']);
  assert.equal(km.actionFor(key('PageDown', { altKey: true })), km.GLOBAL['tabNext']);
  assert.equal(km.actionFor(key('PageUp', { altKey: true })), km.GLOBAL['tabPrev']);
  assert.equal(km.actionFor(key('F6')), km.GLOBAL['regionNext']);
  assert.equal(km.actionFor(key('F6', { shiftKey: true })), km.GLOBAL['regionPrev']);
  assert.equal(km.actionFor(key('F1')), km.GLOBAL['help']);
  assert.equal(km.actionFor(key(',', { ctrlKey: true })), km.GLOBAL['settings']);
});

test('keymap: Alt+1…9 on event.code with AZERTY key values', () => {
  const azerty = ['&', 'é', '"', '\'', '(', '-', 'è', '_', 'ç'];
  azerty.forEach((k, i) => assert.equal(km.actionFor(key(k, { altKey: true, code: `Digit${i + 1}` })), `tab:${i + 1}`));
  assert.equal(km.actionFor(key('1', { altKey: true, code: 'Numpad1' })), 'tab:1');
  assert.equal(km.actionFor(key('à', { altKey: true, code: 'Digit0' })), null, 'Alt+0 unbound');
  assert.ok(km.isGlobal('tab:3'));
  assert.equal(km.digitOf({ code: 'Digit7' }), 7);
});

test('keymap: never bound (Ctrl+Alt = AltGr, Alt+Maj, browser-reserved keys, F12)', () => {
  assert.equal(km.actionFor(key('k', { ctrlKey: true, altKey: true })), null);
  assert.equal(km.actionFor(key('@', { ctrlKey: true, altKey: true, code: 'Digit0' })), null);
  assert.equal(km.actionFor(key('N', { altKey: true, shiftKey: true })), null);
  for (const k of ['n', 't', 'w', 'Tab', 'PageUp', 'PageDown']) assert.equal(km.actionFor(key(k, { ctrlKey: true })), null, `Ctrl+${k}`);
  assert.equal(km.actionFor(key('1', { ctrlKey: true, code: 'Digit1' })), null, 'Ctrl+1');
  for (const k of ['f', 'e', 'd', 'ArrowLeft', 'ArrowRight']) assert.equal(km.actionFor(key(k, { altKey: true })), null, `Alt+${k}`);
  assert.equal(km.actionFor(key('F12')), null);
});

test('keymap: single letters and `?` never act inside text fields', () => {
  assert.equal(km.actionFor(key('?', { shiftKey: true })), km.GLOBAL['help']);
  assert.equal(km.actionFor(key('?', { shiftKey: true, target: textarea })), null);
  assert.equal(km.actionFor(key('?', { target: { tagName: 'INPUT', type: 'text' } })), null);
  assert.equal(km.actionFor(key('?', { target: { tagName: 'INPUT', type: 'checkbox' } })), km.GLOBAL['help']);
  assert.equal(km.actionFor(key('b', { ctrlKey: true, target: textarea })), null, 'Ctrl+B stays bold-free in the composer');
  assert.equal(km.actionFor(key('ArrowUp', { altKey: true, target: textarea })), null);
  assert.equal(km.actionFor(key('o', { ctrlKey: true })), km.CHAT['view']);
  assert.equal(km.actionFor(key('m', { altKey: true })), km.CHAT['mode']);
  assert.ok(!km.isGlobal(km.CHAT['mode'] ?? null));
  assert.equal(km.actionFor(key('k', { ctrlKey: true, isComposing: true })), null);
});
