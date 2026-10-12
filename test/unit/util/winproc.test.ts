import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import {
  assertExeTarget, execHidden, fileTimeToMs, isPidAlive, makeSpawner, msToFileTime, processInfo, sameProcessStart, spawnHidden, SYS32, treeKill,
} from '../../../src/server/util/winproc.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const tmp = createTmpRoot('winproc');
after(() => tmp.dispose());
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

async function waitFor(pred: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await sleep(25); }
}
/** A grandchild that writes its pid then idles forever (the case of a dev server started by the Bash tool). */
function grandchildScript(pidFile: string): string {
  const gc = path.join(tmp.root, `gc-${path.basename(pidFile)}.cjs`);
  fs.writeFileSync(gc, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e6);`);
  return gc;
}

describe('winproc (independent cases run concurrently: process spawns and the CIM query overlap)', { concurrency: true }, () => {
  test('assertExeTarget: absolute .exe only (no .cmd/.bat, no relative, no UNC)', () => {
    assert.equal(assertExeTarget(path.join(SYS32, 'taskkill.exe')), path.join(SYS32, 'taskkill.exe'));
    for (const bad of ['taskkill.exe', 'C:\\x\\run.cmd', 'C:\\x\\run.bat', '\\\\server\\share\\a.exe', 'C:\\x\\script.ps1', '']) assert.throws(() => assertExeTarget(bad), bad);
    assert.throws(() => spawnHidden('node', ['-v']));
  });

  test('execHidden runs an .exe without a shell and captures its output; arguments round-trip unquoted', async () => {
    const r = await execHidden(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b', 'c"d', 'e&f'], { timeoutMs: 15_000 });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), ['a b', 'c"d', 'e&f']);
    const t = await execHidden(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    assert.equal(t.timedOut, true);
  });

  test('treeKill kills a child and its grandchild (taskkill /T /F, absolute path)', async () => {
    const pidFile = path.join(tmp.root, 'tk.pid');
    const gc = grandchildScript(pidFile);
    const child = spawnHidden(process.execPath, ['-e', `require('child_process').spawn(process.execPath, [${JSON.stringify(gc)}], { stdio: 'ignore' }); setInterval(() => {}, 1e6);`]);
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0);
    const gcPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(isPidAlive(child.pid!), true);
    assert.equal(isPidAlive(gcPid), true);
    await treeKill(child.pid!);
    await waitFor(() => !isPidAlive(child.pid!) && !isPidAlive(gcPid), 5_000);
  });

  test('makeSpawner (verbatim platform helper): registry + the SDK abort signal kill the whole tree', async () => {
    const pidFile = path.join(tmp.root, 'sp.pid');
    const gc = grandchildScript(pidFile);
    const reg = new Map<number, string>();
    const spawner = makeSpawner({ add: (p, c) => reg.set(p, c), remove: (p) => reg.delete(p) }, 'perso:4adf4c63-b504-4be1-804b-92a88963e275');
    const ac = new AbortController();
    const useBash = fs.existsSync(GIT_BASH);
    // `; echo done` (a bash builtin, as in platform's tree-test.mjs): if taskkill reaches the node grandchild before bash,
    // bash must not start a NEW process (`sleep 100` did: an orphan outside the enumerated tree, holding the test's pipes)
    const o: SpawnOptions = useBash
      ? { command: GIT_BASH, args: ['-c', `"${process.execPath.replace(/\\/g, '/')}" "${gc.replace(/\\/g, '/')}"; echo done`], cwd: tmp.root, env: { ...process.env }, signal: ac.signal }
      : { command: process.execPath, args: ['-e', `require('child_process').spawn(process.execPath, [${JSON.stringify(gc)}], { stdio: 'ignore' }); setInterval(() => {}, 1e6);`], cwd: tmp.root, env: { ...process.env }, signal: ac.signal };
    const child = spawner(o);
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0);
    const gcPid = Number(fs.readFileSync(pidFile, 'utf8'));
    const pid = (child as unknown as { pid: number }).pid;
    assert.equal(reg.get(pid), 'perso:4adf4c63-b504-4be1-804b-92a88963e275');
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    ac.abort();                                                   // what the SDK does after stdin EOF + grace
    await exited;
    await waitFor(() => !isPidAlive(gcPid), 5_000);
    assert.equal(reg.size, 0, 'removed from the registry on exit');
    const cp = child as unknown as ChildProcess;                  // never let a stray pipe holder keep this test file alive
    for (const s of [cp.stdin, cp.stdout, cp.stderr]) s?.destroy();
  });

  test('FILETIME conversions and the creation-time tolerance', () => {
    assert.equal(fileTimeToMs('116444736000000000'), 0);
    const ms = Date.UTC(2026, 9, 8, 12, 0, 0, 123);
    assert.equal(fileTimeToMs(msToFileTime(ms)), ms);
    assert.equal(fileTimeToMs(BigInt(msToFileTime(ms))), ms);
    assert.equal(sameProcessStart(ms, ms + 1_500), true);
    assert.equal(sameProcessStart(ms, ms + 2_500), false);
  });

  test('processInfo: one CIM query gives name, parent and creation time; dead pids are absent', async () => {
    const self = await processInfo([process.pid, 999_999_999 % 4_000_000 + 4_000_001]);
    const me = self.get(process.pid);
    assert.ok(me, 'own process found');
    assert.match(me.name, /^node(\.exe)?$/i);
    assert.equal(me.parentPid, process.ppid);
    assert.ok(sameProcessStart(me.createdMs, performance.timeOrigin, 5_000), `created ${me.createdMs} vs timeOrigin ${performance.timeOrigin}`);
    assert.match(me.fileTime, /^\d{17,18}$/);
    assert.equal(self.size, 1);
    assert.equal((await processInfo([])).size, 0);
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-5), false);
  });
});
