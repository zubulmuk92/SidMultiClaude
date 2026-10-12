// test/unit/engine/engine.test.ts — createEngine over the in-process fake-query (SPEC §2.3–§2.9, §5.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EngineError } from '../../../src/server/engine/ctl.ts';
import { setupEngine, spec, SID, until, tick } from './engine-helpers.ts';
import type { Rec } from './engine-helpers.ts';

const idx = (log: Rec[], pred: (r: Rec) => boolean): number => log.findIndex(pred);

test('ensure → live; send accepted/duplicate/not_live; lifecycle started → delivered → assistant; facts busy then idle', async () => {
  const { engine, sink, query } = setupEngine({ turn: async (c) => { await tick(3); c.reply(); } });
  const s = spec(1);
  assert.deepEqual(await engine.ensure(s, { why: 'send' }), { ok: true, data: undefined });
  assert.equal(engine.isLive(s.chatId), true);
  assert.deepEqual(await engine.ensure(s, { why: 'prespawn' }), { ok: true, data: undefined });   // no-op when live
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  assert.ok(sink.log.some((r) => r.k === 'frame' && r.f['type'] === 'smc_engine' && r.f['subtype'] === 'initialized'));
  const u = randomUUID();
  assert.equal(engine.send(s.chatId, { uuid: u, text: 'bonjour' }), 'accepted');
  assert.equal(engine.send(s.chatId, { uuid: u, text: 'bonjour' }), 'duplicate');
  assert.equal(engine.send('acc:' + SID(99), { uuid: randomUUID(), text: 'x' }), 'not_live');
  await until(() => sink.log.some((r) => r.k === 'frame' && r.f['type'] === 'command_lifecycle' && r.f['state'] === 'completed'), 'completed');
  await tick();
  const started = idx(sink.log, (r) => r.k === 'frame' && r.f['type'] === 'command_lifecycle' && r.f['state'] === 'started');
  const deliv = idx(sink.log, (r) => r.k === 'delivered' && r.uuid === u && !r.folded);
  const asst = idx(sink.log, (r) => r.k === 'frame' && r.f['type'] === 'assistant');
  assert.ok(started >= 0 && started < deliv && deliv < asst, `order ${started} ${deliv} ${asst}`);
  const facts = sink.log.filter((r): r is Extract<Rec, { k: 'facts' }> => r.k === 'facts').map((r) => r.f);
  assert.ok(facts.some((f) => f.busy));
  const last = facts[facts.length - 1]!;
  assert.equal(last.busy, false);
  assert.equal(last.sentAny, true);
  assert.equal(typeof last.lastRequestAt, 'number');
  assert.equal(last.ttlMs, 3_600_000);
  assert.equal(query.last().options.sessionId, s.sessionId);
  assert.equal(query.last().users[0]!.message.content, 'bonjour');
});

test('images go before the text block; priority later is passed, next is omitted', async () => {
  const { engine, query, sink } = setupEngine();
  const s = spec(2);
  await engine.ensure(s, { why: 'send' });
  engine.send(s.chatId, { uuid: randomUUID(), text: 'vois', images: [{ mediaType: 'image/png', base64: 'AAAA' }], priority: 'later' });
  engine.send(s.chatId, { uuid: randomUUID(), text: 'b', priority: 'next' });
  await until(() => query.last().users.length === 2, 'users');
  const [m1, m2] = query.last().users;
  const c = m1!.message.content as { type: string }[];
  assert.deepEqual(c.map((b) => b.type), ['image', 'text']);
  assert.equal((m1 as { priority?: string }).priority, 'later');
  assert.equal((m2 as { priority?: string }).priority, undefined);
  assert.deepEqual((m1 as { origin?: unknown }).origin, { kind: 'human' });
  // the delivery carries the media types and decoded sizes (live user block = disk rebuild)
  await until(() => sink.log.filter((r) => r.k === 'delivered').length === 2, 'delivered');
  const ds = sink.log.filter((r): r is Extract<Rec, { k: 'delivered' }> => r.k === 'delivered');
  assert.deepEqual([ds[0]!.imageTypes, ds[0]!.imageBytes], [['image/png'], [3]]);
  assert.equal(ds[1]!.imageTypes, undefined);
});

