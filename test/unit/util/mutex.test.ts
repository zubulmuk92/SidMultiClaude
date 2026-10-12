import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedMutex, createMutex } from '../../../src/server/util/mutex.ts';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('FIFO order and never two tasks at once, whatever their durations', async () => {
  const m = createMutex();
  const order: number[] = [];
  let running = 0;
  let maxRunning = 0;
  const task = (i: number, ms: number) => async () => {
    running++; maxRunning = Math.max(maxRunning, running);
    await tick(ms);
    order.push(i);
    running--;
    return i * 10;
  };
  const results = await Promise.all([m.run(task(1, 15)), m.run(task(2, 1)), m.run(task(3, 8)), m.run(() => { order.push(4); return 40; })]);
  assert.deepEqual(order, [1, 2, 3, 4]);
  assert.deepEqual(results, [10, 20, 30, 40]);
  assert.equal(maxRunning, 1);
  assert.equal(m.pending, 0);
});

test('a failing task rejects its own promise only; the chain goes on', async () => {
  const m = createMutex();
  const seen: string[] = [];
  const a = m.run(async () => { seen.push('a'); throw new Error('boom'); });
  const b = m.run(() => { seen.push('b'); return 'ok'; });
  await assert.rejects(a, /boom/);
  assert.equal(await b, 'ok');
  assert.deepEqual(seen, ['a', 'b']);
  const c = m.run(() => { throw new Error('sync throw'); });
  await assert.rejects(c, /sync throw/);
  assert.equal(await m.run(() => 'still alive'), 'still alive');
});

test('pending counts queued + running tasks and is decremented before callers resume', async () => {
  const m = createMutex();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const p1 = m.run(() => gate);
  const p2 = m.run(() => 'x');
  assert.equal(m.pending, 2);
  release();
  await p1;
  assert.equal(m.pending, 1);
  await p2;
  assert.equal(m.pending, 0);
  await m.idle();
});

test('keyed mutex: per-key serialisation, keys run in parallel, idle keys are dropped', async () => {
  const k = createKeyedMutex();
  const log: string[] = [];
  const slow = (tag: string, ms: number) => async () => { log.push(`${tag}+`); await tick(ms); log.push(`${tag}-`); };
  await Promise.all([k.run('perso', slow('p1', 20)), k.run('perso', slow('p2', 1)), k.run('pro', slow('w1', 5))]);
  assert.ok(log.indexOf('p1-') < log.indexOf('p2+'), 'same key: serial');
  assert.ok(log.indexOf('w1+') < log.indexOf('p1-'), 'other key: parallel');
  assert.equal(k.size(), 0);
});
