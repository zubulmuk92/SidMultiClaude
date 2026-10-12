// src/server/claude/accounts.ts — AccountStore: config.json accounts, identity, usage merge, excludes, trust.
// Read-only on profiles (S10/S11): global config parsed, `.credentials.json` stat'ed only, settings.json read for display.
// The app's own `config.json` (v:1) is shared with MetaStore (port, settings): this store rewrites ONLY its `accounts` key,
// re-reading the file first, so the other keys are preserved (atomic write through fs-guard).
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../../shared/protocol.ts';
import type { Account, AccountStore, Clock, Logger, ProfilePaths, UsageInput } from '../contracts.ts';
import { appPaths, canonicalPath, pathKey, profilePaths, samePath, toSlash } from '../util/paths.ts';
import { accountSlug, isAccountId } from '../util/ids.ts';
import { encodeEnvelope, loadVersioned } from '../util/json-store.ts';
import { fsGuard } from '../util/fs-guard.ts';
import type { FsGuard } from '../util/fs-guard.ts';
import { createMutex } from '../util/mutex.ts';
import { CLEANUP_PERIOD_DAYS_DEFAULT, EXPIRING_SOON_DAYS, HEADTAIL_BYTES } from '../../shared/limits.ts';
import { credentialsMtime, discoverCandidates, identityOf, loginStateOf, monogramOf, oauthOf, preferredColor, readGlobalConfig, suggestedColor, suggestedName } from './profiles.ts';
import type { GlobalConfig } from './profiles.ts';
import { readModelCatalog } from './catalog.ts';
import { eventRows, mergeUsage, refreshRows, snapshotRows } from './usage.ts';
import type { UsageSources } from './usage.ts';
import { nameFilter, watchDir } from './watch.ts';
import type { DirWatcher } from './watch.ts';
import { firstStr } from './headtail.ts';

const DAY = 86_400_000;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
const DESKTOP_ENTRYPOINTS = new Set(['claude-desktop', 'claude-desktop-3p', 'local-agent']);

type ConfigData = Record<string, unknown> & { accounts?: unknown };
type Runtime = {
  g: GlobalConfig | null;
  login: Exclude<P.LoginState, 'reauth'>;
  reauth: { credMtime: number; fetchedAt: unknown } | null;
  usage: UsageSources;
  watchers: DirWatcher[];
  cleanupDays: number;
  defaultMode?: string;
  leakFiles: string[];
  expiringSoon: number;
  expiryScanAt: number;
  sig: string;
  baselineTokens?: number;               // last account.baseline result (memory only)
};

function validStored(x: unknown): Account | null {
  const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
  if (!o || !isAccountId(o['id']) || typeof o['name'] !== 'string' || !o['name'].trim()) return null;
  const configDir = o['configDir'] === null ? null : typeof o['configDir'] === 'string' && path.win32.isAbsolute(o['configDir']) ? o['configDir'] : undefined;
  if (configDir === undefined) return null;
  const color = Number.isInteger(o['color']) && (o['color'] as number) >= 1 && (o['color'] as number) <= 8 ? (o['color'] as number) : 1;
  const monogram = typeof o['monogram'] === 'string' && o['monogram'].trim() ? [...o['monogram'].trim()].slice(0, 2).join('') : [...o['name'].trim()][0]!.toUpperCase();
  const dRaw = (o['defaults'] && typeof o['defaults'] === 'object' ? o['defaults'] : {}) as Record<string, unknown>;
  const defaults: Account['defaults'] = {};
  if (typeof dRaw['model'] === 'string' && /^[\w.\-[\]]{1,80}$/.test(dRaw['model'])) defaults.model = dRaw['model'];
  if (typeof dRaw['effort'] === 'string' && EFFORTS.has(dRaw['effort'])) defaults.effort = dRaw['effort'] as P.Effort;
  if (typeof dRaw['mode'] === 'string' && MODES.has(dRaw['mode'])) defaults.mode = dRaw['mode'] as P.PermissionModeId;
  return {
    id: o['id'], name: o['name'].trim().slice(0, 40), color, monogram, configDir,
    hidden: o['hidden'] === true,
    excludeForeignClaudeMd: configDir !== null && o['excludeForeignClaudeMd'] !== false,
    resumeStable: typeof o['resumeStable'] === 'boolean' ? o['resumeStable'] : null,
    defaults,
  };
}
const toStored = (a: Account): Record<string, unknown> => ({
  id: a.id, name: a.name, color: a.color, monogram: a.monogram, configDir: a.configDir, hidden: a.hidden,
  excludeForeignClaudeMd: a.excludeForeignClaudeMd, resumeStable: a.resumeStable, defaults: a.defaults,
});

