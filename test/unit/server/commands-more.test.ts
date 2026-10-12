// WP-D acceptance 4 (continued): bypass proof, re-key, crash → returned queue, delete, fork / continue, rename,
// external holder, transcript pages, session info, settings, open, orphans, quit, logs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type * as P from '../../../src/shared/protocol.ts';
import type { SessionMeta } from '../../../src/server/contracts.ts';
import { resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createWorld, tick } from './_world.ts';

const tmp = createTmpRoot('commands2');
after(() => { resetFsGuardForTests(); tmp.dispose(); });
const SID = '4adf4c63-b504-4be1-804b-92a88963e275';
const CHAT = `perso:${SID}`;
const UUID = (n: number): string => `0b6f3a59-0a8e-4c55-8a51-${String(n).padStart(12, '0')}`;
const code = (r: { ok: boolean; err?: P.WireError }): string => (r.ok ? 'ok' : r.err!.code);

function indexed(w: ReturnType<typeof createWorld>, cwd: string, o: Partial<SessionMeta> = {}): SessionMeta {
  const m: SessionMeta = { accountId: 'perso', sessionId: SID, chatId: CHAT, path: path.join(tmp.root, `${SID}.jsonl`), cwd, title: 'Ancien', titleSource: 'lastPrompt',
    origin: 'cli', createdAt: 1, updatedAt: w.clock.now() - 2 * 3_600_000, mtimeMs: 1, size: 100, lastContext: 150_000, lastRequestAt: w.clock.now() - 2 * 3_600_000, ...o };
  w.index.put(m);
  return m;
}

test('setMode: bypass needs the setting AND typed CONTOURNER; resume never restores bypass', async () => {
  const w = createWorld(tmp, 'mode');
  const win = w.window();
  const cwd = tmp.cwd('p-mode');
  indexed(w, cwd);
  assert.equal(code(await win.req({ t: 'chat.setMode', chatId: CHAT, mode: 'bypassPermissions', typed: 'CONTOURNER' })), 'forbidden');
  w.meta.saveSettings({ allowBypass: true });
  assert.equal(code(await win.req({ t: 'chat.setMode', chatId: CHAT, mode: 'bypassPermissions', typed: 'contourner' })), 'forbidden');
  assert.equal(code(await win.req({ t: 'chat.setMode', chatId: CHAT, mode: 'bypassPermissions', typed: 'CONTOURNER' })), 'ok');
  assert.equal(w.meta.chat(CHAT)?.mode, 'bypassPermissions');
  assert.equal(code(await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(1), text: 'hi' })), 'ok');
  const spec = w.engine.specs.get(CHAT)!;
  assert.equal(spec.start.kind, 'resume');
  assert.equal(spec.mode, 'default', 'bypass downgraded on wake');
  assert.equal(w.engine.calls.find((c) => c.m === 'ensure')?.args[1] && (w.engine.calls.find((c) => c.m === 'ensure')!.args[1] as { why: string }).why, 'wake');
});

test('re-key (/clear): meta, views and chats.rekey move to the new session; the old one stays a cold chat', async () => {
  const w = createWorld(tmp, 'rekey');
  const win = w.window();
  const cwd = tmp.cwd('p-rekey');
  indexed(w, cwd);
  await win.req({ t: 'chat.flags', chatId: CHAT, pinned: true });
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(2), text: '/clear' });
  const NEW = 'perso:9bdf4c63-b504-4be1-804b-92a88963e275';
  w.orch.sink.sessionChanged(CHAT, NEW.slice(6));
  await tick();
  const rk = win.ws.msgs().find((m) => m.t === 'chats' && m.rekey?.length);
  assert.ok(rk && rk.t === 'chats');
  assert.deepEqual(rk.rekey, [{ from: CHAT, to: NEW }]);
  assert.ok(rk.upsert.some((s) => s.chatId === CHAT), 'old session still listed (indexed)');
  assert.equal(w.meta.chat(NEW)?.pinned, true);
  assert.deepEqual([...win.conn.full], [NEW]);
  assert.ok(win.ws.msgs().some((m) => m.t === 'ev' && m.c === NEW && m.ev.k === 'reset'));
});

