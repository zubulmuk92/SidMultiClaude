// test/unit/engine/pool.test.ts — cap, protection, victim classes 1–4, single-timer reaper, low-memory freeze (SPEC §2.8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPool, recacheEstimate } from '../../../src/server/engine/pool.ts';
import type { PoolChat } from '../../../src/server/engine/pool.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';

const MIN = 60_000;
const GB = 1024 ** 3;

function setup(o: { free?: number; stable?: Record<string, boolean> } = {}) {
  const clock = createFakeClock();
  const reaped: string[] = [];
  let free = o.free ?? 8 * GB;
  const views = new Map<string, PoolChat>();
  const pool = createPool({ clock, freeMemBytes: () => free, onReap: (c) => { reaped.push(c); pool.untrack(c); views.delete(c); }, stable: (a) => o.stable?.[a] ?? null });
  const add = (id: string, v: Partial<PoolChat> = {}): PoolChat => {
    const pc: PoolChat = { chatId: id, accountId: id.split(':')[0]!, cwd: 'C:/w/a', title: id, phase: 'live', busy: false, pendingAsks: 0, bgTasks: 0, queued: 0,
      spawnedAt: clock.now(), sentAny: false, ttlMs: 60 * MIN, ...v };
    views.set(id, pc);
    pool.track(id, () => views.get(id)!);
    return pc;
  };
  const patch = (id: string, p: Partial<PoolChat>): void => { Object.assign(views.get(id)!, p); pool.touch(id); };
  return { clock, pool, reaped, add, patch, setFree: (b: number) => { free = b; } };
}

test('reaper: never-requested at spawnedAt+10 min; requested at lastRequestAt+reapMin; ONE timer armed', () => {
  const { clock, pool, reaped, add, patch } = setup();
  add('a:1');
  add('a:2');
  patch('a:2', { sentAny: true, lastRequestAt: clock.now() });
  assert.equal(pool.timerArmed(), true);
  assert.equal(clock.pending(), 1);
  clock.advance(10 * MIN);
  assert.deepEqual(reaped, ['a:1']);
  clock.advance(49 * MIN);
  assert.deepEqual(reaped, ['a:1']);
  clock.advance(1 * MIN);
  assert.deepEqual(reaped, ['a:1', 'a:2']);
  assert.ok(clock.maxPending <= 1, `max pending timers ${clock.maxPending}`);
});

test('reaper: 5-minute cache → min(reapMin, 5 min); reapMin null → never (except never-requested)', () => {
  const { clock, pool, reaped, add, patch } = setup();
  add('a:1');
  patch('a:1', { sentAny: true, lastRequestAt: clock.now(), ttlMs: 5 * MIN });
  clock.advance(5 * MIN);
  assert.deepEqual(reaped, ['a:1']);
  pool.setPolicy({ maxLive: 4, reapMin: null });
  add('a:2');
  patch('a:2', { sentAny: true, lastRequestAt: clock.now() });
  clock.advance(500 * MIN);
  assert.deepEqual(reaped, ['a:1']);
});

test('protected chats are never reaped nor evicted (running, ask, tasks, queue, visible, keepAlive, closing)', () => {
  const { clock, pool, reaped, add } = setup();
  add('a:1', { busy: true });
  add('a:2', { pendingAsks: 1 });
  add('a:3', { bgTasks: 1 });
  add('a:4', { queued: 1 });
  add('a:5');
  add('a:6');
  add('a:7', { phase: 'closing' });
  pool.protect(new Set(['a:5']), new Set(['a:6']));
  assert.equal(pool.timerArmed(), false);
  clock.advance(1_000 * MIN);
  assert.deepEqual(reaped, []);
  for (const c of ['a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6', 'a:7']) assert.equal(pool.isProtected(c), true, c);
  pool.setPolicy({ maxLive: 2, reapMin: 60 });
  const adm = pool.admit({ chatId: 'b:9', why: 'send' });
  assert.deepEqual(adm, { ok: false, err: { code: 'cap_busy' } });
  assert.deepEqual(pool.admit({ chatId: 'b:9', why: 'send', exceed: true }), { ok: true, evict: [] });
});

