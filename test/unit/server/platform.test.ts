// WP-D acceptance 8: S9 table, terminal command (-EncodedCommand round-trip, default profile, `;` refused), openExternal
// scheme check, Edge launch args (S13), port fallback, pipe hand-off < 200 ms, orphan matching, args and env scrub.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { checkCwdPolicy, homeWarning } from '../../../src/server/platform/confine.ts';
import { decodeCommand, terminalCommand, terminalLaunch } from '../../../src/server/platform/terminal.ts';
import { appWindowArgs } from '../../../src/server/platform/window.ts';
import { askRunningInstanceToOpen, bindFirstFree, explorerTarget, holdInstanceLock, pipePath, portCandidates, safeExternalUrl } from '../../../src/server/platform/win.ts';
import { findOrphans } from '../../../src/server/platform/orphans.ts';
import { parseArgs, portToPersist, scrubEnv } from '../../../src/server/main.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { budget } from '../../helpers/perf.ts';

const tmp = createTmpRoot('platform');
after(() => tmp.dispose());
const SID = '4adf4c63-b504-4be1-804b-92a88963e275';

test('S9 working-folder policy table', () => {
  const home = tmp.home;
  const appDir = path.join(tmp.root, 'appdata');
  const probe = path.join(appDir, 'probe-cwd');
  const ext = path.join(tmp.root, 'ext', 'work-profile');
  const work = tmp.cwd('Mon Projet');
  for (const d of [path.join(home, '.claude', 'sub'), path.join(home, '.claude-pro', 'x'), probe, path.join(appDir, 'state'), ext, path.join(home, 'code')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(work, 'f.txt'), 'x');
  let long = work;
  while (long.length < 262) long = path.join(long, 'abcdefghij');
  fs.mkdirSync(long, { recursive: true });
  const ctx = { home, appDir, probeCwd: probe };
  const code = (p: string): string => { const r = checkCwdPolicy(p, [ext], ctx); return r.ok ? `ok:${r.data}` : r.err; };
  const rows: [string, string][] = [
    [work, `ok:${fs.realpathSync.native(work)}`],
    [work.toUpperCase(), `ok:${fs.realpathSync.native(work)}`],
    [path.join(home, 'code'), `ok:${fs.realpathSync.native(path.join(home, 'code'))}`],
    [path.join(work, 'missing'), 'cwd_missing'],
    [path.join(work, 'f.txt'), 'cwd_missing'],
    ['relative\\dir', 'cwd_missing'],
    ['\\\\server\\share', 'cwd_missing'],
    [long, 'cwd_too_long'],
    [home, 'cwd_refused'],
    [path.join(home, '.claude'), 'cwd_refused'],
    [path.join(home, '.claude', 'sub'), 'cwd_refused'],
    [path.join(home, '.claude-pro', 'x'), 'cwd_refused'],
    [ext, 'cwd_refused'],
    [appDir, 'cwd_refused'],
    [path.join(appDir, 'state'), 'cwd_refused'],
    [probe, `ok:${fs.realpathSync.native(probe)}`],
  ];
  for (const [p, want] of rows) assert.equal(code(p), want, p);
  assert.equal(homeWarning(home, home), 'home');
  assert.equal(homeWarning(path.dirname(home), home), 'ancestor');
  assert.equal(homeWarning(work, home), undefined);
});

test('terminal: -EncodedCommand round-trip, CLAUDE_CONFIG_DIR only for non-default profiles, `;` refused', () => {
  const exe = 'C:\\Users\\X\\.local\\bin\\claude.exe';
  const def = terminalLaunch({ cwd: 'C:\\Work\\Mon Projet', configDir: null, sessionId: SID, exe }, 'C:\\wt.exe');
  assert.ok(def.ok);
  if (!def.ok) return;
  assert.deepEqual(def.data.args.slice(0, 2), ['-d', 'C:\\Work\\Mon Projet']);
  const script = decodeCommand(def.data.encoded);
  assert.equal(script, def.data.script);
  assert.match(script, /^Remove-Item Env:CLAUDECODE,Env:CLAUDE_CODE_\*,Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; & 'C:\\Users\\X\\.local\\bin\\claude.exe' --resume 4adf4c63/);
  assert.ok(!script.includes('$env:CLAUDE_CONFIG_DIR'), 'default profile: variable unset');
  const pro = terminalLaunch({ cwd: 'C:\\Work', configDir: "C:\\Users\\X\\.claude-o'pro", sessionId: SID, exe }, null);
  assert.ok(pro.ok && pro.data.file.toLowerCase().endsWith('powershell.exe') && pro.data.cwd === 'C:\\Work', 'fallback without wt.exe');
  if (pro.ok) assert.ok(decodeCommand(pro.data.encoded).includes("$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\X\\.claude-o''pro'"), 'quote doubled');
  assert.deepEqual(terminalCommand({ cwd: 'C:\\a;calc', configDir: null, sessionId: SID, exe }), { ok: false, err: 'cwd_refused' });
  assert.deepEqual(terminalCommand({ cwd: 'C:\\a', configDir: null, sessionId: 'not-a-uuid', exe }), { ok: false, err: 'cwd_refused' });
  const c = terminalCommand({ cwd: 'C:\\a', configDir: null, sessionId: SID, exe });
  assert.ok(c.ok && c.data.startsWith('wt.exe -d "C:\\a" powershell.exe -NoProfile -NoExit -EncodedCommand '));
});

test('openExternal accepts http/https only', () => {
  assert.equal(safeExternalUrl('https://claude.ai/x?y=1'), 'https://claude.ai/x?y=1');
  assert.equal(safeExternalUrl('http://127.0.0.1:9/'), 'http://127.0.0.1:9/');
  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,x', 'ms-settings:', 'C:\\x.exe', '\\\\srv\\s', 'https://a"b', 'x'])
    assert.equal(safeExternalUrl(bad), null, bad);
});

test('explorer.exe never splits or runs: commas encoded in URLs, files open their folder, comma paths refused', () => {
  const u = safeExternalUrl('https://x.example/,/root,C:\\Windows\\System32\\calc.exe?a=1,2#f,g');
  assert.ok(u && !u.includes(',') && !/\s/.test(u), String(u));
  assert.equal(u, 'https://x.example/%2C/root%2CC:/Windows/System32/calc.exe?a=1%2C2#f%2Cg');
  const dir = tmp.cwd('explorer-target');
  fs.writeFileSync(path.join(dir, 'run-me.bat'), '@echo off');
  fs.mkdirSync(path.join(dir, 'a,b'), { recursive: true });
  assert.equal(explorerTarget(dir), dir, 'a folder opens as is');
  assert.equal(explorerTarget(path.join(dir, 'run-me.bat')), dir, 'a file shows its folder, never runs');
  assert.equal(explorerTarget(path.join(dir, 'a,b')), null, 'comma: explorer would split the command line');
  assert.equal(explorerTarget(path.join(dir, 'missing')), null);
});

test('port candidates: the persisted port, then 41731, then 41732–41750 (no duplicates)', () => {
  assert.deepEqual(portCandidates(41740).slice(0, 3), [41740, 41731, 41732]);
  assert.equal(portCandidates(41740).length, 20);
  assert.equal(new Set(portCandidates(41740)).size, 20);
  assert.deepEqual(portCandidates(50123).slice(0, 2), [50123, 41731], 'a custom port, then the default range');
  assert.equal(portCandidates(50123).length, 21);
  assert.equal(portToPersist({ test: false, argPort: null, bound: 41733, stored: 41731 }), 41733, 'a fallback port is persisted');
  assert.equal(portToPersist({ test: false, argPort: null, bound: 41731, stored: 41731 }), null, 'unchanged');
  assert.equal(portToPersist({ test: false, argPort: 41800, bound: 41800, stored: 41731 }), null, '--port is not persisted');
  assert.equal(portToPersist({ test: true, argPort: null, bound: 53111, stored: 41731 }), null, 'tests never persist their random port');
});

test('S13: Edge --app args (dedicated profile, lean flags, no remote debugging, literal 127.0.0.1)', () => {
  const a = appWindowArgs(41731, 'abc_DEF-123', 'C:\\data\\edge-profile');
  assert.equal(a[0], '--app=http://127.0.0.1:41731/#boot=abc_DEF-123');
  assert.ok(a.includes('--user-data-dir=C:\\data\\edge-profile'));
  for (const f of ['--no-first-run', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--no-pings', '--window-size=1280,860']) assert.ok(a.includes(f), f);
  assert.ok(!a.some((x) => /remote-debugging|localhost/.test(x)));
  assert.throws(() => appWindowArgs(41731, 'a b', 'C:\\p'));
});

test('port fallback: 41732–41750 on EADDRINUSE, other errors rethrown', async () => {
  assert.deepEqual(portCandidates(41731).slice(0, 3), [41731, 41732, 41733]);
  assert.equal(portCandidates(41731).length, 20);
  assert.deepEqual(portCandidates(0), [0]);
  const busy = net.createServer();
  await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
  const taken = (busy.address() as net.AddressInfo).port;
  const tried: number[] = [];
  const listen = (p: number): Promise<number> => new Promise((res, rej) => {
    tried.push(p);
    const s = net.createServer();
    s.once('error', rej);
    s.listen({ port: p, host: '127.0.0.1', exclusive: true }, () => { const got = (s.address() as net.AddressInfo).port; s.close(); res(got); });
  });
  const got = await bindFirstFree(listen, [taken, 0]);
  busy.close();
  assert.equal(tried[0], taken);
  assert.ok(got > 0 && got !== taken);
  await assert.rejects(bindFirstFree(() => Promise.reject(Object.assign(new Error('x'), { code: 'EINVAL' })), [1, 2]), /x/);
});

test('single instance: second launch hands off through the pipe in < 200 ms; pipe names are per data dir', async () => {
  const pipe = pipePath(null, { SMC_PIPE: `smc-test-${process.pid}-${Date.now()}` });
  let opened = 0;
  const lock = await holdInstanceLock(pipe, () => { opened++; });
  assert.ok(lock);
  assert.equal(await holdInstanceLock(pipe, () => {}), null, 'taken');
  const t0 = performance.now();
  assert.equal(await askRunningInstanceToOpen(pipe), true);
  const ms = performance.now() - t0;
  assert.ok(ms < budget(200), `hand-off ${ms.toFixed(1)} ms`);
  assert.equal(opened, 1);
  lock!.close();
  assert.equal(await askRunningInstanceToOpen(pipe, 300), false, 'nobody listening');
  assert.notEqual(pipePath('C:\\a', {}), pipePath('C:\\b', {}));
  assert.match(pipePath(null, {}), /^\\\\\.\\pipe\\SidMultiClaude-[\w.-]+$/);
});

test('orphans: recorded pid alive with the same start, and descendants created after it', () => {
  const table = [
    { pid: 10, ppid: 1, name: 'claude.exe', createdMs: 1_000 },
    { pid: 11, ppid: 10, name: 'bash.exe', createdMs: 2_000 },
    { pid: 12, ppid: 11, name: 'node.exe', createdMs: 3_000 },
    { pid: 20, ppid: 1, name: 'reused.exe', createdMs: 9_000_000 },
    { pid: 21, ppid: 20, name: 'child.exe', createdMs: 9_000_001 },
  ];
  const got = findOrphans([{ pid: 10, createdAt: '1000' }, { pid: 20, createdAt: '5000' }], table, 999).map((x) => x.pid).sort();
  assert.deepEqual(got, [10, 11, 12], 'a reused pid and its children are not ours');
});

test('main: args and env scrub', () => {
  assert.deepEqual(parseArgs(['--open', '--port', '0', '--data-dir', 'C:\\d', '--fake-engine', '--print-boot']),
    { open: true, background: false, supervised: false, port: 0, dataDir: 'C:\\d', fakeEngine: true, profilesRoot: null, printBoot: true });
  assert.throws(() => parseArgs(['--nope']));
  assert.throws(() => parseArgs(['--port', '99999']));
  const env: NodeJS.ProcessEnv = { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'x', ANTHROPIC_API_KEY: 'k', claude_effort: 'max', Path: 'C:\\', SMC_TEST: '1' };
  scrubEnv(env);
  assert.deepEqual(Object.keys(env).sort(), ['Path', 'SMC_TEST']);
});