function readSettings(configHome: string): Record<string, unknown> {
  try { const o = JSON.parse(fs.readFileSync(path.join(configHome, 'settings.json'), 'utf8')) as unknown; return o && typeof o === 'object' ? (o as Record<string, unknown>) : {}; } catch { return {}; }
}
/** Files of the default profile's user memory that leak into other profiles as Project memory. */
function leakFilesOf(home: string): string[] {
  const out: string[] = [];
  const base = path.join(home, '.claude');
  try { if (fs.statSync(path.join(base, 'CLAUDE.md')).isFile()) out.push(path.join(base, 'CLAUDE.md')); } catch { /* none */ }
  try {
    for (const e of fs.readdirSync(path.join(base, 'rules'), { recursive: true, withFileTypes: true })) {
      if (e.isFile() && /\.md$/i.test(e.name)) out.push(path.join(e.parentPath, e.name));
      if (out.length > 50) break;
    }
  } catch { /* no rules */ }
  return out;
}

export function createAccountStore(d: { appDir: string; homeReal: string; log: Logger; clock: Clock; guard?: FsGuard }): AccountStore {
  const home = d.homeReal;
  const configFile = appPaths(d.appDir).config;
  const guard = (): FsGuard => d.guard ?? fsGuard();
  const saveMutex = createMutex();
  let accounts: Account[] = [];
  const rt = new Map<P.AccountId, Runtime>();
  const listeners = new Set<(id: P.AccountId) => void>();
  let started = false;

  const loadConfig = (): ConfigData => loadVersioned<ConfigData>({
    file: configFile, version: 1, defaults: () => ({}),
    accept: (x) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as ConfigData) : undefined),
  }).data;
  const save = (): Promise<void> => saveMutex.run(async () => {
    const cur = loadConfig();
    cur.accounts = accounts.map(toStored);
    await guard().writeFileAtomic(configFile, encodeEnvelope(1, cur));
  });
  const emit = (id: P.AccountId): void => {
    for (const cb of listeners) { try { cb(id); } catch (e) { d.log.warn('accounts: listener failed', { err: e }); } }
  };
  const ppaths = (a: Account): ProfilePaths => {
    const p = profilePaths(a.configDir, home);
    return { configHome: p.configHome, globalConfig: p.globalConfig, projectsDir: p.projectsDir, sessionsDir: p.sessionsDir, credentials: p.credentials };
  };

  function scanExpiry(a: Account, r: Runtime): void {
    r.expiryScanAt = d.clock.now();
    const now = d.clock.now();
    const limit = now - Math.max(0, r.cleanupDays - EXPIRING_SOON_DAYS) * DAY;
    const projects = ppaths(a).projectsDir;
    void (async () => {
      let n = 0;
      let dirs: fs.Dirent[] = [];
      try { dirs = await fs.promises.readdir(projects, { withFileTypes: true }); } catch { /* none */ }
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        let files: string[] = [];
        try { files = (await fs.promises.readdir(path.join(projects, dir.name))).filter((f) => /\.jsonl$/i.test(f)); } catch { continue; }
        for (const f of files) {
          const file = path.join(projects, dir.name, f);
          try {
            const st = await fs.promises.stat(file);
            if (st.mtimeMs >= limit) continue;
            const fh = await fs.promises.open(file, 'r');
            try {
              const b = Buffer.allocUnsafe(Math.min(HEADTAIL_BYTES, st.size));
              const got = await fh.read(b, 0, b.length, 0);
              const ep = firstStr(b.toString('utf8', 0, got.bytesRead), 'entrypoint');
              if (!ep || !DESKTOP_ENTRYPOINTS.has(ep)) n++;
            } finally { await fh.close(); }
          } catch { /* vanished */ }
        }
      }
      if (n !== r.expiringSoon) { r.expiringSoon = n; refresh(a.id, true); }
    })().catch((e: unknown) => d.log.warn('accounts: expiry scan failed', { err: e }));
  }

  /** Re-reads the profile (global config, stat of credentials, settings); emits when the view changed. */
  function refresh(id: P.AccountId, force = false): void {
    const a = accounts.find((x) => x.id === id);
    if (!a) return;
    let r = rt.get(id);
    if (!r) {
      r = { g: null, login: 'disconnected', reauth: null, usage: {}, watchers: [], cleanupDays: CLEANUP_PERIOD_DAYS_DEFAULT, leakFiles: [], expiringSoon: 0, expiryScanAt: 0, sig: '' };
      rt.set(id, r);
    }
    const g = readGlobalConfig(a.configDir, home);
    r.g = g;
    r.login = loginStateOf(a.configDir, home, g);
    if (r.reauth) {
      const fetchedAt = fetchedAtOf(g);
      if (r.login !== 'connected' || credentialsMtime(a.configDir, home) !== r.reauth.credMtime || fetchedAt !== r.reauth.fetchedAt) r.reauth = null;
    }
    const snap = g?.['cachedUsageUtilization'];
    const acct = oauthOf(g)?.accountUuid;
    if (snap && typeof snap === 'object') {
      const s = snap as Record<string, unknown>;
      const owner = typeof s['accountUuid'] === 'string' ? s['accountUuid'] : undefined;
      const at = typeof s['fetchedAtMs'] === 'number' ? s['fetchedAtMs'] : 0;
      if (!owner || !acct || owner === acct) r.usage.snapshot = { at, rows: snapshotRows(s) }; else delete r.usage.snapshot;
    } else delete r.usage.snapshot;
    const settings = readSettings(ppaths(a).configHome);
    const cpd = settings['cleanupPeriodDays'];
    r.cleanupDays = typeof cpd === 'number' && Number.isFinite(cpd) && cpd >= 1 ? Math.floor(cpd) : CLEANUP_PERIOD_DAYS_DEFAULT;
    const perms = settings['permissions'] as Record<string, unknown> | undefined;
    if (typeof perms?.['defaultMode'] === 'string') r.defaultMode = perms['defaultMode']; else delete r.defaultMode;
    r.leakFiles = a.configDir === null ? [] : leakFilesOf(home);
    if (started && d.clock.now() - r.expiryScanAt > 3_600_000) scanExpiry(a, r);
    ensureWatch(a, r);
    const sig = JSON.stringify(view(a));
    if (force || sig !== r.sig) { const changed = r.sig !== ''; r.sig = sig; if (changed || force) emit(id); }
  }

  function ensureWatch(a: Account, r: Runtime): void {
    if (!started || r.watchers.some((w) => !w.closed)) return;
    for (const w of r.watchers) w.close();
    r.watchers = [];
    const p = profilePaths(a.configDir, home);
    const targets: [string, string[]][] = a.configDir === null
      ? [[home, ['.claude.json']], [p.configHome, ['.credentials.json', 'settings.json', '.config.json']]]
      : [[a.configDir, ['.claude.json', '.config.json', '.credentials.json', 'settings.json']]];
    for (const [dir, names] of targets) {
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        r.watchers.push(watchDir(dir, { recursive: false, filter: nameFilter(...names), clock: d.clock, log: d.log, onError: () => { /* re-armed on next refresh */ } }, () => refresh(a.id)));
      } catch (e) { d.log.warn('accounts: cannot watch profile dir', { err: e }); }
    }
  }

  function duplicateOf(a: Account): P.AccountId | undefined {
    const mine = oauthOf(rt.get(a.id)?.g ?? null)?.accountUuid;
    if (!mine) return undefined;
    for (const b of accounts) {
      if (b.id === a.id) return undefined;                      // only an EARLIER account is the original
      if (oauthOf(rt.get(b.id)?.g ?? null)?.accountUuid === mine) return b.id;
    }
    return undefined;
  }
  function view(a: Account): P.AccountView {
    const r = rt.get(a.id);
    const g = r?.g ?? null;
    const isDefault = a.configDir === null;
    const identity = identityOf(oauthOf(g));
    const usage = r ? mergeUsage(r.usage, d.clock.now()) : undefined;
    const dup = duplicateOf(a);
    const cli = typeof g?.['lastReleaseNotesSeen'] === 'string' ? g['lastReleaseNotesSeen'] : undefined;
    const login: P.LoginState = r ? (r.reauth && r.login === 'connected' ? 'reauth' : r.login) : 'disconnected';
    return {
      id: a.id, name: a.name, color: a.color, monogram: a.monogram, configDir: a.configDir, isDefault, hidden: a.hidden, login,
      ...(identity ? { identity } : {}), ...(usage ? { usage } : {}),
      defaults: { ...a.defaults },
      diag: {
        leakFiles: isDefault ? [] : [...(r?.leakFiles ?? [])], leakExcluded: !isDefault && a.excludeForeignClaudeMd,
        resumeStable: a.resumeStable, cleanupDays: r?.cleanupDays ?? CLEANUP_PERIOD_DAYS_DEFAULT, expiringSoon: r?.expiringSoon ?? 0,
        ...(dup ? { duplicateOf: dup } : {}), ...(cli ? { cliVersion: cli } : {}), ...(r?.defaultMode ? { defaultMode: r.defaultMode } : {}), ...(r?.baselineTokens !== undefined ? { baselineTokens: r.baselineTokens } : {}),
      },
    };
  }
  const must = (id: P.AccountId): Account => {
    const a = accounts.find((x) => x.id === id);
    if (!a) throw Object.assign(new Error(`unknown account: ${id}`), { code: 'not_found' });
    return a;
  };

  const store: AccountStore & { close(): void; refreshNow(id: P.AccountId): void } = {
    async start() {
      const data = loadConfig();
      const raw = Array.isArray(data.accounts) ? data.accounts : [];
      const seen = new Set<string>();
      accounts = [];
      for (const x of raw) {
        const a = validStored(x);
        if (!a || seen.has(a.id)) continue;
        if (a.configDir !== null) {
          a.configDir = canonicalPath(a.configDir);              // long form: paths() and every watcher need it (8.3)
          // `~\.claude` set explicitly selects the phantom global config: it IS the default profile
          if (samePath(a.configDir, path.join(home, '.claude'))) { a.configDir = null; a.excludeForeignClaudeMd = false; }
        }
        if (a.configDir !== null && accounts.some((b) => b.configDir !== null && samePath(b.configDir, a.configDir!))) continue;
        if (a.configDir === null && accounts.some((b) => b.configDir === null)) continue;
        seen.add(a.id);
        accounts.push(a);
      }
      started = true;
      for (const a of accounts) { refresh(a.id); const r = rt.get(a.id); if (r) r.sig = JSON.stringify(view(a)); }
    },
    list() { return accounts.map(view); },
    get(id) { const a = accounts.find((x) => x.id === id); return a ? { ...a, defaults: { ...a.defaults } } : undefined; },
    paths(id) { return ppaths(must(id)); },
    async candidates() {
      // First run: every candidate not added yet gets a suggested name / colour / monogram, unique against the
      // accounts and the suggestions before it (« Perso », « Perso 2 »…; colours 1, 2, … free ones first)
      const taken = accounts.map((a) => a.name);
      const used = new Set(accounts.map((a) => a.color));
      const list = discoverCandidates(home).map((c) => ({
        ...c, added: accounts.some((a) => (a.configDir === null ? c.configDir === null : c.configDir !== null && samePath(a.configDir, c.configDir))),
      }));
      // colours: the preferred ones (default profile → 1, .claude-pro → 2) are served first, whatever the listing order
      const colors = new Map<P.AccountCandidate, number>();
      const pref = (c: P.AccountCandidate): number => (preferredColor(c.configDir) ? 0 : 1);
      for (const c of [...list].filter((x) => !x.added).sort((a, b) => pref(a) - pref(b))) { const col = suggestedColor(c.configDir, used); used.add(col); colors.set(c, col); }
      return list.map((c) => {
        if (c.added) return c;
        const name = suggestedName(oauthOf(readGlobalConfig(c.configDir, home)), c.configDir, taken);
        taken.push(name);
        return { ...c, suggested: { name, color: colors.get(c) ?? 1, monogram: monogramOf(name) } };
      });
    },
    async add(x) {
      const configDir = x.configDir === null ? null : canonicalPath(x.configDir);
      if (configDir !== null && (samePath(configDir, path.join(home, '.claude')) || samePath(configDir, home))) {
        throw Object.assign(new Error('the default profile is configDir null (CLAUDE_CONFIG_DIR unset)'), { code: 'invalid' });
      }
      if (accounts.some((a) => (a.configDir === null ? configDir === null : configDir !== null && samePath(a.configDir, configDir)))) {
        throw Object.assign(new Error('profile already added'), { code: 'invalid' });
      }
      const name = String(x.name ?? '').trim().slice(0, 40) || suggestedName(oauthOf(readGlobalConfig(configDir, home)), configDir, accounts.map((b) => b.name));
      const a: Account = {
        id: accountSlug(name, accounts.map((b) => b.id)), name,
        color: Number.isInteger(x.color) && x.color >= 1 && x.color <= 8 ? x.color : suggestedColor(configDir, new Set(accounts.map((b) => b.color))),
        monogram: [...String(x.monogram ?? '').trim()].slice(0, 2).join('').toUpperCase() || monogramOf(name),
        configDir, hidden: false, excludeForeignClaudeMd: configDir !== null, resumeStable: null, defaults: {},
      };
      accounts.push(a);
      await save();
      refresh(a.id, true);
      return view(a);
    },
    async update(id, patch) {
      const a = must(id);
      if (patch.name !== undefined && String(patch.name).trim()) a.name = String(patch.name).trim().slice(0, 40);
      if (patch.color !== undefined && Number.isInteger(patch.color) && patch.color >= 1 && patch.color <= 8) a.color = patch.color;
      if (patch.monogram !== undefined && String(patch.monogram).trim()) a.monogram = [...String(patch.monogram).trim()].slice(0, 2).join('');
      if (patch.hidden !== undefined) a.hidden = patch.hidden === true;
      if (patch.excludeForeignClaudeMd !== undefined) a.excludeForeignClaudeMd = a.configDir !== null && patch.excludeForeignClaudeMd === true;
      if (patch.defaults) {
        const p = patch.defaults;
        if (p.model === null) delete a.defaults.model; else if (typeof p.model === 'string' && /^[\w.\-[\]]{1,80}$/.test(p.model)) a.defaults.model = p.model;
        if (p.effort === null) delete a.defaults.effort; else if (p.effort !== undefined && EFFORTS.has(p.effort)) a.defaults.effort = p.effort;
        if (p.mode === null) delete a.defaults.mode; else if (p.mode !== undefined && MODES.has(p.mode)) a.defaults.mode = p.mode;
      }
      await save();
      refresh(id, true);                                       // an empty patch = « re-read the profile now » (login done)
      return view(a);
    },
    claudeMdExcludes(id) {
      const a = must(id);
      if (a.configDir === null || !a.excludeForeignClaudeMd) return [];
      const h = toSlash(home);                                 // exact case, `/` separators: matching is case-sensitive
      return [`${h}/.claude/CLAUDE.md`, `${h}/.claude/rules/**`];
    },
    trustedInCli(id, cwd) {
      const g = rt.get(must(id).id)?.g ?? null;
      const projects = g?.['projects'];
      if (!projects || typeof projects !== 'object') return false;
      const want = new Set<string>();
      let cur = pathKey(cwd);
      for (;;) {                                               // the CLI also honours a trusted parent folder
        want.add(toSlash(cur));
        const up = path.win32.dirname(cur);
        if (up === cur) break;
        cur = up;
      }
      for (const [k, v] of Object.entries(projects as Record<string, unknown>)) {
        if (!v || typeof v !== 'object' || (v as Record<string, unknown>)['hasTrustDialogAccepted'] !== true) continue;
        if (want.has(toSlash(pathKey(k)))) return true;
      }
      return false;
    },
    modelCatalog(id) {
      const a = must(id);
      return readModelCatalog(ppaths(a).configHome, oauthOf(rt.get(id)?.g ?? null)?.organizationUuid);
    },
    cleanupDays(id) { return rt.get(must(id).id)?.cleanupDays ?? CLEANUP_PERIOD_DAYS_DEFAULT; },
    noteUsage(id, u: UsageInput) {
      const r = rt.get(id);
      if (!r) return;
      const at = d.clock.now();
      if (u.kind === 'event') { const e = eventRows(u.info); if (e.rows.length || e.status) r.usage.event = { at, ...e }; }
      else r.usage.refresh = { at, ...refreshRows(u.data) };
      refresh(id, true);
    },
    noteAuthError(id) {
      const a = accounts.find((x) => x.id === id);
      const r = rt.get(id);
      if (!a || !r || r.reauth) return;
      r.reauth = { credMtime: credentialsMtime(a.configDir, home), fetchedAt: fetchedAtOf(r.g) };
      refresh(id, true);
    },
    noteResumeStable(id, v) {
      const a = accounts.find((x) => x.id === id);
      if (!a || a.resumeStable === v) return;
      a.resumeStable = v;
      void save().catch((e: unknown) => d.log.warn('accounts: save failed', { err: e }));
      refresh(id, true);
    },
    noteBaseline(id, tokens) {
      const r = rt.get(id);
      if (!r || !Number.isFinite(tokens) || tokens < 0) return;
      r.baselineTokens = Math.round(tokens);
      refresh(id, true);
    },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    close() { for (const r of rt.values()) { for (const w of r.watchers) w.close(); r.watchers = []; } started = false; },
    refreshNow(id) { refresh(id, true); },
  };
  return store;
}

function fetchedAtOf(g: GlobalConfig | null): unknown {
  return (g?.oauthAccount as Record<string, unknown> | undefined)?.['profileFetchedAt'];
}
