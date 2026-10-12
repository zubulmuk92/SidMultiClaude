// WP-D acceptance 6 (C13, fake clock): exit only after 10 min without a window AND nothing live AND no pending ask;
// an ask with no connected window reopens one; crash-marker helpers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLifetime, parseChildren, readBootCrashState, writeCrashMarker, clearRunFiles } from '../../../src/server/app/lifetime.ts';
import { configureFsGuard, resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { appPaths } from '../../../src/server/util/paths.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { SERVER_IDLE_EXIT_MS } from '../../../src/shared/limits.ts';

const tmp = createTmpRoot('lifetime');
after(() => { resetFsGuardForTests(); tmp.dispose(); });

function setup(o: { background?: boolean } = {}) {
  const clock = createFakeClock();
  const s = { conns: 0, live: 0, asks: 0, reopen: true, opened: 0, exits: 0 };
  const lt = createLifetime({ clock, log: nullLogger, connections: () => s.conns, liveCount: () => s.live, pendingAsks: () => s.asks,
    reopenEnabled: () => s.reopen, openWindow: () => { s.opened++; }, exit: () => { s.exits++; }, ...(o.background ? { background: true } : {}) });
  return { clock, s, lt };
}

test('exits 10 min after the last window when nothing is live', () => {
  const { clock, s, lt } = setup();
  s.conns = 1; lt.onConnect(); lt.check();
  s.conns = 0; lt.check();
  clock.advance(SERVER_IDLE_EXIT_MS - 1);
  assert.equal(s.exits, 0);
  clock.advance(1);
  assert.equal(s.exits, 1);
});

test('a live process or a pending ask keeps it alive; re-checked on exited / askEnd', () => {
  const { clock, s, lt } = setup();
  s.live = 1; lt.check();
  clock.advance(SERVER_IDLE_EXIT_MS * 3);
  assert.equal(s.exits, 0, 'live process');
  s.live = 0; s.asks = 1; lt.check();
  clock.advance(SERVER_IDLE_EXIT_MS * 3);
  assert.equal(s.exits, 0, 'pending ask');
  s.asks = 0; lt.check();                                   // askEnd: no window for > 10 min already → exit now
  assert.equal(s.exits, 1);
});

test('a window coming back cancels the exit; --background waits for a first window', () => {
  const { clock, s, lt } = setup();
  lt.check();
  clock.advance(SERVER_IDLE_EXIT_MS - 10);
  s.conns = 1; lt.onConnect();
  clock.advance(SERVER_IDLE_EXIT_MS * 2);
  assert.equal(s.exits, 0);
  const b = setup({ background: true });
  b.lt.check();
  b.clock.advance(SERVER_IDLE_EXIT_MS * 5);
  assert.equal(b.s.exits, 0, 'autostart server stays up until a window came and went');
  assert.equal(b.clock.pending(), 0, 'and arms no timer');
});

test('reopen rule: an ask with no window opens one (≤ 1 per 30 s); not with a window or when disabled', () => {
  const { clock, s, lt } = setup();
  lt.onAsk(); lt.onAsk();
  assert.equal(s.opened, 1);
  clock.advance(30_000);
  lt.onAsk();
  assert.equal(s.opened, 2);
  clock.advance(30_000);
  s.conns = 1; lt.onAsk();
  s.conns = 0; s.reopen = false; lt.onAsk();
  assert.equal(s.opened, 2);
});

test('crash marker and recorded children', () => {
  const dir = path.join(tmp.root, 'app');
  fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
  configureFsGuard({ allowRoots: [dir], home: tmp.home });
  const p = appPaths(dir);
  assert.deepEqual(readBootCrashState(p), { crashed: false, live: [], children: [] });
  writeCrashMarker(p.crashMarker, { pid: 1, startedAt: 2, live: ['perso:4adf4c63-b504-4be1-804b-92a88963e275', 'bad'] });
  fs.writeFileSync(p.children, JSON.stringify({ v: 1, data: { children: [{ pid: 42, createdAt: '134000000000000000', chatId: 'x' }, { pid: -1, createdAt: 'x' }] } }));
  const st = readBootCrashState(p);
  assert.equal(st.crashed, true);
  assert.deepEqual(st.live, ['perso:4adf4c63-b504-4be1-804b-92a88963e275']);
  assert.deepEqual(st.children, [{ pid: 42, createdAt: '134000000000000000', chatId: 'x' }]);
  assert.deepEqual(parseChildren('[{"pid":7,"procStart":5}]'), [{ pid: 7, createdAt: '5' }]);
  assert.deepEqual(parseChildren('nope'), []);
  clearRunFiles(p);
  assert.equal(fs.existsSync(p.crashMarker), false);
});
