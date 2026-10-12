// test/e2e/harness.ts — E2E harness (SPEC §12.6).
// Starts the real server in test mode on throwaway dirs, reads the boot code it prints, and opens the app in the
// installed Edge through playwright-core (headless, temporary user-data dir, no browser download).
//   server: node src/server/main.ts --data-dir <tmp app> --profiles-root <tmp home> --print-boot [--port n] [--fake-engine]
//           env: clean (no CLAUDE*/ANTHROPIC*/…), SMC_TEST=1, SMC_CLAUDE_EXE=test/fakes/fake-claude.mjs
//   --print-boot contract (main.ts, WP-D): one stdout line `SMC_BOOT {"port":<n>,"boot":"<code>"}` once listening.
// The page then opens http://127.0.0.1:<port>/#boot=<code> and the guard trades the code for a device token.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { LEAKY_ENV } from '../../src/server/engine/options.ts';
import { treeKill } from '../../src/server/util/winproc.ts';
import { createTmpRoot } from '../helpers/tmp-profile.ts';
import type { TmpRoot } from '../helpers/tmp-profile.ts';
import type { WsClient } from '../helpers/ws-client.ts';
import type * as P from '../../src/shared/protocol.ts';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const SERVER_MAIN = path.join(PROJECT_ROOT, 'src', 'server', 'main.ts');
export const FAKE_CLAUDE = path.join(PROJECT_ROOT, 'test', 'fakes', 'fake-claude.mjs');
export const BOOT_LINE_PREFIX = 'SMC_BOOT ';

export type BootInfo = { port: number; boot: string };
/** Parses the --print-boot line; null for anything else. */
export function parseBootLine(line: string): BootInfo | null {
  if (!line.startsWith(BOOT_LINE_PREFIX)) return null;
  try {
    const o = JSON.parse(line.slice(BOOT_LINE_PREFIX.length)) as { port?: unknown; boot?: unknown };
    if (typeof o.port === 'number' && Number.isInteger(o.port) && o.port > 0 && typeof o.boot === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(o.boot)) return { port: o.port, boot: o.boot };
  } catch { /* not JSON */ }
  return null;
}
/** The server's env: the test runner's env minus every Claude/Anthropic/debug variable (it may run inside a Claude session). */
export function serverEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !LEAKY_ENV.test(k)) env[k] = v;
  // SMC_TEST_FREE_MEM_MB: the pool sees 8 GB free whatever the machine has, so no suite depends on the RAM
  // left by other processes (under 1.5 GB the cap drops to max(2, live)); a test that wants the low-memory cap passes its own
  return { ...env, SMC_TEST: '1', SMC_CLAUDE_EXE: FAKE_CLAUDE, SMC_TEST_FREE_MEM_MB: '8192', ...extra };
}

export type ServerOptions = {
  root?: TmpRoot; port?: number; fakeEngine?: boolean; env?: Record<string, string>; args?: string[]; bootTimeoutMs?: number;
  /** Entry script (default src/server/main.ts). Harness self-tests point it at tiny stand-ins. */
  main?: string;
};
export type ServerHandle = BootInfo & {
  root: TmpRoot; proc: ChildProcess; url: string; stdout: string[]; stderr: string[];
  /** Hard stop of the server AND its process tree (taskkill /T /F): no fake-claude child outlives a test. */
  stop(): Promise<number | null>;
};

/** Kills the whole tree of `proc` and resolves with its exit code once it is gone. */
function killTree(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) { resolve(proc.exitCode); return; }
    proc.once('exit', (c) => resolve(c));
    void treeKill(proc.pid);
  });
}

/** Starts the server and resolves once it printed its boot line (rejects if it exits or times out first). */
export function startServer(o: ServerOptions = {}): Promise<ServerHandle> {
  const root = o.root ?? createTmpRoot('e2e');
  const args = [o.main ?? SERVER_MAIN, '--data-dir', root.appDir, '--profiles-root', root.home, '--print-boot',
    ...(o.port ? ['--port', String(o.port)] : []), ...(o.fakeEngine ? ['--fake-engine'] : []), ...(o.args ?? [])];
  const proc = spawn(process.execPath, args, { cwd: PROJECT_ROOT, env: serverEnv(o.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const fail = (why: string): void => {
      if (done) return;
      done = true;
      void killTree(proc).then(() => {
        if (!o.root) root.dispose();
        reject(new Error(`${why}\n--- stderr ---\n${stderr.join('').slice(-4000)}`));
      });
    };
    const timer = setTimeout(() => fail(`server did not print ${BOOT_LINE_PREFIX.trim()} within ${o.bootTimeoutMs ?? 15_000} ms`), o.bootTimeoutMs ?? 15_000);
    proc.stderr!.setEncoding('utf8').on('data', (d: string) => stderr.push(d));
    proc.stdout!.setEncoding('utf8').on('data', (d: string) => {
      stdout.push(d);
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const info = parseBootLine(line);
        if (info && !done) {
          done = true;
          clearTimeout(timer);
          resolve({
            ...info, root, proc, stdout, stderr, url: `http://127.0.0.1:${info.port}/#boot=${info.boot}`,
            stop: () => killTree(proc),
          });
        }
      }
    });
    proc.once('exit', (code) => { clearTimeout(timer); fail(`server exited (code ${code}) before printing its boot line`); });
    proc.once('error', (e) => { clearTimeout(timer); fail(`server spawn failed: ${e.message}`); });
  });
}

