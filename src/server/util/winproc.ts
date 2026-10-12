// src/server/util/winproc.ts — verified Windows process helpers.
// Sections 2 and 3 were verified on Windows (type-checked against SDK 0.3.293 types; a bash → node grandchild dies on
// the tree kill). Everything follows SPEC §10 S8:
// no shell ever, argument arrays, absolute %SystemRoot%\System32 paths, windowsHide:true, .exe targets only.
// No env helper here: engine/options.ts accountEnv() is the only env builder (§2.2).
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import path from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

const SYS32 = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
export { SYS32 };
export const POWERSHELL_EXE = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const TASKKILL_EXE = path.join(SYS32, 'taskkill.exe');

// ---------- 2. Kill a whole tree (bash-launched grandchildren included) ----------
export function treeKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile(path.join(SYS32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

// ---------- 3. SDK spawner: same flags as the SDK's own spawn, plus PID registry and tree kill ----------
export type ChildRegistry = { add(pid: number, chatId: string): void; remove(pid: number): void };
export function makeSpawner(reg: ChildRegistry, chatId: string): (o: SpawnOptions) => SpawnedProcess {
  return (o) => {
    // No `signal` passed to spawn(): Node would call child.kill() = TerminateProcess (claude.exe only) on abort.
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const pid = child.pid;
    if (pid !== undefined) reg.add(pid, chatId);
    const kill = (): boolean => { if (pid !== undefined && child.exitCode === null) void treeKill(pid); return true; };
    // The SDK aborts this forwarded signal only after stdin EOF + ~2 s grace (sdk.d.ts), so the CLI had its chance to exit cleanly.
    o.signal?.addEventListener('abort', kill, { once: true });
    child.kill = kill;                                           // q.close() also goes through the tree kill
    child.once('exit', () => { if (pid !== undefined) reg.remove(pid); });
    return child;
  };
}

// ---------- spawn helpers for everything else the server launches (explorer, msedge, wt, powershell, claude.exe auth) ----------
export type HiddenSpawnOptions = { cwd?: string; env?: Record<string, string>; detached?: boolean; stdio?: StdioOptions };

/** Refuses anything that is not an absolute path to an .exe (Node 24 refuses .cmd/.bat without a shell anyway, S8). */
export function assertExeTarget(command: string): string {
  if (typeof command !== 'string' || !path.win32.isAbsolute(command) || !/\.exe$/i.test(command) || /^[\\/]{2}/.test(command)) {
    throw new Error(`spawn refused: an absolute .exe path is required (got ${JSON.stringify(command)})`);
  }
  return command;
}

/** spawn() with windowsHide:true and never a shell. Arguments are passed as an array (quoted by libuv, never by us). */
export function spawnHidden(command: string, args: readonly string[], o: HiddenSpawnOptions = {}): ChildProcess {
  assertExeTarget(command);
  return spawn(command, [...args], {                         // no shell option at all: the default is no shell (S8 grep test)
    cwd: o.cwd, env: o.env, detached: o.detached ?? false, stdio: o.stdio ?? ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
}

export type ExecResult = { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean };
/** Runs an .exe to completion (hidden, no shell), with a timeout; never rejects. */
export function execHidden(command: string, args: readonly string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string; maxBytes?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try { child = spawnHidden(command, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) {
      resolve({ code: null, signal: null, stdout: '', stderr: String(e), timedOut: false });
      return;
    }
    const max = o.maxBytes ?? 4 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8').on('data', (d: string) => { if (stdout.length < max) stdout += d; });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < max) stderr += d; });
    const t = o.timeoutMs ? setTimeout(() => { timedOut = true; if (child.pid !== undefined) void treeKill(child.pid); }, o.timeoutMs) : null;
    child.on('error', (e) => { if (t) clearTimeout(t); resolve({ code: null, signal: null, stdout, stderr: stderr + String(e), timedOut }); });
    child.on('close', (code, signal) => { if (t) clearTimeout(t); resolve({ code, signal, stdout, stderr, timedOut }); });
    if (o.input !== undefined) child.stdin?.end(o.input); else child.stdin?.end();
  });
}

/** `process.kill(pid, 0)`: true when the pid exists (EPERM = exists but not ours). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

// ---------- creation time lookup (PID-reuse guard: run\children.json, registry procStart, orphans after a crash) ----------
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;   // 100-ns intervals between 1601-01-01 and 1970-01-01
/** Windows FILETIME (decimal string or bigint, UTC) → epoch milliseconds. */
export function fileTimeToMs(ft: string | bigint): number {
  const v = typeof ft === 'bigint' ? ft : BigInt(ft);
  return Number((v - FILETIME_UNIX_EPOCH) / 10_000n);
}
/** Epoch milliseconds → Windows FILETIME decimal string. */
export function msToFileTime(ms: number): string { return (BigInt(Math.round(ms)) * 10_000n + FILETIME_UNIX_EPOCH).toString(); }
/** Two creation times (ms) describe the same process start (recorded at spawn vs read back from Windows). */
export function sameProcessStart(a: number, b: number, toleranceMs = 2_000): boolean { return Math.abs(a - b) <= toleranceMs; }

export type ProcInfo = { pid: number; name: string; parentPid: number; createdMs: number; fileTime: string };
/**
 * One CIM query (`Get-CimInstance Win32_Process`, ≈ 0.5–1 s; `wmic` is absent on this Windows build) for many pids.
 * Missing pids are simply absent from the map. Never rejects (an error gives an empty map).
 */
export async function processInfo(pids: readonly number[], timeoutMs = 15_000): Promise<Map<number, ProcInfo>> {
  const ids = [...new Set(pids)].filter((p) => Number.isSafeInteger(p) && p > 0);
  const out = new Map<number, ProcInfo>();
  if (!ids.length) return out;
  const script = [
    `$f = '${ids.map((p) => `ProcessId=${p}`).join(' OR ')}'`,
    `$r = @(Get-CimInstance -ClassName Win32_Process -Filter $f | ForEach-Object {`,
    `  $ft = if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { '' }`,
    `  [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; ppid = [int]$_.ParentProcessId; ft = $ft } })`,
    `ConvertTo-Json -InputObject $r -Compress`,
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = await execHidden(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeoutMs });
  if (r.code !== 0) return out;
  try {
    const parsed: unknown = JSON.parse(r.stdout.trim() || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows as { pid?: unknown; name?: unknown; ppid?: unknown; ft?: unknown }[]) {
      if (!row || typeof row.pid !== 'number' || typeof row.ft !== 'string' || !/^\d+$/.test(row.ft)) continue;
      out.set(row.pid, { pid: row.pid, name: String(row.name ?? ''), parentPid: typeof row.ppid === 'number' ? row.ppid : 0, createdMs: fileTimeToMs(row.ft), fileTime: row.ft });
    }
  } catch { /* unparsable output: empty map */ }
  return out;
}