test('admit at the cap: classes 1 → 2 → cap.choice (stable first, then coldest) with recacheTokens; prespawn never evicts warm', () => {
  const { clock, pool, add } = setup({ stable: { s: true } });
  pool.setPolicy({ maxLive: 3, reapMin: 60 });
  const t0 = clock.now();
  add('a:never');
  add('a:warm', { sentAny: true, lastRequestAt: t0, lastContext: 50_000 });
  add('s:warm', { sentAny: true, lastRequestAt: t0 + 5 * MIN, lastContext: 30_000, cwd: 'C:/w/other' });
  clock.advance(10 * MIN - 1);
  assert.deepEqual(pool.admit({ chatId: 'x:1', why: 'send' }), { ok: true, evict: [{ chatId: 'a:never', silent: 'never' }] });
  pool.untrack('a:never');
  add('a:old', { sentAny: true, lastRequestAt: t0 - 2 * 60 * MIN, lastContext: 1 });   // cache expired
  assert.deepEqual(pool.admit({ chatId: 'x:1', why: 'send' }), { ok: true, evict: [{ chatId: 'a:old', silent: 'expired' }] });
  pool.untrack('a:old');
  add('b:warm2', { sentAny: true, lastRequestAt: t0 - 1, lastContext: 20_000 });
  assert.deepEqual(pool.admit({ chatId: 'x:1', why: 'prespawn' }), { ok: false, err: { code: 'cap_busy', message: 'prespawn' } });
  const r = pool.admit({ chatId: 'x:1', why: 'send' });
  assert.equal(r.ok, false);
  const err = (r as { err: { code: string; candidates: { chatId: string; recacheTokens: number; stable: boolean; warmMin: number }[] } }).err;
  assert.equal(err.code, 'cap');
  assert.deepEqual(err.candidates.map((c) => c.chatId), ['s:warm', 'b:warm2', 'a:warm']);   // stable first, then coldest
  const aw = err.candidates.find((c) => c.chatId === 'a:warm')!;
  assert.equal(aw.recacheTokens, recacheEstimate(50_000, 'none'));
  assert.equal(aw.warmMin, 51);
  assert.deepEqual(pool.admit({ chatId: 'x:1', why: 'send', evict: 'a:warm' }), { ok: true, evict: [{ chatId: 'a:warm', silent: false }] });
});

test('recacheEstimate: shared prefixes 19 000 / 16 800 / 0', () => {
  assert.equal(recacheEstimate(50_000, 'sameCwd'), 31_000);
  assert.equal(recacheEstimate(50_000, 'account'), 33_200);
  assert.equal(recacheEstimate(10_000, 'sameCwd'), 0);
  assert.equal(recacheEstimate(10_000, 'none'), 10_000);
});

test('low-memory freeze: effective cap = max(2, live) while free < 1.5 GB, evaluated at each admit', () => {
  const { pool, add, setFree } = setup({ free: 1 * GB });
  pool.setPolicy({ maxLive: 6, reapMin: 60 });
  assert.equal(pool.effectiveMax(), 2);
  assert.equal(pool.lowMem(), true);
  add('a:1', { busy: true }); add('a:2', { busy: true }); add('a:3', { busy: true });
  assert.equal(pool.effectiveMax(), 3);
  assert.equal(pool.admit({ chatId: 'b:1', why: 'send' }).ok, false);
  setFree(4 * GB);
  assert.equal(pool.effectiveMax(), 6);
  assert.deepEqual(pool.admit({ chatId: 'b:1', why: 'send' }), { ok: true, evict: [] });
});

test('no setInterval anywhere in src/server (grep test, SPEC §2.8)', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'server');
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && /\bsetInterval\s*\(/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
