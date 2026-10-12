// src/server/platform/files.ts — @-mention index (git ls-files or a capped walk) and the folder browser.
// Platform §3.2 T11: names only, max 200 per answer, skip .git / node_modules, prefer `git ls-files` inside a repo.
// The caller passes a cwd that already passed S9 + realpathSync.native; hits are relative ('/' separators) to it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type * as P from '../../shared/protocol.ts';
import { FILE_INDEX_MAX } from '../../shared/limits.ts';
import { execHidden } from '../util/winproc.ts';
import { homeWarning } from './confine.ts';

const WALK_MAX_ENTRIES = 20_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'dist', 'build', '.next']);
const INDEX_TTL_MS = 30_000;       // re-listed at most every 30 s per cwd (lazily, on the next query: no timer)
const cache = new Map<string, { at: number; entries: P.FileHit[] }>();

/** git.exe from PATH (absolute directories only, never the cwd: platform T20). */
export function findGit(env: NodeJS.ProcessEnv = process.env): string | null {
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, 'git.exe');
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

async function gitList(cwd: string): Promise<P.FileHit[] | null> {
  if (!fs.existsSync(path.join(cwd, '.git'))) return null;
  const git = findGit();
  if (!git) return null;
  // core.fsmonitor / core.untrackedCache off: a repo's own .git\config (e.g. from a downloaded archive) cannot make the
  // app run a command just because the user typed « @ ».
  const r = await execHidden(git, ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, timeoutMs: 5_000, maxBytes: 16 * 1024 * 1024 });
  if (r.code !== 0) return null;
  const files = r.stdout.split('\0').filter(Boolean).slice(0, WALK_MAX_ENTRIES);
  const dirs = new Set<string>();
  for (const f of files) { let d = path.posix.dirname(f); while (d && d !== '.') { dirs.add(d); d = path.posix.dirname(d); } }
  return [...[...dirs].map((d) => ({ path: d, dir: true })), ...files.map((f) => ({ path: f, dir: false }))];
}

async function walk(cwd: string): Promise<P.FileHit[]> {
  const out: P.FileHit[] = [];
  const queue: string[] = [''];
  while (queue.length && out.length < WALK_MAX_ENTRIES) {
    const rel = queue.shift()!;
    let ents: fs.Dirent[];
    try { ents = await fsp.readdir(path.join(cwd, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;                    // never follow junctions out of the jail
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; out.push({ path: p, dir: true }); queue.push(p); }
      else if (e.isFile()) out.push({ path: p, dir: false });
      if (out.length >= WALK_MAX_ENTRIES) break;
    }
  }
  return out;
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Higher is better; -1 = no match. Basename prefix > basename substring > path substring > subsequence. */
export function scoreHit(pathRel: string, q: string): number {
  if (!q) return 1;
  const p = fold(pathRel), qq = fold(q).replace(/\\/g, '/');
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base.startsWith(qq)) return 400 - Math.min(p.length, 300) / 1000;
  if (base.includes(qq)) return 300 - Math.min(p.length, 300) / 1000;
  if (p.includes(qq)) return 200 - Math.min(p.length, 300) / 1000;
  let i = 0;
  for (const ch of p) if (ch === qq[i]) i++;
  return i === qq.length ? 100 - Math.min(p.length, 300) / 1000 : -1;
}

export async function fileIndex(cwd: string, q: string, limit: number, now = Date.now()): Promise<P.FileHit[]> {
  const key = cwd.toLowerCase();
  let c = cache.get(key);
  if (!c || now - c.at > INDEX_TTL_MS) {
    const entries = (await gitList(cwd)) ?? (await walk(cwd));
    c = { at: now, entries };
    cache.set(key, c);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
  }
  const max = Math.max(1, Math.min(limit, FILE_INDEX_MAX));
  return c.entries.map((h) => ({ h, s: scoreHit(h.path, q) })).filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.h.path.localeCompare(b.h.path)).slice(0, max).map((x) => x.h);
}

/** Drive letters that exist (A:–Z:). */
export function listDrives(): string[] {
  const out: string[] = [];
  for (let c = 65; c <= 90; c++) { const d = `${String.fromCharCode(c)}:\\`; try { fs.statSync(d); out.push(d); } catch { /* absent */ } }
  return out;
}

/** Folder browser: the drives for null, else the sub-folders of a real absolute path (with a home/ancestor warning). */
export async function listDirs(p: string | null, home: string): Promise<P.DirListing> {
  if (p === null || p === '') return { path: '', dirs: [], drives: listDrives() };
  if (!path.win32.isAbsolute(p) || /^[\\/]{2}/.test(p) || p.includes('\0')) throw Object.assign(new Error('invalid path'), { code: 'invalid' });
  const real = fs.realpathSync.native(p);
  const ents = await fsp.readdir(real, { withFileTypes: true });
  const dirs = ents.filter((e) => e.isDirectory() && !/^(\$recycle\.bin|system volume information)$/i.test(e.name)).map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  const parent = path.win32.dirname(real);
  const out: P.DirListing = { path: real, dirs };
  if (parent !== real) out.parent = parent;
  const w = homeWarning(real, home);
  if (w) out.warning = w;
  return out;
}
