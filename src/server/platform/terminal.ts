// src/server/platform/terminal.ts — « Ouvrir dans le terminal »: wt -d <cwd> powershell -NoProfile -NoExit -EncodedCommand.
// SPEC §10 S8. Never a shell (argument arrays, absolute paths, .exe targets only).
// The PowerShell script is passed as -EncodedCommand (base64 of UTF-16LE), so no quoting reaches a command line parser.
// wt.exe treats `;` as a command separator: a cwd containing `;` is refused (cwd_refused).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type * as P from '../../shared/protocol.ts';
import { POWERSHELL_EXE } from '../util/winproc.ts';
import { isUuid } from '../util/ids.ts';

export type TerminalSpec = { cwd: string; configDir: string | null; sessionId: P.SessionId; exe: string };
export type TerminalLaunch = { file: string; args: string[]; cwd?: string; script: string; encoded: string };

/** PowerShell single-quoted literal ('' doubles a quote; nothing else is special inside '...'). */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** The script run in the new terminal: clean Claude env, the profile, then `claude --resume <uuid>`. */
export function terminalScript(s: TerminalSpec): string {
  const lines = ['Remove-Item Env:CLAUDECODE,Env:CLAUDE_CODE_*,Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue'];
  if (s.configDir) lines.push(`$env:CLAUDE_CONFIG_DIR = ${psQuote(s.configDir)}`);   // only for non-default profiles
  lines.push(`& ${psQuote(s.exe)} --resume ${s.sessionId}`);
  return lines.join('; ');
}
export const encodeCommand = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');
export const decodeCommand = (b64: string): string => Buffer.from(b64, 'base64').toString('utf16le');

function refused(s: TerminalSpec): boolean {
  return typeof s.cwd !== 'string' || !path.win32.isAbsolute(s.cwd) || /[;"\0\r\n]/.test(s.cwd) || !isUuid(s.sessionId)
    || !s.exe || /["\0\r\n]/.test(s.exe) || (s.configDir !== null && /["\0\r\n]/.test(s.configDir));
}

/** Windows Terminal's app execution alias, if present. */
export function findWt(env: NodeJS.ProcessEnv = process.env): string | null {
  const local = env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  const p = path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe');
  try { fs.lstatSync(p); return p; } catch { return null; }
}

/** How the terminal is launched: wt.exe when available, else powershell.exe with the cwd in the spawn options. */
export function terminalLaunch(s: TerminalSpec, wt: string | null = findWt()): P.Result<TerminalLaunch, 'cwd_refused'> {
  if (refused(s)) return { ok: false, err: 'cwd_refused' };
  const script = terminalScript(s);
  const encoded = encodeCommand(script);
  const ps = ['-NoProfile', '-NoExit', '-EncodedCommand', encoded];
  if (wt) return { ok: true, data: { file: wt, args: ['-d', s.cwd, POWERSHELL_EXE, ...ps], script, encoded } };
  return { ok: true, data: { file: POWERSHELL_EXE, args: ps, cwd: s.cwd, script, encoded } };
}

/** The command line shown by *Copier la commande* (also valid in Win+R and PowerShell). */
export function terminalCommand(s: TerminalSpec): P.Result<string, 'cwd_refused'> {
  if (refused(s)) return { ok: false, err: 'cwd_refused' };
  const encoded = encodeCommand(terminalScript(s));
  return { ok: true, data: `wt.exe -d "${s.cwd}" powershell.exe -NoProfile -NoExit -EncodedCommand ${encoded}` };
}

/** Opens a visible terminal (the one place where a window is wanted: windowsHide is false on purpose). */
export function openTerminal(s: TerminalSpec): P.Result<void, 'cwd_refused'> {
  const l = terminalLaunch(s);
  if (!l.ok) return l;
  const child = spawn(l.data.file, l.data.args, { cwd: l.data.cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => { /* reported by the caller's log through the exit of nothing: best effort */ });
  child.unref();
  return { ok: true, data: undefined };
}
