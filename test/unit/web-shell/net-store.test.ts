// test/unit/web-shell/net-store.test.ts — net.js + apply.js + store.js + actions.js against a fake WebSocket (SPEC §6.1–6.2):
// auth sub-protocols and device token, seq / duplicates / gaps, deltas, reconnect with the same boot (outbox re-send with
// the same uuid, no duplicate turns) and with a new boot (caches dropped, unacknowledged sends returned).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWS, localStore, replaced, tick } from './setup.ts';
import { cid, hello, snap, summary, turn } from './fixtures.ts';
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
const C = cid(1);
const chats = [summary(1, { state: { ...summary(1).state, phase: 'idle', flags: { ...summary(1).state.flags, live: true } } }), summary(2), summary(3, {}, 'pro')];
const recvApply = (ws: FakeWS, frame: unknown[]): void => { ws.recv(frame); apply.flushFrames(); };
const ackTo = (ws: FakeWS, req: any, data?: unknown): void => recvApply(ws, [{ t: 'ack', id: req.id, ok: true, ...(data !== undefined ? { data } : {}) }]);
let ws: FakeWS;

test('limits: the browser copy matches src/shared/limits.ts', () => {
  for (const [k, v] of Object.entries(store.LIMITS)) assert.equal(v, (LIM as any)[k], k);
});

test('connect: #boot is read once, dropped from the URL, sent as smc.boot; device token stored', async () => {
  net.connect();
  ws = FakeWS.last;
  assert.equal(ws.url, 'ws://127.0.0.1:45678/ws');
  assert.deepEqual(ws.protocols, ['smc.v1', 'smc.boot.AbCdEfGhIjKlMnOpQrStUvWx']);
  assert.deepEqual(replaced, ['/']);
  ws.open();
  ws.recv([{ t: 'device-token', token: 'devtok_0123456789abcdef' }]);
  assert.equal(localStore.get('smc.device'), 'devtok_0123456789abcdef');
  recvApply(ws, [hello('boot-1', chats)]);
  await tick();
  assert.equal(store.conn.value.status, 'open');
  assert.equal(store.chats.value.size, 3);
  assert.equal(ws.of('view').length, 1, 'view sent after hello');
});

test('view + snap + ev: tail page loaded, deltas applied, duplicates dropped, a gap asks for a fresh snap', async () => {
  act.openChat(C);
  await tick();
  const view = ws.of('view').at(-1);
  assert.deepEqual(view.full, [C]);
  assert.equal(view.focused, C);
  ackTo(ws, view);
  recvApply(ws, [{ t: 'snap', snap: snap(C, 5, { lastDiskTurnId: 'u:a' }) }]);
  const rec = store.getRec(C);
  assert.equal(rec.seq, 5);
  const page = ws.of('tx.page').at(-1);
  assert.equal(page.chatId, C);
  ackTo(ws, page, { turns: [turn('u:a', 'Bonjour')], cursor: null, hasMore: false });
  await tick();
  assert.deepEqual(rec.turns.value.map((x: any) => x.id), ['u:a']);
  const ev = (s: number, e: unknown) => ({ t: 'ev', c: C, s, ev: e });
  recvApply(ws, [
    ev(6, { k: 'turn.start', turn: { id: 'u:b', at: 2, user: { uuid: 'b', text: 'Suite', origin: 'human' } } }),
    ev(7, { k: 'block', turnId: 'u:b', block: { k: 'text', id: 'a:m1:0', md: '', live: true } }),
    ev(8, { k: 'delta', parts: [['a:m1:0', 'Bon']] }),
    ev(8, { k: 'delta', parts: [['a:m1:0', 'XX']] }),
  ]);
  assert.equal(rec.blockSigs.get('a:m1:0').value.md, 'Bon', 'duplicate s=8 dropped');
  const views = ws.of('view').length;
  recvApply(ws, [ev(10, { k: 'delta', parts: [['a:m1:0', 'perdu']] }), ev(11, { k: 'delta', parts: [['a:m1:0', 'perdu']] })]);
  assert.equal(rec.blockSigs.get('a:m1:0').value.md, 'Bon', 'nothing applied after a gap');
  assert.equal(ws.of('view').length, views + 1, 'gap → view re-sent');
  recvApply(ws, [{ t: 'snap', snap: snap(C, 11, { lastDiskTurnId: 'u:a', live: { id: 'u:b', at: 2, user: null, blocks: [{ k: 'text', id: 'a:m1:0', md: 'Bonjour', live: true }] } }) }]);
  assert.equal(rec.blockSigs.get('a:m1:0').value.md, 'Bonjour');
  assert.deepEqual(rec.turns.value.map((x: any) => x.id), ['u:a', 'u:b'], 'snap merged with no duplicate turn');
  recvApply(ws, [ev(12, { k: 'block', turnId: 'u:b', block: { k: 'text', id: 'a:m1:0', md: 'Bonjour !' } }), ev(13, { k: 'turn.end', turnId: 'u:b', footer: { input: 1, cacheRead: 2, cacheWrite: 0, output: 3, models: [] } })]);
  assert.equal(rec.blockSigs.get('a:m1:0').value.live, undefined, 'block upsert freezes the live block');
  assert.equal(rec.turnSigs.get('u:b').value.footer.output, 3);
});

