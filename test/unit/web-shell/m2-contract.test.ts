// test/unit/web-shell/m2-contract.test.ts — M2 integration of the shell side of contract.d.ts: the Actions formerly wired
// loosely through configureChatSurface, ChatVM.askEndReason / autoAvailable, chat.retry, UiState.scroll, the chat.send
// frame bound (L1), the activity framing, login error keys and grouped notifications. Owner: M2 web integrator.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWS, tick } from './setup.ts';
import { cid, hello, summary } from './fixtures.ts';
import * as LIM from '../../../src/shared/limits.ts';
// @ts-expect-error browser module without declarations (checked by tsconfig.web.json)
import * as netM from '../../../src/web/net.js';
// @ts-expect-error browser module
import * as applyM from '../../../src/web/apply.js';
// @ts-expect-error browser module
import * as storeM from '../../../src/web/store.js';
// @ts-expect-error browser module
import * as actionsM from '../../../src/web/actions.js';
// @ts-expect-error browser module
import * as derivedM from '../../../src/web/derived.js';
// @ts-expect-error browser module
import * as loginM from '../../../src/web/components/dialogs/Login.js';
// @ts-expect-error browser module
import * as notifyM from '../../../src/web/lib/notify.js';
// @ts-expect-error browser module
import * as envM from '../../../src/web/components/chat/env.js';

const net: any = netM, apply: any = applyM, store: any = storeM, act: any = actionsM, derived: any = derivedM, login: any = loginM, notify: any = notifyM, env: any = envM;
const C = cid(1);
let ws: FakeWS;
const recvApply = (frame: unknown[]): void => { ws.recv(frame); apply.flushFrames(); };
const ackLast = (t: string, data?: unknown): void => { const req = ws.of(t).at(-1); recvApply([{ t: 'ack', id: req.id, ok: true, ...(data !== undefined ? { data } : {}) }]); };

test('connect + hello', async () => {
  net.connect();
  ws = FakeWS.last;
  ws.open();
  recvApply([hello('boot-m2', [summary(1, { state: { ...summary(1).state, phase: 'idle' } })])]);
  await tick();
  assert.equal(store.conn.value.status, 'open');
});

test('contract: every Actions member of contract.d.ts is implemented, and the chat surface uses the store ones', () => {
  const names = ['send', 'interrupt', 'cancelQueued', 'decide', 'prespawn', 'loadOlder', 'detail', 'mentions', 'prompts', 'setMode', 'setModel',
    'rename', 'task', 'rewind', 'fork', 'info', 'sleep', 'openChat', 'openExternal', 'toast', 'resolveSend', 'resend', 'search', 'logClient',
    'terminal', 'flags', 'openPath', 'setSettings', 'closePane', 'forceStop', 'retry', 'saveView', 'saveScroll'];
  for (const n of names) assert.equal(typeof act.actions[n], 'function', n);
  assert.equal(env.getEnv().actions, act.actions);
  assert.equal(env.getEnv().useChat, store.useChat);
});

test('chat.retry: « Réessayer » / « Relancer » send chat.retry {chatId} and nothing else (never a spawn)', async () => {
  const before = ws.sent.length;
  const p = act.actions.retry(C);
  await tick();
  assert.deepEqual(ws.sent.slice(before).map((m: any) => m.t), ['chat.retry']);
  assert.equal(ws.of('chat.retry').at(-1).chatId, C);
  ackLast('chat.retry');
  await p;
});

test('ChatVM: autoAvailable follows meta.autoAvailable (unknown → false); askEndReason reads the askEnd frames', async () => {
  const vm = store.useChat(C);
  assert.equal(vm.autoAvailable.value, false);
  store.getRec(C).meta.value = { model: 'opus', mode: 'default', autoAvailable: true };
  assert.equal(vm.autoAvailable.value, true);
  store.getRec(C).meta.value = { model: 'haiku', mode: 'default' };
  assert.equal(vm.autoAvailable.value, false);
  assert.equal(vm.askEndReason('r-1'), undefined);
  recvApply([{ t: 'askEnd', chatId: C, requestId: 'r-1', reason: 'cancelled' }]);
  assert.equal(vm.askEndReason('r-1'), 'cancelled');
});

test('saveScroll / saveView: UiState.scroll and views are updated (null drops the anchor) and saved through ui.save', async () => {
  act.actions.saveScroll(C, { turnId: 'u:a', offset: 12.4 });
  assert.deepEqual(store.ui.value.scroll[C], { turnId: 'u:a', offset: 12 });
  const u = store.ui.value;
  act.actions.saveScroll(C, { turnId: 'u:a', offset: 12 });
  assert.equal(store.ui.value, u, 'unchanged anchor: no update');
  act.actions.saveView(C, 'detailed');
  assert.equal(store.ui.value.views[C], 'detailed');
  act.actions.saveScroll(C, null);
  assert.equal(C in store.ui.value.scroll, false);
  await new Promise((r) => setTimeout(r, LIM.META_DEBOUNCE_MS + 50));
  const saved = ws.of('ui.save').at(-1);
  assert.ok(saved, 'ui.save sent');
  assert.equal(saved.ui.views[C], 'detailed');
});

