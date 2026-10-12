// M2 server wiring: chat.retry (lead decision), smc_engine notes, AccountView.models, ChatMetaView.autoAvailable,
// the cost baseline seeded from the transcript tail on resume / fork, login cancel key, account.baseline, C2S coverage.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../../../src/shared/protocol.ts';
import type { RawEntry, SessionMeta } from '../../../src/server/contracts.ts';
import { decodeCursor } from '../../../src/server/util/ids.ts';
import { SCHEMAS } from '../../../src/server/ws/validate.ts';
import { resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createWorld, tick } from './_world.ts';

const tmp = createTmpRoot('m2wiring');
after(() => { resetFsGuardForTests(); tmp.dispose(); });
const SID = '4adf4c63-b504-4be1-804b-92a88963e275';
const CHAT = `perso:${SID}`;
const UUID = (n: number): string => `0b6f3a59-0a8e-4c55-8a51-${String(n).padStart(12, '0')}`;
const code = (r: { ok: boolean; err?: P.WireError }): string => (r.ok ? 'ok' : r.err!.code);
type World = ReturnType<typeof createWorld>;

function indexed(w: World, cwd: string, o: Partial<SessionMeta> = {}): SessionMeta {
  const m: SessionMeta = { accountId: 'perso', sessionId: SID, chatId: CHAT, path: path.join(tmp.root, `${SID}.jsonl`), cwd, title: 'Ancien',
    titleSource: 'lastPrompt', origin: 'cli', createdAt: 1, updatedAt: w.clock.now() - 60_000, mtimeMs: 1, size: 100, ...o };
  w.index.put(m);
  return m;
}
const toasts = (msgs: P.S2C[]): Extract<P.S2C, { t: 'toast' }>[] => msgs.filter((m): m is Extract<P.S2C, { t: 'toast' }> => m.t === 'toast');
const evs = (msgs: P.S2C[], chatId: P.ChatId): P.ChatEvent[] => msgs.flatMap((m) => (m.t === 'ev' && m.c === chatId ? [m.ev] : []));

test('every C2S type of the validator has a command handler', () => {
  const w = createWorld(tmp, 'cover');
  const missing = Object.keys(SCHEMAS).filter((t) => typeof (w.commands as Record<string, unknown>)[t] !== 'function');
  assert.deepEqual(missing, []);
  assert.ok('chat.retry' in SCHEMAS);
});

test('a message a crash handed back stays queued until the user acts (survives the next spawn); chat.cancelQueued drops it', async () => {
  const w = createWorld(tmp, 'returned');
  const win = w.window();
  indexed(w, tmp.cwd('p-returned'));
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  assert.equal(code(await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(1), text: 'hi' })), 'ok');
  await tick();
  w.engine.pushFacts(CHAT, { busy: true, queue: [{ uuid: UUID(2), text: 'perdu', images: 0, delivery: 'queued' }] });
  await tick();
  w.engine.crash(CHAT, 3);
  await tick();
  const lastQueue = (): P.QueueItem[] | undefined => evs(win.ws.msgs(), CHAT).filter((e): e is Extract<P.ChatEvent, { k: 'queue' }> => e.k === 'queue').at(-1)?.items;
  assert.deepEqual(lastQueue()?.map((q) => [q.uuid, q.delivery]), [[UUID(2), 'returned']]);
  // a new message spawns a new process: the returned one is still there (re-sent only on an explicit click)
  assert.equal(code(await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(3), text: 'nouveau' })), 'ok');
  await tick();
  assert.deepEqual(w.orch.snapshot(CHAT)?.queue.map((q) => q.uuid), [UUID(2)]);
  // « Renvoyer », ✎, ↑ or ✕ → chat.cancelQueued: dropped, every window gets the new queue
  assert.deepEqual(await win.req({ t: 'chat.cancelQueued', chatId: CHAT, uuid: UUID(2) }), { ok: true, data: { cancelled: true } });
  assert.deepEqual(lastQueue(), []);
  assert.deepEqual(w.orch.snapshot(CHAT)?.queue, []);
  assert.equal(w.engine.calls.filter((c) => c.m === 'cancelQueued').length, 0, 'never asked the engine');
});