test('send: optimistic chip; reconnect with the same boot re-sends the SAME uuid, no duplicate turns', async () => {
  const rec = store.getRec(C);
  const uuid = act.actions.send(C, 'Salut');
  await tick();
  assert.equal(rec.localQueue.value[0].uuid, uuid);
  assert.equal(rec.localQueue.value[0].delivery, 'pending');
  assert.equal(ws.of('chat.send')[0].uuid, uuid);
  ws.close(1006);
  assert.equal(store.conn.value.status, 'reconnecting');
  net.reconnectNow();
  const ws2 = FakeWS.last;
  assert.notEqual(ws2, ws);
  assert.deepEqual(ws2.protocols, ['smc.v1', 'smc.auth.devtok_0123456789abcdef'], 'device token, no boot code');
  ws2.open();
  recvApply(ws2, [hello('boot-1', chats)]);
  await tick();
  const resent = ws2.of('chat.send');
  assert.equal(resent.length, 1);
  assert.equal(resent[0].uuid, uuid, 'same uuid');
  assert.equal(ws2.of('view').length, 1);
  recvApply(ws2, [{ t: 'snap', snap: snap(C, 13, { lastDiskTurnId: 'u:a' }) }]);
  assert.equal(ws2.of('tx.page').length, 0, 'same lastDiskTurnId: no reload');
  ackTo(ws2, resent[0], { accepted: 'duplicate' });
  await tick();
  assert.equal(rec.localQueue.value.length, 0, 'chip dropped on ack');
  assert.deepEqual(rec.turns.value.map((x: any) => x.id), ['u:a', 'u:b']);
  ws = ws2;
});

test('new boot: caches and seq dropped, drafts kept, unacknowledged sends return to the composer', async () => {
  const rec = store.getRec(C);
  store.setRemoteDraft(rec, { text: 'brouillon', attachments: [], at: 5 });
  const uuid = act.actions.send(C, 'Perdu ?');
  await tick();
  ws.close(1006);
  net.reconnectNow();
  const ws3 = FakeWS.last;
  ws3.open();
  recvApply(ws3, [hello('boot-2', chats)]);
  await tick();
  assert.equal(ws3.of('chat.send').length, 0, 'never re-sent after a server restart');
  const chip = rec.localQueue.value.find((q: any) => q.uuid === uuid);
  assert.equal(chip.delivery, 'returned');
  assert.ok(store.toasts.value.some((x: any) => x.key === 'send.serverRestarted'));
  assert.equal(rec.turns.value.length, 0);
  assert.equal(rec.seq, -1);
  assert.equal(rec.draft.value.text, 'brouillon');
  recvApply(ws3, [{ t: 'snap', snap: snap(C, 0, { lastDiskTurnId: 'u:a' }) }]);
  assert.equal(ws3.of('tx.page').length, 1, 'tail reloaded after a new boot');
  const id2 = act.resend(C, uuid);
  await tick();
  assert.notEqual(id2, uuid, '« Renvoyer » uses a NEW uuid');
  assert.equal(ws3.of('chat.send')[0].uuid, id2);
  ws = ws3;
});

test('limits: a frame above WS_MAX_PAYLOAD_BYTES is refused locally; images over 12 MiB never leave', async () => {
  const r = await net.request({ t: 'log.client', level: 'warn', msg: 'x'.repeat(LIM.WS_MAX_PAYLOAD_BYTES + 10) });
  assert.deepEqual(r, { ok: false, err: { code: 'too_large' } });
  const before = ws.of('chat.send').length;
  const big = 'A'.repeat(4 * 1024 * 1024);
  act.actions.send(C, 'images', { images: [1, 2, 3, 4].map(() => ({ mediaType: 'image/png', base64: big })) });
  await tick();
  assert.equal(ws.of('chat.send').length, before, 'nothing sent');
  assert.ok(store.toasts.value.some((x: any) => x.key === 'shell.send.imagesTooLarge'));
  assert.equal(act.checkSendLimits('ok', [{ mediaType: 'image/png', base64: 'AAAA' }]), null);
});

