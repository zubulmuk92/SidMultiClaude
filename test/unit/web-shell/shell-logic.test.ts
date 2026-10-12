// test/unit/web-shell/shell-logic.test.ts — notification rules (looking matrix, tags, DND, grouping, S17 minimal text),
// tabs / panes / layouts (no duplicates, newPane up to 4 then LRU, closing never stops), title helper, and i18n coverage
// (every literal key used by the WP-E code exists).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './setup.ts';
import { cid, SETTINGS, state, summary } from './fixtures.ts';
// @ts-expect-error browser module without declarations (checked by tsconfig.web.json)
import * as notifyM from '../../../src/web/lib/notify.js';
// @ts-expect-error browser module
import * as actionsM from '../../../src/web/actions.js';
// @ts-expect-error browser module
import * as storeM from '../../../src/web/store.js';
// @ts-expect-error browser module
import * as i18nM from '../../../src/web/lib/i18n.js';
// @ts-expect-error browser module
import * as newChatM from '../../../src/web/components/dialogs/NewChat.js';

const n: any = notifyM, act: any = actionsM, store: any = storeM, i18n: any = i18nM;
const ctx = (o: Record<string, unknown> = {}) => ({ looking: false, settings: SETTINGS, now: 1000, monogram: 'A', accountName: 'ACME', ...o });
const needs = (phase: string, count = 1) => ({ ...state(phase as any, 10), pending: { count, oldestAt: 10 } });

test('notify: needs_* when not looking → tag chatId:kind, minimal text, chime; never when looking, muted, external', () => {
  const prev = summary(1, { state: state('running', 0), title: 'Fix CI' });
  const next = summary(1, { state: needs('needs_permission'), title: 'Fix CI' });
  const ask = { toolName: 'Bash', input: { command: 'rm -rf secret-prompt' } };
  const x = n.notificationFor(prev, next, ctx({ ask }));
  assert.equal(x.tag, `${cid(1)}:perm`);
  assert.equal(x.title, 'Autorisation requise · A · Fix CI');
  assert.equal(x.body, 'Bash', 'tool name only: no input, no prompt (S17)');
  assert.equal(x.sound, 'chime');
  assert.equal(n.notificationFor(prev, next, ctx({ looking: true })), null);
  assert.equal(n.notificationFor(prev, { ...next, muted: true }, ctx()), null);
  assert.equal(n.notificationFor(prev, { ...next, state: { ...next.state, flags: { ...next.state.flags, external: { pid: 1, kind: 'cli', entrypoint: 'cli', status: 'waiting' } } } }, ctx()), null);
  assert.equal(n.notificationFor(undefined, next, ctx()), null, 'first sight (hello) never notifies');
  assert.equal(n.notificationFor(next, next, ctx()), null, 'no change, no notification');
  assert.equal(n.notificationFor(next, { ...next, state: needs('needs_permission', 2) }, ctx()).tag, `${cid(1)}:perm`, 'a second ask re-notifies (same tag replaces)');
  assert.equal(n.notificationFor(prev, { ...next, state: needs('needs_answer') }, ctx()).title, 'Question de Claude · Fix CI');
  assert.equal(n.notificationFor(prev, { ...next, state: needs('needs_plan') }, ctx()).tag, `${cid(1)}:plan`);
});

test('notify: done only after ≥ 10 s of running; error / limit; DND and settings gate delivery', () => {
  const run = summary(1, { state: state('running', 0) });
  const done = (since: number) => summary(1, { state: state('idle', since, { unread: true }) });
  assert.equal(n.notificationFor(run, done(9_000), ctx()), null);
  const x = n.notificationFor(run, done(12_000), ctx());
  assert.equal(x.tag, `${cid(1)}:done`);
  assert.equal(x.body, '', 'no model output in notifications');
  assert.equal(n.notificationFor(run, summary(1, { state: state('error', 5) }), ctx()).sound, 'low');
  assert.match(n.notificationFor(run, summary(1, { state: state('rate_limited', 5) }), ctx()).title, /^Limite atteinte · ACME/);
  assert.deepEqual(n.allowed({ ...SETTINGS, dndUntil: 5000 }, 1000), { os: false, sound: false });
  assert.deepEqual(n.allowed({ ...SETTINGS, dndUntil: 500 }, 1000), { os: true, sound: false });
  assert.deepEqual(n.allowed({ ...SETTINGS, notifications: false, sound: true }, 1000), { os: false, sound: true });
});

test('notify: several within 3 s → one grouped notification', () => {
  const a = { tag: 'a:perm', title: 'A', body: '', chatId: 'a', sound: 'chime' };
  const b = { tag: 'b:ask', title: 'B', body: '', chatId: 'b', sound: 'chime' };
  let g = n.groupNotif({ at: 0, items: [] }, a, 10_000);
  assert.equal(g.show.tag, 'a:perm');
  g = n.groupNotif(g.buf, b, 11_000);
  assert.equal(g.show.tag, 'smc:multi');
  assert.equal(g.show.title, '2 chats ont besoin de vous');
  g = n.groupNotif(g.buf, a, 20_000);
  assert.equal(g.show.tag, 'a:perm', 'window elapsed: single again');
});

