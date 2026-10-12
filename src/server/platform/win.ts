// src/server/platform/win.ts — exe lookup, port bind + fallback, pipe lock, openExternal, openPath, freemem.
// SPEC §5.1 Platform: port + single instance; openExternal/openPath (no shell, http/https only via explorer.exe).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CwdCheck, Logger, Platform } from '../contracts.ts';
import { PORT_DEFAULT, PORT_FALLBACK_FIRST, PORT_FALLBACK_LAST } from '../../shared/limits.ts';
import { spawnHidden } from '../util/winproc.ts';
import { homeReal } from '../util/paths.ts';
import { resolveClaudeExe } from '../engine/exe.ts';
import { checkCwdPolicy, confine } from './confine.ts';
import { openTerminal, terminalCommand } from './terminal.ts';
import { fileIndex, listDirs } from './files.ts';
import { killPids, listOrphans } from './orphans.ts';
import { openAppWindow } from './window.ts';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const EXPLORER_EXE = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'explorer.exe');

// ------------------------------------------------------------------ single instance (named pipe, one verb)
const userSlug = (): string => os.userInfo().username.replace(/[^\w.-]/g, '_');
/** `\\.\pipe\SidMultiClaude-<user>` for the real data dir; a per-data-dir suffix otherwise (tests never collide). */
export function pipePath(appRoot: string | null, env: NodeJS.ProcessEnv = process.env): string {
  if (env['SMC_PIPE']) return `\\\\.\\pipe\\${env['SMC_PIPE'].replace(/[^\w.-]/g, '_')}`;
  const base = `SidMultiClaude-${userSlug()}`;
  const suffix = appRoot ? '-' + createHash('sha256').update(appRoot.toLowerCase()).digest('hex').slice(0, 10) : '';
  return `\\\\.\\pipe\\${base}${suffix}`;
}
/** Takes the lock; every connection means "open a window" (no data, no secret: S18). null when already taken. */
export function holdInstanceLock(pipe: string, onOpenRequest: () => void): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const srv = net.createServer((c) => { c.on('error', () => {}); c.end('ok\n'); try { onOpenRequest(); } catch { /* logged by caller */ } });
    srv.once('error', () => resolve(null));
    srv.listen(pipe, () => resolve(srv));
  });
}
/** Second launch: asks the running instance to open a window. true when it answered. */
export function askRunningInstanceToOpen(pipe: string, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(pipe);
    const t = setTimeout(() => { c.destroy(); resolve(false); }, timeoutMs);
    let buf = '';
    c.on('data', (d) => { buf += String(d); });
    c.on('end', () => { clearTimeout(t); resolve(buf.startsWith('ok')); });
    c.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

// ------------------------------------------------------------------ port: preferred, then 41732–41750 (EADDRINUSE / EACCES)
/** The persisted (or --port) port first, then 41731, then 41732–41750, without duplicates. 0 = any free port (tests). */
export function portCandidates(preferred: number): number[] {
  if (preferred === 0) return [0];
  const out = [preferred];
  for (const p of [PORT_DEFAULT, ...Array.from({ length: PORT_FALLBACK_LAST - PORT_FALLBACK_FIRST + 1 }, (_, i) => PORT_FALLBACK_FIRST + i)]) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
/** Tries each candidate with `listen`; returns the bound port. Rethrows anything that is not "port unavailable". */
export async function bindFirstFree(listen: (port: number) => Promise<number>, candidates: readonly number[]): Promise<number> {
  let last: unknown = new Error('no port candidate');
  for (const p of candidates) {
    try { return await listen(p); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw e;
      last = e;
    }
  }
  throw last;
}

// ------------------------------------------------------------------ external opens
/** http/https only, through explorer.exe (the user's default browser, never the app profile: T3).
 *  explorer.exe splits its command line at commas (`/root,<object>`, `/select,<object>`): a link such as
 *  `https://x/,/root,C:/…/calc.exe` would run a program, so commas are percent-encoded (one token, same URL for servers). */
export function safeExternalUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 8_192 || /[\0\r\n"]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const href = u.href.replace(/,/g, '%2C');
    return /[\s"]/.test(href) ? null : href;
  } catch { return null; }
}
/** Explorer shows folders only: a file opens its folder (`explorer.exe <file>` would run it, S8). A comma would split
 *  explorer's command line (see safeExternalUrl), so such paths are refused. null = refused or missing. */
export function explorerTarget(p: string): string | null {
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return null; }
  const dir = st.isDirectory() ? p : path.dirname(p);
  return dir.includes(',') || /["\0\r\n]/.test(dir) ? null : dir;
}
export function findVsCode(env: NodeJS.ProcessEnv = process.env): string | null {
  const local = env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
  for (const p of [path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(pf, 'Microsoft VS Code', 'Code.exe')]) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

// ------------------------------------------------------------------ helpers.json (SHA-256 recorded by scripts/install.ps1)
export type HelpersManifest = { jobrun?: { path: string; sha256: string }; launcher?: { path: string; sha256: string } };
export function readHelpers(file: string): HelpersManifest {
  try { const o = JSON.parse(fs.readFileSync(file, 'utf8')) as { v?: number; data?: HelpersManifest }; return o.data ?? {}; } catch { return {}; }
}
export function sha256File(p: string): string { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
/** launcher\jobrun.exe present and its hash equal to the one recorded at install, else null (→ plain isolation). */
export function verifiedJobrun(helpersFile: string): string | null {
  const m = readHelpers(helpersFile).jobrun;
  if (!m?.path || !m.sha256) return null;
  try { return sha256File(m.path).toLowerCase() === m.sha256.toLowerCase() ? fs.realpathSync.native(m.path) : null; } catch { return null; }
}

export type PlatformDeps = {
  appDir: string; log: Logger;
  home?: string;                                   // profiles root (--profiles-root), default the real home
  configDirs?: () => readonly string[];            // configured account dirs (S9 refusals)
  helpersFile?: string; edgeProfile?: string; probeCwd?: string;
  env?: NodeJS.ProcessEnv;                         // default process.env (startApp's env in tests)
};
export function createPlatform(d: PlatformDeps): Platform & { jobrunPath(): string | null } {
  const home = d.home ?? homeReal();
  const helpersFile = d.helpersFile ?? path.join(d.appDir, 'state', 'helpers.json');
  const edgeProfile = d.edgeProfile ?? path.join(d.appDir, 'edge-profile');
  let jobrun: { at: number; path: string | null } | null = null;
  const jobrunPath = (): string | null => {
    if (!jobrun || Date.now() - jobrun.at > 60_000) jobrun = { at: Date.now(), path: verifiedJobrun(helpersFile) };
    return jobrun.path;
  };
  const spawnDetached = (exe: string, args: string[]): void => {
    try { const c = spawnHidden(exe, args, { detached: true, stdio: 'ignore' }); c.on('error', (e) => d.log.warn('open failed', { err: String(e) })); c.unref(); }
    catch (e) { d.log.warn('open refused', { err: String(e) }); }
  };
  return {
    claudeExe: (pref) => resolveClaudeExe(pref, d.env),
    checkCwd: (p, configDirs): CwdCheck => checkCwdPolicy(p, [...configDirs, ...(d.configDirs?.() ?? [])], { home, appDir: d.appDir, probeCwd: d.probeCwd }),
    confine: (root, rel) => confine(root, rel),
    jobrunAvailable: () => jobrunPath() !== null,
    jobrunPath,
    openExternal(url) {
      const u = safeExternalUrl(url);
      if (!u) throw Object.assign(new Error('url refused'), { code: 'invalid' });
      spawnDetached(EXPLORER_EXE, [u]);
    },
    openPath(p, how) {
      if (how === 'vscode') { const code = findVsCode(); if (!code) throw Object.assign(new Error('vscode missing'), { code: 'unsupported' }); spawnDetached(code, [p]); return; }
      const dir = explorerTarget(p);
      if (!dir) throw Object.assign(new Error('explorer target refused'), { code: 'invalid' });
      spawnDetached(EXPLORER_EXE, [dir]);
    },
    terminalCommand: (s) => terminalCommand(s),
    openTerminal: (s) => openTerminal(s),
    fileIndex: (cwd, q, limit) => fileIndex(cwd, q, limit),
    listDirs: (p) => listDirs(p, home),
    openAppWindow: (port, code, browser) => openAppWindow(port, code, browser, edgeProfile),
    listOrphans: (recorded) => listOrphans(recorded),
    killPids: (pids) => killPids(pids),
    freeMemBytes: () => os.freemem(),
  };
}
