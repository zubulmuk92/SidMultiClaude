// test/unit/web-shell/outbox-drafts.test.ts — store / net / apply / actions edge cases (audit round 1): drafts are never
// echoed nor reverted by an older server copy; requests with side effects are not replayed after a same-boot reconnect;
// login `waiting` keeps the URL; removed and re-keyed chats keep the layout consistent; sleeping a chat in the middle
// of a turn is confirmed first; error copy; UTF-8 frame size; a reset during a tail load asks again.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWS, tick } from './setup.ts';
import { cid, hello, state, summary, turn } from './fixtures.ts';
import * as LIM from '../../../src/shared/limits.ts';
// @ts-expect-error browser module without declarations (checked by tsconfig.web.json)
import * as netM from '../../../src/web/net.js';
// @ts-expect-error browser module
import * as applyM from '../../../src/web/apply.js';
// @ts-expect-error browser module
import * as storeM from '../../../src/web/store.js';
// @ts-expect-error browser module
import * as actionsM from '../../../src/web/actions.js';

const net: any = netM, apply: any = applyM, store: any = storeM, act: any = actionsM;
const C = cid(1), D = cid(2), R = cid(3);
const chats = [summary(1), summary(2), summary(3, { state: state('running', 5) })];
const recvApply = (ws: FakeWS, frame: unknown[]): void => { ws.recv(frame); apply.flushFrames(); };
const draft = (text: string, at: number) => ({ text, attachments: [], at });
let ws: FakeWS;

/** Drops the socket and reconnects with the device token; the new socket gets `hello(boot)`. */
async function reconnect(boot: string, o: Record<string, unknown> = {}): Promise<FakeWS> {
  ws.close(1006);
  net.reconnectNow();
  const next = FakeWS.last;
  assert.notEqual(next, ws);
  next.open();
  recvApply(next, [hello(boot, chats, o)]);
  await tick();
  ws = next;
  return next;
}

test('drafts: no echo of the initial or a remote draft; a newer local draft survives a same-boot hello', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    net.connect();
    ws = FakeWS.last;
    ws.open();
    ws.recv([{ t: 'device-token', token: 'devtok_drafts_0123456789' }]);
    recvApply(ws, [hello('b1', chats, { drafts: { [C]: draft('copie serveur', 10) } })]);
    await tick();
    assert.equal(store.getRec(C).draft.value.text, 'copie serveur');
    store.getRec(D);                                      // hover prefetch / Peek / open: a record with an empty draft
    mock.timers.tick(1500);
    await tick();
    assert.equal(ws.of('draft.save').length, 0, 'neither the empty initial draft nor the server copy is sent back');
    const rec = store.getRec(C);
    rec.draft.value = draft('tapé ici', 20);
    mock.timers.tick(1100);
    await tick();
    assert.deepEqual(ws.of('draft.save').map((m: any) => m.draft?.text), ['tapé ici']);
    recvApply(ws, [{ t: 'ack', id: ws.of('draft.save')[0].id, ok: true }]);
    ws.close(1006);                                       // connection lost; the user keeps typing
    rec.draft.value = draft('tapé hors ligne', 30);
    mock.timers.tick(1100);
    net.reconnectNow();
    const ws2 = FakeWS.last;
    ws2.open();
    recvApply(ws2, [hello('b1', chats, { drafts: { [C]: draft('tapé ici', 20) } })]);
    await tick();
    ws = ws2;
    assert.equal(rec.draft.value.text, 'tapé hors ligne', 'an older server copy never reverts what was typed meanwhile');
    assert.deepEqual(ws2.of('draft.save').map((m: any) => m.draft?.text), ['tapé hors ligne'], 'the queued save goes out after hello');
    recvApply(ws2, [{ t: 'ack', id: ws2.of('draft.save')[0].id, ok: true }]);
    recvApply(ws2, [hello('b1', chats, { drafts: { [C]: draft('autre fenêtre', 40) } })]);
    assert.equal(rec.draft.value.text, 'autre fenêtre', 'a newer copy (another window) wins');
    rec.draft.value = draft('x', 50);
    store.setRemoteDraft(rec, draft('autre fenêtre bis', 60));
    mock.timers.tick(1500);
    await tick();
    assert.deepEqual(ws2.of('draft.save').map((m: any) => m.draft?.text), ['tapé hors ligne'], 'a remote draft cancels the local save still waiting for its debounce');
  } finally { mock.timers.reset(); }
});

