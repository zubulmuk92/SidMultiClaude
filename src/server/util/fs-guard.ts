// src/server/util/fs-guard.ts — THE ONLY fs write API of the app (SPEC §7.2, §10 S11).
// Every app write (json-store, log, drafts, run files, caches) goes through a guard:
// - allow-list: the target must lie inside one of `allowRoots` (the app data dir; tests add their temp roots);
// - deny-list (wins): anything inside a Claude profile — <home>\.claude, <home>\.claude-*, <home>\.claude.json*, and every
//   configured account configDir — is refused, whatever the allow-list says;
// - the check runs on the canonical path (8.3 names expanded, junctions resolved, case-insensitive) AND on the lexical path,
//   each also in its Win32 form (trailing dots/spaces of every component dropped: `.claude.` and `.claude ` name `.claude`
//   for any API that does not use \\?\ paths); alternate data streams (`x:stream`) are refused outright.
// The single exemption is createProfileDir(): an EMPTY new <home>\.claude-<slug> folder the user asked for (login flow).
// Reads are not guarded here (node:fs directly), but `*.key` and `.credentials.json` are never opened (stat only, S10).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalPath, isInside, pathKey, DEFAULT_GLOBAL_CONFIG_RE, PROFILE_DIR_NAME_RE } from './paths.ts';

export class FsGuardError extends Error {
  readonly code = 'EGUARD';
  readonly target: string;
  constructor(message: string, target: string) {
    super(`${message}: ${target}`);
    this.name = 'FsGuardError';
    this.target = target;
  }
}

export type FsGuardConfig = {
  allowRoots: readonly string[];               // writes must land inside one of these (canonicalised once)
  home: string;                                // real home: its .claude, .claude-* and .claude.json* are always refused
  profileDirs?: () => readonly string[];       // configured account configDirs (any location), read at each check
};
export type WriteData = string | Uint8Array;
export type AtomicOptions = {
  backup?: boolean;                            // keep the previous version as <file>.bak (default true)
  /**
   * Async writes only: called synchronously right before each commit attempt (.bak + rename, done in one synchronous
   * block). Returning false drops the prepared temp file instead: a newer version was committed meanwhile (json-store's
   * flushSync during an in-flight flush), and an older one must never replace it.
   */
  shouldCommit?: () => boolean;
};