test('crash: returned queue event + toast, error state; delete needs cold; rename uses the SDK helper when cold', async () => {
  const w = createWorld(tmp, 'crash');
  const win = w.window();
  const cwd = tmp.cwd('p-crash');
  indexed(w, cwd);
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(3), text: 'x' });
  await tick();
  w.engine.pushFacts(CHAT, { queue: [{ uuid: UUID(4), text: 'pas envoyé', images: 0, delivery: 'queued' }] });
  assert.equal(code(await win.req({ t: 'chat.delete', chatId: CHAT, confirm: true })), 'busy');
  w.engine.crash(CHAT, 3);
  await tick();
  const q = win.ws.msgs().filter((m) => m.t === 'ev' && m.ev.k === 'queue').at(-1);
  assert.ok(q && q.t === 'ev' && q.ev.k === 'queue' && q.ev.items[0]?.delivery === 'returned');
  assert.ok(win.ws.msgs().some((m) => m.t === 'toast' && m.key === 'queue.returned.toast'));
  assert.equal(w.orch.summary(CHAT)?.state.phase, 'error');
  assert.equal(code(await win.req({ t: 'chat.rename', chatId: CHAT, title: 'Nouveau nom' })), 'ok');
  assert.deepEqual(w.helperCalls.at(-1), ['rename', 'perso', SID, 'Nouveau nom']);
  assert.equal(w.orch.summary(CHAT)?.title, 'Nouveau nom');
  w.holders.set(CHAT, { pid: 1, kind: 'interactive', entrypoint: 'cli', status: 'idle' });
  assert.equal(code(await win.req({ t: 'chat.rename', chatId: CHAT, title: 'x' })), 'forbidden', 'external holder');
  assert.equal(code(await win.req({ t: 'chat.delete', chatId: CHAT, confirm: true })), 'forbidden');
  w.holders.clear();
  assert.equal(code(await win.req({ t: 'chat.delete', chatId: CHAT, confirm: true })), 'ok');
  assert.deepEqual(w.helperCalls.at(-1), ['remove', 'perso', SID]);
  assert.ok(win.ws.msgs().some((m) => m.t === 'chats' && m.remove.includes(CHAT)));
});

test('fork / continue on another account', async () => {
  const w = createWorld(tmp, 'fork');
  const win = w.window();
  const src = indexed(w, tmp.cwd('p-fork'));
  assert.equal(code(await win.req({ t: 'chat.fork', chatId: CHAT, accountId: 'pro', upToUuid: UUID(5) })), 'invalid');
  assert.equal(code(await win.req({ t: 'chat.fork', chatId: CHAT, accountId: 'pro' })), 'not_logged_in');
  const f = await win.req<{ chatId: string }>({ t: 'chat.fork', chatId: CHAT });
  assert.ok(f.ok);
  const fm = w.meta.chat(f.data!.chatId)!;
  assert.deepEqual(fm.pendingStart, { kind: 'fork', fromChatId: CHAT, fromJsonl: src.path });
  assert.deepEqual(fm.links, { forkedFrom: CHAT });
  w.views[1]!.login = 'connected';
  const c = await win.req<{ chatId: string }>({ t: 'chat.fork', chatId: CHAT, accountId: 'pro' });
  assert.ok(c.ok && c.data!.chatId.startsWith('pro:'));
  assert.deepEqual(w.meta.chat(CHAT)?.links, { continuedTo: c.data!.chatId });
  const up = await win.req<{ chatId: string }>({ t: 'chat.fork', chatId: CHAT, upToUuid: UUID(5) });
  assert.ok(up.ok && up.data!.chatId === 'perso:9adf4c63-b504-4be1-804b-92a88963e275');
  assert.equal(w.meta.chat(up.data!.chatId)?.pendingStart, undefined, 'forkUpTo writes the transcript: plain resume');
  const sendFork = await win.req({ t: 'chat.send', chatId: f.data!.chatId, uuid: UUID(6), text: 'suite' });
  assert.equal(code(sendFork), 'ok');
  assert.deepEqual(w.engine.specs.get(f.data!.chatId)?.start, { kind: 'fork', fromJsonl: src.path, title: 'Ancien' });
});

