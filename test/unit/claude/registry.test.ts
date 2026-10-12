// test/unit/claude/registry.test.ts — LiveRegistry: liveness (pid + procStart / fresh), own pids, *.key never opened.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createLiveRegistry } from '../../../src/server/claude/registry.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { msToFileTime, processInfo } from '../../../src/server/util/winproc.ts';
import { makeStore, until } from './lib.ts';
import type * as P from '../../../src/shared/protocol.ts';
import { budget } from '../../helpers/perf.ts';

const root = createTmpRoot('wpc-reg');
const pro = root.profile('pro');
const { store } = await makeStore(root);
const acc = await store.add({ configDir: pro.configDir, name: 'W', color: 2, monogram: 'W' });
after(async () => { store.close(); await root.disposeAsync(); });

const SID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SID_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const SID_C = 'cccccccc-0000-4000-8000-000000000003';
const T = Date.parse('2026-10-08T08:00:00Z');
const OLD = Date.now() - 3_600_000;

// spy every read API: a *.key path must never be opened
const opened: string[] = [];
const spies = [
  mock.method(fs.promises, 'readFile', (orig => function (this: unknown, p: unknown, ...a: unknown[]) { opened.push(String(p)); return (orig as (...x: unknown[]) => unknown).call(this, p, ...a); })(fs.promises.readFile)),
  mock.method(fs.promises, 'open', (orig => function (this: unknown, p: unknown, ...a: unknown[]) { opened.push(String(p)); return (orig as (...x: unknown[]) => unknown).call(this, p, ...a); })(fs.promises.open)),
  mock.method(fs, 'readFileSync', (orig => function (this: unknown, p: unknown, ...a: unknown[]) { opened.push(String(p)); return (orig as (...x: unknown[]) => unknown).call(this, p, ...a); })(fs.readFileSync)),
  mock.method(fs, 'openSync', (orig => function (this: unknown, p: unknown, ...a: unknown[]) { opened.push(String(p)); return (orig as (...x: unknown[]) => unknown).call(this, p, ...a); })(fs.openSync)),
];
after(() => { for (const s of spies) s.mock.restore(); });

test('liveness: alive + procStart match; stale dead pid ignored; pid reuse ignored; own pids excluded', async () => {
  pro.addRegistry({ pid: 1001, sessionId: SID_A, procStart: msToFileTime(T), updatedAt: OLD, status: 'busy' });
  pro.addRegistry({ pid: 1002, sessionId: SID_B, procStart: msToFileTime(T), updatedAt: OLD });        // dead pid (stale file)
  pro.addRegistry({ pid: 1003, sessionId: SID_C, procStart: msToFileTime(T), updatedAt: OLD });        // pid reused by another process
  const alive = new Set([1001, 1003]);
  let lookups = 0;
  const reg = createLiveRegistry({ accounts: store, log: nullLogger, isAlive: (p) => alive.has(p),
    procStart: async (pids) => { lookups++; return new Map(pids.map((p) => [p, p === 1003 ? T + 600_000 : T + 500])); } });
  const events: [string, P.ExternalHolder | null][] = [];
  reg.onChange((_a, sid, h) => events.push([sid, h]));
  reg.start();
  await until(() => reg.holder(acc.id, SID_A) !== null, 2000);
  assert.deepEqual(reg.holder(acc.id, SID_A), { pid: 1001, kind: 'interactive', entrypoint: 'cli', status: 'busy' });
  assert.deepEqual(reg.holder(acc.id, SID_A.toUpperCase()), reg.holder(acc.id, SID_A));
  assert.equal(reg.holder(acc.id, SID_B), null);
  assert.equal(reg.holder(acc.id, SID_C), null);
  assert.equal(lookups, 1);
  reg.setOwnPids(new Set([1001]));
  assert.equal(reg.holder(acc.id, SID_A), null);
  assert.ok(events.some(([s, h]) => s === SID_A && h === null));
  reg.setOwnPids(new Set());
  // a fresh file with an unknown creation time counts while updatedAt < 60 s
  alive.add(1004);
  const before = events.length;
  pro.addRegistry({ pid: 1004, sessionId: SID_B, updatedAt: Date.now() });
  const ms = await until(() => events.slice(before).some(([s, h]) => s === SID_B && h?.pid === 1004), 2000);
  assert.ok(ms < budget(500), `registry watch reacted in ${ms.toFixed(0)} ms`);
  fs.rmSync(`${pro.paths.sessionsDir}\\1004.json`);
  await until(() => reg.holder(acc.id, SID_B) === null, 2000);
  reg.close();
  assert.ok(opened.some((p) => /\\\d+\.json$/.test(p)));
  assert.equal(opened.filter((p) => /\.key$/i.test(p)).length, 0);
});

test('a failed creation-time query never marks a live holder dead; it is asked again later', async () => {
  const SID_D = 'dddddddd-0000-4000-8000-000000000004';
  let t = Date.now();
  let answer: Map<number, number> = new Map();                 // the CIM query « fails »: an alive pid is missing
  let lookups = 0;
  const reg = createLiveRegistry({ accounts: store, log: nullLogger, isAlive: (p) => p === 2001, now: () => t,
    procStart: async () => { lookups++; return answer; } });
  pro.addRegistry({ pid: 2001, sessionId: SID_D, procStart: msToFileTime(T), updatedAt: t });
  reg.start();
  await until(() => lookups === 1, 2000);
  assert.equal(reg.holder(acc.id, SID_D)?.pid, 2001, 'fresh updatedAt: live while the creation time is unknown');
  t += 120_000;                                                // the file goes stale; the query now works
  answer = new Map([[2001, T + 300]]);
  pro.addRegistry({ pid: 2001, sessionId: SID_D, procStart: msToFileTime(T), updatedAt: t - 90_000, status: 'waiting' });
  await until(() => lookups === 2, 2000);
  await until(() => reg.holder(acc.id, SID_D)?.status === 'waiting', 2000);
  reg.close();
});

test('real process: own creation time read back from Windows (CIM)', async () => {
  const me = (await processInfo([process.pid])).get(process.pid);
  assert.ok(me, 'CIM lookup of the test process');
  const reg = createLiveRegistry({ accounts: store, log: nullLogger });
  pro.addRegistry({ pid: process.pid, sessionId: SID_C, procStart: me.fileTime, updatedAt: OLD, kind: 'bg', entrypoint: 'sdk-cli' });
  reg.start();
  await until(() => reg.holder(acc.id, SID_C) !== null, 15_000, 50);
  assert.equal(reg.holder(acc.id, SID_C)?.kind, 'bg');
  reg.close();
  assert.equal(opened.filter((p) => /\.key$/i.test(p)).length, 0);
});
