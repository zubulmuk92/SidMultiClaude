// src/server/claude/session-index.ts — SessionIndex: cache\index-<acc>.json, stat pass, incremental refresh.
// SPEC §5.5: per account a stat pass over realpathNative(<cfg>\projects)\*\*.jsonl; the cache is keyed by
// (mtimeMs, size, birthtimeMs); a changed file is re-read through the SDK head/tail 64 KiB algorithm (headtail.ts).
// One recursive watcher per account (300 ms debounce per path, `null` filename → rescan). No periodic timer: reconcile()
// runs on window focus. Live app chats (setLive) only get mtimeMs/size refreshed: the orchestrator owns their live state.
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../../shared/protocol.ts';
import type { AccountStore, Clock, Logger, SessionIndex, SessionMeta } from '../contracts.ts';
import { makeChatId, UUID_RE } from '../util/ids.ts';
import { realpathNative } from '../util/paths.ts';
import { encodeEnvelope, loadVersioned } from '../util/json-store.ts';
import { fsGuard } from '../util/fs-guard.ts';
import type { FsGuard } from '../util/fs-guard.ts';
import { INDEX_TEXT_MAX_CHARS, META_DEBOUNCE_MS } from '../../shared/limits.ts';
import { cut, readFileMeta } from './headtail.ts';
import { watchDir } from './watch.ts';
import type { DirWatcher } from './watch.ts';

const CACHE_VERSION = 1;
const READ_CONCURRENCY = 16;
const JSONL_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const SIDECAR_RE = /^([^\\/]+)[\\/]([0-9a-f-]{36})[\\/]custom-title\.json$/i;
const FILE_RE = /^([^\\/]+)[\\/]([^\\/]+\.jsonl)$/i;

/** One cached file: its stat signature and either its meta or `skip` (sidechain head / no messages). */
type Slot = { mtimeMs: number; size: number; birthtimeMs: number; meta?: SessionMeta; skip?: true };
type CacheData = { files: Record<string, Slot> };
type Acc = {
  id: P.AccountId; projects: string | null; slots: Map<string, Slot>;
  watcher: DirWatcher | null; queue: Promise<void>; saveTimer: { cancel(): void } | null; dirty: boolean; primed: boolean;
};
type Stat = { file: string; sessionId: string; mtimeMs: number; size: number; birthtimeMs: number };

export function originOf(entrypoint: string | undefined): P.Origin {
  if (entrypoint === 'cli') return 'cli';
  if (entrypoint === 'sdk-ts') return 'app';
  if (entrypoint === 'claude-desktop' || entrypoint === 'claude-desktop-3p') return 'desktop';
  return 'other';
}
const sameSig = (s: Slot | undefined, st: Stat): boolean =>
  !!s && s.mtimeMs === st.mtimeMs && s.size === st.size && s.birthtimeMs === st.birthtimeMs;

async function mapLimit<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** readdir + stat of <projects>\*\<uuid>.jsonl (no content read). */
export async function statPass(projects: string): Promise<Stat[]> {
  let dirs: fs.Dirent[];
  try { dirs = await fs.promises.readdir(projects, { withFileTypes: true }); } catch { return []; }
  const lists = await mapLimit(dirs.filter((x) => x.isDirectory()), READ_CONCURRENCY, async (dir) => {
    const base = path.join(projects, dir.name);
    let names: string[];
    try { names = await fs.promises.readdir(base); } catch { return []; }
    const files = names.map((n) => JSONL_RE.exec(n)).filter((m): m is RegExpExecArray => !!m);
    const stats = await Promise.all(files.map(async (m): Promise<Stat | null> => {
      const file = path.join(base, m[0]);
      try {
        const st = await fs.promises.stat(file);
        return st.isFile() ? { file, sessionId: m[1]!, mtimeMs: st.mtimeMs, size: st.size, birthtimeMs: st.birthtimeMs } : null;
      } catch { return null; }
    }));
    return stats.filter((s): s is Stat => !!s);
  });
  return lists.flat();
}

