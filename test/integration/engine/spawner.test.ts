// test/integration/engine/spawner.test.ts — jobrun / plain isolation, tree kill, fallback, children.json, jobrun memory (SPEC §2.11, WP-A.5).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execHidden, isPidAlive, POWERSHELL_EXE, TASKKILL_EXE } from '../../../src/server/util/winproc.ts';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnerFactory, SpawnSpec } from '../../../src/server/contracts.ts';
import { makeEngine } from '../../../src/server/engine/engine.ts';
import { realClock } from '../../../src/server/util/clock.ts';
import { recordingSink } from '../../unit/engine/engine-helpers.ts';
import { FAKE, JOBRUN, realEngine, tmpDirs, waitFor, frames } from './real-helpers.ts';
import type { ChildProcess } from 'node:child_process';
import { createSpawner } from '../../../src/server/engine/spawner.ts';
import type { ChildRecord } from '../../../src/server/engine/spawner.ts';
import { createFsGuard } from '../../../src/server/util/fs-guard.ts';
import { memoryLogger } from '../../../src/server/util/log.ts';

const strays: number[] = [];
after(() => { for (const p of strays) if (isPidAlive(p)) try { process.kill(p); } catch { /* gone */ } });
const readPid = async (f: string): Promise<number> => { await waitFor(() => fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() !== '', 'pid file ' + f); const p = Number(fs.readFileSync(f, 'utf8').trim()); strays.push(p); return p; };
const records = (file: string): ChildRecord[] => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as ChildRecord[] : []);

test('job mode: hook grandchild (bash … &) dies on sleep; children.json and ownPids hold jobrun + CLI; jobrun private memory ≤ 15 MB', { skip: JOBRUN ? false : 'jobrun.exe not built' }, async (t) => {
  const E = realEngine('job', { isolation: 'job' });
  try {
    const s = E.spec({ isolation: 'job' });
    await E.engine.ensure(s, { why: 'send' });
    await waitFor(() => E.engine.facts(s.chatId)?.phase === 'live', 'live');
    const pidFile = path.join(E.dirs.root, 'gc.pid');
    E.engine.send(s.chatId, { uuid: randomUUID(), text: 'HOOKS:' + pidFile });
    const gc = await readPid(pidFile);
    await waitFor(() => frames(E.sink, s.chatId).some((f) => f['type'] === 'result'), 'result');
    assert.ok(isPidAlive(gc), 'grandchild alive before sleep');
    const regFile = path.join(E.dirs.root, 'run', 'children.json');
    const recs = records(regFile);
    const host = recs.find((r) => r.role === 'jobrun');
    const cli = E.engine.facts(s.chatId)!.cliPid!;
    assert.ok(host, JSON.stringify(recs));
    assert.ok(recs.some((r) => r.role === 'cli' && r.pid === cli && r.hostPid === host.pid), JSON.stringify(recs));
    assert.ok(E.engine.ownPids().has(host.pid) && E.engine.ownPids().has(cli));
    assert.equal(E.engine.stats().isolation, 'job');
    const mem = await execHidden(POWERSHELL_EXE, ['-NoProfile', '-Command', `(Get-Process -Id ${host.pid}).PrivateMemorySize64`], { timeoutMs: 20_000 });
    const mb = Number(mem.stdout.trim()) / 1024 / 1024;
    t.diagnostic(`jobrun.exe private memory: ${mb.toFixed(2)} MB`);
    fs.writeFileSync(path.join(E.dirs.root, '..', 'jobrun-memory.txt'), `${mb.toFixed(2)} MB private (pid ${host.pid})\n`);
    assert.ok(mb > 0 && mb <= 15, `jobrun private memory ${mb} MB`);
    const info = await E.engine.sleep(s.chatId, 'user');
    assert.equal(info?.reason, 'closed');
    await waitFor(() => !isPidAlive(gc), 'grandchild dead after sleep', 5_000);
    await waitFor(() => records(regFile).length === 0, 'registry emptied', 5_000);
  } finally { await E.dispose(); }
});