test('a send refused by the open crash breaker turns the error banner into « breaker » (Réessayer)', async () => {
  const w = createWorld(tmp, 'breaker');
  const win = w.window();
  indexed(w, tmp.cwd('p-breaker'));
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  assert.equal(code(await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(1), text: 'hi' })), 'ok');
  await tick();
  w.engine.crash(CHAT, 3);
  await tick();
  w.engine.failNextEnsure({ code: 'breaker_open' });
  assert.equal(code(await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(2), text: 'encore' })), 'breaker_open');
  assert.equal(w.orch.summary(CHAT)?.state.error?.code, 'breaker');
  assert.equal(code(await win.req({ t: 'chat.retry', chatId: CHAT })), 'ok');
  assert.equal(w.orch.summary(CHAT)?.state.error, undefined);
});

test('after « Restaurer la conversation » tx.page shows the chain up to the rewind point until the next accepted send', async () => {
  const w = createWorld(tmp, 'rewound');
  const win = w.window();
  const sm = indexed(w, tmp.cwd('p-rewound'));
  fs.writeFileSync(sm.path, 'x'.repeat(4096));                                 // the size is the rewound read's `off`
  const e = (uuid: string, parentUuid: string | null, type: string, content: unknown): RawEntry =>
    ({ off: 0, len: 1, e: { uuid, parentUuid, type, message: { role: type, content } } });
  w.chains.set(sm.path, [e(UUID(11), null, 'user', 'un'), e(UUID(12), UUID(11), 'assistant', [{ type: 'text', text: 'un' }]),
    e(UUID(13), UUID(12), 'user', 'deux'), e(UUID(14), UUID(13), 'assistant', [{ type: 'text', text: 'deux' }])]);
  const befores: { cursor: string; turns: number }[] = [];
  w.reader.before = async (_f, cursor, turns) => { befores.push({ cursor, turns }); return { chain: w.chains.get(sm.path)!.slice(0, 2), cursor: null, hasMore: false }; };
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  assert.equal(code(await win.req({ t: 'chat.rewind', chatId: CHAT, userUuid: UUID(13), action: 'conv', dryRun: false })), 'ok');
  const spawn = w.engine.calls.filter((c) => c.m === 'ensure').at(-1);
  assert.deepEqual((spawn?.args[0] as { start: unknown }).start, { kind: 'rewind', atUuid: UUID(12), dropsTurn: UUID(13) });
  const page = await win.req<P.TranscriptPage>({ t: 'tx.page', chatId: CHAT, limit: 30 });
  assert.ok(page.ok);
  assert.equal(befores.length, 1, 'read from the rewind point, not the old leaf');
  assert.deepEqual(decodeCursor(befores[0]!.cursor), { off: 4096, leaf: UUID(12) });
  assert.equal(code(await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(5), text: 'deux bis' })), 'ok');
  await win.req({ t: 'tx.page', chatId: CHAT, limit: 30 });
  assert.equal(befores.length, 1, 'the next message ends the rewound view: the latest leaf again');
});

test('a fork not sent yet shows its source history at once (tx.page reads the source transcript)', async () => {
  const w = createWorld(tmp, 'forkview');
  const win = w.window();
  const sm = indexed(w, tmp.cwd('p-forkview'));
  w.chains.set(sm.path, [{ off: 0, len: 1, e: { uuid: UUID(21), parentUuid: null, type: 'user', message: { role: 'user', content: 'source' } } },
    { off: 1, len: 1, e: { uuid: UUID(22), parentUuid: UUID(21), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'réponse' }] } } }]);
  const r = await win.req<{ chatId: P.ChatId }>({ t: 'chat.fork', chatId: CHAT });
  assert.ok(r.ok && r.data);
  const page = await win.req<P.TranscriptPage>({ t: 'tx.page', chatId: r.data.chatId, limit: 30 });
  assert.ok(page.ok);
  assert.equal(page.data?.turns.length, 1, 'the source turn, before any send');
});