test('ask: ask() before the facts that count it; decide → askEnd answered; second decide not_pending', async () => {
  const { engine, sink } = setupEngine({ turn: async (c) => { const r = await c.ask('Bash', { command: 'npm ci' }, { suggestions: [] }); c.reply(r ? `R:${(r as { behavior: string }).behavior}` : 'withdrawn'); } });
  const s = spec(3);
  await engine.ensure(s, { why: 'send' });
  engine.send(s.chatId, { uuid: randomUUID(), text: 'go' });
  await until(() => sink.log.some((r) => r.k === 'ask'), 'ask');
  await tick();
  const a = sink.log.find((r): r is Extract<Rec, { k: 'ask' }> => r.k === 'ask')!.a;
  const askAt = idx(sink.log, (r) => r.k === 'ask');
  const countAt = idx(sink.log, (r) => r.k === 'facts' && r.f.pendingAsks === 1);
  assert.ok(askAt < countAt);
  assert.equal(engine.facts(s.chatId)!.pendingAsks, 1);
  assert.deepEqual(engine.asks(s.chatId).map((x) => x.requestId), [a.requestId]);
  assert.equal(engine.decide(s.chatId, a.requestId, { kind: 'allow-once' }), 'ok');
  assert.equal(engine.decide(s.chatId, a.requestId, { kind: 'allow-once' }), 'not_pending');
  await until(() => sink.log.some((r) => r.k === 'frame' && r.f['type'] === 'result'), 'result');
  assert.ok(sink.log.some((r) => r.k === 'askEnd' && r.why === 'answered'));
  const res = sink.log.find((r) => r.k === 'frame' && r.f['type'] === 'result') as Extract<Rec, { k: 'frame' }>;
  assert.equal(res.f['result'], 'R:allow');
});

test('interrupt during an ask: callback returns null, askEnd cancelled, stillQueued reported', async () => {
  const { engine, sink, clock } = setupEngine({ turn: async (c) => { const r = await c.ask('Bash', { command: 'x' }); if (!r) return false; c.reply(); return true; } });
  const s = spec(4);
  await engine.ensure(s, { why: 'send' });
  engine.send(s.chatId, { uuid: randomUUID(), text: 'go' });
  const q2 = randomUUID();
  engine.send(s.chatId, { uuid: q2, text: 'later', priority: 'later' });
  await until(() => sink.log.some((r) => r.k === 'ask'), 'ask');
  const r = await engine.interrupt(s.chatId);
  assert.deepEqual(r.stillQueued, [q2]);
  clock.advance(1_000);
  await until(() => sink.log.some((x) => x.k === 'askEnd' && x.why === 'cancelled'), 'askEnd cancelled');
  assert.equal(engine.facts(s.chatId)!.stuck, false);
});

test('crash with a pending ask and a queued message: askEnd crash, deliveries returned, exited after the last frame', async () => {
  const { engine, sink, query } = setupEngine({ turn: async (c) => { await c.ask('Bash', { command: 'x' }); return false; } });
  const s = spec(5);
  await engine.ensure(s, { why: 'send' });
  engine.send(s.chatId, { uuid: randomUUID(), text: 'go' });
  const q2 = randomUUID();
  engine.send(s.chatId, { uuid: q2, text: 'second', priority: 'later' });
  await until(() => sink.log.some((r) => r.k === 'ask'), 'ask');
  query.last().crash(3);
  await until(() => sink.log.some((r) => r.k === 'exited'), 'exited');
  const ex = sink.log.find((r): r is Extract<Rec, { k: 'exited' }> => r.k === 'exited')!;
  assert.equal(ex.info.reason, 'crash');
  assert.equal(ex.info.code, 3);
  assert.deepEqual(ex.returned.map((x) => [x.uuid, x.delivery]), [[q2, 'returned']]);
  assert.ok(sink.log.some((r) => r.k === 'askEnd' && r.why === 'crash'));
  assert.equal(idx(sink.log, (r) => r.k === 'exited'), sink.log.length - 1 - [...sink.log].reverse().findIndex((r) => r.k === 'exited'));
  assert.ok(!sink.log.slice(idx(sink.log, (r) => r.k === 'exited')).some((r) => r.k === 'frame'));
  assert.equal(engine.isLive(s.chatId), false);
});

