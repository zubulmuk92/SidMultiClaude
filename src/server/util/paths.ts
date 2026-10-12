// src/server/util/paths.ts — app dirs, realpathNative, 8.3 guard, profile roots, home.
// Rules (SPEC §2.2, §7):
// - anything watched or spawned goes through realpathNative (fs.realpathSync.native expands 8.3 names and fixes case;
//   fs.realpathSync does not);
// - assertNo83 runs before EVERY fs.watch: libuv aborts the whole process on a path with an 8.3 component;
// - path comparisons are case-insensitive and separator-insensitive (Windows).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProfilePaths } from '../contracts.ts';

export const APP_DIR_NAME = 'SidMultiClaude';
export const SHORT_NAME_RE = /~\d/;
/** Profile data dirs directly under home: `.claude` (default profile) and `.claude-<anything>` (other profiles). */
export const PROFILE_DIR_NAME_RE = /^\.claude(?:-[^\\/]+)?$/i;
/** Global config file of the default profile and its temp/backup siblings (`~\.claude.json`, `.claude.json.tmp.*`, `.claude.json.backup`). */
export const DEFAULT_GLOBAL_CONFIG_RE = /^\.claude\.json(?:\..*)?$/i;

// ------------------------------------------------------------------ 8.3 guard
export function has83(p: string): boolean { return SHORT_NAME_RE.test(p); }

export class ShortNameError extends Error {
  readonly code = 'E83';
  readonly target: string;
  constructor(target: string) {
    super(`8.3 short name in path (fs.watch would abort the process): ${target}`);
    this.name = 'ShortNameError';
    this.target = target;
  }
}
/** Call right before fs.watch(p): throws on any 8.3 component (e.g. JEANDU~1). Returns p. */
export function assertNo83(p: string): string {
  if (has83(p)) throw new ShortNameError(p);
  return p;
}

// ------------------------------------------------------------------ canonical paths
/** fs.realpathSync.native on the absolute path: 8.3 names expanded, exact case, junctions resolved. Throws if missing. */
export function realpathNative(p: string): string {
  return fs.realpathSync.native(path.resolve(p));
}
/** Like realpathNative, but tolerates a missing tail: canonicalises the longest existing ancestor and appends the rest as given. */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch { /* walk up */ }
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;                 // even the root does not resolve (missing drive): keep the lexical form
    rest.unshift(path.basename(cur));
    cur = parent;
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { /* keep walking */ }
  }
}

/** Comparison key: absolute, `\` separators, no trailing separator (except a drive root), lower-case. */
export function pathKey(p: string): string {
  let r = path.win32.resolve(p).replace(/\//g, '\\');
  if (r.length > 3 && r.endsWith('\\')) r = r.slice(0, -1);
  return r.toLowerCase();
}
export function samePath(a: string, b: string): boolean { return pathKey(a) === pathKey(b); }
/** True when `child` is `parent` itself (orEqual, default) or lies under it. Lexical and case-insensitive: canonicalise first. */
export function isInside(child: string, parent: string, orEqual = true): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (c === p) return orEqual;
  return c.startsWith(p.endsWith('\\') ? p : p + '\\');
}
/** `C:\a\b` → `C:/a/b` (claudeMdExcludes, trustedInCli normalisation). */
export function toSlash(p: string): string { return p.replace(/\\/g, '/'); }

// ------------------------------------------------------------------ home
let homeCache: string | undefined;
/** realpathNative(os.homedir()), memoised (long form, exact case: C:\Users\Jean Dupont). */
export function homeReal(): string {
  if (homeCache === undefined) homeCache = realpathNative(os.homedir());
  return homeCache;
}