test('chat.retry: resets the engine breaker, clears error state, acks; never spawns', async () => {
  const w = createWorld(tmp, 'retry');
  const win = w.window();
  indexed(w, tmp.cwd('p-retry'));
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  assert.equal(code(await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(1), text: 'hi' })), 'ok');
  await tick();
  w.engine.crash(CHAT, 3);
  await tick();
  assert.equal(w.orch.summary(CHAT)?.state.error?.code, 'crash');
  const ensures = w.engine.calls.filter((c) => c.m === 'ensure').length;
  assert.equal(code(await win.req({ t: 'chat.retry', chatId: CHAT })), 'ok');
  assert.ok(w.engine.calls.some((c) => c.m === 'resetBreaker' && c.chatId === CHAT), 'breaker reset');
  assert.equal(w.orch.summary(CHAT)?.state.error, undefined, 'error cleared');
  assert.equal(w.engine.calls.filter((c) => c.m === 'ensure').length, ensures, 'no spawn');
  assert.equal(w.engine.isLive(CHAT), false);
  assert.ok(win.ws.msgs().some((m) => m.t === 'ev' && m.c === CHAT && m.ev.k === 'state' && !m.ev.state.error), 'state pushed');
  assert.equal(code(await win.req({ t: 'chat.retry', chatId: 'perso:9bdf4c63-b504-4be1-804b-92a88963e275' })), 'not_found');
});

test('smc_engine notes: identity mismatch, fallbacks, resume_stable, external holder; the reducer never sees them', async () => {
  const w = createWorld(tmp, 'notes');
  w.views[0]!.identity = { email: 'moi@example.invalid', plan: 'Max', accountUuid: 'acc-1' };
  const win = w.window();
  indexed(w, tmp.cwd('p-notes'));
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  assert.equal(code(await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(2), text: 'hi' })), 'ok');
  await tick();
  const before = win.ws.msgs().length;
  const at = w.clock.now();
  w.orch.sink.frame(CHAT, { type: 'smc_engine', subtype: 'initialized', capabilities: [], email: 'MOI@example.invalid' }, at);
  assert.equal(toasts(win.ws.msgs()).length, 0, 'same email (case-insensitive): no toast');
  w.orch.sink.frame(CHAT, { type: 'smc_engine', subtype: 'initialized', capabilities: [], email: 'autre@example.invalid' }, at);
  w.orch.sink.frame(CHAT, { type: 'smc_engine', subtype: 'isolation_fallback' }, at);
  w.orch.sink.frame(CHAT, { type: 'smc_engine', subtype: 'rewind_fallback' }, at);
  w.orch.sink.frame(CHAT, { type: 'smc_engine', subtype: 'resume_stable', stable: false }, at);
  await tick();
  const t = toasts(win.ws.msgs());
  assert.deepEqual(t.map((x) => x.key), ['account.mismatch', 'isolation.fallback', 'rewind.fallback']);
  assert.deepEqual(t[0]!.args, { account: 'perso', expected: 'moi@example.invalid', actual: 'autre@example.invalid' });
  assert.ok(t.every((x) => x.level === 'warn' && x.chatId === CHAT));
  const note = evs(win.ws.msgs(), CHAT).find((e) => e.k === 'system' && e.row.kind === 'notice');
  assert.ok(note && note.k === 'system' && note.row.text === 'account.mismatch', 'session note row');
  assert.deepEqual(w.orch.identityMismatch(CHAT), { expected: 'moi@example.invalid', actual: 'autre@example.invalid' });
  assert.deepEqual(w.accounts.stable, [['perso', false]]);
  assert.ok(!evs(win.ws.msgs().slice(before), CHAT).some((e) => e.k === 'block' || e.k === 'turn.start'), 'no block from an engine note');
  // external_holder: the engine closes the process; the chat shows « Ouvert ailleurs » (state.external) once cold
  const holder: P.ExternalHolder = { pid: 777, kind: 'interactive', entrypoint: 'cli', status: 'idle' };
  w.orch.sink.frame(CHAT, { type: 'smc_engine', subtype: 'external_holder', holder }, at);
  await w.engine.sleep(CHAT, 'user');
  await tick();
  assert.deepEqual(w.orch.summary(CHAT)?.state.flags.external, holder);
});

test('AccountView.models from the model catalog; absent when empty', async () => {
  const w = createWorld(tmp, 'models');
  w.accounts.catalog = [{ value: 'opus', label: 'Opus', efforts: ['low', 'high'], isDefault: true }];
  const hello = w.orch.hello();
  assert.ok(hello.t === 'hello');
  assert.deepEqual(hello.accounts.find((a) => a.id === 'perso')?.models, w.accounts.catalog);
  w.accounts.catalog = [];
  w.orch.pushAccounts();
  const h2 = w.orch.hello();
  assert.ok(h2.t === 'hello' && h2.accounts.every((a) => a.models === undefined));
});

