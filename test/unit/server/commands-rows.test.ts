// WP-D acceptance 4 (rows of SPEC §6.3 not covered by commands*.test.ts): prespawn gating, send exceed / force and the
// engine's errors, interrupt, cancelQueued, setModel, flags keepAlive, setCwd, sleep, rewind, task, info, terminal copy.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../../../src/shared/protocol.ts';
import type { SessionMeta, SpawnSpec, EnsureOpts } from '../../../src/server/contracts.ts';
import { resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { decodeCommand } from '../../../src/server/platform/terminal.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createWorld, tick } from './_world.ts';

const tmp = createTmpRoot('commands-rows');
after(() => { resetFsGuardForTests(); tmp.dispose(); });
const SID = '4adf4c63-b504-4be1-804b-92a88963e275';
const CHAT = `perso:${SID}`;
const UUID = (n: number): string => `0b6f3a59-0a8e-4c55-8a51-${String(n).padStart(12, '0')}`;
const code = (r: { ok: boolean; err?: P.WireError }): string => (r.ok ? 'ok' : r.err!.code);
type World = ReturnType<typeof createWorld>;
const ensures = (w: World): [SpawnSpec, EnsureOpts][] => w.engine.calls.filter((c) => c.m === 'ensure').map((c) => c.args as [SpawnSpec, EnsureOpts]);
const callsOf = (w: World, m: string): unknown[][] => w.engine.calls.filter((c) => c.m === m).map((c) => c.args);

function indexed(w: World, cwd: string, o: Partial<SessionMeta> = {}): SessionMeta {
  const m: SessionMeta = { accountId: 'perso', sessionId: SID, chatId: CHAT, path: path.join(tmp.root, `${SID}.jsonl`), cwd, title: 'Ancien', titleSource: 'lastPrompt',
    origin: 'cli', createdAt: 1, updatedAt: w.clock.now(), mtimeMs: 1, size: 100, ...o };
  w.index.put(m);
  return m;
}

test('chat.prespawn: only when the setting is on and the chat is cold and not external; always ok', async () => {
  const w = createWorld(tmp, 'prespawn');
  const win = w.window();
  indexed(w, tmp.cwd('r-prespawn'));
  w.meta.saveSettings({ prespawn: false });
  assert.equal(code(await win.req({ t: 'chat.prespawn', chatId: CHAT })), 'ok');
  w.meta.saveSettings({ prespawn: true });
  w.holders.set(CHAT, { pid: 1, kind: 'interactive', entrypoint: 'cli', status: 'idle' });
  assert.equal(code(await win.req({ t: 'chat.prespawn', chatId: CHAT })), 'ok');
  assert.equal(ensures(w).length, 0, 'setting off, then held by a terminal: no spawn');
  w.holders.clear();
  w.engine.failNextEnsure({ code: 'breaker_open' });
  assert.equal(code(await win.req({ t: 'chat.prespawn', chatId: CHAT })), 'ok', 'errors swallowed');
  // the pre-spawn is fire-and-forget and reads the transcript tail (async I/O) before engine.ensure: wait for the call
  // (one tick was enough on an idle machine only; auditor, M2)
  for (let i = 0; i < 300 && !ensures(w).length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(ensures(w).at(-1)![1].why, 'prespawn');
  assert.equal(w.engine.isLive(CHAT), false);
});

test('chat.send: exceed / force reach the engine; cap_busy, external, breaker_open, not_logged_in, cwd_missing come back', async () => {
  const w = createWorld(tmp, 'send-errors');
  const win = w.window();
  const cwd = tmp.cwd('r-send');
  indexed(w, cwd);
  const send = (n: number, o: Record<string, unknown> = {}) => win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(n), text: 'x', ...o });
  const holder: P.ExternalHolder = { pid: 7, kind: 'interactive', entrypoint: 'cli', status: 'busy' };
  for (const err of [{ code: 'cap_busy' }, { code: 'breaker_open' }, { code: 'external', holder }] as P.WireError[]) {
    w.engine.failNextEnsure(err);
    const r = await send(1);
    assert.deepEqual(r.ok ? null : r.err, err);
  }
  assert.deepEqual(await send(1, { exceed: true }), { ok: true, data: { accepted: 'new' } }, 'refused sends are not remembered as sent');
  assert.equal(ensures(w).at(-1)![1].exceed, true);
  await w.engine.sleep(CHAT, 'user');
  await send(2, { force: true });
  assert.equal(ensures(w).at(-1)![1].force, true);
  await w.engine.sleep(CHAT, 'user');
  indexed(w, path.join(cwd, 'gone'));
  assert.equal(code(await send(3)), 'cwd_missing', 'recorded folder gone → resume.cwdMissing');
  const other = 'pro:5bdf4c63-b504-4be1-804b-92a88963e275';
  w.index.put({ ...indexed(w, cwd), accountId: 'pro', chatId: other, sessionId: other.slice(4) });
  assert.equal(code(await win.req({ t: 'chat.send', chatId: other, uuid: UUID(4), text: 'x' })), 'not_logged_in');
});