// ------------------------------------------------------------------ app data dir (%LOCALAPPDATA%\SidMultiClaude, SPEC §7.1)
export type AppPaths = {
  root: string;
  config: string;                 // config.json (v:1): port, Settings, accounts[]
  stateDir: string;
  device: string;                 // state\device.json
  chats: string;                  // state\chats.json
  ui: string;                     // state\ui.json
  draftsDir: string;              // state\drafts\
  prompts: string;                // state\prompts.jsonl
  helpers: string;                // state\helpers.json (SHA-256 of the compiled helpers)
  cacheDir: string;               // cache\ (index-<accountId>.json)
  runDir: string;
  instance: string;               // run\instance.json
  children: string;               // run\children.json
  crashMarker: string;            // run\crash.marker
  logsDir: string;
  edgeProfile: string;            // dedicated browser profile
  probeCwd: string;               // cwd of the transient no-prompt usage/baseline processes (the only S9 exemption)
};
/** %LOCALAPPDATA%\SidMultiClaude in its long form (LOCALAPPDATA can hold an 8.3 path). */
export function defaultAppRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(canonicalPath(base), APP_DIR_NAME);
}
export function appPaths(root: string): AppPaths {
  const r = canonicalPath(root);
  const state = path.join(r, 'state');
  const run = path.join(r, 'run');
  return {
    root: r,
    config: path.join(r, 'config.json'),
    stateDir: state,
    device: path.join(state, 'device.json'),
    chats: path.join(state, 'chats.json'),
    ui: path.join(state, 'ui.json'),
    draftsDir: path.join(state, 'drafts'),
    prompts: path.join(state, 'prompts.jsonl'),
    helpers: path.join(state, 'helpers.json'),
    cacheDir: path.join(r, 'cache'),
    runDir: run,
    instance: path.join(run, 'instance.json'),
    children: path.join(run, 'children.json'),
    crashMarker: path.join(run, 'crash.marker'),
    logsDir: path.join(r, 'logs'),
    edgeProfile: path.join(r, 'edge-profile'),
    probeCwd: path.join(r, 'probe-cwd'),
  };
}
/** state\drafts\<file>: a chatId contains ':' (illegal in Windows file names, and an ADS separator), so it is encoded. */
export function draftFileName(chatId: string): string {
  const i = chatId.indexOf(':');
  if (i <= 0) throw new Error(`invalid chatId: ${chatId}`);
  return `${chatId.slice(0, i)}_${chatId.slice(i + 1)}.json`;   // accountId never contains '_'
}
export function draftFile(p: AppPaths, chatId: string): string { return path.join(p.draftsDir, draftFileName(chatId)); }
/** Inverse of draftFileName (null for foreign files). */
export function chatIdFromDraftFile(name: string): string | null {
  const m = /^([a-z][a-z0-9-]{0,23})_([0-9a-f-]{36})\.json$/.exec(name);
  return m ? `${m[1]}:${m[2]}` : null;
}
export function indexFile(p: AppPaths, accountId: string): string { return path.join(p.cacheDir, `index-${accountId}.json`); }

// ------------------------------------------------------------------ Claude profiles
/**
 * Paths of one profile. configDir null = default profile: CLAUDE_CONFIG_DIR UNSET, data in <home>\.claude and the global
 * config in <home>\.claude.json. A legacy `<configHome>\.config.json` wins when it exists: `legacy` reports it.
 */
export function profilePaths(configDir: string | null, home: string): ProfilePaths & { legacyGlobalConfig: string } {
  const configHome = configDir ?? path.join(home, '.claude');
  return {
    configHome,
    globalConfig: configDir ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json'),
    legacyGlobalConfig: path.join(configHome, '.config.json'),
    projectsDir: path.join(configHome, 'projects'),
    sessionsDir: path.join(configHome, 'sessions'),
    credentials: path.join(configHome, '.credentials.json'),
  };
}
export function isProfileDirName(name: string): boolean { return PROFILE_DIR_NAME_RE.test(name); }
/** Candidate profile data dirs under `home`: `.claude` (default, configDir null) and every existing `.claude-*` dir. */
export function profileCandidates(home: string): { configDir: string | null; dir: string }[] {
  const out: { configDir: string | null; dir: string }[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(home); } catch { return out; }
  const def = path.join(home, '.claude');
  if (names.some((n) => n.toLowerCase() === '.claude')) out.push({ configDir: null, dir: def });
  for (const n of names.sort()) {
    if (!/^\.claude-/i.test(n)) continue;
    const dir = path.join(home, n);
    try { if (fs.statSync(dir).isDirectory()) out.push({ configDir: dir, dir }); } catch { /* vanished */ }
  }
  return out;
}

// ------------------------------------------------------------------ CLI project key
function djb2(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}
/** Name of `<cfg>\projects\<key>` for a cwd (pass the realpathNative form: an 8.3 cwd gives another key). */
export function projectKey(cwd: string): string {
  const k = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return k.length <= 200 ? k : `${k.slice(0, 200)}-${Math.abs(djb2(cwd)).toString(36)}`;
}
