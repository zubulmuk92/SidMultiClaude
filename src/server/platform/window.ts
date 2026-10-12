// src/server/platform/window.ts — Edge/Chrome --app launch with a dedicated profile and the lean flags (SPEC §6.1, S13).
// Never --remote-debugging-*. The boot code travels in the URL fragment (never sent over HTTP).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_WINDOW_HEIGHT_PX, APP_WINDOW_WIDTH_PX } from '../../shared/limits.ts';

export const LEAN_FLAGS: readonly string[] = Object.freeze([
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-default-apps',
  '--disable-background-networking', '--disable-component-update', '--no-pings',
]);

/** Known install locations (no registry, no PATH): Edge first, Chrome as the user-selectable fallback. */
export function browserCandidates(browser: 'edge' | 'chrome', env: NodeJS.ProcessEnv = process.env): string[] {
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
  const local = env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  const edge = [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')];
  const chrome = [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')];
  return browser === 'chrome' ? [...chrome, ...edge] : [...edge, ...chrome];
}
export function findBrowser(browser: 'edge' | 'chrome', env: NodeJS.ProcessEnv = process.env): string | null {
  for (const p of browserCandidates(browser, env)) { try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}

/** The exact argument list (unit-tested: dedicated profile, lean flags, no remote debugging, literal 127.0.0.1). */
export function appWindowArgs(port: number, bootCode: string, profileDir: string): string[] {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('invalid port');
  if (!/^[A-Za-z0-9_-]+$/.test(bootCode)) throw new Error('invalid boot code');
  return [`--app=http://127.0.0.1:${port}/#boot=${bootCode}`, `--user-data-dir=${profileDir}`, ...LEAN_FLAGS,
    `--window-size=${APP_WINDOW_WIDTH_PX},${APP_WINDOW_HEIGHT_PX}`];
}

/** Launches the app window (detached, hidden console-less GUI). Returns the browser pid, or undefined when no browser. */
export function openAppWindow(port: number, bootCode: string, browser: 'edge' | 'chrome', profileDir: string): number | undefined {
  const exe = findBrowser(browser);
  if (!exe) return undefined;
  const child = spawn(exe, appWindowArgs(port, bootCode, profileDir), { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => { /* no window: the launcher's MessageBox / npm start output covers it */ });
  child.unref();
  return child.pid;
}
