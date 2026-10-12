// test/unit/engine/regressions.test.ts — engine regressions (first set): asks after a re-key, no frame after exited(),
// reap/evict notes, the S9-exempt probe cwd, a CLI that outlives the SDK iterator (SPEC §2.5, §2.7 step 5, §2.8, §5.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../../../src/server/contracts.ts';
import { makeEngine } from '../../../src/server/engine/engine.ts';
import { memoryLogger } from '../../../src/server/util/log.ts';
import { createFakeQuery } from '../../fakes/fake-query.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';
import { recordingSink, setupEngine, spec, SID, until, tick } from './engine-helpers.ts';
import type { Rec } from './engine-helpers.ts';

/** A spawned CLI stand-in: exits only when told to (or on kill when exitOnKill). */
class FakeChild extends EventEmitter {
  pid = 40_000 + Math.floor(Math.random() * 10_000);
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kills = 0;
  exitOnKill = false;
  kill(): boolean { this.kills++; if (this.exitOnKill) setImmediate(() => this.exit(null, 'SIGKILL')); return true; }
  exit(code: number | null, sig: string | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code; this.signalCode = sig; this.emit('exit', code, sig);
  }
}

/** Engine over fake-query whose QueryFn really calls spawnClaudeCodeProcess (like the SDK). `sdkLike`: q.close() is
 *  ignored and the iterator ends only on the child's exit, as with the real SDK and a CLI that ignores EOF. */
function withChild(o: { sdkLike?: boolean } = {}) {
  const clock = createFakeClock();
  const sink = recordingSink();
  const fq = createFakeQuery();
  const children: FakeChild[] = [];
  const spawner = (() => () => { const c = new FakeChild(); children.push(c); return c; }) as never;
  const query = ((a: { prompt: never; options: Options }) => {
    a.options.spawnClaudeCodeProcess!({ command: 'claude', args: [], cwd: '.', env: {}, signal: new AbortController().signal });
    const q = fq(a) as unknown as Record<string, unknown>;
    if (o.sdkLike) {
      const h = fq.last();
      q['close'] = () => { h.calls.push({ name: 'close', args: [] }); };
      children[children.length - 1]!.once('exit', () => h.finish());
    }
    return q;
  }) as unknown as QueryFn;
  const engine = makeEngine({ query, clock, sink, log: memoryLogger(), spawner, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null });
  return { clock, sink, fq, children, engine };
}
const exitedOf = (log: Rec[], c: string) => log.find((r): r is Extract<Rec, { k: 'exited' }> => r.k === 'exited' && r.c === c);

test('asks after a /clear re-key land on the NEW chat id; decide works there; no flip-back', async () => {
  const next = SID(93);
  let n = 0;
  const { engine, sink } = setupEngine({ turn: async (c) => {
    if (n++ === 0) { c.emit({ type: 'conversation_reset', new_conversation_id: next, trigger: 'clear' }); c.reply(''); return; }
    const r = await c.ask('Bash', { command: 'ls' }); c.reply(r ? 'R' : 'W');
  } });
  const s = spec(38);
  await engine.ensure(s, { why: 'send' });
  engine.send(s.chatId, { uuid: randomUUID(), text: '/clear' });
  await until(() => sink.log.some((r) => r.k === 'session'), 'session');
  const to = `acc:${next}`;
  assert.equal(engine.send(to, { uuid: randomUUID(), text: 'go' }), 'accepted');
  await until(() => sink.log.some((r) => r.k === 'ask'), 'ask');
  await tick();
  const a = sink.log.find((r): r is Extract<Rec, { k: 'ask' }> => r.k === 'ask')!.a;
  assert.equal(a.chatId, to);
  assert.equal(engine.facts(to)?.pendingAsks, 1);
  assert.deepEqual(engine.asks(to).map((x) => x.requestId), [a.requestId]);
  assert.equal(engine.decide(to, a.requestId, { kind: 'allow-once' }), 'ok');
  await until(() => sink.log.some((r) => r.k === 'frame' && r.c === to && r.f['type'] === 'result' && r.f['result'] === 'R'), 'result R');
  assert.equal(sink.log.filter((r) => r.k === 'session').length, 1);
});

