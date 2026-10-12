import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeadlineScheduler, realClock } from '../../../src/server/util/clock.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';

test('single-deadline scheduler: one timer for many deadlines, fired in deadline order', () => {
  const clock = createFakeClock(0);
  const fired: string[][] = [];
  const s = createDeadlineScheduler<string>(clock, (keys) => { fired.push(keys); });
  s.set('a', 5_000);
  s.set('b', 1_000);
  s.set('c', 3_000);
  s.set('d', 1_000);
  assert.equal(clock.pending(), 1);
  assert.equal(s.next()?.at, 1_000);
  clock.advance(1_000);
  assert.deepEqual(fired, [['b', 'd']]);
  assert.equal(clock.pending(), 1);
  assert.equal(s.next()?.key, 'c');
  clock.advance(10_000);
  assert.deepEqual(fired, [['b', 'd'], ['c'], ['a']]);
  assert.equal(clock.pending(), 0);
  assert.equal(s.armed(), false);
  assert.equal(clock.maxPending, 1, 'never more than one timer armed');
});

test('moving, removing and null/Infinity deadlines re-arm only when the earliest changes', () => {
  const clock = createFakeClock(0);
  const fired: string[] = [];
  const s = createDeadlineScheduler<string>(clock, (keys) => fired.push(...keys));
  s.set('x', 10_000);
  const armed1 = clock.armedCount;
  s.set('y', 20_000);                                     // later than the earliest: no re-arm
  assert.equal(clock.armedCount, armed1);
  s.set('x', 5_000);                                      // earlier: re-armed
  assert.equal(clock.nextAt(), 5_000);
  s.set('x', null);                                       // removed: now armed for y
  assert.equal(clock.nextAt(), 20_000);
  s.set('y', Infinity);                                   // protected (= never): nothing armed
  assert.equal(clock.pending(), 0);
  assert.equal(s.size(), 0);
  clock.advance(60_000);
  assert.deepEqual(fired, []);
  assert.equal(clock.maxPending, 1);
});

test('onDue may set new deadlines, including already-due ones; dispose stops everything', () => {
  const clock = createFakeClock(0);
  const fired: string[] = [];
  const s = createDeadlineScheduler<string>(clock, (keys, now) => {
    fired.push(...keys.map((k) => `${k}@${now}`));
    if (keys.includes('a')) { s.set('b', now + 500); s.set('c', now); }
  });
  s.set('a', 1_000);
  clock.advance(1_000);
  clock.advance(500);
  assert.deepEqual(fired, ['a@1000', 'c@1000', 'b@1500']);
  s.set('z', 9_000);
  s.dispose();
  clock.advance(10_000);
  assert.deepEqual(fired, ['a@1000', 'c@1000', 'b@1500']);
  assert.equal(clock.pending(), 0);
});

test('poke() fires what is already due without waiting for the timer', () => {
  const clock = createFakeClock(0);
  const fired: string[] = [];
  const s = createDeadlineScheduler<string>(clock, (k) => fired.push(...k));
  s.set('a', 100);
  s.set('b', 50_000);
  clock.set(200);                                          // fake clock fires the timer while moving
  assert.deepEqual(fired, ['a']);
  s.poke();
  assert.deepEqual(fired, ['a']);
  assert.equal(s.next()?.key, 'b');
});

test('realClock: now() is Date.now(), timers fire and can be cancelled', async () => {
  assert.ok(Math.abs(realClock.now() - Date.now()) < 50);
  let hits = 0;
  realClock.timer(5, () => { hits++; });
  const t = realClock.timer(5, () => { hits += 100; });
  t.cancel();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hits, 1);
});
