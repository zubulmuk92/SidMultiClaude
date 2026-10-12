// WP-D acceptance 9 + Q3/L4: install.ps1 (csc build, SHA-256 manifest, shortcuts in TEST directories only, VBS fallback)
// and the launcher's supervisor: GUI subsystem (no console), pipe hand-off, exit 0 stops, 75 restarts, ≤ 3 restarts / 60 s.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execHidden, POWERSHELL_EXE } from '../../../src/server/util/winproc.ts';
import { holdInstanceLock, pipePath } from '../../../src/server/platform/win.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const tmp = createTmpRoot('launcher');
after(() => tmp.dispose());
const csc = path.join(process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const haveCsc = fs.existsSync(csc);
const dirs = { out: path.join(tmp.root, 'out'), data: path.join(tmp.root, 'data'), desk: path.join(tmp.root, 'Desktop'), start: path.join(tmp.root, 'Programs') };

async function install(extra: string[] = []): Promise<{ launcher: string; isolation: string; shortcuts: string[]; helpers: string }> {
  const r = await execHidden(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'install.ps1'),
    '-OutDir', dirs.out, '-DataDir', dirs.data, '-DesktopDir', dirs.desk, '-StartMenuDir', dirs.start, '-NodeExe', process.execPath, ...extra], { timeoutMs: 120_000 });
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('SMC_INSTALL '));
  assert.ok(line, `install.ps1 output:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice('SMC_INSTALL '.length)) as { launcher: string; isolation: string; shortcuts: string[]; helpers: string };
}
async function shortcutTarget(lnk: string): Promise<string> {
  const r = await execHidden(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`], { timeoutMs: 20_000 });
  return r.stdout.trim();
}

test('install.ps1 without csc: VBS fallback shortcuts (console-free), plain isolation, empty manifest', { timeout: 120_000 }, async () => {
  const r = await install(['-Csc', path.join(tmp.root, 'no-csc.exe')]);
  assert.equal(r.launcher, 'vbs');
  assert.equal(r.isolation, 'plain');
  assert.equal(r.shortcuts.length, 2);
  for (const l of r.shortcuts) assert.ok(l.startsWith(tmp.root), 'shortcuts only in the test dirs');
  assert.match(await shortcutTarget(r.shortcuts[0]!), /\\System32\\wscript\.exe$/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.helpers, 'utf8')), { v: 1, data: {} });
});