export type BrowserOptions = { channel?: 'msedge' | 'chrome'; headless?: boolean; viewport?: { width: number; height: number };
  /** Runs on the fresh context before the first page.goto (init scripts: a frame recorder, a fake Notification…). */
  beforeGoto?: (context: BrowserContext) => Promise<void> };
/** Installed Edge (default) through playwright-core: no download, temporary profile, notifications granted for the origin. */
export async function openBrowser(origin: string, o: BrowserOptions = {}): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({ channel: o.channel ?? 'msedge', headless: o.headless ?? true });
  const context = await browser.newContext({ viewport: o.viewport ?? { width: 1280, height: 860 }, locale: 'fr-FR' });
  await context.grantPermissions(['notifications'], { origin });
  return { browser, context };
}

export type Harness = { server: ServerHandle; browser: Browser; context: BrowserContext; page: Page; close(): Promise<void> };
/** Server + Edge + a page opened on the boot URL. Always call close() (it also deletes the temp dirs). */
export async function launch(o: ServerOptions & BrowserOptions = {}): Promise<Harness> {
  const server = await startServer(o);
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const { browser, context } = await openBrowser(origin, o);
    if (o.beforeGoto) await o.beforeGoto(context);
    const page = await context.newPage();
    await page.goto(server.url);
    const h: Harness = {
      server, browser, context, page,
      async close() {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        await h.server.stop();                // the current server (restartServer replaces it)
        if (!o.root) h.server.root.dispose();
      },
    };
    return h;
  } catch (e) {
    await server.stop();
    server.root.dispose();
    throw e;
  }
}

/** The installed Edge, if any (E2E suites skip cleanly without it). */
export function edgeInstalled(): boolean {
  return [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']].filter(Boolean)
    .some((p) => fs.existsSync(path.join(p!, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
}

// ------------------------------------------------------------------ M2: real-server helpers
/**
 * Registers every profile candidate of the temp profiles root as an account (the real server starts with none), in
 * candidate order, and resolves with the account list once the server pushed it. Names / monograms come from `names`
 * (by configDir basename, '' for the default profile), else « Compte n ». `only` restricts it to those basenames.
 */
export async function addAllAccounts(side: WsClient, names: Record<string, { name: string; monogram: string }> = {},
  only?: string[]): Promise<P.AccountView[]> {
  const c = await side.request<P.AccountCandidate[]>({ t: 'account.candidates' }, 10_000);
  if (!c.ok) throw new Error(`account.candidates: ${JSON.stringify(c.err)}`);
  let n = 0;
  for (const cand of c.data ?? []) {
    const key = cand.configDir ? path.basename(cand.configDir) : '';
    if (cand.added || (only && !only.includes(key))) continue;
    n++;
    const nm = names[key] ?? { name: `Compte ${n}`, monogram: String(n) };
    const r = await side.request({ t: 'account.add', configDir: cand.configDir, name: nm.name, color: n, monogram: nm.monogram }, 10_000);
    if (!r.ok) throw new Error(`account.add ${key}: ${JSON.stringify(r.err)}`);
  }
  const want = (c.data ?? []).filter((x) => x.added || !only || only.includes(x.configDir ? path.basename(x.configDir) : '')).length;
  const frame = await side.next<Extract<P.S2C, { t: 'accounts' }>>((m) => m.t === 'accounts' && m.accounts.length >= want, 10_000);
  return frame.accounts;
}

/**
 * Server restart on the same data dir and port (the window keeps its device token): hard stop of the whole tree, then
 * a new server process. Mutates `h.server` so close() stops the new one.
 */
export async function restartServer(h: Harness, o: ServerOptions = {}): Promise<ServerHandle> {
  const port = h.server.port;
  await h.server.stop();
  let last: unknown = null;
  for (let i = 0; i < 20; i++) {                // the port can take a moment to be free again
    try {
      const s = await startServer({ ...o, root: h.server.root, port });
      h.server = s;
      return s;
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 250)); }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