export async function buildMeta(accountId: P.AccountId, st: Stat): Promise<SessionMeta | null> {
  const m = await readFileMeta(st.file, st.sessionId);
  if (!m) return null;
  const meta: SessionMeta = {
    accountId, sessionId: st.sessionId, chatId: makeChatId(accountId, st.sessionId), path: st.file, cwd: m.cwd ?? '',
    title: cut(m.title, INDEX_TEXT_MAX_CHARS), titleSource: m.titleSource, origin: originOf(m.entrypoint),
    createdAt: m.createdAt ?? (st.birthtimeMs || st.mtimeMs), updatedAt: m.updatedAt ?? st.mtimeMs,
    mtimeMs: st.mtimeMs, size: st.size,
  };
  if (m.firstPrompt) meta.firstPrompt = cut(m.firstPrompt, INDEX_TEXT_MAX_CHARS);
  if (m.gitBranch) meta.branch = m.gitBranch;
  if (m.entrypoint) meta.entrypoint = m.entrypoint;
  if (m.model) meta.model = m.model;
  if (m.lastMode) meta.lastMode = m.lastMode;
  if (m.lastContext !== undefined) meta.lastContext = m.lastContext;
  if (m.lastRequestAt !== undefined) meta.lastRequestAt = m.lastRequestAt;
  if (m.costUsd !== undefined) meta.costUsd = m.costUsd;
  if (m.ownerAccountUuid) meta.ownerAccountUuid = m.ownerAccountUuid;
  if (m.lastError) meta.lastError = { ...m.lastError };
  return meta;
}

const validSlot = (x: unknown): x is Slot => {
  const s = x as Slot | null;
  return !!s && typeof s === 'object' && typeof s.mtimeMs === 'number' && typeof s.size === 'number' && typeof s.birthtimeMs === 'number'
    && (s.skip === true || (!!s.meta && typeof s.meta === 'object' && typeof s.meta.sessionId === 'string' && typeof s.meta.title === 'string'));
};

export type SessionIndexDeps = { accounts: AccountStore; cacheDir: string; log: Logger; clock: Clock; guard?: FsGuard };
export type SessionIndexExt = SessionIndex & {
  /** Chats with a live app process: watcher events only refresh their mtimeMs/size (the orchestrator owns the rest). */
  setLive(chatIds: ReadonlySet<P.ChatId>): void;
  /** Writes pending cache files now and closes the watchers (shutdown, tests). */
  close(): Promise<void>;
};

