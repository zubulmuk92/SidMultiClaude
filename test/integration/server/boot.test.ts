// WP-D acceptance 7 + C8/§2.9: the real process — listening in < 400 ms (fake engine), 30 s idle ≈ 0 ms CPU, second launch
// hands off through the pipe and exits 0, app.quit exits 0 and removes the run files, a hard kill leaves the crash marker
// that the next boot reports.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, SERVER_MAIN, serverEnv, PROJECT_ROOT } from '../../e2e/harness.ts';
import type { ServerHandle } from '../../e2e/harness.ts';
import { execHidden, POWERSHELL_EXE } from '../../../src/server/util/winproc.ts';
import { appPaths } from '../../../src/server/util/paths.ts';
import { connectWs } from '../../helpers/ws-client.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { SERVER_IDLE_CPU_WINDOW_MS, SERVER_IDLE_RSS_BUDGET_BYTES } from '../../../src/shared/limits.ts';

const tmp = createTmpRoot('int-boot');
const servers: ServerHandle[] = [];
after(async () => { for (const s of servers) await s.stop(); tmp.dispose(); });

function logLines(appDir: string): Record<string, unknown>[] {
  const dir = appPaths(appDir).logsDir;
  return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
}
async function cpuMs(pid: number): Promise<number> {
  const r = await execHidden(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`], { timeoutMs: 20_000 });
  return Number(r.stdout.trim().replace(',', '.'));
}

test('boot < 400 ms to listen, second launch hands off, 30 s idle without CPU', { timeout: 120_000 }, async () => {
  const t0 = performance.now();
  const s = await startServer({ root: tmp, fakeEngine: true });
  const wall = performance.now() - t0;
  servers.push(s);
  const listening = logLines(tmp.appDir).find((l) => l['msg'] === 'listening');
  assert.ok(listening, 'listening logged');
  const ms = Number(listening['ms']);
  console.log(`# boot: listening ${ms} ms after startApp, ${wall.toFixed(0)} ms from spawn (incl. node + imports)`);
  assert.ok(ms < 400, `listening after ${ms} ms`);
  // second launch on the same data dir: asks the first one to open a window (test mode prints a new boot line), exits 0
  const before = s.stdout.join('').split('SMC_BOOT').length;
  const second = spawn(process.execPath, [SERVER_MAIN, '--data-dir', tmp.appDir, '--profiles-root', tmp.home, '--fake-engine', '--open'],
    { cwd: PROJECT_ROOT, env: serverEnv(), stdio: 'ignore', windowsHide: true });
  const code = await new Promise<number | null>((r) => second.once('exit', r));
  assert.equal(code, 0, 'second instance exits 0');
  for (let i = 0; i < 50 && s.stdout.join('').split('SMC_BOOT').length === before; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(s.stdout.join('').split('SMC_BOOT').length > before, 'running instance opened a window');
  // idle: no timers, no polling (5 s settle: start-up GC and JIT work of V8's background threads)
  await new Promise((r) => setTimeout(r, 5_000));
  // 6 windows of 5 s. A polling timer would show in every window; one isolated blip is tolerated because, when other
  // test files run in parallel (other servers, Edge, csc, CIM queries), Windows occasionally charges a single burst to
  // an idle process. The total is still reported.
  const windows: number[] = [];
  let prev = await cpuMs(s.proc.pid!);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, SERVER_IDLE_CPU_WINDOW_MS / 6));
    const cur = await cpuMs(s.proc.pid!);
    windows.push(cur - prev);
    prev = cur;
  }
  const total = windows.reduce((a, b) => a + b, 0);
  const withoutBlip = total - Math.max(...windows);
  console.log(`# idle CPU over ${SERVER_IDLE_CPU_WINDOW_MS / 1000} s: ${total.toFixed(1)} ms, per 5 s: ${windows.map((x) => x.toFixed(0)).join(' ')} (Windows accounting granularity 15.6 ms)`);
  assert.ok(withoutBlip <= 16, `idle CPU ${windows.join(' ')} ms`);
  // §9.5: RSS < 120 MB with 0 live chats (the SDK is not loaded before the first spawn)
  const ws = await execHidden(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${s.proc.pid!}).WorkingSet64`], { timeoutMs: 20_000 });
  const rss = Number(ws.stdout.trim());
  console.log(`# idle RSS ${(rss / 1e6).toFixed(1)} MB`);
  assert.ok(rss > 0 && rss < SERVER_IDLE_RSS_BUDGET_BYTES, `RSS ${rss}`);
});

test('app.quit exits 0 and removes run files; a hard kill leaves the marker the next boot reports', { timeout: 60_000 }, async () => {
  const root = createTmpRoot('int-boot2');
  try {
    const s1 = await startServer({ root, fakeEngine: true });
    const p = appPaths(root.appDir);
    assert.ok(fs.existsSync(p.crashMarker) && fs.existsSync(p.instance));
    await s1.stop();                                                           // hard kill (taskkill /T /F)
    assert.ok(fs.existsSync(p.crashMarker), 'marker left behind');
    const s2 = await startServer({ root, fakeEngine: true });
    servers.push(s2);
    for (let i = 0; i < 50 && !logLines(root.appDir).some((l) => l['msg'] === 'previous run crashed'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(logLines(root.appDir).some((l) => l['msg'] === 'previous run crashed'));
    const w = await connectWs({ port: s2.port, boot: s2.boot });
    await w.next((m) => m.t === 'hello');
    const exit = new Promise<number | null>((r) => s2.proc.once('exit', r));
    assert.ok((await w.request({ t: 'app.quit' })).ok);
    await w.next((m) => m.t === 'bye');
    assert.equal(await exit, 0);
    assert.equal(fs.existsSync(p.crashMarker), false);
    assert.equal(fs.existsSync(p.instance), false);
  } finally { root.dispose(); }
});