test('cap refusal waits for the choice; resolveSend re-sends the same uuid with evict', async () => {
  const uuid = act.actions.send(C, 'cap ?');
  await tick();
  const req = ws.of('chat.send').at(-1);
  recvApply(ws, [{ t: 'ack', id: req.id, ok: false, err: { code: 'cap', candidates: [{ chatId: cid(2), title: 'x', warmMin: 1, recacheTokens: 10, stable: true }] } }]);
  await tick();
  assert.equal(store.sendIssues.value.get(C).uuid, uuid);
  act.resolveSend(C, uuid, { evict: cid(2) });
  await tick();
  const again = ws.of('chat.send').at(-1);
  assert.equal(again.uuid, uuid);
  assert.equal(again.evict, cid(2));
  assert.equal(store.sendIssues.value.has(C), false);
});

test('cap_busy waits inline too (no dead end); resolveSend re-sends the same uuid with exceed', async () => {
  const uuid = act.actions.send(C, 'occupés ?');
  await tick();
  const req = ws.of('chat.send').at(-1);
  recvApply(ws, [{ t: 'ack', id: req.id, ok: false, err: { code: 'cap_busy' } }]);
  await tick();
  assert.equal(store.sendIssues.value.get(C)?.err.code, 'cap_busy');
  assert.equal(store.getRec(C).localQueue.value.find((q: any) => q.uuid === uuid)?.returned, undefined, 'not returned: it waits for the choice');
  act.resolveSend(C, uuid, { exceed: true });
  await tick();
  const again = ws.of('chat.send').at(-1);
  assert.deepEqual([again.uuid, again.exceed], [uuid, true]);
  recvApply(ws, [{ t: 'ack', id: again.id, ok: true, data: { accepted: 'new' } }]);
  await tick();
  assert.equal(store.sendIssues.value.has(C), false);
});

test('« Renvoyer » on a message the server handed back after a crash re-sends it (new uuid) and drops it server-side', async () => {
  const rec = store.getRec(C);
  const old = '6c1f0a59-0a8e-4c55-8a51-000000000077';
  rec.serverQueue.value = [{ uuid: old, text: 'perdu', images: 0, delivery: 'returned' }];   // as the `queue` event leaves it
  const sends = ws.of('chat.send').length;
  const id = act.resend(C, old);
  await tick();
  assert.ok(id && id !== old, 'a new uuid');
  assert.equal(ws.of('chat.cancelQueued').at(-1)?.uuid, old, 'the returned item leaves the server queue (every window)');
  assert.equal(ws.of('chat.send').length, sends + 1);
  assert.equal(ws.of('chat.send').at(-1).text, 'perdu');
  rec.serverQueue.value = [];
});

test('decide: not_pending is a value, not an error', async () => {
  const p = act.actions.decide(C, 'req-1', { kind: 'allow-once' });
  await tick();
  const req = ws.of('chat.decide').at(-1);
  recvApply(ws, [{ t: 'ack', id: req.id, ok: false, err: { code: 'not_pending' } }]);
  assert.equal(await p, 'not_pending');
});

test('ask / askEnd: server-held asks, oldest first, reasons kept for the dock', () => {
  const a = (rid: string, since: number) => ({ chatId: C, requestId: rid, toolUseId: 't' + rid, kind: 'permission', toolName: 'Bash', input: {}, offerAlways: false, alwaysRules: [], offerAuto: false, defaultToNo: false, since });
  recvApply(ws, [{ t: 'ask', ask: a('r2', 20) }, { t: 'ask', ask: a('r1', 10) }]);
  assert.deepEqual(store.useChat(C).asks.value.map((x: any) => x.requestId), ['r1', 'r2']);
  recvApply(ws, [{ t: 'askEnd', chatId: C, requestId: 'r1', reason: 'cancelled' }]);
  assert.deepEqual(store.useChat(C).asks.value.map((x: any) => x.requestId), ['r2']);
  assert.equal(store.askEndReasons.get(`${C}|r1`), 'cancelled');
});

test('rekey (/clear): tabs, panes and draft follow the new chat id', () => {
  const to = cid(9);
  act.openChat(C);
  recvApply(ws, [{ t: 'chats', upsert: [], remove: [], rekey: [{ from: C, to }] }]);
  assert.ok(store.ui.value.tabs.includes(to) && !store.ui.value.tabs.includes(C));
  assert.equal(store.ui.value.panes[0], to);
  assert.equal(store.getRec(to).draft.value.text, 'brouillon');
  net._testReset({ reset: true });
});