test('outbox, same boot: chat.send / reads / saves are re-sent; requests with side effects fail with connection_lost', async () => {
  const create = net.request({ t: 'chat.create', accountId: 'perso', cwd: 'C:\\proj\\p1', mode: 'default' });
  const page = net.request({ t: 'tx.page', chatId: C, limit: 30 });
  const interrupt = net.request({ t: 'chat.interrupt', chatId: R });
  const uuid = act.actions.send(R, 'encore');
  await tick();
  assert.equal(ws.of('chat.create').length, 1);
  const ws2 = await reconnect('b1');
  assert.equal(ws2.of('chat.create').length, 0, 'never created twice');
  assert.equal(ws2.of('chat.interrupt').length, 0, 'never interrupts the next turn by accident');
  assert.deepEqual(await create, { ok: false, err: { code: 'internal', message: 'connection_lost' } });
  assert.equal((await interrupt).ok, false);
  assert.equal(ws2.of('tx.page').length, 1, 'a read is simply asked again');
  assert.equal(ws2.of('chat.send')[0]?.uuid, uuid, 'chat.send: same uuid (the server deduplicates)');
  recvApply(ws2, [{ t: 'ack', id: ws2.of('tx.page')[0].id, ok: true, data: { turns: [], cursor: null, hasMore: false } }]);
  assert.equal((await page).ok, true);
  assert.equal(act.errorKey({ code: 'internal', message: 'connection_lost' }).key, 'shell.err.connectionLost');
  const fork = net.request({ t: 'chat.fork', chatId: C });
  await tick();
  const ws3 = await reconnect('b2');
  assert.deepEqual(await fork, { ok: false, err: { code: 'internal', message: 'restarted' } }, 'new boot: not « message non envoyé »');
  assert.equal(act.errorKey({ code: 'internal', message: 'restarted' }).key, 'shell.err.restarted');
  assert.equal(ws3.of('chat.send').length, 0, 'new boot: chat.send never re-sent');
  assert.equal(store.getRec(R).localQueue.value.find((q: any) => q.uuid === uuid)?.delivery, 'returned');
});

test('offline settings changes add up: the waiting settings.set patch is merged, never dropped', async () => {
  ws.close(1006);
  void net.request({ t: 'settings.set', patch: { theme: 'dark' } });
  void net.request({ t: 'settings.set', patch: { density: 'comfortable' } });
  void net.request({ t: 'ui.save', ui: { ...store.ui.value, layout: 2 } });
  void net.request({ t: 'ui.save', ui: { ...store.ui.value, layout: 3 } });
  net.reconnectNow();
  const next = FakeWS.last;
  next.open();
  recvApply(next, [hello('b2', chats)]);
  await tick();
  ws = next;
  assert.deepEqual(next.of('settings.set').map((m: any) => m.patch), [{ theme: 'dark', density: 'comfortable' }]);
  assert.deepEqual(next.of('ui.save').map((m: any) => m.ui.layout), [3], 'whole states: the latest wins');
});

test('frame size counts UTF-8 bytes: 6 Mi three-byte characters are refused locally', async () => {
  const before = ws.sent.length;
  const r = await net.request({ t: 'log.client', level: 'warn', msg: '€'.repeat(6 * 1024 * 1024) });
  assert.deepEqual(r, { ok: false, err: { code: 'too_large' } });
  assert.equal(ws.sent.length, before, 'nothing left the page');
  assert.ok('€'.repeat(6 * 1024 * 1024).length < LIM.WS_MAX_PAYLOAD_BYTES, 'the UTF-16 length alone would have let it through');
});

test('login: `waiting` right after `url` keeps the URL; done / error replace it; a server restart ends it', async () => {
  const acc = 'perso';
  const url = { step: 'url', url: 'https://claude.ai/oauth/authorize?x=1' };
  recvApply(ws, [{ t: 'login', accountId: acc, step: url }, { t: 'login', accountId: acc, step: { step: 'waiting' } }]);
  assert.deepEqual(store.loginSteps.value[acc], url);
  recvApply(ws, [{ t: 'login', accountId: acc, step: { step: 'done', email: 'a@b.c', plan: 'Max' } }]);
  assert.equal(store.loginSteps.value[acc].step, 'done');
  recvApply(ws, [{ t: 'login', accountId: 'pro', step: { step: 'waiting' } }]);
  assert.equal(store.loginSteps.value.pro.step, 'waiting', 'waiting alone is shown as is');
  await reconnect('b3');                                  // the login run died with the server
  assert.equal(store.loginSteps.value.pro.step, 'error');
  assert.equal(store.loginSteps.value[acc].step, 'done', 'a finished login stays finished');
});

test('chats removed by the server leave no tab or pane; a rekey (/clear) is saved and moves the per-chat view', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    act.openChat(C);
    act.openChat(D, 'newPane');
    assert.deepEqual(store.ui.value.panes, [C, D]);
    recvApply(ws, [{ t: 'chats', upsert: [], remove: [D] }]);
    assert.ok(!store.ui.value.tabs.includes(D) && !store.ui.value.panes.includes(D), 'deleted elsewhere: tab and pane gone');
    act.updateUi((u: any) => ({ ...u, views: { ...u.views, [C]: 'focus' } }));
    mock.timers.tick(1100);
    await tick();
    const saves = ws.of('ui.save').length;
    const to = cid(9);
    recvApply(ws, [{ t: 'chats', upsert: [summary(9)], remove: [], rekey: [{ from: C, to }] }]);
    assert.equal(store.ui.value.views[to], 'focus');
    assert.equal(store.ui.value.views[C], undefined);
    mock.timers.tick(1100);
    await tick();
    assert.ok(ws.of('ui.save').length > saves, 'the re-keyed layout is saved: a reload shows the new conversation');
    const last = ws.of('ui.save').at(-1).ui;
    assert.ok(last.tabs.includes(to) && !last.tabs.includes(C) && last.panes[0] === to);
  } finally { mock.timers.reset(); }
});