test('ui.save is at most META_DEBOUNCE_MS late even under a stream of changes, and flushUiSave sends it at once', async () => {
  const n0 = ws.of('ui.save').length;
  const t0 = Date.now();
  // scroll anchors every 100 ms for 1.25× the debounce: a trailing debounce re-armed by each one would send nothing
  while (Date.now() - t0 < LIM.META_DEBOUNCE_MS * 1.25) {
    act.actions.saveScroll(C, { turnId: 'u:a', offset: Date.now() - t0 });
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ws.of('ui.save').length > n0, 'saved during the stream of changes');
  act.actions.saveView(C, 'focus');
  const n1 = ws.of('ui.save').length;
  act.flushUiSave();                                             // pagehide
  assert.equal(ws.of('ui.save').length, n1 + 1);
  assert.equal(ws.of('ui.save').at(-1).ui.views[C], 'focus');
  act.flushUiSave();
  assert.equal(ws.of('ui.save').length, n1 + 1, 'nothing pending: nothing sent');
});

test('L1: the serialized chat.send frame is bounded by WS_MAX_PAYLOAD_BYTES (JSON escaping of control characters)', async () => {
  const text = '\u0001'.repeat(1_000_000);                   // 1 MB of UTF-8, 6 MB once JSON-escaped
  const img = { mediaType: 'image/png', base64: 'A'.repeat(Math.floor(3.8 * 1024 * 1024)) };
  const images = [img, img, img];                              // 11.4 MiB: under MAX_IMAGES_TOTAL_BYTES
  assert.equal(act.checkSendLimits(text, images), null, 'each limit alone passes');
  assert.equal(act.checkSendLimits(text, images, { t: 'chat.send', chatId: C, uuid: 'u', text, images }), 'shell.err.tooLarge');
  const before = ws.of('chat.send').length;
  act.actions.send(C, text, { images });
  await tick();
  assert.equal(ws.of('chat.send').length, before, 'nothing sent');
  assert.ok(store.toasts.value.some((x: any) => x.key === 'shell.err.tooLarge'));
  assert.equal(store.getRec(C).localQueue.value.at(-1).delivery, 'returned');
});

test('activity: data-only from the server, framed in French by the client', () => {
  const s = (phase: string, activity: string) => ({ ...summary(1), activity, state: { ...summary(1).state, phase } });
  assert.equal(derived.activityText(s('running', 'Bash : npm test')), '« Bash : npm test »');
  assert.equal(derived.activityText(s('needs_answer', 'Quelle lib ?')), 'Question : Quelle lib ?');
  assert.equal(derived.activityText(s('needs_plan', 'Refactorer auth')), 'Plan à valider : Refactorer auth');
  assert.equal(derived.activityText(s('idle', '  ')), '');
});

test('login errors: the key renders through i18n with the raw message as {detail} / {code}; unknown key → message', () => {
  assert.equal(login.loginErrorText({ key: 'login.err.timeout', message: 'timeout' }), 'Délai de connexion dépassé (10 min).');
  assert.equal(login.loginErrorText({ key: 'login.err.failed', message: 'invalid_grant' }), 'Connexion échouée : invalid_grant');
  assert.equal(login.loginErrorText({ key: 'login.err.exit', message: '3' }), 'Le processus de connexion s\'est arrêté (code 3).');
  assert.equal(login.loginErrorText({ key: 'login.err.nope', message: 'brut' }), 'brut');
  assert.equal(login.loginErrorText({ message: 'brut' }), 'brut');
});

test('notifications: the grouped « notif.multi » closes the single one it replaces (one on screen per burst)', () => {
  const open: any[] = [];
  const g = globalThis as any;
  g.Notification = class { static permission = 'granted'; tag: string; closed = false; onclose: any = null; onclick: any = null;
    constructor(_t: string, o: { tag: string }) { this.tag = o.tag; open.push(this); }
    close() { this.closed = true; this.onclose?.(); } };
  const a = { tag: 'smc:a', title: 'A', body: '', chatId: 'x:a' }, b = { tag: 'smc:b', title: 'B', body: '', chatId: 'x:b' };
  let r = notify.groupNotif({ at: 0, items: [] }, a, 1000);
  notify.deliver(r.show, () => {});
  r = notify.groupNotif(r.buf, b, 2000);
  assert.equal(r.show.tag, notify.MULTI_TAG);
  notify.deliver(r.show, () => {});
  assert.deepEqual(open.filter((n) => !n.closed).map((n) => n.tag), [notify.MULTI_TAG]);
  delete g.Notification;
});
