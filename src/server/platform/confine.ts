// src/server/platform/confine.ts — path jail (15 test cases) + S9 cwd policy.
// The path jail below passes 15 cases, a junction escape included. Reasons are typed so callers can log them.
// checkCwdPolicy implements the S9 working-folder policy (SPEC §10 S9, C18).
import fs from 'node:fs';
import path from 'node:path';
import type { CwdCheck } from '../contracts.ts';
import { CWD_TOO_LONG_AT } from '../../shared/limits.ts';

export const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.[^\\/]*)?$/i;
export type ConfineReason = 'bad type/length' | 'NUL byte' | 'UNC/device path' | 'absolute/drive-relative path' | 'ADS / colon'
  | 'reserved device name' | 'lexical escape' | 'escapes root after realpath (junction/symlink)';

export class ConfineError extends Error {
  readonly reason: ConfineReason;
  constructor(reason: ConfineReason) { super(reason); this.name = 'ConfineError'; this.reason = reason; }
}

/**
 * Returns the real absolute path if `rel` (from the UI) stays inside `rootReal`, else throws ConfineError.
 * `rootReal` must be fs.realpathSync.native(chat cwd). A missing target passes the lexical checks only (nothing to resolve).
 */
export function confineOrThrow(rootReal: string, rel: string): string {
  if (typeof rel !== 'string' || rel.length > 1024) throw new ConfineError('bad type/length');
  if (rel.includes('\0')) throw new ConfineError('NUL byte');
  if (/^[\\/]{2}/.test(rel)) throw new ConfineError('UNC/device path');          // \\server\share, \\?\, \\.\pipe
  if (path.win32.isAbsolute(rel) || /^[a-z]:/i.test(rel)) throw new ConfineError('absolute/drive-relative path');
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p.includes(':'))) throw new ConfineError('ADS / colon');   // file.txt:stream
  if (parts.some((p) => RESERVED_NAME_RE.test(p.replace(/[. ]+$/, '')))) throw new ConfineError('reserved device name');
  const abs = path.resolve(rootReal, rel);
  if (outside(path.relative(rootReal, abs))) throw new ConfineError('lexical escape');
  let real: string;
  try { real = fs.realpathSync.native(abs); } catch {
    // non-existent target: its deepest existing ancestor must still resolve inside the root (a junction on the way out)
    for (let anc = path.dirname(abs); ; anc = path.dirname(anc)) {
      let ra: string;
      try { ra = fs.realpathSync.native(anc); } catch { if (path.dirname(anc) === anc) return abs; continue; }
      if (outside(path.relative(rootReal, ra))) throw new ConfineError('escapes root after realpath (junction/symlink)');
      return abs;
    }
  }
  if (!outside(path.relative(rootReal, real))) return real;
  throw new ConfineError('escapes root after realpath (junction/symlink)');
}
/** path.relative() result that leaves the root: `..`, `..\x`, or another drive (`..foo` is a legal name inside). */
function outside(r: string): boolean {
  return r === '..' || r.startsWith('..\\') || r.startsWith('../') || path.isAbsolute(r);
}

/** Platform.confine contract shape: the real path, or null when refused. `root` is canonicalised here. */
export function confine(root: string, rel: string): string | null {
  let rootReal: string;
  try { rootReal = fs.realpathSync.native(root); } catch { return null; }
  try { return confineOrThrow(rootReal, rel); } catch { return null; }
}

export type CwdPolicyContext = {
  home: string;                     // real home (profiles root): itself refused, its .claude / .claude-* refused
  appDir: string;                   // %LOCALAPPDATA%\SidMultiClaude: refused, except probeCwd
  probeCwd?: string;                // the only S9 exemption (transient usage/baseline processes)
};

const lower = (p: string): string => p.toLowerCase();
/** Case-insensitive "child is parent or inside it" on canonical Win32 paths. */
function inside(child: string, parent: string): boolean {
  const c = lower(path.win32.resolve(child)), pr = lower(path.win32.resolve(parent));
  if (c === pr) return true;
  return c.startsWith(pr.endsWith('\\') ? pr : pr + '\\');
}
function realOrSelf(p: string): string { try { return fs.realpathSync.native(p); } catch { return path.win32.resolve(p); } }

/**
 * S9 working-folder policy (SPEC §10 S9, C18). Returns the canonical cwd, or the refusal code:
 * - cwd_missing: not an existing directory (realpathSync.native also expands 8.3 names and resolves junctions);
 * - cwd_too_long: 259 characters or more (CreateProcess caps the current directory at MAX_PATH);
 * - cwd_refused: the home folder itself, anything inside a Claude config dir (<home>\.claude, <home>\.claude-*, any
 *   configured configDir) or inside the app data folder (probeCwd excepted).
 * Ancestors of home (C:\, C:\Users) are allowed here; the folder browser warns about them.
 */
export function checkCwdPolicy(p: string, configDirs: readonly string[], ctx?: CwdPolicyContext): CwdCheck {
  if (typeof p !== 'string' || !p || p.includes('\0') || !path.win32.isAbsolute(p) || /^[\\/]{2}/.test(p)) return { ok: false, err: 'cwd_missing' };
  let real: string;
  try {
    real = fs.realpathSync.native(p);
    if (!fs.statSync(real).isDirectory()) return { ok: false, err: 'cwd_missing' };
  } catch { return { ok: false, err: 'cwd_missing' }; }
  if (real.length >= CWD_TOO_LONG_AT) return { ok: false, err: 'cwd_too_long' };
  if (ctx?.probeCwd && lower(real) === lower(realOrSelf(ctx.probeCwd))) return { ok: true, data: real };
  const refused: string[] = [...configDirs.map(realOrSelf)];
  if (ctx) {
    const home = realOrSelf(ctx.home);
    if (lower(real) === lower(home)) return { ok: false, err: 'cwd_refused' };
    refused.push(path.win32.join(home, '.claude'), realOrSelf(ctx.appDir));
    if (inside(real, home)) {
      const first = path.win32.relative(home, real).split('\\')[0] ?? '';
      if (/^\.claude(?:-.*)?$/i.test(first.replace(/[. ]+$/, ''))) return { ok: false, err: 'cwd_refused' };
    }
  }
  if (refused.some((r) => inside(real, r))) return { ok: false, err: 'cwd_refused' };
  return { ok: true, data: real };
}

/** 'home' for the home folder itself, 'ancestor' for C:\, C:\Users… (the folder browser warns), else undefined. */
export function homeWarning(p: string, home: string): 'home' | 'ancestor' | undefined {
  const a = lower(path.win32.resolve(p)), h = lower(path.win32.resolve(home));
  if (a === h) return 'home';
  return inside(h, a) ? 'ancestor' : undefined;
}
