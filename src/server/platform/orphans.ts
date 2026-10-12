// src/server/platform/orphans.ts — post-crash CIM query and kill (plain isolation only; the user decides).
// SPEC §2.9: after a server crash, processes started by Claude through bash may survive (their parent
// claude.exe died with the libuv job). One CIM query lists every process; we keep the recorded children that are still
// alive with the same creation time, plus every descendant of a recorded pid created after it. Nothing is killed here.
import { execHidden, fileTimeToMs, POWERSHELL_EXE, sameProcessStart, treeKill } from '../util/winproc.ts';

export type ProcRow = { pid: number; ppid: number; name: string; createdMs: number };

/** Recorded creation times may be a FILETIME string, epoch ms, or an ISO date. NaN when unreadable. */
export function parseCreatedAt(s: string): number {
  if (/^\d{16,}$/.test(s)) return fileTimeToMs(s);
  if (/^\d{1,15}$/.test(s)) return Number(s);
  return Date.parse(s);
}

/** Pure part (unit-tested): recorded pids still alive (same start) and their descendants created after them. */
export function findOrphans(recorded: { pid: number; createdAt: string }[], table: readonly ProcRow[], selfPid = process.pid): { pid: number; name: string }[] {
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const children = new Map<number, ProcRow[]>();
  for (const r of table) { const l = children.get(r.ppid) ?? []; l.push(r); children.set(r.ppid, l); }
  const out = new Map<number, string>();
  const visit = (pid: number, after: number, depth: number): void => {
    if (depth > 16) return;
    for (const c of children.get(pid) ?? []) {
      if (c.pid === selfPid || out.has(c.pid) || !(c.createdMs >= after - 2_000)) continue;   // PID-reuse guard
      out.set(c.pid, c.name);
      visit(c.pid, c.createdMs, depth + 1);
    }
  };
  for (const rec of recorded) {
    const at = parseCreatedAt(rec.createdAt);
    if (!Number.isFinite(at)) continue;
    const live = byPid.get(rec.pid);
    if (live && !sameProcessStart(live.createdMs, at)) continue;      // pid reused by an unrelated process: not ours, nor its children
    if (live) out.set(live.pid, live.name);
    visit(rec.pid, at, 0);                 // children of a dead (or live) recorded process
  }
  out.delete(selfPid);
  return [...out].map(([pid, name]) => ({ pid, name }));
}

/** Every process (pid, parent, name, creation time): one Get-CimInstance call (≈ 0.5–1 s, only after a crash). */
export async function processTable(timeoutMs = 20_000): Promise<ProcRow[]> {
  const script = [
    '$r = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
    "  $ft = if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { '' }",
    '  [pscustomobject]@{ p = [int]$_.ProcessId; q = [int]$_.ParentProcessId; n = [string]$_.Name; f = $ft } })',
    'ConvertTo-Json -InputObject $r -Compress',
  ].join('\n');
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const r = await execHidden(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { timeoutMs, maxBytes: 32 * 1024 * 1024 });
  if (r.code !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(r.stdout.trim() || '[]');
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { p?: unknown; q?: unknown; n?: unknown; f?: unknown }[];
    return rows.filter((x) => x && typeof x.p === 'number' && typeof x.f === 'string' && /^\d+$/.test(x.f))
      .map((x) => ({ pid: x.p as number, ppid: typeof x.q === 'number' ? x.q : 0, name: String(x.n ?? ''), createdMs: fileTimeToMs(x.f as string) }));
  } catch { return []; }
}

export async function listOrphans(recorded: { pid: number; createdAt: string }[]): Promise<{ pid: number; name: string }[]> {
  if (!recorded.length) return [];
  return findOrphans(recorded, await processTable());
}

/** Kills each tree (taskkill /T /F, absolute path). Only called with pids from the last `orphans` list (commands.ts). */
export async function killPids(pids: number[]): Promise<void> {
  await Promise.all(pids.filter((p) => Number.isSafeInteger(p) && p > 0 && p !== process.pid).map((p) => treeKill(p)));
}