test('window title and favicon: at most one paint per second, and the last state is always painted', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  try {
    const at: number[] = [];
    const paint = store.throttle(() => at.push(Date.now()), 1000);
    paint(); paint(); paint();                            // a burst of summary changes
    assert.deepEqual(at, [10_000]);
    mock.timers.tick(400);
    paint();
    assert.equal(at.length, 1, 'held back');
    mock.timers.tick(600);
    assert.deepEqual(at, [10_000, 11_000], 'trailing paint: the latest counts are never lost');
    for (let i = 0; i < 30; i++) { mock.timers.tick(100); paint(); }
    for (let i = 1; i < at.length; i++) assert.ok((at[i] ?? 0) - (at[i - 1] ?? 0) >= 1000, `${at[i]} after ${at[i - 1]}`);
    assert.ok(at.length <= 5, `${at.length} paints in 4 s`);
  } finally { mock.timers.reset(); }
});

test('tabs and panes: no duplicates, newPane up to 4 then LRU, close keeps Claude running, reopen, Alt+n', () => {
  store.chats.value = new Map([1, 2, 3, 4, 5, 6].map((i) => [cid(i), summary(i)]));
  act.openChat(cid(1));
  act.openChat(cid(2));
  assert.deepEqual(store.ui.value.panes, [cid(2)]);
  assert.deepEqual(store.ui.value.tabs, [cid(1), cid(2)]);
  act.openChat(cid(3), 'newPane');
  act.openChat(cid(4), 'newPane');
  act.openChat(cid(5), 'newPane');
  assert.equal(store.ui.value.layout, 4);
  assert.deepEqual(store.ui.value.panes, [cid(2), cid(3), cid(4), cid(5)]);
  act.focusPane(1); act.focusPane(2); act.focusPane(3);
  act.openChat(cid(6), 'newPane');
  assert.deepEqual(store.ui.value.panes, [cid(6), cid(3), cid(4), cid(5)], 'least recently focused pane replaced');
  act.openChat(cid(4));
  assert.equal(store.ui.value.focusedPane, 2, 'already visible: that pane gets the focus (no duplicate)');
  act.openChat(cid(1), 'background');
  assert.ok(!store.ui.value.panes.includes(cid(1)));
  act.closeTab(cid(4));
  assert.ok(!store.ui.value.tabs.includes(cid(4)));
  assert.equal(store.ui.value.closed[0], cid(4));
  act.reopenTab();
  assert.ok(store.ui.value.tabs.includes(cid(4)));
  act.tabAt(1);
  assert.equal(store.ui.value.panes[store.ui.value.focusedPane], store.ui.value.tabs[0]);
  act.setLayout();
  assert.equal(store.ui.value.layout, 1);
  assert.equal(store.ui.value.panes.length, 1);
  act.setLayout(3);
  assert.equal(store.ui.value.panes.length, 3);
  assert.ok(store.ui.value.panes.every((p: string | null) => p !== null), 'new panes filled with open tabs');
  act.moveTab(0, 2);
  assert.equal(store.ui.value.tabs[2], cid(1));
});

test('new chat title: first prompt line without @mentions and /commands, 60 chars max', () => {
  const f = (newChatM as any).titleFromPrompt;
  assert.equal(f('/model opus\nRegarde @src/app.ts et corrige le bug'), 'Regarde et corrige le bug');
  assert.equal(f('x'.repeat(80)).length, 60);
  assert.equal(f(''), '');
});

test('i18n: every literal key used by the shell exists (fr.js)', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'web');
  const files = ['actions.js', 'apply.js', 'net.js', 'store.js', 'derived.js', 'main.js', 'lib/notify.js', 'lib/favicon.js',
    ...fs.readdirSync(path.join(root, 'components', 'shell')).map((f) => `components/shell/${f}`),
    ...fs.readdirSync(path.join(root, 'components', 'dialogs')).map((f) => `components/dialogs/${f}`)];
  const missing: string[] = [];
  const re = /\bt(?:Part|Parts|TitleBody)?\(\s*'([a-z][\w.]*)'|\b(?:key|body|ok|label): '([a-z][a-zA-Z]*\.[\w.]+)'/g;
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(re)) { const k = m[1] ?? m[2]; if (k && !i18n.has(k)) missing.push(`${f}: ${k}`); }
  }
  for (const k of ['shell.view.normal', 'shell.view.detailed', 'shell.view.focus', 'shell.theme.system', 'shell.theme.light', 'shell.theme.dark',
    'shell.status.conn.open', 'shell.status.conn.connecting', 'shell.status.conn.reconnecting', 'shell.status.conn.expired', 'shell.status.conn.closed',
    'shell.bucket.needs', 'shell.bucket.running', 'shell.bucket.error', 'shell.bucket.done', 'shell.bucket.idle', 'shell.bucket.cold',
    'shell.effort.low', 'shell.effort.max', 'state.external.busy', 'state.external.waiting']) if (!i18n.has(k)) missing.push(k);
  // the help overlay: every row has its description and its French key names (`.keys`)
  const help = fs.readFileSync(path.join(root, 'components', 'shell', 'Help.js'), 'utf8');
  const rows = [...help.matchAll(/'(shell\.help\.[\w.]+)'/g)].map((m) => m[1] ?? '');
  assert.ok(rows.length >= 18, 'help rows found');
  for (const k of rows) { if (!i18n.has(k)) missing.push(`Help.js: ${k}`); if (!/^shell\.help\.(title|global|chat|composer|cards|sidebar)$/.test(k) &&!i18n.has(`${k}.keys`)) missing.push(`Help.js: ${k}.keys`); }
  assert.deepEqual(missing, []);
});
