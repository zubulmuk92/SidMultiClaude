// src/server/engine/spawner.ts — jobrun/plain spawner, PID registry (run\children.json), hard kill (SPEC §2.11).
// spawn(isolation === 'job' ? JOBRUN : o.command, …) with pipes, windowsHide, NO shell and NO `signal` (Node would call
// TerminateProcess on claude.exe alone). The SDK's forwarded abort (stdin EOF + ~2 s grace) and q.close() both land on
// our hard kill: TerminateProcess(jobrun) (the Job Object kills the whole tree) or taskkill /T /F (plain).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { Logger, SpawnerFactory } from '../contracts.ts';
import { treeKill } from '../util/winproc.ts';
import { fsGuard } from '../util/fs-guard.ts';
import type { FsGuard } from '../util/fs-guard.ts';

export type ChildRole = 'jobrun' | 'cli';
export type ChildRecord = { pid: number; createdAt: string; createdMs: number; chatId: string; role: ChildRole; hostPid: number };
/** What the engine reads back from a spawned child (extra fields on the ChildProcess object). */
export type SpawnTag = { smcIsolation: 'job' | 'plain'; smcFallback: boolean; smcHostPid: number | undefined };
export interface SpawnerExtras {
  /** Every live jobrun + CLI pid we started (LiveRegistry exclusion). */
  ownPids(): ReadonlySet<number>;
  /** The CLI pid behind a host pid (jobrun mode: known only from initializationResult().pid). */
  noteCliPid(chatId: string, hostPid: number, cliPid: number): void;
  records(): ChildRecord[];
}

/** `fs`: the write guard (SPEC §10 S11). Default: the app-wide guard once main.ts configured it; plain node:fs only where no
 *  guard exists (tests, scripts/contract.ts, scripts/smoke.ts write their registry under a scratch dir). */
export const createSpawner: (o: { jobrunPath: string | null; registryFile: string; log: Logger; fs?: FsGuard }) => SpawnerFactory & SpawnerExtras = (o) => {
  const recs = new Map<number, ChildRecord>();
  const jobrun = o.jobrunPath && fs.existsSync(o.jobrunPath) ? o.jobrunPath : null;
  if (o.jobrunPath && !jobrun) o.log.warn('spawner: jobrun.exe not found, plain isolation only', { jobrunPath: o.jobrunPath });
  const writer = (): Pick<FsGuard, 'mkdirSync' | 'writeFileSync' | 'renameSync'> => {
    if (o.fs) return o.fs;
    try { return fsGuard(); } catch { return fs; }            // not configured (tests, scripts): no guard to go through
  };

  function persist(): void {
    try {
      const w = writer();
      w.mkdirSync(path.dirname(o.registryFile), { recursive: true });
      const tmp = `${o.registryFile}.${process.pid}.tmp`;
      w.writeFileSync(tmp, JSON.stringify([...recs.values()], null, 1));
      w.renameSync(tmp, o.registryFile);
    } catch (e) { o.log.warn('spawner: children.json write failed', { err: String(e) }); }
  }
  function add(pid: number, chatId: string, role: ChildRole, hostPid: number, createdMs = Date.now()): void {
    const now = createdMs;
    recs.set(pid, { pid, createdAt: new Date(now).toISOString(), createdMs: now, chatId, role, hostPid });
    persist();
  }
  function removeHost(hostPid: number): void {
    let changed = false;
    for (const [pid, r] of recs) if (r.hostPid === hostPid) { recs.delete(pid); changed = true; }
    if (changed) persist();
  }

  function rawSpawn(cmd: string, args: readonly string[], so: SpawnOptions): ChildProcess {
    return spawn(cmd, [...args], { cwd: so.cwd, env: so.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }

  const factory: SpawnerFactory = (chatId, isolation) => (so) => {
    let mode: 'job' | 'plain' = isolation === 'job' && jobrun ? 'job' : 'plain';
    let fallback = isolation === 'job' && !jobrun;
    let child: ChildProcess | null = null;
    if (mode === 'job') {
      try { child = rawSpawn(jobrun!, [so.command, ...so.args], so); } catch (e) { o.log.warn('spawner: jobrun spawn threw, plain fallback', { chatId, err: String(e) }); }
    } else child = rawSpawn(so.command, so.args, so);
    if (mode === 'job' && (child === null || child.pid === undefined)) {   // jobrun could not start: this chat retries once in plain mode
      child?.once('error', (e) => o.log.warn('spawner: jobrun spawn failed, plain fallback', { chatId, err: String(e) }));
      mode = 'plain';
      fallback = true;
      child = rawSpawn(so.command, so.args, so);
    }
    const proc: ChildProcess = child ?? rawSpawn(so.command, so.args, so);
    const pid = proc.pid;
    if (pid !== undefined) add(pid, chatId, mode === 'job' ? 'jobrun' : 'cli', pid);
    const origKill = proc.kill.bind(proc);
    const hardKill = (): void => {
      if (pid === undefined) return;
      if (mode === 'job') origKill();                            // TerminateProcess(jobrun): its job handle closes, the tree dies
      else void treeKill(pid);                                   // taskkill /PID <pid> /T /F (absolute System32 path)
    };
    const kill = (): boolean => { if (proc.exitCode === null && proc.signalCode === null) hardKill(); return true; };
    so.signal?.addEventListener('abort', kill, { once: true });
    proc.kill = kill;
    proc.once('exit', () => { if (pid !== undefined) removeHost(pid); });
    proc.once('error', (e) => o.log.warn('spawner: child error', { chatId, err: String(e) }));
    const tag: SpawnTag = { smcIsolation: mode, smcFallback: fallback, smcHostPid: pid };
    Object.assign(proc, tag);
    return proc as unknown as SpawnedProcess;
  };

  return Object.assign(factory, {
    ownPids: (): ReadonlySet<number> => new Set(recs.keys()),
    noteCliPid(chatId: string, hostPid: number, cliPid: number): void {
      if (cliPid === hostPid || recs.has(cliPid) || !recs.has(hostPid)) return;
      add(cliPid, chatId, 'cli', hostPid, recs.get(hostPid)!.createdMs);   // the CLI starts ≈ 40 ms after jobrun: its start time, not init time
    },
    records: (): ChildRecord[] => [...recs.values()],
  });
};
