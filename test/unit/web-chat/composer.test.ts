// composer/logic.js + WakeHint: send keys (SPEC §9.3: Entrée / Alt+Entrée / Ctrl+Entrée gating), queue chips by
// delivery (incl. folded and returned), ↑ take-back, slash palette, @ mentions, invisible characters, the L1 image
// budget, token hints (ux §7.8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { web } from './_load.ts';

const L = await web('components/composer/logic.js');
const { wakeHint } = await web('components/composer/WakeHint.js');
const { LIMITS } = await web('components/chat/consts.js');

const key = (k: string, m: { shift?: boolean; alt?: boolean; ctrl?: boolean; composing?: boolean } = {}) =>
  ({ key: k, shiftKey: !!m.shift, altKey: !!m.alt, ctrlKey: !!m.ctrl, isComposing: !!m.composing });
const S = (o: Partial<{ running: boolean; canSendNow: boolean; ctrlEnterSends: boolean; popupOpen: boolean }> = {}) =>
  ({ running: false, canSendNow: false, ctrlEnterSends: false, popupOpen: false, ...o });

test('Entrée sends (folds while running), Maj+Entrée is a newline, IME composition is ignored', () => {
  assert.equal(L.sendKey(key('Enter'), S()), 'send');
  assert.equal(L.sendKey(key('Enter'), S({ running: true })), 'send');     // no priority: folded at the next tool boundary
  assert.equal(L.sendKey(key('Enter', { shift: true }), S()), 'newline');
  assert.equal(L.sendKey(key('Enter', { composing: true }), S()), null);
  assert.equal(L.sendKey(key('a'), S()), null);
  assert.equal(L.sendKey(key('Enter'), S({ popupOpen: true })), null);    // the palette takes Entrée
});

test('Alt+Entrée = « après ce tour » while running; Ctrl+Entrée = « maintenant » only with interrupt_send_now_v1', () => {
  assert.equal(L.sendKey(key('Enter', { alt: true }), S({ running: true })), 'later');
  assert.equal(L.sendKey(key('Enter', { alt: true }), S()), 'send');
  assert.equal(L.sendKey(key('Enter', { ctrl: true }), S({ running: true, canSendNow: true })), 'now');
  assert.equal(L.sendKey(key('Enter', { ctrl: true }), S({ running: true, canSendNow: false })), 'send');
  assert.equal(L.sendKey(key('Enter', { ctrl: true }), S({ canSendNow: true })), 'send');
  // « Envoyer avec Ctrl+Entrée »: Entrée inserts a newline
  assert.equal(L.sendKey(key('Enter'), S({ ctrlEnterSends: true })), 'newline');
  assert.equal(L.sendKey(key('Enter', { ctrl: true }), S({ ctrlEnterSends: true })), 'send');
});

test('queue chips follow the delivery states (SPEC §9.2 item 6)', () => {
  const chip = (delivery: string, priority?: string) => L.queueChip({ uuid: 'u', text: 't', images: 0, delivery, ...(priority ? { priority } : {}) });
  assert.equal(chip('queued').key, 'queue.item');
  assert.equal(chip('queued', 'later').key, 'queue.later');
  assert.equal(chip('pending').removable, true);
  for (const d of ['started', 'folded', 'completed']) assert.deepEqual([chip(d).key, chip(d).removable], ['queue.taken', false]);
  for (const d of ['cancelled', 'refused']) assert.equal(chip(d).key, 'queue.removed');
  assert.deepEqual([chip('returned').key, chip('returned').resend], ['queue.returned', true]);
  const q = ['queued', 'started', 'returned', 'folded', 'pending'].map((delivery, i) => ({ uuid: String(i), text: 't' + i, images: 0, delivery }));
  assert.deepEqual(L.takeBackable(q).map((x: any) => x.uuid), ['0', '2', '4']);
});

test('slash palette: query only in the first token, grouped builtin › skill › plugin › mcp, aliases match', () => {
  assert.equal(L.slashQuery('/comp', 5), 'comp');
  assert.equal(L.slashQuery('/compact now', 12), null);
  assert.equal(L.slashQuery('hello', 2), null);
  const cmds = [
    { name: 'compact', description: 'Compacter la conversation', group: 'builtin', local: false },
    { name: 'context', description: 'Occupation du contexte', group: 'builtin', local: true },
    { name: 'code-review', description: 'Revue du diff', group: 'skill', local: false, aliases: ['cr'] },
    { name: 'slack-post', description: 'Poster', group: 'mcp', local: false },
  ];
  const g = L.slashResults(cmds, 'c');
  assert.deepEqual(g.map((x: any) => x.group), ['builtin', 'skill', 'mcp']);
  assert.deepEqual(L.slashResults(cmds, 'cr').flatMap((x: any) => x.items.map((c: any) => c.name))[0], 'code-review');
  assert.deepEqual(L.slashResults(cmds, 'zzz'), []);
  assert.deepEqual(L.INTERCEPTED, ['model', 'effort', 'rewind', 'clear']);
});

