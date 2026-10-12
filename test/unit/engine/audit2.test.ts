// test/unit/engine/audit2.test.ts — engine regressions (second set): a `refused` lifecycle is terminal (SPEC §2.4, §2.3 busy),
// the Write preview never opens a secret file (SPEC §10 S10), a throwing sink never wedges a chat, a refused rewind falls back
// to a plain resume (SPEC §2.1), a failed jobrun.exe to plain isolation (§2.11), the cap holds under races, offerAuto tracks
// the current model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../../../src/server/contracts.ts';
import { makeEngine } from '../../../src/server/engine/engine.ts';
import { readDiffBase } from '../../../src/server/engine/permissions.ts';
import { memoryLogger } from '../../../src/server/util/log.ts';
import { createFakeQuery } from '../../fakes/fake-query.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';
import { recordingSink, setupEngine, spec, until, tick } from './engine-helpers.ts';

test('a refused message leaves the queue at once (terminal state): it never keeps the chat busy nor comes back as returned', async () => {
  let release: () => void = () => {};
  const { engine, sink, query, clock } = setupEngine({ turn: async (c) => {
    if (c.text === 'A') await new Promise<void>((r) => { release = r; });
    c.reply();
  } });
  const s = spec(60);
  await engine.ensure(s, { why: 'send' });
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  const A = randomUUID(); const B = randomUUID();
  engine.send(s.chatId, { uuid: A, text: 'A' });
  engine.send(s.chatId, { uuid: B, text: 'B', priority: 'later' });
  await until(() => (engine.facts(s.chatId)?.queue ?? []).some((q) => q.uuid === B && q.delivery === 'queued'), 'B queued');
  query.last().emit({ type: 'command_lifecycle', command_uuid: B, state: 'refused' });
  await tick(5);
  assert.deepEqual(engine.facts(s.chatId)!.queue.map((q) => [q.uuid, q.delivery]), [[A, 'started']]);
  assert.ok(sink.log.some((r) => r.k === 'frame' && r.f['type'] === 'command_lifecycle' && r.f['state'] === 'refused'), 'the frame reaches the sink');
  const p = engine.sleep(s.chatId, 'force');
  await tick(5); clock.advance(10_000); await tick(10);
  await p;
  release();
  const ex = sink.log.find((r) => r.k === 'exited' && r.c === s.chatId) as { returned: { uuid: string }[] } | undefined;
  assert.ok(ex, 'exited');
  assert.deepEqual(ex.returned.map((x) => x.uuid), []);
});

test('Write preview base: never opens .credentials.json, *.key (also `a.key.`) or a data stream; a plain file is read', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'smc-wpa-diffbase-')));
  const reads: string[] = [];
  const orig = fs.promises.readFile;
  (fs.promises as { readFile: unknown }).readFile = ((p: fs.PathLike, ...rest: unknown[]) => { reads.push(String(p)); return (orig as (...a: unknown[]) => unknown)(p, ...rest); }) as unknown;
  try {
    for (const f of ['.credentials.json', 'secret.key', 'ok.txt']) fs.writeFileSync(path.join(dir, f), 'x');
    for (const f of ['.credentials.json', 'secret.key', 'SECRET.KEY', 'secret.key.', 'secret.key ', 'secret.key::$DATA', 'ok.txt:hidden']) {
      assert.deepEqual(await readDiffBase(dir, f), { unavailable: true }, f);
    }
    assert.deepEqual(reads, [], 'no secret file was opened');
    assert.deepEqual(await readDiffBase(dir, 'ok.txt'), { path: path.join(dir, 'ok.txt'), text: 'x' });
    assert.deepEqual(await readDiffBase(dir, 'new.txt'), { path: path.join(dir, 'new.txt'), text: '' });
    assert.deepEqual(await readDiffBase(dir, '../outside.txt'), { unavailable: true });
  } finally {
    (fs.promises as { readFile: unknown }).readFile = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a sink that throws in ask/askEnd never wedges a chat: decide still answers, a crash is still reported as exited', async () => {
  const { engine, sink, query } = setupEngine({ turn: async (c) => { const r = await c.ask('Bash', { command: 'npm ci' }, { suggestions: [] }); c.reply(r ? 'R' : 'withdrawn'); } });
  const boom = (): never => { throw new Error('sink bug'); };
  const s = spec(61);
  await engine.ensure(s, { why: 'send' });
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  sink.ask = boom; sink.askEnd = boom;
  engine.send(s.chatId, { uuid: randomUUID(), text: 'go' });
  await until(() => engine.asks(s.chatId).length === 1, 'ask registered despite the sink');
  assert.equal(engine.decide(s.chatId, engine.asks(s.chatId)[0]!.requestId, { kind: 'allow-once' }), 'ok');
  await until(() => sink.log.some((r) => r.k === 'frame' && r.f['type'] === 'result'), 'turn went on');
  engine.send(s.chatId, { uuid: randomUUID(), text: 'again' });
  await until(() => engine.asks(s.chatId).length === 1, 'second ask');
  query.last().crash(3);
  await until(() => sink.log.some((r) => r.k === 'exited' && r.c === s.chatId), 'exited reported');
  assert.equal(engine.isLive(s.chatId), false);
  assert.deepEqual(engine.asks(s.chatId), []);
});