test('ChatMetaView.autoAvailable follows ProcessFacts.autoAvailable (undefined until known)', async () => {
  const w = createWorld(tmp, 'auto');
  const win = w.window();
  indexed(w, tmp.cwd('p-auto'));
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(3), text: 'hi' });
  await tick();
  assert.equal(w.orch.snapshot(CHAT)?.meta.autoAvailable, undefined);
  w.engine.pushFacts(CHAT, { autoAvailable: false });
  await tick();
  assert.equal(w.orch.snapshot(CHAT)?.meta.autoAvailable, false);
  assert.ok(evs(win.ws.msgs(), CHAT).some((e) => e.k === 'meta' && e.meta.autoAvailable === false));
  w.engine.pushFacts(CHAT, { autoAvailable: true });
  await tick();
  assert.equal(w.orch.snapshot(CHAT)?.meta.autoAvailable, true);
});

test('resume seeds the live reducer with the transcript cost-state: the first turn costs the delta, not the total', async () => {
  const w = createWorld(tmp, 'baseline');
  const win = w.window();
  w.engine.setAutoReply(false);
  const m = indexed(w, tmp.cwd('p-base'));
  fs.writeFileSync(m.path, [
    JSON.stringify({ type: 'user', uuid: UUID(90), parentUuid: null, sessionId: SID, message: { role: 'user', content: 'avant' } }),
    JSON.stringify({ type: 'cost-state', totalCostUSD: 1.5, modelUsage: {}, sessionId: SID }),
  ].join('\n') + '\n');
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  assert.equal(code(await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(4), text: 'suite' })), 'ok');
  await tick(); await tick();
  w.orch.sink.frame(CHAT, { type: 'result', subtype: 'success', is_error: false, uuid: UUID(5), usage: {}, total_cost_usd: 1.75, session_id: SID }, w.clock.now());
  await tick();
  const footer = w.orch.snapshot(CHAT)?.metrics.lastTurn;
  assert.ok(footer, 'a footer');
  assert.ok(Math.abs((footer!.costUsd ?? -1) - 0.25) < 1e-9, `turn cost ${footer!.costUsd}`);
});

test('a new chat starts from 0; account.baseline feeds diag.baselineTokens; login cancel emits login.err.cancelled', async () => {
  const w = createWorld(tmp, 'misc');
  const win = w.window();
  const r = await win.req<{ chatId: string }>({ t: 'chat.create', accountId: 'perso', cwd: tmp.cwd('p-new'), mode: 'default', trust: true });
  assert.equal(code(r), 'ok');
  const id = (r as { data: { chatId: string } }).data.chatId;
  await win.req({ t: 'chat.send', chatId: id, uuid: UUID(6), text: 'bonjour' });
  await tick(); await tick();
  assert.equal(w.orch.snapshot(id)?.metrics.lastTurn?.costUsd, 0, 'fake turn total 0 → delta 0 from a 0 baseline');
  assert.equal(code(await win.req({ t: 'account.baseline', accountId: 'perso' })), 'ok');
  assert.deepEqual(w.accounts.baselines, [['perso', 18_000]]);
  assert.equal(code(await win.req({ t: 'account.login', accountId: 'pro' })), 'ok');
  assert.equal(code(await win.req({ t: 'account.loginCancel', accountId: 'pro' })), 'ok');
  const last = win.ws.msgs().filter((m) => m.t === 'login').at(-1);
  assert.deepEqual(last && last.t === 'login' ? last.step : null, { step: 'error', key: 'login.err.cancelled', message: 'cancelled' });
});

test('delivered images carry their media types and sizes: the live user block equals the disk rebuild', async () => {
  const w = createWorld(tmp, 'images');
  const win = w.window();
  indexed(w, tmp.cwd('p-img'));
  await win.req({ t: 'view', full: [CHAT], focused: CHAT, windowFocused: true });
  const images: P.ImageInput[] = [{ mediaType: 'image/png', base64: 'AAAA' }, { mediaType: 'image/jpeg', base64: 'AAAAAA==' }];
  assert.equal(code(await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(7), text: 'regarde', images })), 'ok');
  await tick(); await tick();
  const user = w.orch.snapshot(CHAT)?.live?.user;
  assert.deepEqual(user?.images?.map((i) => [i.mediaType, i.bytes]), [['image/png', 3], ['image/jpeg', 4]]);
});