test('no frame after exited() (the resume_stable timer dies with the process); reap / eviction notes reach the sink', async () => {
  const { engine, sink, clock } = setupEngine();
  engine.setPolicy({ maxLive: 2, reapMin: 60 });
  const a = spec(33);
  await engine.ensure(a, { why: 'prespawn' });
  await until(() => engine.facts(a.chatId)?.phase === 'live', 'live a');
  await engine.sleep(a.chatId, 'user');                         // gone < 3 s after init
  clock.advance(5_000);
  await tick(10);
  const at = sink.log.findIndex((r) => r.k === 'exited' && r.c === a.chatId);
  assert.ok(at >= 0);
  assert.deepEqual(sink.log.slice(at + 1).filter((r) => r.k === 'frame'), []);
  assert.equal(exitedOf(sink.log, a.chatId)!.info.message, undefined);
  const b = spec(34);
  await engine.ensure(b, { why: 'prespawn' });
  await until(() => engine.facts(b.chatId)?.phase === 'live', 'live b');
  clock.advance(10 * 60_000);                                   // never requested: reaped at spawnedAt + 10 min
  await until(() => !!exitedOf(sink.log, b.chatId), 'reaped');
  assert.equal(exitedOf(sink.log, b.chatId)!.info.message, 'reap');
  const c1 = spec(35); const c2 = spec(36);
  await engine.ensure(c1, { why: 'prespawn' });
  await engine.ensure(c2, { why: 'prespawn' });
  await until(() => engine.facts(c1.chatId)?.phase === 'live' && engine.facts(c2.chatId)?.phase === 'live', 'live c');
  assert.deepEqual(await engine.ensure(spec(37), { why: 'send' }), { ok: true, data: undefined });   // class 1 victim
  assert.equal(exitedOf(sink.log, c1.chatId)!.info.message, 'evict:never');
});

test('a usage probe (S9-exempt cwd) drops localSettings suggestions; a normal chat keeps them', async () => {
  const sugg = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }];
  const { engine, sink } = setupEngine({ turn: async (c) => { await c.ask('Bash', { command: 'ls' }, { suggestions: sugg }); c.reply(); } });
  const p = spec(39); const n = spec(40);
  await engine.ensure(p, { why: 'usage' });
  await engine.ensure(n, { why: 'send' });
  engine.send(p.chatId, { uuid: randomUUID(), text: 'x' });
  engine.send(n.chatId, { uuid: randomUUID(), text: 'y' });
  await until(() => sink.log.filter((r) => r.k === 'ask').length === 2, 'two asks');
  const asks = sink.log.filter((r): r is Extract<Rec, { k: 'ask' }> => r.k === 'ask').map((r) => r.a);
  const probe = asks.find((x) => x.chatId === p.chatId)!; const chat = asks.find((x) => x.chatId === n.chatId)!;
  assert.deepEqual([probe.offerAlways, probe.alwaysRules], [false, []]);
  assert.deepEqual([chat.offerAlways, chat.alwaysRules], [true, ['Bash(ls)']]);
});

test('a CLI still running when the SDK iterator ends: own kill; a survivor stays registered (unkillable) until its exit', async () => {
  const { clock, sink, fq, children, engine } = withChild();
  const s = spec(31);
  await engine.ensure(s, { why: 'send' });
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  fq.last().finish();                                           // iterator over, no close requested, process alive
  await tick(10);
  clock.advance(3_000);
  await tick(10);
  assert.equal(children[0]!.kills, 1);
  assert.equal(engine.facts(s.chatId)?.phase, 'closing');
  clock.advance(3_000);                                         // survives our kill
  await tick(10);
  assert.equal(engine.isLive(s.chatId), true);
  assert.equal(sink.log.some((r) => r.k === 'exited'), false);
  assert.deepEqual(await engine.ensure(s, { why: 'send' }), { ok: false, err: { code: 'busy', message: 'closing' } });   // never two writers
  children[0]!.exit(1);
  await until(() => !!exitedOf(sink.log, s.chatId), 'exited');
  assert.equal(exitedOf(sink.log, s.chatId)!.info.reason, 'crash');
  assert.equal(engine.isLive(s.chatId), false);
});