// A QueryFn whose rewind spawns are refused like CLI 2.1.294 does (measured, 0 tokens): an error result carrying the refusal
// in errors[] and on stderr, then exit 1 before initialize is answered. Other spawns behave normally.
function refusingRewinds() {
  const normal = createFakeQuery();
  const REFUSAL = 'Resume rejected by --resume-drops-turn: resuming at a1 would discard entries not attributable to turn u1';
  const refusing = { handles: [] as Options[] };
  const query = ((a: { prompt: never; options: Options }) => {
    if (!a.options.resumeSessionAt) return normal(a);
    refusing.handles.push(a.options);                             // like the SDK before initialize: the prompt is never read
    a.options.stderr?.(REFUSAL + '\n');
    const frames: Record<string, unknown>[] = [{ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, errors: [REFUSAL], session_id: a.options.resume }];
    const it = {
      async next(): Promise<IteratorResult<unknown>> {
        await new Promise((r) => setImmediate(r));
        const f = frames.shift();
        if (f) return { value: f, done: false };
        throw new Error('Claude Code process exited with code 1');
      },
      return: async () => ({ value: undefined, done: true }), [Symbol.asyncIterator]() { return it; },
      initializationResult: () => new Promise(() => {}), close: () => {}, interrupt: async () => {},
    };
    return it;
  }) as unknown as QueryFn;
  return { query, normal, refusing };
}

test('a refused rewind falls back to a plain resume of the same session (rewind_fallback note, no exit, no breaker count)', async () => {
  const { query, normal, refusing } = refusingRewinds();
  const clock = createFakeClock(); const sink = recordingSink();
  const engine = makeEngine({ query, clock, sink, log: memoryLogger(), spawner: (() => () => { throw new Error('no spawn'); }) as never, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null });
  for (let i = 0; i < 4; i++) {                                   // 4 refusals in a row: the breaker (3 in 10 min) stays closed
    const s = spec(62, { start: { kind: 'rewind', atUuid: 'a1', dropsTurn: 'u1' } });
    assert.deepEqual(await engine.ensure(s, { why: 'rewind' }), { ok: true, data: undefined }, `rewind ${i}`);
    await until(() => normal.handles.length === i + 1 && engine.facts(s.chatId)?.phase === 'live', 'resumed');
    assert.equal(refusing.handles.length, i + 1);
    const o = normal.last().options;
    assert.equal(o.resume, s.sessionId); assert.equal(o.resumeSessionAt, undefined); assert.equal(o.resumeDropsTurn, undefined);
    assert.equal(engine.isLive(s.chatId), true);
    assert.equal(sink.log.filter((r) => r.k === 'exited').length, 0, 'no exit reported for the refused process');
    const notes = sink.log.filter((r) => r.k === 'frame' && r.c === s.chatId && r.f['subtype'] === 'rewind_fallback');
    assert.equal(notes.length, 1);
    await engine.sleep(s.chatId, 'user');
    sink.log.length = 0;
  }
});