test('breaker: 3 crashes in 10 min → breaker_open; resetBreaker re-allows', async () => {
  const { engine, sink, query } = setupEngine();
  const s = spec(6);
  for (let i = 0; i < 3; i++) {
    assert.equal((await engine.ensure(s, { why: 'send' })).ok, true);
    query.last().crash(1);
    await until(() => sink.log.filter((r) => r.k === 'exited').length === i + 1, 'exit ' + i);
  }
  assert.deepEqual(await engine.ensure(s, { why: 'send' }), { ok: false, err: { code: 'breaker_open' } });
  engine.resetBreaker(s.chatId);
  assert.equal((await engine.ensure(s, { why: 'send' })).ok, true);
});

test('external holder blocks a resume unless force; init timeout → init_timeout exit', async () => {
  const holder = { pid: 4242, kind: 'interactive', entrypoint: 'cli', status: 'idle' as const };
  const { engine } = setupEngine({}, { holder: () => holder });
  const s = spec(7, { start: { kind: 'resume' } });
  assert.deepEqual(await engine.ensure(s, { why: 'wake' }), { ok: false, err: { code: 'external', holder } });
  assert.equal((await engine.ensure(s, { why: 'wake', force: true })).ok, true);
  const h = setupEngine({ init: 'hang' });
  const s2 = spec(8);
  await h.engine.ensure(s2, { why: 'send' });
  h.clock.advance(45_000);
  await until(() => h.sink.log.some((r) => r.k === 'exited'), 'exit');
  const ex = h.sink.log.find((r): r is Extract<Rec, { k: 'exited' }> => r.k === 'exited')!;
  assert.equal(ex.info.reason, 'init_timeout');
});

test('conversation_reset → sessionChanged + re-key; a CLI-chosen fork id → sessionChanged', async () => {
  const next = SID(91);
  const { engine, sink } = setupEngine({ turn: (c) => { c.emit({ type: 'conversation_reset', new_conversation_id: next, trigger: 'clear' }); c.reply(); } });
  const s = spec(9);
  await engine.ensure(s, { why: 'send' });
  engine.send(s.chatId, { uuid: randomUUID(), text: '/clear' });
  await until(() => sink.log.some((r) => r.k === 'session'), 'session');
  const ev = sink.log.find((r): r is Extract<Rec, { k: 'session' }> => r.k === 'session')!;
  assert.deepEqual([ev.c, ev.sid], [s.chatId, next]);
  assert.equal(engine.isLive(`acc:${next}`), true);
  assert.equal(engine.isLive(s.chatId), false);
  const cliId = SID(92);
  const f = setupEngine({ sessionId: cliId, startFrames: [{ type: 'system', subtype: 'session_title_changed', title: 'F' }] });
  const fs2 = spec(10, { start: { kind: 'fork', fromJsonl: 'C:/x/a.jsonl', title: 'F' } });
  await f.engine.ensure(fs2, { why: 'send' });
  await until(() => f.sink.log.some((r) => r.k === 'session'), 'fork session');
  assert.equal(f.engine.isLive(`acc:${cliId}`), true);
});

