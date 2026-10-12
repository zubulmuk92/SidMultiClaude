// src/server/claude/registry.ts — LiveRegistry: sessions\<pid>.json (never *.key), pid+procStart liveness.
// Every Claude Code process writes `<cfg>\sessions\<pid>.json` ~1 s after start and deletes it at exit; a crash
// leaves a stale file. A holder is live iff its pid is alive (process.kill(pid, 0)) AND either its creation time matches
// the recorded `procStart` (Windows FILETIME, looked up once per pid with one CIM query and cached) or `updatedAt` is
// < 60 s old (used while the creation time is unknown). The engine's own pids are excluded. Only `<digits>.json` names
// are ever opened: the sibling `<pid>.<sha256>.key` (messaging-pipe secret) is never read (S10).
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../../shared/protocol.ts';
import type { AccountStore, LiveRegistry, Logger } from '../contracts.ts';
import { realpathNative } from '../util/paths.ts';
import { fileTimeToMs, isPidAlive, processInfo, sameProcessStart } from '../util/winproc.ts';
import { REGISTRY_FRESH_MS } from '../../shared/limits.ts';
import { watchDir } from './watch.ts';
import type { DirWatcher } from './watch.ts';

const PID_FILE_RE = /^(\d{1,10})\.json$/;
const MAX_FILE_BYTES = 256 * 1024;
const LOOKUP_RETRY_MS = 30_000;
const STATUSES = new Set(['busy', 'idle', 'waiting', 'blocked']);

type Rec = { pid: number; sessionId: string; kind: string; entrypoint: string; status: P.ExternalHolder['status']; procStartMs?: number; updatedAt: number };
type Acc = { id: P.AccountId; dir: string | null; recs: Map<number, Rec>; watcher: DirWatcher | null };

export type LiveRegistryDeps = {
  accounts: AccountStore; log: Logger;
  /** Tests: pid → creation time (epoch ms). Default: one CIM query (util/winproc processInfo). */
  procStart?: (pids: number[]) => Promise<Map<number, number>>;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
};

export function parseRegistryFile(text: string, pidFromName: number): Rec | null {
  let o: Record<string, unknown>;
  try { const x = JSON.parse(text) as unknown; if (!x || typeof x !== 'object' || Array.isArray(x)) return null; o = x as Record<string, unknown>; } catch { return null; }
  const pid = typeof o['pid'] === 'number' ? o['pid'] : pidFromName;
  if (pid !== pidFromName || typeof o['sessionId'] !== 'string' || !o['sessionId']) return null;
  let procStartMs: number | undefined;
  const ps = o['procStart'];
  if (typeof ps === 'string' && /^\d{15,20}$/.test(ps)) procStartMs = fileTimeToMs(ps);
  else if (typeof ps === 'number' && Number.isFinite(ps) && ps > 1e15) procStartMs = fileTimeToMs(BigInt(Math.trunc(ps)));
  const upd = typeof o['updatedAt'] === 'number' ? o['updatedAt'] : typeof o['statusUpdatedAt'] === 'number' ? o['statusUpdatedAt'] : typeof o['startedAt'] === 'number' ? o['startedAt'] : 0;
  const st = String(o['status'] ?? 'idle');
  return {
    pid, sessionId: o['sessionId'].toLowerCase(), kind: String(o['kind'] ?? 'interactive'), entrypoint: String(o['entrypoint'] ?? 'cli'),
    status: (STATUSES.has(st) ? st : 'idle') as Rec['status'], updatedAt: upd, ...(procStartMs !== undefined ? { procStartMs } : {}),
  };
}