test('slash palette hides terminal-only commands (init.terminal_slash_commands and TUI-only ones), even on an exact query', () => {
  const names = (q: string, cmds: any[]) => L.slashResults(cmds, q).flatMap((x: any) => x.items.map((c: any) => c.name));
  const cmds = ['doctor', 'color', 'focus', 'reload-plugins', 'vim', 'exit', 'login', 'compact', 'context', 'cost']
    .map((name) => ({ name, description: name, group: 'builtin', local: false }));
  assert.deepEqual(names('', cmds).sort(), ['compact', 'context', 'cost']);
  for (const q of ['doctor', 'color', 'focus', 'reload', 'vim', 'exit', 'login']) assert.deepEqual(names(q, cmds), [], q);
  for (const n of ['doctor', 'color', 'focus', 'reload-plugins']) assert.ok(L.TERMINAL_ONLY.has(n), n);
});

test('@ mentions: token before the caret, insertion with forward slashes and a trailing « / » for folders', () => {
  assert.deepEqual(L.mentionQuery('voir @src/pa', 12), { start: 5, q: 'src/pa' });
  assert.equal(L.mentionQuery('mail a@b', 8), null);
  const r = L.insertMention('voir @src/pa et', { start: 5 }, 12, 'src\\parser', true);
  assert.equal(r.text, 'voir @src/parser/  et');
  assert.equal(r.caret, 'voir @src/parser/ '.length);
});

test('pasted text loses zero-width and bidi control characters (ux §7.6)', () => {
  const r = L.stripInvisible('a​b‮c﻿');
  assert.deepEqual(r, { text: 'abc', removed: 3 });
  assert.deepEqual(L.stripInvisible('rien'), { text: 'rien', removed: 0 });
});

test('L1 image budget: each ≤ MAX_IMAGE_BYTES, the sum ≤ MAX_IMAGES_TOTAL_BYTES, small images untouched', () => {
  const lim = { perImage: LIMITS.MAX_IMAGE_BYTES, total: LIMITS.MAX_IMAGES_TOTAL_BYTES };
  assert.deepEqual(L.imageTargets([1000, 2000], lim), [1000, 2000]);
  const big = L.imageTargets([6 * 2 ** 20, 100], lim);
  assert.equal(big[0], LIMITS.MAX_IMAGE_BYTES); assert.equal(big[1], 100);
  const many = Array.from({ length: 8 }, () => 4 * 2 ** 20);
  const t = L.imageTargets(many, lim);
  assert.ok(t.reduce((a: number, b: number) => a + b, 0) <= LIMITS.MAX_IMAGES_TOTAL_BYTES);
  assert.ok(t.every((x: number) => x <= LIMITS.MAX_IMAGE_BYTES && x > 0));
  assert.equal(LIMITS.MAX_IMAGES_TOTAL_BYTES, 12 * 2 ** 20);
  assert.ok(LIMITS.MAX_IMAGES_TOTAL_BYTES < LIMITS.WS_MAX_PAYLOAD_BYTES);    // a send frame never exceeds the socket cap
  assert.equal(L.imageTokens(1000, 750), 1000);
});

test('token hints: sleeping chat > 20 k, expired cache > 30 k, context near auto-compaction (window − 33 k, 5 %)', () => {
  const now = 1_000_000;
  assert.equal(L.recacheEstimate(84_000), 65_000);
  assert.equal(L.recacheEstimate(10_000), 0);
  assert.equal(wakeHint({ phase: 'cold', live: false, wake: { lastContext: 84_000, recacheTokens: 0 }, metrics: {}, now }).key, 'composer.wake');
  assert.equal(wakeHint({ phase: 'cold', live: false, wake: { lastContext: 30_000, recacheTokens: 0 }, metrics: {}, now }), null);
  assert.equal(wakeHint({ phase: 'idle', live: true, metrics: { contextTokens: 80_000, cacheWarmUntil: now - 1 }, now }).key, 'composer.cacheCold');
  assert.equal(wakeHint({ phase: 'idle', live: true, metrics: { contextTokens: 80_000, cacheWarmUntil: now + 60_000 }, now }), null);
  const full = wakeHint({ phase: 'idle', live: true, metrics: { contextTokens: 930_000, contextWindow: 1_000_000, autoCompactAt: 967_000 }, now });
  assert.deepEqual(full, { key: 'composer.contextFull', args: { pct: '93' } });
  assert.equal(L.contextFull({ contextTokens: 500_000, contextWindow: 1_000_000 }), null);
  assert.equal(L.contextFull({ contextTokens: 160_000, contextWindow: 200_000 }), 80);   // 200 k window: 167 k − 10 k = 157 k
  assert.equal(L.contextFull({ contextTokens: 150_000, contextWindow: 200_000 }), null);
});