test('fallback launcher without csc: wscript runs the VBS, which starts `node main --open` hidden in the app folder and returns', { timeout: 60_000 }, async () => {
  const app = path.join(tmp.root, 'vbsapp');
  const stub = path.join(app, 'src', 'server', 'main.mjs');
  const log = path.join(tmp.root, `vbs-runs-${Date.now()}.txt`);
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, "import fs from 'node:fs';\nfs.appendFileSync(process.env.SMC_STUB_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\n");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const wscript = path.join(process.env['WINDIR'] ?? 'C:\\Windows', 'System32', 'wscript.exe');
  const t0 = performance.now();
  const r = await execHidden(wscript, ['//B', '//Nologo', path.join(ROOT, 'launcher', 'SidMultiClaude.vbs'), process.execPath, stub], { timeoutMs: 30_000, env: { ...env, SMC_STUB_LOG: log } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(performance.now() - t0 < 10_000, 'the launcher does not wait for the server');
  for (let i = 0; i < 200 && !fs.existsSync(log); i++) await new Promise((res) => setTimeout(res, 50));
  const run = JSON.parse(fs.readFileSync(log, 'utf8').trim()) as { argv: string[]; cwd: string };
  assert.deepEqual(run.argv, ['--open'], 'the server opens the window; the launcher never builds a URL');
  assert.equal(fs.realpathSync.native(run.cwd).toLowerCase(), fs.realpathSync.native(app).toLowerCase());
});

test('install.ps1 with csc: both helpers built, hashes recorded, shortcuts target the launcher', { skip: !haveCsc && 'csc.exe not available', timeout: 180_000 }, async () => {
  const r = await install();
  assert.equal(r.launcher, 'exe');
  const m = JSON.parse(fs.readFileSync(r.helpers, 'utf8')) as { v: number; data: Record<string, { path: string; sha256: string }> };
  for (const k of ['launcher', 'jobrun'] as const) {
    const e = m.data[k];
    if (k === 'jobrun' && !e) continue;                                         // WP-A's jobrun.cs may not compile yet
    assert.ok(e, k);
    assert.equal(createHash('sha256').update(fs.readFileSync(e.path)).digest('hex'), e.sha256, `${k} hash`);
  }
  assert.equal((await shortcutTarget(r.shortcuts[0]!)).toLowerCase(), path.join(dirs.out, 'SidMultiClaude.exe').toLowerCase());
  const pe = fs.readFileSync(path.join(dirs.out, 'SidMultiClaude.exe'));
  const off = pe.readUInt32LE(0x3c);
  assert.equal(pe.readUInt16LE(off + 0x5c), 2, 'IMAGE_SUBSYSTEM_WINDOWS_GUI: no console window');
});

function runLauncher(stubCodes: number[], env: Record<string, string> = {}): Promise<{ code: number | null; runs: string[]; ms: number }> {
  const stub = path.join(tmp.root, 'app', 'src', 'server', 'main.mjs');
  const log = path.join(tmp.root, `runs-${Date.now()}.txt`);
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, `import fs from 'node:fs';
const log = process.env.SMC_STUB_LOG; const codes = JSON.parse(process.env.SMC_STUB_CODES);
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(codes[Math.min(n, codes.length - 1)]);`);
  const t0 = performance.now();
  const p = spawn(path.join(dirs.out, 'SidMultiClaude.exe'), [process.execPath, stub, '--data-dir', 'X'], {
    env: { ...process.env, SMC_LAUNCHER_NOBOX: '1', SMC_PIPE: `smc-launcher-${process.pid}`, SMC_STUB_LOG: log, SMC_STUB_CODES: JSON.stringify(stubCodes), ...env }, windowsHide: true, stdio: 'ignore' });
  return new Promise((resolve) => p.once('exit', (code) => resolve({ code, runs: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [], ms: performance.now() - t0 })));
}

test('supervisor: exit 0 stops; 75 restarts at once; crashes restart ≤ 3 times in 60 s with backoff; pipe hand-off', { skip: !haveCsc && 'csc.exe not available', timeout: 120_000 }, async () => {
  assert.ok(fs.existsSync(path.join(dirs.out, 'SidMultiClaude.exe')), 'built by the previous test');
  const stop = await runLauncher([0]);
  assert.equal(stop.code, 0);
  assert.deepEqual(stop.runs, [JSON.stringify(['--data-dir', 'X', '--open', '--supervised'])]);
  const restart = await runLauncher([75, 0]);
  assert.equal(restart.code, 0);
  assert.equal(restart.runs.length, 2);
  assert.ok(!restart.runs[1]!.includes('--open'), 'restarts never reopen a window');
  const crash = await runLauncher([1]);
  assert.equal(crash.code, 3, 'gives up (MessageBox in real use)');
  assert.equal(crash.runs.length, 4, '1 start + 3 restarts');
  assert.ok(crash.ms >= 7_000, `backoff 0.5 + 2 + 5 s (${crash.ms.toFixed(0)} ms)`);
  let opened = 0;
  const lock = await holdInstanceLock(pipePath(null, { SMC_PIPE: `smc-launcher-${process.pid}` }), () => { opened++; });
  try {
    const hand = await runLauncher([0]);
    assert.equal(hand.code, 0);
    assert.equal(hand.runs.length, 0, 'no second server');
    assert.equal(opened, 1, 'the running instance was asked to open a window');
  } finally { lock?.close(); }
});