export interface FsGuard {
  /** Canonical target path, or throws FsGuardError. Pure check: no write, only realpath lookups. */
  check(target: string): string;
  isAllowed(target: string): boolean;
  writeFile(p: string, data: WriteData): Promise<void>;
  writeFileSync(p: string, data: WriteData): void;
  appendFile(p: string, data: WriteData): Promise<void>;
  appendFileSync(p: string, data: WriteData): void;
  /** Opens a file for appending and returns the fd (logger). The caller writes with fs.writeSync and closes it. */
  openAppendSync(p: string): number;
  mkdir(p: string, o?: { recursive?: boolean }): Promise<void>;
  mkdirSync(p: string, o?: { recursive?: boolean }): void;
  rename(from: string, to: string): Promise<void>;
  renameSync(from: string, to: string): void;
  copyFile(from: string, to: string): Promise<void>;
  copyFileSync(from: string, to: string): void;
  rm(p: string, o?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rmSync(p: string, o?: { recursive?: boolean; force?: boolean }): void;
  /**
   * tmp file + fsync (async), then the commit: the previous version becomes <p>.bak and the tmp file replaces <p>, both in
   * ONE synchronous block (metadata operations, sub-millisecond), so no other write of the same file in this process can
   * interleave between the shouldCommit() check and the rename. Windows sharing errors retry the commit after async waits.
   */
  writeFileAtomic(p: string, data: WriteData, o?: AtomicOptions): Promise<void>;
  writeFileAtomicSync(p: string, data: WriteData, o?: AtomicOptions): void;
  /** The one profile exemption: creates the EMPTY folder <home>\.claude-<slug> (must not exist yet). */
  createProfileDir(dir: string): Promise<string>;
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const RETRY_DELAYS_MS = [10, 20, 40, 80, 120, 160, 200, 250, 300];
const PROFILE_SLUG_RE = /^\.claude-[a-z0-9](?:[a-z0-9._-]{0,39}[a-z0-9_-])?$/i;   // no trailing dot (Win32 would drop it)

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const errCode = (e: unknown): string => ((e as NodeJS.ErrnoException | null)?.code ?? '');

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const d = RETRY_DELAYS_MS[i];
      if (d === undefined || !RETRY_CODES.has(errCode(e))) throw e;
      await delay(d);
    }
  }
}
function withRetrySync<T>(fn: () => T): T {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      const d = RETRY_DELAYS_MS[i];
      if (d === undefined || !RETRY_CODES.has(errCode(e))) throw e;
      sleepSync(d);
    }
  }
}
const tmpName = (target: string): string => `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
const once = <T>(fn: () => T): T => fn();

/**
 * <target>.bak := the current <target>, atomically: a hard link (no copy; the data was fsynced when it was written) or,
 * where links are unsupported, a copy into a temp sibling, then one rename. A kill at any point leaves the previous .bak
 * or the new one, never a torn file (a plain copyFile onto .bak could be cut half-way).
 * `retry` false: a single attempt (the async commit retries the whole commit after an async wait instead of sleeping).
 */
function backupSync(target: string, bak: string, bakTmp: string, retry = true): void {
  const run = retry ? withRetrySync : once;
  try {
    try { fs.linkSync(target, bakTmp); } catch { run(() => fs.copyFileSync(target, bakTmp)); }
    run(() => fs.renameSync(bakTmp, bak));
  } catch (e) {
    try { fs.rmSync(bakTmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}
/** Win32 form of a path: trailing dots and spaces of every component dropped (what CreateFile does without \\?\). */
function win32Form(p: string): string {
  return p.split('\\').map((c, i) => (i === 0 ? c : (c.replace(/[. ]+$/, '') || c))).join('\\');
}

export function createFsGuard(c: FsGuardConfig): FsGuard {
  const home = canonicalPath(c.home);
  const allow = c.allowRoots.map((r) => canonicalPath(r));
  if (!allow.length) throw new Error('fs-guard: allowRoots must not be empty');

  function forbiddenReason(p: string): string | null {
    if (isInside(p, home, false)) {
      const first = path.relative(home, p).split(/[\\/]/)[0] ?? '';
      if (PROFILE_DIR_NAME_RE.test(first)) return 'inside a Claude profile';
      if (DEFAULT_GLOBAL_CONFIG_RE.test(first)) return 'Claude global config';
    }
    for (const d of c.profileDirs?.() ?? []) {
      if (!d) continue;
      if (isInside(p, d) || isInside(p, canonicalPath(d))) return 'inside a configured Claude profile';
    }
    return null;
  }

  function check(target: string): string {
    if (typeof target !== 'string' || !target || target.includes('\0')) throw new FsGuardError('invalid path', String(target));
    if (/^[\\/]{2}/.test(target)) throw new FsGuardError('UNC or device path refused', target);
    const lexical = path.resolve(target);
    if (lexical.slice(2).includes(':')) throw new FsGuardError('alternate data stream refused', target);   // x:stream, x::$DATA
    const canonical = canonicalPath(target);
    for (const p of [lexical, canonical, win32Form(lexical), win32Form(canonical)]) {
      const why = forbiddenReason(p);
      if (why) throw new FsGuardError(`fs-guard: write refused (${why})`, target);
    }
    if (!allow.some((r) => isInside(canonical, r))) throw new FsGuardError('fs-guard: write outside the app data dir refused', target);
    return canonical;
  }
  const isAllowed = (t: string): boolean => { try { check(t); return true; } catch { return false; } };

  /** One synchronous commit attempt: .bak refresh (single try) + rename. Throws the fs error as is. */
  function commitOnce(target: string, tmp: string, backup: boolean): void {
    if (backup && fs.existsSync(target)) { const bak = check(target + '.bak'); backupSync(target, bak, check(tmpName(bak)), false); }
    fs.renameSync(tmp, target);
  }
  async function writeFileAtomic(p: string, data: WriteData, o?: AtomicOptions): Promise<void> {
    const target = check(p);
    const tmp = check(tmpName(target));
    try {
      const fh = await fsp.open(tmp, 'w');
      try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
      for (let i = 0; ; i++) {
        if (o?.shouldCommit && !o.shouldCommit()) { await fsp.rm(tmp, { force: true }); return; }   // superseded: drop it
        try { commitOnce(target, tmp, o?.backup !== false); return; } catch (e) {
          const d = RETRY_DELAYS_MS[i];
          if (d === undefined || !RETRY_CODES.has(errCode(e))) throw e;
          await delay(d);                                  // AV / indexer holding the file: retry the whole commit later
        }
      }
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  function writeFileAtomicSync(p: string, data: WriteData, o?: AtomicOptions): void {
    const target = check(p);
    const tmp = check(tmpName(target));
    try {
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (o?.backup !== false && fs.existsSync(target)) { const bak = check(target + '.bak'); backupSync(target, bak, check(tmpName(bak))); }
      withRetrySync(() => fs.renameSync(tmp, target));
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw e;
    }
  }

  return {
    check,
    isAllowed,
    writeFile: async (p, data) => { await fsp.writeFile(check(p), data); },
    writeFileSync: (p, data) => { fs.writeFileSync(check(p), data); },
    appendFile: async (p, data) => { await fsp.appendFile(check(p), data); },
    appendFileSync: (p, data) => { fs.appendFileSync(check(p), data); },
    openAppendSync: (p) => fs.openSync(check(p), 'a'),
    mkdir: async (p, o) => { await fsp.mkdir(check(p), { recursive: o?.recursive ?? true }); },
    mkdirSync: (p, o) => { fs.mkdirSync(check(p), { recursive: o?.recursive ?? true }); },
    rename: async (from, to) => { const a = check(from); const b = check(to); await withRetry(() => fsp.rename(a, b)); },
    renameSync: (from, to) => { const a = check(from); const b = check(to); withRetrySync(() => fs.renameSync(a, b)); },
    copyFile: async (from, to) => { const b = check(to); await withRetry(() => fsp.copyFile(from, b)); },
    copyFileSync: (from, to) => { const b = check(to); withRetrySync(() => fs.copyFileSync(from, b)); },
    rm: async (p, o) => { const t = check(p); await withRetry(() => fsp.rm(t, { recursive: o?.recursive ?? false, force: o?.force ?? false })); },
    rmSync: (p, o) => { const t = check(p); withRetrySync(() => fs.rmSync(t, { recursive: o?.recursive ?? false, force: o?.force ?? false })); },
    writeFileAtomic,
    writeFileAtomicSync,
    async createProfileDir(dir) {
      const lexical = path.resolve(dir);
      const canonical = canonicalPath(dir);
      if (pathKey(path.dirname(canonical)) !== pathKey(home)) throw new FsGuardError('a new profile folder must be directly under home', dir);
      if (!PROFILE_SLUG_RE.test(path.basename(lexical))) throw new FsGuardError('a new profile folder must be named .claude-<slug>', dir);
      if (fs.existsSync(canonical)) throw new FsGuardError('profile folder already exists', dir);
      await fsp.mkdir(canonical, { recursive: false });
      return canonical;
    },
  };
}

// ------------------------------------------------------------------ app-wide instance (configured once by main.ts at boot)
let shared: FsGuard | null = null;
export function configureFsGuard(c: FsGuardConfig): FsGuard { shared = createFsGuard(c); return shared; }
/** The configured app-wide guard. Throws until configureFsGuard() ran: no write can happen before the guard knows its roots. */
export function fsGuard(): FsGuard {
  if (!shared) throw new Error('fs-guard is not configured (configureFsGuard must run at boot)');
  return shared;
}
/** Test helper: forget the app-wide guard. */
export function resetFsGuardForTests(): void { shared = null; }
