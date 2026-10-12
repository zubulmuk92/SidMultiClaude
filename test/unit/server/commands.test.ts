// WP-D acceptance 4: the §6.3 command rules with the fake engine and fake stores (real hub, rpc, orchestrator, MetaStore).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type * as P from '../../../src/shared/protocol.ts';
import type { SpawnSpec, EnsureOpts } from '../../../src/server/contracts.ts';
import { resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createWorld, tick } from './_world.ts';

const tmp = createTmpRoot('commands');
after(() => { resetFsGuardForTests(); tmp.dispose(); });
const ensures = (w: ReturnType<typeof createWorld>): [SpawnSpec, EnsureOpts][] => w.engine.calls.filter((c) => c.m === 'ensure').map((c) => c.args as [SpawnSpec, EnsureOpts]);
const UUID = (n: number): string => `0b6f3a59-0a8e-4c55-8a51-${String(n).padStart(12, '0')}`;

test('chat.create: account, S9, trust rules', async () => {
  const w = createWorld(tmp, 'create');
  const win = w.window();
  const cwd = tmp.cwd('proj-create');
  const err = async (b: Record<string, unknown>): Promise<string> => { const r = await win.req({ t: 'chat.create', mode: 'default', ...b }); return r.ok ? 'ok' : r.err.code; };
  assert.equal(await err({ accountId: 'nope', cwd }), 'not_found');
  assert.equal(await err({ accountId: 'pro', cwd }), 'not_logged_in');
  assert.equal(await err({ accountId: 'perso', cwd: tmp.home }), 'cwd_refused');
  assert.equal(await err({ accountId: 'perso', cwd: path.join(tmp.home, '.claude') }), 'cwd_missing');
  assert.equal(await err({ accountId: 'perso', cwd: path.join(cwd, 'missing') }), 'cwd_missing');
  assert.equal(await err({ accountId: 'perso', cwd }), 'untrusted');
  assert.equal(await err({ accountId: 'perso', cwd, mode: 'bypassPermissions', trust: true }), 'forbidden');
  const r = await win.req<{ chatId: string }>({ t: 'chat.create', accountId: 'perso', cwd, mode: 'plan', trust: true, title: 'Mon chat' });
  assert.ok(r.ok && r.data);
  const chatId = r.data!.chatId;
  assert.match(chatId, /^perso:[0-9a-f-]{36}$/);
  assert.equal(w.meta.appTrusted('perso', cwd), true);
  assert.deepEqual(w.meta.chat(chatId)?.pendingStart, { kind: 'new' });
  const up = win.ws.msgs().filter((m) => m.t === 'chats').flatMap((m) => (m.t === 'chats' ? m.upsert : [])).find((s) => s.chatId === chatId);
  assert.ok(up && up.state.flags.notStarted && up.title === 'Mon chat' && up.titleSource === 'app');
  assert.equal(await err({ accountId: 'perso', cwd }), 'ok', 'trusted in the app now');
  assert.equal(ensures(w).length, 0, 'create never spawns');
});

test('chat.send: spawn with the derived title, outbox duplicate, cap retry with evict/exceed, prompt history', async () => {
  const w = createWorld(tmp, 'send');
  const win = w.window();
  const cwd = tmp.cwd('proj-send');
  w.trusted.add(cwd.toLowerCase());
  const c = await win.req<{ chatId: string }>({ t: 'chat.create', accountId: 'perso', cwd, mode: 'default' });
  const chatId = c.ok ? c.data!.chatId : '';
  w.engine.failNextEnsure({ code: 'cap', candidates: [{ chatId: 'perso:5bdf4c63-b504-4be1-804b-92a88963e275', title: 'x', warmMin: 3, recacheTokens: 20_000, stable: true }] });
  const capped = await win.req({ t: 'chat.send', chatId, uuid: UUID(1), text: 'Corrige le test\nsuite' });
  assert.ok(!capped.ok && capped.err.code === 'cap' && 'candidates' in capped.err && capped.err.candidates.length === 1);
  const sent = await win.req({ t: 'chat.send', chatId, uuid: UUID(1), text: 'Corrige le test\nsuite', evict: 'perso:5bdf4c63-b504-4be1-804b-92a88963e275' });
  assert.deepEqual(sent, { ok: true, data: { accepted: 'new' } });
  const [spec, opts] = ensures(w).at(-1)!;
  assert.equal(opts.why, 'send');
  assert.equal(opts.evict, 'perso:5bdf4c63-b504-4be1-804b-92a88963e275');
  assert.deepEqual(spec.start, { kind: 'new', title: 'Corrige le test' });
  assert.equal(spec.mode, 'default');
  assert.equal(spec.cwd, cwd);
  assert.equal(spec.account.configDir, null);
  assert.equal(spec.isolation, 'plain', 'no jobrun.exe recorded');
  assert.deepEqual(await win.req({ t: 'chat.send', chatId, uuid: UUID(1), text: 'x' }), { ok: true, data: { accepted: 'duplicate' } });
  await tick(); await tick();
  assert.deepEqual(w.prompts, ['Corrige le test\nsuite'], 'delivered → prompt history');
  assert.equal(w.meta.chat(chatId)?.pendingStart, undefined, 'the CLI owns the transcript now');
  assert.equal(w.engine.calls.filter((x) => x.m === 'rename').length, 0, 'titled at spawn: no live rename');
});