test('close(force) on a CLI that dies on our own kill: ExitInfo killed, never a false « unkillable »', async () => {
  const { clock, children, engine } = withChild({ sdkLike: true });
  const s = spec(32);
  await engine.ensure(s, { why: 'send' });
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  children[0]!.exitOnKill = true;
  const p = engine.sleep(s.chatId, 'force');
  await tick(10);
  clock.advance(2_000);                                         // q.close() ignored → our own kill 2 s later → exit
  const info = await p;
  assert.equal(info?.reason, 'killed');
  assert.notEqual(info?.message, 'unkillable');
  assert.equal(children[0]!.kills, 1);
  assert.equal(engine.isLive(s.chatId), false);
});

test('facts() is coalesced: one per chat per tick for a burst of frames (SPEC §5.5)', async () => {
  const { engine, sink, query } = setupEngine();
  const s = spec(41);
  await engine.ensure(s, { why: 'send' });
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  await tick(5);
  const before = sink.log.filter((r) => r.k === 'facts').length;
  for (let i = 0; i < 20; i++) query.last().emit({ type: 'system', subtype: 'status', status: 'requesting', parent_tool_use_id: null });
  await tick(5);
  assert.equal(sink.log.filter((r) => r.k === 'frame' && r.f['subtype'] === 'status').length, 20);
  assert.equal(sink.log.filter((r) => r.k === 'facts').length - before, 1);
  assert.equal(engine.facts(s.chatId)!.busy, true);
});

test('resumeStable: a SessionStart hook frame within 3 s AFTER init still marks the spawn unstable; none → stable', async () => {
  const { engine, sink, query, clock } = setupEngine();
  const s = spec(42);
  await engine.ensure(s, { why: 'prespawn' });
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  clock.advance(1_000);
  query.last().emit({ type: 'system', subtype: 'hook_started', hook_id: 'h', hook_name: 'SessionStart:resume', hook_event: 'SessionStart' });
  await tick(5);
  clock.advance(5_000);
  await tick(5);
  const notes = (c: string) => sink.log.filter((r) => r.k === 'frame' && r.c === c && r.f['subtype'] === 'resume_stable').map((r) => (r as { f: Record<string, unknown> }).f['stable']);
  assert.deepEqual(notes(s.chatId), [false]);
  const s2 = spec(43);
  await engine.ensure(s2, { why: 'prespawn' });
  await until(() => engine.facts(s2.chatId)?.phase === 'live', 'live 2');
  clock.advance(3_000);
  await tick(5);
  assert.deepEqual(notes(s2.chatId), [true]);
});

test('cap.choice names a resumed chat by the title the CLI announced (session_title_changed), not by its id', async () => {
  const { engine } = setupEngine({ startFrames: [{ type: 'system', subtype: 'session_title_changed', title: 'Mon chat' }] });
  engine.setPolicy({ maxLive: 2, reapMin: 60 });
  const a = spec(44, { start: { kind: 'resume' } }); const b = spec(45, { start: { kind: 'resume' } });
  for (const s of [a, b]) {
    await engine.ensure(s, { why: 'wake' });
    await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
    engine.send(s.chatId, { uuid: randomUUID(), text: 'x' });
    await until(() => engine.facts(s.chatId)?.busy === false && engine.facts(s.chatId)?.lastRequestAt !== undefined, 'warm');
  }
  const r = await engine.ensure(spec(46), { why: 'send' });
  assert.equal(r.ok, false);
  const err = (r as { err: { code: string; candidates: { title: string }[] } }).err;
  assert.equal(err.code, 'cap');
  assert.deepEqual(err.candidates.map((c) => c.title), ['Mon chat', 'Mon chat']);
});