test('a refused rewind with a message typed meanwhile: exited rewind_refused with the message returned, not a crash', async () => {
  const { query, normal } = refusingRewinds();
  const clock = createFakeClock(); const sink = recordingSink();
  const engine = makeEngine({ query, clock, sink, log: memoryLogger(), spawner: (() => () => { throw new Error('no spawn'); }) as never, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null });
  const s = spec(63, { start: { kind: 'rewind', atUuid: 'a1', dropsTurn: 'u1' } });
  for (let i = 0; i < 3; i++) {
    await engine.ensure(s, { why: 'rewind' });
    const u = randomUUID();
    assert.equal(engine.send(s.chatId, { uuid: u, text: 'x' }), 'accepted');
    await until(() => sink.log.some((r) => r.k === 'exited' && r.c === s.chatId), 'exited');
    const ex = sink.log.find((r) => r.k === 'exited') as { info: { reason: string; message?: string }; returned: { uuid: string }[] };
    assert.equal(ex.info.reason, 'spawn_failed'); assert.equal(ex.info.message, 'rewind_refused');
    assert.deepEqual(ex.returned.map((x) => x.uuid), [u]);
    sink.log.length = 0;
  }
  assert.equal(normal.handles.length, 0);
  assert.deepEqual(await engine.ensure({ ...s, start: { kind: 'resume' } }, { why: 'send' }), { ok: true, data: undefined }, 'breaker still closed');
});

test('cap race: an ensure() that took the slot freed by another one\'s eviction never pushes the live count over the cap', async () => {
  const { engine } = setupEngine();
  engine.setPolicy({ maxLive: 2, reapMin: 60 });
  const [a, b, x, y] = [spec(70), spec(71), spec(72), spec(73)];
  for (const s of [a, b]) { await engine.ensure(s, { why: 'prespawn' }); await until(() => engine.facts(s.chatId)?.phase === 'live', 'live'); }
  const px = engine.ensure(x, { why: 'send' });                  // evicts a (class 1) and waits for its exit…
  const py = engine.ensure(y, { why: 'send' });                  // …meanwhile y takes the slot a is freeing
  assert.deepEqual(await py, { ok: true, data: undefined });
  assert.deepEqual(await px, { ok: true, data: undefined });
  await tick(10);
  const live = [a, b, x, y].filter((s) => engine.isLive(s.chatId)).map((s) => s.chatId);
  assert.equal(live.length, 2, live.join(' '));
  assert.ok(engine.isLive(x.chatId) && engine.isLive(y.chatId));
});

test('low-memory freeze: one eviction admits one chat (the re-check never evicts a second victim)', async () => {
  const { engine } = setupEngine({}, { free: 512 * 1024 ** 2 });
  engine.setPolicy({ maxLive: 4, reapMin: 60 });
  const chats = [spec(80), spec(81), spec(82)];
  for (const s of chats) { assert.equal((await engine.ensure(s, { why: 'prespawn', exceed: true })).ok, true); await until(() => engine.facts(s.chatId)?.phase === 'live', 'live'); }
  const n = spec(83);
  assert.deepEqual(await engine.ensure(n, { why: 'send' }), { ok: true, data: undefined });
  assert.equal([...chats, n].filter((s) => engine.isLive(s.chatId)).length, 3);
  assert.equal(engine.isLive(chats[0]!.chatId), false, 'the oldest never-requested chat was the one victim');
});

test('offerAuto follows the CURRENT model (a /model typed in the chat), not only the model picked at spawn', async () => {
  const models = [{ value: 'default', resolvedModel: 'fake-model', supportsAutoMode: true }, { value: 'opus', resolvedModel: 'big-model', supportsAutoMode: false }];
  const { engine, sink } = setupEngine({ init: { models }, turn: async (c) => {
    if (c.text === 'switched') c.emit({ type: 'system', subtype: 'init', model: 'big-model', permissionMode: 'default' });   // as after /model opus
    await tick(3);                                              // the API request: the engine has read the frame by then
    await c.ask('Bash', { command: 'npm ci' }, { suggestions: [] });
    c.reply();
  } });
  const s = spec(90);
  await engine.ensure(s, { why: 'send' });
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  const offer = async (text: string): Promise<boolean> => {
    const n = sink.log.filter((r) => r.k === 'ask').length;
    engine.send(s.chatId, { uuid: randomUUID(), text });
    await until(() => sink.log.filter((r) => r.k === 'ask').length > n, 'ask');
    const a = (sink.log.filter((r) => r.k === 'ask').pop() as { a: { requestId: string; offerAuto: boolean } }).a;
    engine.decide(s.chatId, a.requestId, { kind: 'allow-once' });
    return a.offerAuto;
  };
  assert.equal(await offer('plain'), true);
  assert.equal(await offer('switched'), false);
});