test('interrupt, cancelQueued, setModel, flags keepAlive, task, info on a live chat', async () => {
  const w = createWorld(tmp, 'live-rows');
  const win = w.window();
  indexed(w, tmp.cwd('r-live'));
  assert.deepEqual(await win.req({ t: 'chat.interrupt', chatId: CHAT }), { ok: true, data: { stillQueued: [] } }, 'cold: nothing to stop');
  assert.deepEqual(await win.req({ t: 'chat.cancelQueued', chatId: CHAT, uuid: UUID(9) }), { ok: true, data: { cancelled: false } });
  assert.equal(callsOf(w, 'cancelQueued').length, 0, 'cold: the engine is not asked');
  assert.equal(code(await win.req({ t: 'chat.task', chatId: CHAT, op: 'stopAll' })), 'not_live');
  assert.equal(code(await win.req({ t: 'chat.setModel', chatId: CHAT, model: 'opus', effort: 'high' })), 'ok');
  assert.deepEqual([w.meta.chat(CHAT)?.model, w.meta.chat(CHAT)?.effort], ['opus', 'high'], 'cold: stored for the next spawn');
  await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(1), text: 'go' });
  assert.equal(ensures(w).at(-1)![0].model, 'opus');
  assert.deepEqual(await win.req({ t: 'chat.interrupt', chatId: CHAT }), { ok: true, data: { stillQueued: [] } });
  assert.equal(callsOf(w, 'interrupt').length, 1);
  assert.deepEqual(await win.req({ t: 'chat.cancelQueued', chatId: CHAT, uuid: UUID(9) }), { ok: true, data: { cancelled: false } });
  assert.deepEqual(callsOf(w, 'cancelQueued'), [[UUID(9)]]);
  assert.equal(code(await win.req({ t: 'chat.setModel', chatId: CHAT, model: null, effort: null })), 'ok');
  assert.deepEqual(callsOf(w, 'setModel').at(-1), [null, null], 'live: setModel + effort');
  assert.equal(w.meta.chat(CHAT)?.model, undefined, 'null clears the stored model');
  assert.equal(code(await win.req({ t: 'chat.flags', chatId: CHAT, keepAlive: true })), 'ok');
  const protect = w.engine.calls.filter((c) => c.m === 'protect').at(-1)!;
  assert.deepEqual(protect.args[1], [CHAT], 'keepAlive → engine.protect');
  assert.equal(code(await win.req({ t: 'chat.task', chatId: CHAT, op: 'stop', ref: 'task-1' })), 'ok');
  assert.deepEqual(callsOf(w, 'task').at(-1), ['stop', 'task-1']);
  for (const what of ['context', 'rules', 'commands'] as const) assert.equal(code(await win.req({ t: 'chat.info', chatId: CHAT, what })), 'ok', what);
  assert.deepEqual(w.engine.calls.filter((c) => ['contextSummary', 'rules', 'commands'].includes(c.m)).map((c) => c.m), ['contextSummary', 'rules', 'commands']);
});

