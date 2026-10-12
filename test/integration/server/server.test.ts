// SPEC §12.2(c): the real server (guard + hub + validators + orchestrator + commands + real WP-C stores on a tmp profile)
// with the fake engine, driven by real WebSocket clients. Includes the fault-injection checks (S20).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type * as P from '../../../src/shared/protocol.ts';
import { parseArgs, startApp } from '../../../src/server/main.ts';
import type { AppHandle } from '../../../src/server/main.ts';
import type { FakeEngine } from '../../fakes/fake-engine.ts';
import { resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { appPaths } from '../../../src/server/util/paths.ts';
import { connectWs } from '../../helpers/ws-client.ts';
import type { WsClient } from '../../helpers/ws-client.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const tmp = createTmpRoot('int-server');
const exits: number[] = [];
const opened: string[] = [];
let app: AppHandle;
let fe: FakeEngine;
let w1: WsClient;
let token = '';
const UUID = (n: number): string => `0b6f3a59-0a8e-4c55-8a51-${String(n).padStart(12, '0')}`;

before(async () => {
  tmp.defaultProfile({ login: 'connected' });
  app = await startApp({ args: parseArgs(['--data-dir', tmp.appDir, '--profiles-root', tmp.home, '--fake-engine']),
    env: { ...process.env, SMC_TEST: '1' }, exit: (c) => { exits.push(c); }, openWindow: (_p, code) => { opened.push(code); } });
  fe = app.engine as FakeEngine;
});
after(async () => {
  await app.shutdown(0).catch(() => {});
  resetFsGuardForTests();
  tmp.dispose();
});

test('boot: listening fast on a random port, device token then hello', async () => {
  assert.ok(app.port > 0 && app.port !== 41731);
  assert.ok(app.listenMs < 400, `listening after ${app.listenMs.toFixed(0)} ms`);
  w1 = await connectWs({ port: app.port, boot: app.newBootCode() });
  const hello = await w1.next<Extract<P.S2C, { t: 'hello' }>>((m) => m.t === 'hello');
  assert.ok(w1.deviceToken);
  token = w1.deviceToken!;
  assert.equal(w1.frames[0]![0]!.t, 'device-token', 'device-token is the first frame');
  assert.equal(hello.boot, app.boot);
  assert.equal(hello.settings.maxLive, 4);
  assert.ok(Array.isArray(hello.chats) && Array.isArray(hello.asks));
  assert.ok(fs.existsSync(appPaths(tmp.appDir).instance));
});

test('account → chat → send → streamed turn with contiguous seq; outbox duplicate', async () => {
  const add = await w1.request<P.AccountView>({ t: 'account.add', configDir: null, name: 'Perso', color: 1, monogram: 'P' });
  assert.ok(add.ok, JSON.stringify(add));
  const acc = add.data!;
  const cwd = tmp.cwd('proj');
  const c = await w1.request<{ chatId: string }>({ t: 'chat.create', accountId: acc.id, cwd, mode: 'default', trust: true });
  assert.ok(c.ok, JSON.stringify(c));
  const chatId = c.data!.chatId;
  assert.ok((await w1.request({ t: 'view', full: [chatId], focused: chatId, windowFocused: true })).ok);
  const snap = await w1.next<Extract<P.S2C, { t: 'snap' }>>((m) => m.t === 'snap' && m.snap.chatId === chatId);
  const s = await w1.request({ t: 'chat.send', chatId, uuid: UUID(1), text: 'ECHO: bonjour' });
  assert.deepEqual(s, { ok: true, data: { accepted: 'new' } });
  await w1.next((m) => m.t === 'ev' && m.c === chatId && m.ev.k === 'turn.end');
  const evs = w1.all('ev').filter((m) => m.c === chatId);
  evs.forEach((m, i) => assert.equal(m.s, snap.snap.seq + i + 1, 'contiguous after snap.seq'));
  assert.ok(evs.some((m) => m.ev.k === 'turn.start'));
  assert.deepEqual(await w1.request({ t: 'chat.send', chatId, uuid: UUID(1), text: 'ECHO: bonjour' }), { ok: true, data: { accepted: 'duplicate' } });
  const procs = w1.all('procs').at(-1);
  assert.equal(procs?.procs.live, 1);
  // §2.9: run\crash.marker lists the live chats (rewritten ≤ 1 s after a spawn), so a server crash marks them interrupted
  const marker = appPaths(tmp.appDir).crashMarker;
  let live: string[] = [];
  for (let i = 0; i < 60 && !live.includes(chatId); i++) {
    await new Promise((r) => setTimeout(r, 50));
    try { live = (JSON.parse(fs.readFileSync(marker, 'utf8')) as { live: string[] }).live; } catch { /* being replaced */ }
  }
  assert.deepEqual(live, [chatId], 'the crash marker names the live chat');
});

test('two windows: ask to both, first answer wins, askEnd to both', async () => {
  const w2 = await connectWs({ port: app.port, token });
  await w2.next((m) => m.t === 'hello');
  const chatId = fe.stats().items[0]!.chatId;
  fe.askNow({ chatId, requestId: 'r-1', toolUseId: 't-1', kind: 'permission', toolName: 'Bash', input: { command: 'ls' }, offerAlways: false, alwaysRules: [],
    offerAuto: false, defaultToNo: false, since: Date.now() });
  await Promise.all([w1.next((m) => m.t === 'ask'), w2.next((m) => m.t === 'ask')]);
  const [a, b] = await Promise.all([w2.request({ t: 'chat.decide', chatId, requestId: 'r-1', answer: { kind: 'allow-once' } }),
    w1.request({ t: 'chat.decide', chatId, requestId: 'r-1', answer: { kind: 'deny', message: 'non' } })]);
  assert.deepEqual([a.ok, b.ok ? 'ok' : b.err.code], [true, 'not_pending']);
  await Promise.all([w1.next((m) => m.t === 'askEnd'), w2.next((m) => m.t === 'askEnd')]);
  await w2.close();
});

test('fault injection: a throwing engine call and a crashing chat never stop the server', async () => {
  const chatId = fe.stats().items[0]!.chatId;
  fe.throwOn.add('interrupt');
  const r = await w1.request({ t: 'chat.interrupt', chatId });
  assert.ok(!r.ok && r.err.code === 'timeout');
  fe.throwOn.clear();
  const bad = await w1.request({ t: 'chat.send', chatId, uuid: 'nope', text: 'x' } as never);
  assert.ok(!bad.ok && bad.err.code === 'invalid');
  w1.ws.send('{"id":');                                                       // garbage: logged, no ack, no crash
  fe.crash(chatId, 1);
  await w1.next((m) => m.t === 'chats' && m.upsert.some((s) => s.chatId === chatId && s.state.phase === 'error'));
  const ok = await w1.request({ t: 'account.candidates' });
  assert.ok(ok.ok, 'still serving');
});

test('C13 reopen rule: an ask while no window is connected opens one, which gets the ask in hello', async () => {
  const chatId = w1.all('chats').flatMap((m) => m.upsert)[0]!.chatId;
  await w1.close();
  for (let i = 0; i < 100 && app.hub.connections() > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.hub.connections(), 0);
  const before = opened.length;
  fe.askNow({ chatId, requestId: 'r-reopen', toolUseId: 't-9', kind: 'permission', toolName: 'Bash', input: { command: 'ls' }, offerAlways: false,
    alwaysRules: [], offerAuto: false, defaultToNo: false, since: Date.now() });
  assert.equal(opened.length, before + 1, 'the server opened a window for the ask');
  w1 = await connectWs({ port: app.port, boot: opened.at(-1)! });
  const hello = await w1.next<Extract<P.S2C, { t: 'hello' }>>((m) => m.t === 'hello');
  assert.equal(w1.deviceToken, token, 'the same device token is handed to the new window');
  assert.ok(hello.asks.some((a) => a.requestId === 'r-reopen'), 'pending ask in hello');
  assert.ok((await w1.request({ t: 'chat.decide', chatId, requestId: 'r-reopen', answer: { kind: 'allow-once' } })).ok);
});

test('app.quit: busy while live, then bye + exit 0 + run files removed', async () => {
  const chatId = fe.stats().items[0]?.chatId;
  if (!chatId) {
    const any = w1.all('chats').flatMap((m) => m.upsert)[0]!;
    await w1.request({ t: 'chat.send', chatId: any.chatId, uuid: UUID(9), text: 'ECHO: re' });
  }
  const busy = await w1.request({ t: 'app.quit' });
  assert.ok(!busy.ok && busy.err.code === 'busy');
  const q = await w1.request({ t: 'app.quit', force: true });
  assert.ok(q.ok);
  await w1.next((m) => m.t === 'bye');
  await w1.closed;
  for (let i = 0; i < 50 && !exits.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [0]);
  assert.equal(fs.existsSync(appPaths(tmp.appDir).crashMarker), false);
  assert.equal(fs.existsSync(appPaths(tmp.appDir).instance), false);
});