/** A spawned process stand-in (stderr is a real stream, read by the engine). */
class Kid extends EventEmitter {
  pid = 50_000 + Math.floor(Math.random() * 10_000);
  exitCode: number | null = null; signalCode: string | null = null;
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill(): boolean { return true; }
  exit(code: number): void { if (this.exitCode === null) { this.exitCode = code; this.emit('exit', code, null); } }
}

test('a jobrun.exe that fails before starting the CLI (exit 4 + `jobrun:` stderr) retries once in plain mode, isolation_fallback, no exit', async () => {
  const isolations: string[] = [];
  const fq = createFakeQuery();
  const spawner = ((_c: string, isolation: string) => () => { isolations.push(isolation); return new Kid(); }) as never;
  const query = ((a: { prompt: never; options: Options }) => {
    const kid = a.options.spawnClaudeCodeProcess!({ command: 'claude', args: [], cwd: '.', env: {}, signal: new AbortController().signal }) as unknown as Kid;
    if (isolations[isolations.length - 1] !== 'job') return fq(a);
    const it = {                                                  // jobrun: AssignProcessToJobObject denied → exit 4, the SDK iterator throws
      async next(): Promise<IteratorResult<unknown>> {
        kid.stderr.write('jobrun: AssignProcessToJobObject failed 5\n');
        await tick(3); kid.exit(4); await tick(1);
        throw new Error('Claude Code process exited with code 4');
      },
      return: async () => ({ value: undefined, done: true }), [Symbol.asyncIterator]() { return it; },
      initializationResult: () => new Promise(() => {}), close: () => {}, interrupt: async () => {},
    };
    return it;
  }) as unknown as QueryFn;
  const sink = recordingSink();
  const engine = makeEngine({ query, clock: createFakeClock(), sink, log: memoryLogger(), spawner, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null });
  const s = spec(91, { isolation: 'job' });
  assert.deepEqual(await engine.ensure(s, { why: 'send' }), { ok: true, data: undefined });
  await until(() => isolations.length === 2 && engine.facts(s.chatId)?.phase === 'live', 'plain retry live');
  assert.deepEqual(isolations, ['job', 'plain']);
  assert.ok(sink.log.some((r) => r.k === 'frame' && r.c === s.chatId && r.f['subtype'] === 'isolation_fallback'));
  assert.equal(sink.log.some((r) => r.k === 'exited'), false);
  assert.equal(engine.stats().isolation, 'plain');
  engine.send(s.chatId, { uuid: randomUUID(), text: 'ok' });
  await until(() => sink.log.some((r) => r.k === 'frame' && r.f['type'] === 'result'), 'turn on the plain process');
});

test('close step 2: every stopTask at once, then ≤ 5 s; a CLI that never answers stopTask does not stretch the step (SPEC §2.7)', async () => {
  const { engine, query, clock } = setupEngine({ controls: { stopTask: () => new Promise(() => {}) } });
  const s = spec(92);
  await engine.ensure(s, { why: 'send' });
  await until(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  query.last().emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 't1', task_type: 'local_bash', description: 'a' }, { task_id: 't2', task_type: 'local_bash', description: 'b' }, { task_id: 'w', task_type: 'monitor', description: 'w', ambient: true }] });
  await until(() => engine.facts(s.chatId)?.bgTasks === 2, 'two non-ambient background tasks');
  let done = false;
  const p = engine.sleep(s.chatId, 'user', { stopTasks: true }).then((i) => { done = true; return i; });
  await tick(5);
  assert.deepEqual(query.last().calls.filter((c) => c.name === 'stopTask').map((c) => c.args[0]), ['t1', 't2']);
  clock.advance(4_999); await tick(5);
  assert.equal(done, false);
  clock.advance(1); await tick(10);
  assert.equal(done, true);
  assert.equal((await p)?.reason, 'closed');
});