test('chat.setCwd: cold only, S9 errors, stored as the resume cwd; chat.sleep: busy with background tasks, stopTasks, force', async () => {
  const w = createWorld(tmp, 'cwd-sleep');
  const win = w.window();
  const cwd = tmp.cwd('r-cwd');
  indexed(w, path.join(cwd, 'moved-away'));
  const set = (p: string) => win.req({ t: 'chat.setCwd', chatId: CHAT, cwd: p });
  assert.equal(code(await set(path.join(cwd, 'nope'))), 'cwd_missing');
  assert.equal(code(await set(tmp.home)), 'cwd_refused');
  let long = cwd;
  while (long.length < 262) long = path.join(long, 'abcdefghij');
  fs.mkdirSync(long, { recursive: true });
  assert.equal(code(await set(long)), 'cwd_too_long');
  assert.equal(code(await set(cwd)), 'ok');
  assert.equal(w.meta.chat(CHAT)?.cwd, cwd);
  await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(1), text: 'x' });
  assert.equal(ensures(w).at(-1)![0].cwd, cwd, 'the wake uses the new folder');
  assert.equal(code(await set(cwd)), 'busy', 'live: refused');
  w.engine.pushFacts(CHAT, { bgTasks: 2 });
  assert.equal(code(await win.req({ t: 'chat.sleep', chatId: CHAT })), 'busy', 'background tasks need stopTasks');
  assert.equal(code(await win.req({ t: 'chat.sleep', chatId: CHAT, stopTasks: true })), 'ok');
  assert.deepEqual(callsOf(w, 'sleep').at(-1), ['user', { stopTasks: true }]);
  await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(2), text: 'y' });
  assert.equal(code(await win.req({ t: 'chat.sleep', chatId: CHAT, force: true })), 'ok');
  assert.deepEqual(callsOf(w, 'sleep').at(-1), ['force', {}], '« Forcer l\'arrêt » skips the graceful steps');
  assert.equal(code(await win.req({ t: 'chat.sleep', chatId: CHAT })), 'ok', 'already cold');
});

test('chat.rewind: dryRun previews, code rewinds files, conv relaunches at the entry before the prompt', async () => {
  const w = createWorld(tmp, 'rewind');
  const win = w.window();
  const sm = indexed(w, tmp.cwd('r-rewind'));
  const U1 = UUID(11), A1 = UUID(12), U2 = UUID(13);
  w.chains.set(sm.path, [
    { off: 0, len: 1, e: { type: 'user', uuid: U1, parentUuid: null, message: { role: 'user', content: 'a' } } },
    { off: 1, len: 1, e: { type: 'assistant', uuid: A1, parentUuid: U1, message: { id: 'msg_1', role: 'assistant', content: [] } } },
    { off: 2, len: 1, e: { type: 'user', uuid: U2, parentUuid: A1, message: { role: 'user', content: 'b' } } },
  ]);
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  assert.deepEqual(await win.req({ t: 'chat.rewind', chatId: CHAT, userUuid: U2, action: 'both', dryRun: true }), { ok: true, data: { files: [] } });
  assert.deepEqual(callsOf(w, 'rewindFiles'), [[U2, true]], 'dry run: preview only');
  assert.equal(ensures(w).at(-1)![1].why, 'rewind');
  assert.equal(code(await win.req({ t: 'chat.rewind', chatId: CHAT, userUuid: U2, action: 'code', dryRun: false })), 'ok');
  assert.deepEqual(callsOf(w, 'rewindFiles').at(-1), [U2, false]);
  assert.equal(callsOf(w, 'sleep').length, 0, 'code only: no relaunch');
  assert.equal(code(await win.req({ t: 'chat.rewind', chatId: CHAT, userUuid: U2, action: 'conv', dryRun: false })), 'ok');
  assert.deepEqual(callsOf(w, 'sleep').at(-1)?.[0], 'rewind');
  assert.deepEqual(ensures(w).at(-1)![0].start, { kind: 'rewind', atUuid: A1, dropsTurn: U2 });
  await tick();
  assert.ok(win.ws.msgs().some((m) => m.t === 'ev' && m.c === CHAT && m.ev.k === 'reset' && m.ev.reason === 'rewind'));
  assert.equal(code(await win.req({ t: 'chat.rewind', chatId: CHAT, userUuid: UUID(99), action: 'conv', dryRun: false })), 'not_found');
});

test('chat.terminal copyOnly: the -EncodedCommand line, nothing launched or slept; `;` in the folder refused', async () => {
  const w = createWorld(tmp, 'terminal');
  const win = w.window();
  const cwd = tmp.cwd('r-term');
  indexed(w, cwd);
  const r = await win.req<{ command: string }>({ t: 'chat.terminal', chatId: CHAT, copyOnly: true });
  assert.ok(r.ok && r.data!.command.startsWith(`wt.exe -d "${cwd}" powershell.exe -NoProfile -NoExit -EncodedCommand `));
  const script = decodeCommand(r.data!.command.split(' ').at(-1)!);
  assert.ok(script.endsWith(`& 'C:\\fake\\claude.exe' --resume ${SID}`), script);
  assert.ok(!script.includes('$env:CLAUDE_CONFIG_DIR ='), 'default profile: no CLAUDE_CONFIG_DIR');
  assert.equal(callsOf(w, 'sleep').length, 0);
  indexed(w, 'C:\\a;calc');
  assert.equal(code(await win.req({ t: 'chat.terminal', chatId: CHAT, copyOnly: true })), 'cwd_refused');
});