export function createSessionIndex(d: SessionIndexDeps): SessionIndexExt {
  const guard = (): FsGuard => d.guard ?? fsGuard();
  const accs = new Map<P.AccountId, Acc>();
  const byChat = new Map<P.ChatId, SessionMeta>();
  const listeners = new Set<(upsert: SessionMeta[], removed: P.ChatId[]) => void>();
  let live: ReadonlySet<P.ChatId> = new Set();
  let started = false;
  let closed = false;
  let offAccounts: (() => void) | null = null;

  const cacheFile = (id: P.AccountId): string => path.join(d.cacheDir, `index-${id}.json`);
  const emit = (up: SessionMeta[], rm: P.ChatId[]): void => {
    if (!up.length && !rm.length) return;
    for (const cb of listeners) { try { cb(up, rm); } catch (e) { d.log.warn('index: listener failed', { err: e }); } }
  };
  const enqueue = (a: Acc, fn: () => Promise<void>): Promise<void> => {
    const p = a.queue.then(fn).catch((e: unknown) => d.log.warn('index: task failed', { account: a.id, err: e }));
    a.queue = p;
    return p;
  };

  async function save(a: Acc): Promise<void> {
    a.saveTimer?.cancel(); a.saveTimer = null;
    if (!a.dirty) return;
    a.dirty = false;
    const files: Record<string, Slot> = {};
    for (const [k, s] of a.slots) files[k] = s;
    try { await guard().mkdir(d.cacheDir, { recursive: true }); await guard().writeFileAtomic(cacheFile(a.id), encodeEnvelope(CACHE_VERSION, { files }), { backup: false }); }
    catch (e) { d.log.warn('index: cache write failed', { account: a.id, err: e }); }
  }
  const scheduleSave = (a: Acc): void => {
    a.dirty = true;
    if (a.saveTimer || closed) return;
    a.saveTimer = d.clock.timer(META_DEBOUNCE_MS, () => { a.saveTimer = null; void save(a); });
  };

  /** Recomputes the winner of each touched chatId (two files with one session id: the newest wins) and emits. */
  function settle(a: Acc, touched: Set<string>): void {
    const up: SessionMeta[] = [];
    const rm: P.ChatId[] = [];
    for (const sid of touched) {
      const chatId = makeChatId(a.id, sid);
      let best: SessionMeta | undefined;
      for (const s of a.slots.values()) if (s.meta?.sessionId === sid && (!best || s.meta.mtimeMs > best.mtimeMs)) best = s.meta;
      const prev = byChat.get(chatId);
      if (best) { if (prev !== best) { byChat.set(chatId, best); up.push(best); } }
      else if (prev) { byChat.delete(chatId); rm.push(chatId); }
    }
    if (up.length || rm.length) scheduleSave(a);
    if (started) emit(up, rm);
  }

  /** Applies one stat result to its slot; returns true when the slot changed. */
  async function apply(a: Acc, st: Stat, force = false): Promise<boolean> {
    const old = a.slots.get(st.file);
    if (!force && sameSig(old, st)) return false;
    const chatId = makeChatId(a.id, st.sessionId);
    if (old?.meta && live.has(chatId)) {
      a.slots.set(st.file, { ...st, meta: { ...old.meta, mtimeMs: st.mtimeMs, size: st.size } });
      return true;
    }
    const meta = await buildMeta(a.id, st);
    a.slots.set(st.file, meta ? { mtimeMs: st.mtimeMs, size: st.size, birthtimeMs: st.birthtimeMs, meta } : { mtimeMs: st.mtimeMs, size: st.size, birthtimeMs: st.birthtimeMs, skip: true });
    scheduleSave(a);
    return true;
  }

  async function scan(a: Acc): Promise<void> {
    resolveProjects(a);
    const stats = a.projects ? await statPass(a.projects) : [];
    const touched = new Set<string>();
    const seen = new Set<string>();
    const changed = stats.filter((st) => { seen.add(st.file); return !sameSig(a.slots.get(st.file), st); });
    await mapLimit(changed, READ_CONCURRENCY, async (st) => { if (await apply(a, st)) touched.add(st.sessionId); });
    for (const [file, s] of [...a.slots]) {
      if (seen.has(file)) continue;
      a.slots.delete(file);
      scheduleSave(a);
      if (s.meta) touched.add(s.meta.sessionId);
    }
    if (!a.primed) { a.primed = true; for (const s of a.slots.values()) if (s.meta) touched.add(s.meta.sessionId); }
    settle(a, touched);
    ensureWatch(a);
  }

  async function refreshFile(a: Acc, file: string, force = false): Promise<void> {
    const m = JSONL_RE.exec(path.basename(file));
    if (!m) return;
    let st: Stat | null = null;
    try { const s = await fs.promises.stat(file); if (s.isFile()) st = { file, sessionId: m[1]!, mtimeMs: s.mtimeMs, size: s.size, birthtimeMs: s.birthtimeMs }; } catch { /* gone */ }
    if (!st) {
      const old = a.slots.get(file);
      if (!old) return;
      a.slots.delete(file);
      scheduleSave(a);
      if (old.meta) settle(a, new Set([old.meta.sessionId]));
      return;
    }
    if (await apply(a, st, force)) settle(a, new Set([st.sessionId]));
  }

  function resolveProjects(a: Acc): void {
    try {
      const p = realpathNative(d.accounts.paths(a.id).projectsDir);
      if (fs.statSync(p).isDirectory()) a.projects = p;
    } catch { a.projects = null; }
    if (!a.projects && a.watcher) { a.watcher.close(); a.watcher = null; }
  }
  function ensureWatch(a: Acc): void {
    if (closed || !a.projects || (a.watcher && !a.watcher.closed)) return;
    try {
      a.watcher = watchDir(a.projects, { recursive: true, clock: d.clock, log: d.log, onError: () => { a.watcher = null; } }, (name) => onWatch(a, name));
    } catch (e) { a.watcher = null; d.log.warn('index: cannot watch projects', { account: a.id, err: e }); }
  }
  function onWatch(a: Acc, name: string | null): void {
    if (closed || !a.projects) return;
    if (name === null) { void enqueue(a, () => scan(a)); return; }
    const f = FILE_RE.exec(name);
    if (f) { const file = path.join(a.projects, f[1]!, f[2]!); void enqueue(a, () => refreshFile(a, file)); return; }
    const s = SIDECAR_RE.exec(name);
    if (s) { const file = path.join(a.projects, s[1]!, `${s[2]!.toLowerCase()}.jsonl`); void enqueue(a, () => refreshFile(a, file, true)); return; }
    // a project folder appeared, vanished or was renamed; deeper names (subagents\, tool-results\, *.tmp) never rescan
    if (!/[\\/]/.test(name)) void enqueue(a, () => scan(a));
  }
  function register(id: P.AccountId): Acc {
    let a = accs.get(id);
    if (a) return a;
    a = { id, projects: null, slots: new Map(), watcher: null, queue: Promise.resolve(), saveTimer: null, dirty: false, primed: false };
    accs.set(id, a);
    const cached = loadVersioned<CacheData>({
      file: cacheFile(id), version: CACHE_VERSION, defaults: () => ({ files: {} }),
      accept: (x) => (x && typeof x === 'object' && (x as CacheData).files && typeof (x as CacheData).files === 'object' ? (x as CacheData) : undefined),
    }).data;
    for (const [file, s] of Object.entries(cached.files)) {
      if (!validSlot(s)) continue;
      if (s.meta && (s.meta.accountId !== id || s.meta.path !== file || !UUID_RE.test(s.meta.sessionId))) continue;
      a.slots.set(file, s);
    }
    resolveProjects(a);
    return a;
  }

  const index: SessionIndexExt = {
    async start() {
      closed = false;
      const ids = d.accounts.list().map((v) => v.id);
      await Promise.all(ids.map((id) => { const a = register(id); return enqueue(a, () => scan(a)); }));
      started = true;
      offAccounts ??= d.accounts.onChange((id) => {               // subscribed once, released by close()
        if (closed || accs.has(id) || !d.accounts.get(id)) return;
        const a = register(id);
        void enqueue(a, () => scan(a));
      });
    },
    list(accountId) {
      const out: SessionMeta[] = [];
      for (const m of byChat.values()) if (!accountId || m.accountId === accountId) out.push(m);
      return out.sort((x, y) => y.updatedAt - x.updatedAt);
    },
    get(chatId) { return byChat.get(chatId); },
    async reconcile(accountId) {
      const ids = accountId ? [accountId] : d.accounts.list().map((v) => v.id);
      await Promise.all(ids.filter((id) => d.accounts.get(id)).map((id) => { const a = register(id); return enqueue(a, () => scan(a)); }));
    },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    setLive(chatIds) {
      const ended = [...live].filter((c) => !chatIds.has(c));
      live = new Set(chatIds);
      for (const c of ended) {                                 // no longer live: re-read what the process wrote meanwhile
        const m = byChat.get(c);
        const a = m ? accs.get(m.accountId) : undefined;
        if (m && a) void enqueue(a, () => refreshFile(a, m.path, true));
      }
    },
    async close() {
      closed = true;
      offAccounts?.();
      offAccounts = null;
      for (const a of accs.values()) { a.watcher?.close(); a.watcher = null; }
      await Promise.all([...accs.values()].map(async (a) => { await a.queue; await save(a); }));
    },
  };
  return index;
}
