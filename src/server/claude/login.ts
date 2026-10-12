// src/server/claude/login.ts — LoginService: claude.exe auth login|logout piped, hidden, clean env.
// `claude auth login [--email]` prints `If the browser didn't open, visit: <url>` then waits for an optional
// `code#state` line on stdin; success = `Login successful.` + exit 0 + `oauthAccount` appearing in the global config.
// The app never reads, stores or shows a token: only the URL and the CLI's own messages pass through.
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type * as P from '../../shared/protocol.ts';
import type { AccountStore, Logger, LoginService } from '../contracts.ts';
import { accountEnv } from '../engine/options.ts';
import { execHidden, spawnHidden, treeKill } from '../util/winproc.ts';
import { fsGuard } from '../util/fs-guard.ts';
import type { FsGuard } from '../util/fs-guard.ts';
import { LOGIN_TIMEOUT_MS } from '../../shared/limits.ts';
import { identityOf, oauthOf, readGlobalConfig } from './profiles.ts';

const URL_RE = /visit:\s*(https?:\/\/\S+)/i;
const STRAY_URL_RE = /(https:\/\/(?:claude\.ai|console\.anthropic\.com|platform\.claude\.com)\/\S+)/i;
const OK_RE = /Login successful\./;
const FAIL_RE = /(Login failed[^\n]*|Invalid code[^\n]*)/;
/** A machine whose managed settings forbid this login (forceLoginMethod / forceLoginOrgUUID / managed gateway). Heuristic. */
const MANAGED_RE = /(managed settings|forceLogin(?:Method|OrgUUID)|managed by your organi[sz]ation|not allowed by your organi[sz]ation)[^\n]*/i;
/** LoginStep error: `key` = login.err.* (French copy client side), `message` = the raw detail.
 *  login.err.failed renders {detail} = message; login.err.exit renders {code} = message. */
type ErrKey = 'timeout' | 'failed' | 'exit' | 'spawn' | 'managed' | 'cancelled';
export const loginError = (k: ErrKey, message: string): P.LoginStep => ({ step: 'error', key: `login.err.${k}`, message });
const LOGOUT_TIMEOUT_MS = 60_000;
const OAUTH_WAIT_MS = 5_000;

type Run = { child: ChildProcess; timer: NodeJS.Timeout; done: boolean; cancelled: boolean };

export type LoginDeps = {
  accounts: AccountStore; exe: () => string; log: Logger;
  /** Tests: arguments placed before `auth login` (e.g. the fake CLI script run by node.exe). */
  argsPrefix?: () => string[];
  timeoutMs?: number;
  /** How long to wait for oauthAccount after `Login successful.` (default 5 s). */
  oauthWaitMs?: number;
  guard?: FsGuard;
  /** Tests: the env base (defaults to process.env, scrubbed by accountEnv). */
  envBase?: NodeJS.ProcessEnv;
};