test('live controls: bypass forbidden, rename live/not_live, summary-only context, missing runtime methods', async () => {
  const { engine, query } = setupEngine({ missing: ['cancelAsyncMessage', 'listPermissionRules'] });
  const s = spec(11);
  await engine.ensure(s, { why: 'send' });
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  await assert.rejects(engine.setMode(s.chatId, 'bypassPermissions'), (e: unknown) => e instanceof EngineError && e.code === 'forbidden');
  await engine.setMode(s.chatId, 'acceptEdits');
  await until(() => engine.facts(s.chatId)?.mode === 'acceptEdits', 'mode');
  await engine.rename(s.chatId, 'Titre');
  assert.deepEqual(query.last().calls.find((c) => c.name === 'renameSession')!.args, ['Titre', s.sessionId]);
  await assert.rejects(engine.rename('acc:' + SID(98), 'x'), (e: unknown) => e instanceof EngineError && e.code === 'not_live');
  const cs = await engine.contextSummary(s.chatId);
  assert.equal(cs.total, 37152);
  assert.equal(cs.autoCompactAt, 200000 - 33000);
  assert.deepEqual(query.last().calls.find((c) => c.name === 'getContextUsage')!.args, [{ detail: 'summary' }]);
  assert.equal(await engine.cancelQueued(s.chatId, randomUUID()), false);
  await assert.rejects(engine.rules(s.chatId), (e: unknown) => e instanceof EngineError && e.code === 'unsupported');
  await engine.setModel(s.chatId, 'sonnet', 'high');
  assert.ok(query.last().calls.some((c) => c.name === 'setModel'));
  assert.deepEqual(query.last().calls.find((c) => c.name === 'applyFlagSettings')!.args, [{ effortLevel: 'high' }]);
});

test('sleep: graceful close (input.end) resolves ExitInfo closed; null when not live; ownPids/stats cheap', async () => {
  const { engine, sink } = setupEngine();
  const s = spec(12);
  await engine.ensure(s, { why: 'send' });
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  const st = engine.stats();
  assert.equal(st.live, 1);
  assert.equal(st.items[0]!.neverRequested, true);
  const info = await engine.sleep(s.chatId, 'user');
  assert.equal(info?.reason, 'closed');
  assert.equal(engine.isLive(s.chatId), false);
  assert.equal(await engine.sleep(s.chatId, 'user'), null);
  assert.ok(sink.log.some((r) => r.k === 'exited'));
});

test('cap: a 3rd chat at maxLive 2 evicts a never-requested one silently; warm ones → cap candidates', async () => {
  const { engine, sink } = setupEngine();
  engine.setPolicy({ maxLive: 2, reapMin: 60 });
  const a = spec(20); const b = spec(21); const c = spec(22);
  await engine.ensure(a, { why: 'send' });
  await engine.ensure(b, { why: 'send' });
  await until(() => engine.facts(b.chatId)?.phase === 'live' && engine.facts(a.chatId)?.phase === 'live', 'live');
  engine.send(b.chatId, { uuid: randomUUID(), text: 'x' });
  await until(() => engine.facts(b.chatId)?.busy === false && engine.facts(b.chatId)?.lastRequestAt !== undefined, 'b idle');
  assert.equal((await engine.ensure(c, { why: 'send' })).ok, true);   // a (never requested) evicted
  assert.equal(engine.isLive(a.chatId), false);
  assert.ok(sink.log.some((r) => r.k === 'exited' && r.c === a.chatId));
  engine.send(c.chatId, { uuid: randomUUID(), text: 'y' });
  await until(() => engine.facts(c.chatId)?.busy === false && engine.facts(c.chatId)?.lastRequestAt !== undefined, 'c idle');
  const r = await engine.ensure(spec(23), { why: 'send' });
  assert.equal(r.ok, false);
  assert.equal((r as { err: { code: string } }).err.code, 'cap');
  assert.deepEqual((await engine.ensure(spec(23), { why: 'prespawn' })), { ok: false, err: { code: 'cap_busy', message: 'prespawn' } });
  await engine.shutdown(15_000);
});