test('job mode: killing the host (no /T) kills the jobrun tree, grandchild included', { skip: JOBRUN ? false : 'jobrun.exe not built' }, async () => {
  const d = tmpDirs('hostkill');
  try {
    const pidFile = path.join(d.root, 'gc.pid');
    const host = spawn(process.execPath, [path.join(import.meta.dirname, 'host-child.ts'), JOBRUN!, d.cfg, d.cwd, pidFile, path.join(d.root, 'children.json')],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let line = '';
    host.stdout.on('data', (b: Buffer) => { line += b.toString(); });
    await waitFor(() => line.includes('\n'), 'host ready', 30_000);
    const info = JSON.parse(line.trim()) as { cli: number; grandchild: number };
    strays.push(info.grandchild, info.cli);
    assert.ok(isPidAlive(info.grandchild) && isPidAlive(info.cli));
    await execHidden(TASKKILL_EXE, ['/PID', String(host.pid), '/F']);
    await waitFor(() => !isPidAlive(info.grandchild) && !isPidAlive(info.cli), 'tree dead after host kill', 8_000);
  } finally { d.dispose(); }
});

test('plain mode: own kill (taskkill /T /F) takes the linked tree down', async () => {
  const E = realEngine('plain', { isolation: 'plain', jobrun: null });
  try {
    const s = E.spec();
    await E.engine.ensure(s, { why: 'send' });
    await waitFor(() => E.engine.facts(s.chatId)?.phase === 'live', 'live');
    const pidFile = path.join(E.dirs.root, 'gc.pid');
    E.engine.send(s.chatId, { uuid: randomUUID(), text: 'BGJOB:' + pidFile });
    const gc = await readPid(pidFile);
    await waitFor(() => frames(E.sink, s.chatId).some((f) => f['type'] === 'result'), 'result');
    assert.equal(E.engine.stats().isolation, 'plain');
    E.engine.send(s.chatId, { uuid: randomUUID(), text: 'HANG' });   // keeps the CLI (and so the tree) alive until our own kill
    await waitFor(() => E.engine.facts(s.chatId)?.busy === true, 'busy');
    await E.engine.sleep(s.chatId, 'force');
    await waitFor(() => !isPidAlive(gc), 'grandchild dead after taskkill /T', 8_000);
  } finally { await E.dispose(); }
});

test('a jobrun that cannot start falls back to plain for that chat (isolation_fallback note)', async () => {
  const d = tmpDirs('fallback');
  const bogus = path.join(d.root, 'jobrun.exe');
  fs.writeFileSync(bogus, 'not an executable');
  const E = realEngine('fb', { isolation: 'job', jobrun: bogus });
  try {
    const s = E.spec({ isolation: 'job' });
    assert.equal((await E.engine.ensure(s, { why: 'send' })).ok, true);
    await waitFor(() => E.engine.facts(s.chatId)?.phase === 'live', 'live');
    assert.ok(frames(E.sink, s.chatId).some((f) => f['subtype'] === 'isolation_fallback'));
    E.engine.send(s.chatId, { uuid: randomUUID(), text: 'ECHO:ok' });
    await waitFor(() => frames(E.sink, s.chatId).some((f) => f['type'] === 'result'), 'result');
  } finally { await E.dispose(); d.dispose(); }
});

test('children.json goes through the fs-guard when one is given (SPEC §10 S11); a refused write is logged, never thrown', async () => {
  const d = tmpDirs('guard');
  try {
    const guard = createFsGuard({ allowRoots: [d.root], home: path.join(d.root, 'home') });
    const calls: string[] = [];
    const spy = { ...guard, mkdirSync: (p: string, o?: { recursive?: boolean }) => { calls.push('mkdir'); guard.mkdirSync(p, o); },
      writeFileSync: (p: string, x: string | Uint8Array) => { calls.push('write'); guard.writeFileSync(p, x); },
      renameSync: (a: string, b: string) => { calls.push('rename'); guard.renameSync(a, b); } };
    const reg = path.join(d.root, 'run', 'children.json');
    const sp = createSpawner({ jobrunPath: null, registryFile: reg, log: memoryLogger(), fs: spy });
    const child = sp('t:x', 'plain')({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 300)'], cwd: d.cwd, env: { ...process.env } as Record<string, string>, signal: new AbortController().signal }) as unknown as ChildProcess;
    assert.deepEqual(calls.slice(0, 3), ['mkdir', 'write', 'rename']);
    assert.equal((JSON.parse(fs.readFileSync(reg, 'utf8')) as ChildRecord[])[0]?.pid, child.pid);
    await new Promise((r) => child.once('exit', r));
    await waitFor(() => (JSON.parse(fs.readFileSync(reg, 'utf8')) as ChildRecord[]).length === 0, 'record removed');
    const log = memoryLogger();
    const outside = createSpawner({ jobrunPath: null, registryFile: path.join(d.root, 'home', '.claude', 'children.json'), log, fs: guard });
    const c2 = outside('t:y', 'plain')({ command: process.execPath, args: ['-e', ''], cwd: d.cwd, env: { ...process.env } as Record<string, string>, signal: new AbortController().signal }) as unknown as ChildProcess;
    await new Promise((r) => c2.once('exit', r));
    assert.equal(fs.existsSync(path.join(d.root, 'home', '.claude', 'children.json')), false);
    assert.ok(log.lines.some((l) => /children\.json write failed/.test(JSON.stringify(l))), 'refusal logged');
  } finally { d.dispose(); }
});

test('a real jobrun.exe that cannot start the CLI (CreateProcess fails, exit 5): one plain retry, isolation_fallback, no exit', { skip: JOBRUN ? false : 'jobrun.exe not built' }, async () => {
  const d = tmpDirs('jrfail');
  const sink = recordingSink(); const log = memoryLogger();
  const base = createSpawner({ jobrunPath: JOBRUN, registryFile: path.join(d.root, 'children.json'), log });
  let broken = true;                                              // the first job spawn gets a CLI path that does not exist
  const spawner = ((c: string, iso: 'job' | 'plain') => (so: SpawnOptions) => {
    const o = broken && iso === 'job' ? { ...so, command: path.join(d.root, 'missing-cli.exe') } : so;
    if (iso === 'job') broken = false;
    return base(c, iso)(o);
  }) as SpawnerFactory;
  const engine = makeEngine({ query, clock: realClock, sink, log, spawner, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null });
  try {
    const sid = randomUUID();
    const s: SpawnSpec = { chatId: `t:${sid}`, sessionId: sid, cwd: d.cwd, account: { id: 't', configDir: d.cfg, claudeMdExcludes: [] }, mode: 'default',
      start: { kind: 'new' }, allowBypass: false, aiTitles: false, exe: FAKE, isolation: 'job' };
    assert.deepEqual(await engine.ensure(s, { why: 'send' }), { ok: true, data: undefined });
    await waitFor(() => engine.facts(s.chatId)?.phase === 'live', 'plain retry live', 20_000);
    assert.ok(frames(sink, s.chatId).some((f) => f['subtype'] === 'isolation_fallback'));
    assert.equal(sink.log.some((r) => r.k === 'exited'), false);
    assert.equal(engine.stats().isolation, 'plain');
    engine.send(s.chatId, { uuid: randomUUID(), text: 'ECHO:ok' });
    await waitFor(() => frames(sink, s.chatId).some((f) => f['type'] === 'result'), 'result');
  } finally { await engine.shutdown(15_000); d.dispose(); }
});