test('sleep: a chat in the middle of a turn is confirmed first; « Forcer l\'arrêt » and idle chats are not', async () => {
  const before = ws.of('chat.sleep').length;
  const p = act.sleepChat(R);
  await tick();
  assert.equal(store.overlay.value?.kind, 'confirm');
  assert.equal(store.overlay.value.props.body, 'shell.sleep.running');
  store.overlay.value.props.resolve(false);
  store.overlay.value = null;
  await p;
  assert.equal(ws.of('chat.sleep').length, before, 'cancelled: nothing sent');
  const q = act.sleepChat(R, false, true);
  await tick();
  assert.equal(store.overlay.value, null);
  const req = ws.of('chat.sleep').at(-1);
  assert.equal(req.force, true);
  recvApply(ws, [{ t: 'ack', id: req.id, ok: true }]);
  await q;
  const idle = act.sleepChat(cid(4));
  await tick();
  assert.equal(store.overlay.value, null, 'not in a turn: no confirmation');
  recvApply(ws, [{ t: 'ack', id: ws.of('chat.sleep').at(-1).id, ok: true }]);
  await idle;
});

test('error copy: forbidden is a plain refusal; cwd_refused tells the home folder and profile folders apart', () => {
  assert.equal(act.errorKey({ code: 'forbidden' }).key, 'shell.err.forbidden');
  assert.equal(act.errorKey({ code: 'cwd_refused' }, 'C:\\Users\\me').key, 'new.homeRefused');
  assert.equal(act.errorKey({ code: 'cwd_refused' }, 'C:\\Users\\me\\.claude-pro\\projects').key, 'new.profileRefused');
  assert.equal(act.errorKey({ code: 'cwd_refused' }, 'C:\\Users\\me\\.claude').args.chemin, 'C:\\Users\\me\\.claude');
  assert.equal(act.errorKey({ code: 'cwd_refused' }, 'C:\\Users\\me\\AppData\\Local\\SidMultiClaude\\x').key, 'new.profileRefused');
  assert.equal(act.errorKey({ code: 'cwd_refused' }, 'C:\\Users\\me\\claude-notes').key, 'new.homeRefused');
});

test('a reset while the tail page is in flight drops that page and asks again', async () => {
  const rec = store.getRec(C);
  const n0 = ws.of('tx.page').length;
  const p = act.loadTail(C);
  await tick();
  const first = ws.of('tx.page').at(-1);
  assert.equal(ws.of('tx.page').length, n0 + 1);
  apply.applyChatEvent(rec, { k: 'reset', reason: 'clear' });
  recvApply(ws, [{ t: 'ack', id: first.id, ok: true, data: { turns: [turn('u:old', 'avant /clear')], cursor: null, hasMore: false } }]);
  await tick();
  assert.equal(ws.of('tx.page').length, n0 + 2, 'asked again');
  recvApply(ws, [{ t: 'ack', id: ws.of('tx.page').at(-1).id, ok: true, data: { turns: [turn('u:new', 'après')], cursor: null, hasMore: false } }]);
  await p;
  assert.deepEqual(rec.turns.value.map((x: any) => x.id), ['u:new']);
  net._testReset({ reset: true });
});

test('after a server RESTART the window keeps its newer layout (the server may have lost its last ui.save) and saves it again', async () => {
  const mine = { ...store.ui.value, layout: 4, focusedPane: 3 };
  store.ui.value = mine;                                           // acknowledged earlier: nothing pending any more
  const serverUi = { ...mine, layout: 1, focusedPane: 0 };         // what the crashed server had on disk
  const before = ws.of('ui.save').length;
  const next = await reconnect(`b-restart-${Date.now()}`, { ui: serverUi });
  assert.equal(store.ui.value.layout, 4, 'the local layout wins over the restarted server');
  act.flushUiSave();                                               // the re-save is scheduled: send it now
  assert.equal(next.of('ui.save').at(-1)?.ui.layout, 4, 'and is saved again');
  assert.ok(next.of('ui.save').length > 0 && before >= 0);
  for (const r of next.of('ui.save')) recvApply(next, [{ t: 'ack', id: r.id, ok: true }]);   // the server took it
  await tick();
  // a plain reconnect to the SAME server process adopts the server's layout (another window may have changed it)
  const boot = store.conn.value.boot;
  await reconnect(boot, { ui: { ...mine, layout: 2 } });
  assert.equal(store.ui.value.layout, 2);
});