test('pre-spawned untitled chat: live rename at the first delivered; wake summary pushes /compact first', async () => {
  const w = createWorld(tmp, 'title');
  const win = w.window();
  const cwd = tmp.cwd('proj-title');
  w.trusted.add(cwd.toLowerCase());
  const c = await win.req<{ chatId: string }>({ t: 'chat.create', accountId: 'perso', cwd, mode: 'default' });
  const chatId = c.ok ? c.data!.chatId : '';
  assert.deepEqual(await win.req({ t: 'chat.prespawn', chatId }), { ok: true });
  await tick();
  assert.deepEqual(ensures(w)[0]![0].start, { kind: 'new' });
  assert.equal(ensures(w)[0]![1].why, 'prespawn');
  await win.req({ t: 'chat.send', chatId, uuid: UUID(2), text: '/review Fix the CI please' });
  await tick(); await tick();
  const renames = w.engine.calls.filter((x) => x.m === 'rename');
  assert.equal(renames.length, 1);
  assert.equal(renames[0]!.args[0], 'Fix the CI please');
  await w.engine.sleep(chatId, 'user');
  await win.req({ t: 'chat.send', chatId, uuid: UUID(3), text: 'encore', wake: 'summary' });
  const texts = (w.engine.sent.get(chatId) ?? []).map((m) => [m.text, m.priority ?? '-']);
  assert.deepEqual(texts.slice(-2), [['/compact', '-'], ['encore', 'later']]);
  assert.equal(ensures(w).at(-1)![1].why, 'wake');
});

test('asks: every window gets ask / askEnd; decide is first-answer-wins', async () => {
  const w = createWorld(tmp, 'ask');
  const a = w.window(), b = w.window();
  const cwd = tmp.cwd('proj-ask');
  w.trusted.add(cwd.toLowerCase());
  const c = await a.req<{ chatId: string }>({ t: 'chat.create', accountId: 'perso', cwd, mode: 'default' });
  const chatId = c.ok ? c.data!.chatId : '';
  await a.req({ t: 'chat.send', chatId, uuid: UUID(4), text: 'go' });
  const ask: P.PendingAsk = { chatId, requestId: 'req-1', toolUseId: 't1', kind: 'permission', toolName: 'Bash', input: { command: 'npm ci' },
    offerAlways: true, alwaysRules: ['Bash(npm ci)'], offerAuto: false, defaultToNo: false, since: w.clock.now() };
  w.engine.askNow(ask);
  await tick();
  for (const win of [a, b]) assert.ok(win.ws.msgs().some((m) => m.t === 'ask' && m.ask.requestId === 'req-1'));
  const up = a.ws.msgs().filter((m) => m.t === 'chats').flatMap((m) => (m.t === 'chats' ? m.upsert : [])).filter((s) => s.chatId === chatId).at(-1);
  assert.equal(up?.state.phase, 'needs_permission');
  assert.equal(w.orch.hello().asks.length, 1, 'hello carries pending asks');
  assert.deepEqual(await a.req({ t: 'chat.decide', chatId, requestId: 'req-1', answer: { kind: 'allow-once' } }), { ok: true });
  const late = await b.req({ t: 'chat.decide', chatId, requestId: 'req-1', answer: { kind: 'deny', message: 'non' } });
  assert.ok(!late.ok && late.err.code === 'not_pending');
  for (const win of [a, b]) assert.ok(win.ws.msgs().some((m) => m.t === 'askEnd' && m.requestId === 'req-1'));
});