export function createLiveRegistry(d: LiveRegistryDeps): LiveRegistry & { close(): void; refresh(accountId?: P.AccountId): Promise<void> } {
  const accs = new Map<P.AccountId, Acc>();
  const listeners = new Set<(accountId: P.AccountId, sessionId: P.SessionId, h: P.ExternalHolder | null) => void>();
  const created = new Map<number, number | null>();      // pid → creation time (null = not found = dead)
  const pending = new Set<number>();
  const retryAt = new Map<number, number>();              // pid → earliest next lookup after a failed one
  let own: ReadonlySet<number> = new Set();
  let closed = false;
  let offAccounts: (() => void) | null = null;
  const now = d.now ?? Date.now;
  const alive = d.isAlive ?? isPidAlive;
  const lookup = d.procStart ?? (async (pids: number[]) => {
    const m = await processInfo(pids);
    return new Map([...m].map(([pid, i]) => [pid, i.createdMs]));
  });

  function liveRec(r: Rec): boolean {
    if (own.has(r.pid) || !alive(r.pid)) return false;
    const c = created.get(r.pid);
    if (r.procStartMs !== undefined && c !== undefined) return c !== null && sameProcessStart(c, r.procStartMs);
    return now() - r.updatedAt < REGISTRY_FRESH_MS;
  }
  function holderOf(a: Acc, sessionId: string): P.ExternalHolder | null {
    let best: Rec | null = null;
    for (const r of a.recs.values()) if (r.sessionId === sessionId && liveRec(r) && (!best || r.updatedAt > best.updatedAt)) best = r;
    return best ? { pid: best.pid, kind: best.kind, entrypoint: best.entrypoint, status: best.status } : null;
  }
  const sig = (h: P.ExternalHolder | null): string => (h ? `${h.pid}|${h.status}|${h.kind}` : '');
  function emitDiff(a: Acc, sessions: Iterable<string>, before: Map<string, string>): void {
    for (const sid of sessions) {
      const h = holderOf(a, sid);
      if (sig(h) === (before.get(sid) ?? '')) continue;
      for (const cb of listeners) { try { cb(a.id, sid, h); } catch (e) { d.log.warn('registry: listener failed', { err: e }); } }
    }
  }
  const snapshot = (a: Acc, sessions: Iterable<string>): Map<string, string> => new Map([...sessions].map((s) => [s, sig(holderOf(a, s))]));

  async function readOne(a: Acc, name: string): Promise<Rec | null> {
    const m = PID_FILE_RE.exec(name);
    if (!m || !a.dir) return null;                             // never anything but <digits>.json (no *.key)
    const file = path.join(a.dir, name);
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      return parseRegistryFile(await fs.promises.readFile(file, 'utf8'), Number(m[1]));
    } catch { return null; }
  }
  async function verify(a: Acc, pids: number[]): Promise<void> {
    const t = now();
    const want = pids.filter((p) => !created.has(p) && !pending.has(p) && (retryAt.get(p) ?? 0) <= t && alive(p));
    if (!want.length) return;
    for (const p of want) pending.add(p);
    const sessions = new Set([...a.recs.values()].filter((r) => want.includes(r.pid)).map((r) => r.sessionId));
    const before = snapshot(a, sessions);
    let found = new Map<number, number>();
    try { found = await lookup(want); } catch (e) { d.log.warn('registry: creation-time lookup failed', { err: e }); }
    for (const p of want) {
      pending.delete(p);
      const c = found.get(p);
      if (c !== undefined) { created.set(p, c); retryAt.delete(p); }
      else if (!alive(p)) created.set(p, null);              // exited meanwhile
      // Still alive but not in the answer: the query failed (PowerShell slow or blocked). Never cache that as « dead »:
      // the creation time stays unknown (liveness falls back to a fresh updatedAt) and is asked again later.
      else retryAt.set(p, now() + LOOKUP_RETRY_MS);
    }
    if (!closed) emitDiff(a, sessions, before);
  }
  async function scanAcc(a: Acc): Promise<void> {
    resolveDir(a);
    const names: string[] = [];
    if (a.dir) { try { for (const n of await fs.promises.readdir(a.dir)) if (PID_FILE_RE.test(n)) names.push(n); } catch { /* gone */ } }
    const recs = (await Promise.all(names.map((n) => readOne(a, n)))).filter((r): r is Rec => !!r);
    const sessions = new Set([...a.recs.values(), ...recs].map((r) => r.sessionId));
    const before = snapshot(a, sessions);
    for (const pid of a.recs.keys()) if (!recs.some((r) => r.pid === pid)) { created.delete(pid); retryAt.delete(pid); }
    a.recs = new Map(recs.map((r) => [r.pid, r]));
    emitDiff(a, sessions, before);
    ensureWatch(a);
    await verify(a, recs.filter((r) => r.procStartMs !== undefined).map((r) => r.pid));
  }
  async function onFile(a: Acc, name: string): Promise<void> {
    const m = PID_FILE_RE.exec(name);
    if (!m) return;
    const pid = Number(m[1]);
    const rec = await readOne(a, name);
    const old = a.recs.get(pid);
    const sessions = new Set([old?.sessionId, rec?.sessionId].filter((s): s is string => !!s));
    const before = snapshot(a, sessions);
    if (!rec || (old && old.procStartMs !== rec.procStartMs)) { created.delete(pid); retryAt.delete(pid); }
    if (rec) a.recs.set(pid, rec); else a.recs.delete(pid);
    emitDiff(a, sessions, before);
    if (rec?.procStartMs !== undefined) await verify(a, [pid]);
  }
  function resolveDir(a: Acc): void {
    try { const p = realpathNative(d.accounts.paths(a.id).sessionsDir); a.dir = fs.statSync(p).isDirectory() ? p : null; } catch { a.dir = null; }
  }
  function ensureWatch(a: Acc): void {
    if (closed || (a.watcher && !a.watcher.closed)) return;
    try {
      if (a.dir) {
        a.watcher = watchDir(a.dir, { recursive: false, filter: (n) => n === null || PID_FILE_RE.test(n), log: d.log, onError: () => { a.watcher = null; } },
          (n) => { void (n === null ? scanAcc(a) : onFile(a, n)).catch((e: unknown) => d.log.warn('registry: refresh failed', { err: e })); });
      } else {
        const home = realpathNative(d.accounts.paths(a.id).configHome);  // wait for <cfg>\sessions to appear
        a.watcher = watchDir(home, { recursive: false, filter: (n) => n === null || n.toLowerCase() === 'sessions', log: d.log, onError: () => { a.watcher = null; } },
          () => { a.watcher?.close(); a.watcher = null; void scanAcc(a).catch(() => undefined); });
      }
    } catch (e) { a.watcher = null; d.log.warn('registry: cannot watch', { account: a.id, err: e }); }
  }
  function register(id: P.AccountId): Acc {
    let a = accs.get(id);
    if (!a) { a = { id, dir: null, recs: new Map(), watcher: null }; accs.set(id, a); }
    return a;
  }

  return {
    start() {
      closed = false;
      for (const v of d.accounts.list()) void scanAcc(register(v.id)).catch((e: unknown) => d.log.warn('registry: scan failed', { err: e }));
      offAccounts ??= d.accounts.onChange((id) => {               // subscribed once, released by close()
        if (closed || accs.has(id) || !d.accounts.get(id)) return;
        void scanAcc(register(id)).catch(() => undefined);
      });
    },
    holder(accountId, sessionId) {
      const a = accs.get(accountId);
      return a ? holderOf(a, sessionId.toLowerCase()) : null;
    },
    setOwnPids(pids) {
      const all = [...accs.values()].map((a) => ({ a, s: new Set([...a.recs.values()].map((r) => r.sessionId)) }));
      const before = all.map(({ a, s }) => snapshot(a, s));
      own = new Set(pids);
      all.forEach(({ a, s }, i) => emitDiff(a, s, before[i]!));
    },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    close() { closed = true; offAccounts?.(); offAccounts = null; for (const a of accs.values()) { a.watcher?.close(); a.watcher = null; } },
    async refresh(accountId) {
      const ids = accountId ? [accountId] : d.accounts.list().map((v) => v.id);
      await Promise.all(ids.map((id) => scanAcc(register(id))));
    },
  };
}
