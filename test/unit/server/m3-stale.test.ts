// test/unit/server/m3-stale.test.ts — M3 (real run, screenshot 02): transcript tails keep their last error forever. The
// orchestrator seeds a cold chat's limit only while resetsAt > clock.now(), clears it once reset, and an old `auth` error
// marks a chat only while its account still needs a login (reauth / disconnected).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type * as P from '../../../src/shared/protocol.ts';
import type { SessionMeta } from '../../../src/server/contracts.ts';
import { resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createWorld, tick } from './_world.ts';

const tmp = createTmpRoot('m3stale');
after(() => { resetFsGuardForTests(); tmp.dispose(); });
type World = ReturnType<typeof createWorld>;
const DAY = 86_400_000;
const sid = (n: number): string => `5bdf4c63-b504-4be1-804b-${String(n).padStart(12, '0')}`;

function put(w: World, accountId: 'perso' | 'pro', n: number, lastError: SessionMeta['lastError']): P.ChatId {
  const sessionId = sid(n);
  const chatId = `${accountId}:${sessionId}`;
  w.index.put({ accountId, sessionId, chatId, path: path.join(tmp.root, `${sessionId}.jsonl`), cwd: tmp.cwd(`p${n}`), title: `Chat ${n}`,
    titleSource: 'lastPrompt', origin: 'cli', createdAt: 1, updatedAt: w.clock.now() - 40 * DAY, mtimeMs: 1, size: 100, ...(lastError ? { lastError } : {}) });
  return chatId;
}
const helloState = (w: World, chatId: P.ChatId): P.ChatStateView => {
  const h = w.orch.hello() as Extract<P.S2C, { t: 'hello' }>;
  const s = h.chats.find((c) => c.chatId === chatId);
  assert.ok(s, `chat ${chatId} in hello`);
  return s.state;
};

test('a rate limit from an old transcript tail (resetsAt long past) is not shown', () => {
  const w = createWorld(tmp, 'past');
  const c = put(w, 'perso', 1, { kind: 'rate_limit', resetsAt: w.clock.now() - 40 * DAY });
  const st = helloState(w, c);
  assert.equal(st.phase, 'cold');
  assert.equal(st.limit, undefined);
});

test('a future limit is shown, then cleared (and pushed) once it resets', async () => {
  const w = createWorld(tmp, 'future');
  const at = w.clock.now() + 60_000;
  const c = put(w, 'perso', 2, { kind: 'rate_limit', resetsAt: at });
  const win = w.window();
  await tick();
  assert.equal(helloState(w, c).phase, 'rate_limited');
  assert.equal(helloState(w, c).limit?.resetsAt, at);
  w.clock.advance(61_000);
  await tick();
  assert.equal(helloState(w, c).phase, 'cold');
  const ups = win.ws.msgs().flatMap((m) => (m.t === 'chats' ? m.upsert : [])).filter((s) => s.chatId === c);
  assert.ok(ups.some((s) => s.state.phase === 'cold' && !s.state.limit), 'the reset is pushed to the windows');
});

test('an old auth error does not mark a chat of a connected account', () => {
  const w = createWorld(tmp, 'auth-ok');
  const c = put(w, 'perso', 3, { kind: 'auth' });            // perso: connected
  const st = helloState(w, c);
  assert.equal(st.phase, 'cold');
  assert.equal(st.error, undefined);
});

test('an auth error marks the chat while the account needs a login (disconnected / reauth)', () => {
  const w = createWorld(tmp, 'auth-ko');
  const c = put(w, 'pro', 4, { kind: 'auth' });              // pro: disconnected
  assert.equal(helloState(w, c).phase, 'error');
  assert.equal(helloState(w, c).error?.code, 'auth');
});

// M3 verifier: the account's state is read « currently », not once. A login state change summarises again the account's
// chats whose tail ends on an auth error (the real run: a re-login left them in « À traiter » until a restart).
const upserts = (win: { ws: { msgs(): P.S2C[] } }, chatId: P.ChatId): P.ChatSummary[] =>
  win.ws.msgs().flatMap((m) => (m.t === 'chats' ? m.upsert : [])).filter((s) => s.chatId === chatId);

test('a login change pushes the cold chats with an old auth error again (connected: no error; reauth: error)', async () => {
  const w = createWorld(tmp, 'auth-relogin');
  const c = put(w, 'pro', 5, { kind: 'auth' });              // pro: disconnected
  const plain = put(w, 'pro', 6, undefined);
  const other = put(w, 'perso', 7, { kind: 'auth' });        // perso: connected, not touched
  const win = w.window();
  await tick();
  assert.equal(helloState(w, c).phase, 'error');
  w.views[1]!.login = 'connected';
  w.emitAccount('pro');
  await tick();
  assert.equal(upserts(win, c).at(-1)?.state.phase, 'cold', 'pushed without its old error');
  assert.equal(upserts(win, c).at(-1)?.state.error, undefined);
  assert.equal(helloState(w, c).phase, 'cold');
  assert.equal(upserts(win, plain).length, 0, 'only the chats whose tail ends on an auth error');
  assert.equal(upserts(win, other).length, 0, 'only the account that changed');
  w.views[1]!.login = 'reauth';
  w.emitAccount('pro');
  await tick();
  assert.equal(upserts(win, c).at(-1)?.state.phase, 'error', 'marked again while the account needs a login');
  const n = upserts(win, c).length;
  w.emitAccount('pro');                                      // same login state (usage refresh…): nothing pushed
  await tick();
  assert.equal(upserts(win, c).length, n);
});

test('a viewed chat (runtime, not live) drops its old auth error once its account is connected again', async () => {
  const w = createWorld(tmp, 'auth-rt');
  const c = put(w, 'pro', 8, { kind: 'auth' });              // pro: disconnected
  const win = w.window();
  w.orch.onUser(c, 'viewed');                                // creates the runtime, seeded with the error
  await tick();
  assert.equal(helloState(w, c).error?.code, 'auth');
  w.views[1]!.login = 'connected';
  w.emitAccount('pro');
  await tick();
  assert.equal(helloState(w, c).phase, 'cold');
  assert.equal(helloState(w, c).error, undefined);
  assert.equal(upserts(win, c).at(-1)?.state.error, undefined);
});