export function createLoginService(d: LoginDeps): LoginService {
  const runs = new Map<P.AccountId, Run>();
  const starting = new Map<P.AccountId, { cancelled: boolean }>();   // between start() and the spawn
  const prefix = (): string[] => d.argsPrefix?.() ?? [];

  async function waitForOauth(configDir: string | null, home: string): Promise<P.AccountView['identity'] | undefined> {
    const until = Date.now() + (d.oauthWaitMs ?? OAUTH_WAIT_MS);
    for (;;) {
      const id = identityOf(oauthOf(readGlobalConfig(configDir, home)));
      if (id || Date.now() > until) return id;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async function ensureProfileDir(configDir: string): Promise<void> {
    try { if (fs.statSync(configDir).isDirectory()) return; } catch { /* missing */ }
    await (d.guard ?? fsGuard()).createProfileDir(configDir);     // the only app write under a profile: an EMPTY folder
  }

  const svc: LoginService = {
    start(id, email, onStep) {
      const acc = d.accounts.get(id);
      if (!acc) { onStep(loginError('failed', `unknown account: ${id}`)); return; }
      svc.cancel(id);                                            // works when the method is called unbound too
      const paths = d.accounts.paths(id);
      const home = acc.configDir === null ? path.dirname(paths.globalConfig) : path.dirname(acc.configDir);
      const token = { cancelled: false };
      starting.set(id, token);
      void (async () => {
        if (acc.configDir !== null) await ensureProfileDir(acc.configDir);
        if (starting.get(id) === token) starting.delete(id);
        if (token.cancelled) return;
        const args = [...prefix(), 'auth', 'login', ...(email ? ['--email', email] : [])];
        const child = spawnHidden(d.exe(), args, { env: accountEnv(acc.configDir, false, d.envBase), stdio: ['pipe', 'pipe', 'pipe'], cwd: paths.configHome });
        const run: Run = { child, done: false, cancelled: false, timer: setTimeout(() => {
          if (run.done) return;
          finish(loginError('timeout', `no answer after ${Math.round((d.timeoutMs ?? LOGIN_TIMEOUT_MS) / 1000)} s`));
          if (child.pid !== undefined) void treeKill(child.pid);
        }, d.timeoutMs ?? LOGIN_TIMEOUT_MS) };
        runs.set(id, run);
        let out = '';
        let urlSent = false;
        let ok = false;
        let failMsg = '';
        const finish = (s: P.LoginStep): void => {
          if (run.done) return;
          run.done = true;
          clearTimeout(run.timer);
          if (runs.get(id) === run) runs.delete(id);
          if (!run.cancelled) onStep(s);
        };
        const onData = (chunk: string): void => {
          out = (out + chunk).slice(-16_384);
          if (!urlSent) {
            const m = URL_RE.exec(out) ?? STRAY_URL_RE.exec(out);
            if (m?.[1]) { urlSent = true; onStep({ step: 'url', url: m[1] }); onStep({ step: 'waiting' }); }
          }
          if (OK_RE.test(out)) ok = true;
          const f = FAIL_RE.exec(out);
          if (f?.[1]) failMsg = f[1].trim();
        };
        child.stdout?.setEncoding('utf8').on('data', onData);
        child.stderr?.setEncoding('utf8').on('data', onData);
        child.stdin?.on('error', () => undefined);
        child.on('error', (e) => finish(loginError('spawn', e.message)));
        child.on('close', (code) => {
          if (run.done) return;
          if (code === 0 && ok) {
            void waitForOauth(acc.configDir, home).then((ident) => {
              void d.accounts.update(id, {}).catch(() => undefined);   // re-read the profile now
              if (ident) finish({ step: 'done', email: ident.email, plan: ident.plan });
              else finish(loginError('failed', 'Login successful, but no oauthAccount in the profile'));
            });
          } else {
            const managed = MANAGED_RE.exec(out)?.[0]?.trim();
            if (managed) finish(loginError('managed', managed));
            else if (failMsg) finish(loginError('failed', failMsg));
            else finish(loginError('exit', String(code ?? 'null')));
          }
        });
      })().catch((e: unknown) => {
        if (starting.get(id) === token) starting.delete(id);
        if (token.cancelled) return;
        d.log.warn('login: start failed', { err: e });
        onStep(loginError('spawn', e instanceof Error ? e.message : String(e)));
      });
    },
    code(id, code) {
      const r = runs.get(id);
      const c = String(code ?? '').trim();
      if (!r || r.done || !c || /[\r\n]/.test(c) || c.length > 4096) return;
      r.child.stdin?.write(`${c}\n`);
    },
    cancel(id) {
      const t = starting.get(id);
      if (t) { t.cancelled = true; starting.delete(id); }
      const r = runs.get(id);
      if (!r) return;
      r.cancelled = true;
      r.done = true;
      clearTimeout(r.timer);
      runs.delete(id);
      if (r.child.pid !== undefined && r.child.exitCode === null) void treeKill(r.child.pid);
    },
    async logout(id) {
      const acc = d.accounts.get(id);
      if (!acc) throw Object.assign(new Error(`unknown account: ${id}`), { code: 'not_found' });
      const res = await execHidden(d.exe(), [...prefix(), 'auth', 'logout'], { env: accountEnv(acc.configDir, false, d.envBase), timeoutMs: LOGOUT_TIMEOUT_MS });
      await d.accounts.update(id, {}).catch(() => undefined);
      if (res.code !== 0) throw new Error(`claude auth logout failed (code ${res.code ?? 'null'})`);
    },
  };
  return svc;
}