test('transcript page, session info (foreign CLAUDE.md), wake estimate in the summary', async () => {
  const w = createWorld(tmp, 'tx');
  const win = w.window();
  const sm = indexed(w, tmp.cwd('p-tx'));
  w.chains.set(sm.path, [{ off: 0, len: 10, e: { type: 'user', uuid: UUID(7), parentUuid: null, sessionId: SID, timestamp: '2026-10-08T10:00:00.000Z', message: { role: 'user', content: 'Bonjour' } } }]);
  const p = await win.req<P.TranscriptPage>({ t: 'tx.page', chatId: CHAT, limit: 20 });
  assert.ok(p.ok && p.data!.turns.length === 1 && p.data!.turns[0]!.id === `u:${UUID(7)}`);
  assert.equal(w.orch.snapshot(CHAT)?.lastDiskTurnId, `u:${UUID(7)}`);
  const s = w.orch.summary(CHAT)!;
  assert.ok(s.wake && s.wake.dialog && s.wake.lastContext === 150_000, 'idle > 1 h and > 100 k → wake dialog');
  assert.equal(code(await win.req({ t: 'chat.info', chatId: CHAT, what: 'context' })), 'not_live');
  const info = await win.req<P.SessionInfo>({ t: 'chat.info', chatId: CHAT, what: 'session' });
  assert.ok(info.ok && info.data!.transcriptPath === sm.path && info.data!.instructions[0]!.foreign === false, 'default profile CLAUDE.md is its own');
  assert.equal(code(await win.req({ t: 'tx.detail', chatId: CHAT, blockId: 't:nope', field: 'output' })), 'not_found');
});

test('settings, open, orphans, quit, log.client', async () => {
  const w = createWorld(tmp, 'misc');
  const win = w.window();
  assert.equal(code(await win.req({ t: 'settings.set', patch: { maxLive: 6, reapMin: 30 } })), 'ok');
  assert.ok(w.engine.calls.some((c) => c.m === 'setPolicy' && JSON.stringify(c.args[0]) === '{"maxLive":6,"reapMin":30}'));
  assert.ok(win.ws.msgs().some((m) => m.t === 'settings' && m.settings.maxLive === 6));
  assert.equal(code(await win.req({ t: 'open', what: 'url', target: 'javascript:alert(1)' })), 'invalid');
  assert.equal(code(await win.req({ t: 'open', what: 'explorer', target: 'C:\\Windows' })), 'invalid', 'no chat → no root');
  assert.equal(code(await win.req({ t: 'orphans.kill', pids: [1234] })), 'invalid', 'only pids from the last list');
  assert.equal(code(await win.req({ t: 'log.client', level: 'warn', msg: 'x' })), 'ok');
  const cwd = tmp.cwd('p-misc');
  indexed(w, cwd);
  await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(8), text: 'x' });
  assert.equal(code(await win.req({ t: 'open', what: 'explorer', target: path.join(cwd, '..', '..') })), 'invalid', 'outside the cwd');
  assert.equal(code(await win.req({ t: 'app.quit' })), 'busy');
  assert.equal(code(await win.req({ t: 'app.quit', force: true })), 'ok');
  await tick();
  assert.equal(w.quits.length, 1);
  assert.equal(code(await win.req({ t: 'chat.sleep', chatId: CHAT })), 'ok');
  assert.equal(w.engine.isLive(CHAT), false);
});
