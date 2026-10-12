// test/helpers/tmp-profile.ts — throwaway homes and Claude config dirs for tests. NEVER real ones.
// Layout (mirrors the machine):
//   <root>\home\                   fake home  (= server --profiles-root)
//   <root>\home\.claude\           default profile data dir (CLAUDE_CONFIG_DIR unset)
//   <root>\home\.claude.json       default profile global config
//   <root>\home\.claude-<name>\    other profiles (+ their own .claude.json)
//   <root>\app\                    fake %LOCALAPPDATA%\SidMultiClaude (= server --data-dir)
//   <root>\work\<name>\            project folders (cwds)
//   <root>\ext\<name>\             config dirs outside home (a "configured dir")
// Every write of this helper is checked to stay inside <root>; the root is created under the OS temp dir and must not
// be inside any real Claude profile. `.credentials.json` files written here are fake placeholders (never tokens).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalPath, homeReal, isInside, profilePaths, projectKey, PROFILE_DIR_NAME_RE } from '../../src/server/util/paths.ts';
import type { ProfilePaths } from '../../src/server/contracts.ts';
import type { PermissionModeId } from '../../src/shared/protocol.ts';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');

export type LoginKind = 'connected' | 'disconnected' | 'incoherent-token' | 'incoherent-account' | 'credman';
export type OAuthAccountInit = {
  accountUuid?: string; emailAddress?: string; displayName?: string; fullName?: string;
  organizationUuid?: string; organizationName?: string; organizationType?: string; organizationRole?: string;
  seatTier?: string | null; organizationRateLimitTier?: string; userRateLimitTier?: string | null;
};
export type ProfileInit = {
  login?: LoginKind;                       // default 'connected'
  account?: OAuthAccountInit;              // merged over a synthetic account (example.invalid emails)
  settings?: Record<string, unknown>;      // <cfg>\settings.json
  claudeMd?: string;                       // <cfg>\CLAUDE.md
  catalog?: boolean;                       // <cfg>\cache\model-catalog\<org>-<hash>-cc.json (default true when connected)
  usage?: Record<string, unknown>;         // global config cachedUsageUtilization
  globalConfig?: Record<string, unknown>;  // extra global-config keys
};
export type TurnInit = {
  user: string;
  assistant?: string;
  tool?: { name: string; input: Record<string, unknown>; result: string; isError?: boolean; toolUseResult?: unknown };
  model?: string;
  usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; ttl5m?: boolean };
  error?: 'rate_limit' | 'authentication_failed';
  resetsAt?: number;                       // with error 'rate_limit' (epoch seconds, like quotaLimits.resetsAt)
};
export type SessionInit = {
  cwd: string;
  sessionId?: string;
  title?: string;                          // custom-title (re-appended in the tail like the CLI)
  aiTitle?: string;
  sidecarTitle?: string;                   // <sid>\custom-title.json
  turns?: TurnInit[];                      // default: one short turn
  entrypoint?: string;                     // default 'sdk-ts' (app sessions); 'cli' for terminal ones
  version?: string;                        // default '2.1.294'
  gitBranch?: string;                      // default 'HEAD'
  startedAt?: number;                      // epoch ms of the first entry (default: 2026-10-08T10:00:00Z)
  lastMode?: PermissionModeId;             // a permission-mode tail entry
  costUsd?: number;                        // a cost-state tail entry
  ownerAccountUuid?: string;               // a bridge-session tail entry
  instructions?: string[];                 // first-turn attachment{type:'instructions'} file paths
  extraEntries?: Record<string, unknown>[];
  mtime?: Date;                            // utimes of the .jsonl (retention / ordering tests)
};
export type RegistryInit = {
  pid: number; sessionId: string; cwd?: string; kind?: string; entrypoint?: string;
  status?: 'busy' | 'idle' | 'waiting' | 'blocked'; procStart?: string; updatedAt?: number; startedAt?: number; name?: string;
};
export interface TmpProfile {
  readonly configDir: string | null;       // null = default profile
  readonly paths: ProfilePaths;
  readonly accountUuid: string | undefined;
  setLogin(kind: LoginKind, account?: OAuthAccountInit): void;
  readGlobalConfig(): Record<string, unknown>;
  writeGlobalConfig(patch: Record<string, unknown>): void;     // shallow merge
  writeSettings(s: Record<string, unknown>): void;
  trust(cwd: string, sep?: '/' | '\\'): void;                   // projects[<path>].hasTrustDialogAccepted = true
  addCatalog(models?: { id: string; name: string; efforts?: string[]; quickSelect?: boolean }[]): string;
  addSession(o: SessionInit): { sessionId: string; path: string; entries: Record<string, unknown>[] };
  /** Copies a sanitized pair transcript (test/fixtures/pairs/<name>/transcript.jsonl); `cwd` rewrites every recorded cwd. */
  addFixtureSession(name: string, o?: { cwd?: string }): { sessionId: string; path: string };
  addRegistry(o: RegistryInit): string;                         // sessions\<pid>.json (+ a decoy <pid>.<hash>.key)
  addHistory(entries: { display: string; project: string; sessionId: string; timestamp?: number }[]): void;
}
export interface TmpRoot {
  readonly root: string;
  readonly home: string;
  readonly appDir: string;
  cwd(name: string): string;                                    // creates <root>\work\<name>, returns realpathNative
  defaultProfile(o?: ProfileInit): TmpProfile;
  profile(name: string, o?: ProfileInit): TmpProfile;           // <home>\.claude-<name>
  externalProfile(name: string, o?: ProfileInit): TmpProfile;   // <root>\ext\<name> (configured dir outside home)
  /** <home>\.claude\.claude.json without oauthAccount: the "phantom" global config. */
  writePhantomGlobalConfig(): string;
  dispose(): void;
  /** Like dispose(), but waits for handles released late (a watcher closed in the same tick, an antivirus scan). */
  disposeAsync(): Promise<void>;
}

// ------------------------------------------------------------------ safety
function assertSafeRoot(root: string): void {
  const tmp = canonicalPath(os.tmpdir());
  if (!isInside(root, tmp, false)) throw new Error(`tmp-profile: root must be inside the OS temp dir: ${root}`);
  let realHome: string | null = null;
  try { realHome = homeReal(); } catch { /* no home */ }
  if (realHome && isInside(root, realHome, false)) {
    const first = path.relative(realHome, root).split(/[\\/]/)[0] ?? '';
    if (PROFILE_DIR_NAME_RE.test(first) || /^\.claude\.json/i.test(first)) throw new Error(`tmp-profile: refusing a root inside a real Claude profile: ${root}`);
  }
}

export function createTmpRoot(label = 'test'): TmpRoot {
  const base = canonicalPath(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, `smc-${label.replace(/[^\w-]/g, '_')}-`)));
  assertSafeRoot(root);
  const home = path.join(root, 'home');
  const appDir = path.join(root, 'app');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  const guardWrite = (p: string): string => {
    if (!isInside(p, root)) throw new Error(`tmp-profile: write outside the temp root refused: ${p}`);
    return p;
  };
  const writeJson = (p: string, o: unknown): void => {
    guardWrite(p);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(o, null, 2));
  };
  const makeProfile = (configDir: string | null, o: ProfileInit = {}): TmpProfile => {
    const paths = profilePaths(configDir, home);
    fs.mkdirSync(guardWrite(paths.configHome), { recursive: true });
    let accountUuid: string | undefined;
    const readGlobal = (): Record<string, unknown> => {
      try { return JSON.parse(fs.readFileSync(paths.globalConfig, 'utf8')) as Record<string, unknown>; } catch { return {}; }
    };
    const writeGlobal = (patch: Record<string, unknown>): void => writeJson(paths.globalConfig, { ...readGlobal(), ...patch });
    const p: TmpProfile = {
      configDir,
      paths,
      get accountUuid() { return accountUuid; },
      setLogin(kind, account) {
        const acct = syntheticAccount(configDir ? path.basename(configDir) : 'default', { ...(o.account ?? {}), ...(account ?? {}) });
        const g = readGlobal();
        delete g['oauthAccount'];
        const flags = (g['cachedGrowthBookFeatures'] ?? {}) as Record<string, unknown>;
        delete flags['tengu_windows_credman'];
        const withAccount = kind === 'connected' || kind === 'incoherent-account' || kind === 'credman';
        const withCred = kind === 'connected' || kind === 'incoherent-token';
        if (withAccount) g['oauthAccount'] = acct;
        if (kind === 'credman') flags['tengu_windows_credman'] = true;
        g['cachedGrowthBookFeatures'] = flags;
        writeJson(paths.globalConfig, g);
        accountUuid = withAccount ? acct.accountUuid : undefined;
        if (withCred) {
          guardWrite(paths.credentials);
          fs.writeFileSync(paths.credentials, JSON.stringify({ note: 'fake credentials written by test/helpers/tmp-profile.ts; never a token' }));
        } else fs.rmSync(paths.credentials, { force: true });
      },
      readGlobalConfig: readGlobal,
      writeGlobalConfig: writeGlobal,
      writeSettings: (s) => writeJson(path.join(paths.configHome, 'settings.json'), s),
      trust(cwd, sep = '/') {
        const g = readGlobal();
        const projects = (g['projects'] ?? {}) as Record<string, Record<string, unknown>>;
        const key = sep === '/' ? cwd.replace(/\\/g, '/') : cwd.replace(/\//g, '\\');
        projects[key] = { ...(projects[key] ?? {}), allowedTools: [], hasTrustDialogAccepted: true };
        writeJson(paths.globalConfig, { ...g, projects });
      },
      addCatalog(models) {
        const org = ((readGlobal()['oauthAccount'] ?? {}) as Record<string, unknown>)['organizationUuid'] ?? '00000000-0000-4000-8000-0000000000aa';
        const file = path.join(paths.configHome, 'cache', 'model-catalog', `${String(org)}-${randomBytes(4).toString('hex')}-cc.json`);
        const list = models ?? [
          { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], quickSelect: true },
          { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], quickSelect: true },
          { id: 'claude-haiku-5-5', name: 'Haiku 5.5', efforts: ['low', 'medium', 'high'], quickSelect: true },
        ];
        writeJson(file, {
          version: 2, fetchedAt: '2026-10-08T09:00:00.000Z', staleAt: '2026-10-08T10:00:00.000Z',
          catalog: { surface: 'cc', config: { id: 'cc', models: list.map((m) => ({
            id: m.id, name: m.name, short_name: m.name, description: `${m.name} (catalogue de test)`, section: 'main', capabilities: {},
            thinking: { type: 'effort', description: 'Effort', effort_options: (m.efforts ?? []).map((e) => ({ id: e, name: e })) },
            quick_select: m.quickSelect ?? false, min_claude_code_version: '2.1.0',
          })) } },
        });
        return file;
      },
      addSession(s) {
        const sessionId = s.sessionId ?? randomUUID();
        const entries = buildTranscript({ ...s, sessionId });
        const dir = path.join(paths.projectsDir, projectKey(s.cwd));
        const file = path.join(dir, `${sessionId}.jsonl`);
        guardWrite(file);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
        if (s.sidecarTitle !== undefined) writeJson(path.join(dir, sessionId, 'custom-title.json'), { customTitle: s.sidecarTitle });
        if (s.mtime) fs.utimesSync(file, s.mtime, s.mtime);
        return { sessionId, path: file, entries };
      },
      addFixtureSession(name, fo) {
        const src = path.join(FIXTURES, 'pairs', name, 'transcript.jsonl');
        const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
        const sessionId = String(lines.find((e) => typeof e['sessionId'] === 'string')?.['sessionId'] ?? '');
        const recordedCwd = String(lines.find((e) => typeof e['cwd'] === 'string')?.['cwd'] ?? fo?.cwd ?? '');
        const cwd = fo?.cwd ?? recordedCwd;
        if (fo?.cwd) for (const e of lines) if (typeof e['cwd'] === 'string') e['cwd'] = fo.cwd;
        const dir = path.join(paths.projectsDir, projectKey(cwd));
        const file = path.join(dir, `${sessionId}.jsonl`);
        guardWrite(file);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
        return { sessionId, path: file };
      },
      addRegistry(r) {
        const file = path.join(paths.sessionsDir, `${r.pid}.json`);
        const now = r.updatedAt ?? Date.now();
        writeJson(file, {
          pid: r.pid, sessionId: r.sessionId, cwd: r.cwd ?? root, startedAt: r.startedAt ?? now - 60_000,
          procStart: r.procStart ?? '134041872000000000', version: '2.1.294', peerProtocol: 1, peerFeatures: ['notify_idle'],
          kind: r.kind ?? 'interactive', entrypoint: r.entrypoint ?? 'cli', pidDomain: 'win32:TESTHOST',
          messagingSocketPath: `\\\\.\\pipe\\LOCAL\\cc-msg-${randomBytes(8).toString('hex')}`, name: r.name ?? 'session de test',
          nameSince: now - 60_000, status: r.status ?? 'idle', statusUpdatedAt: now, updatedAt: now,
        });
        // Decoy secret: a *.key file must NEVER be opened by the app (fs-spy test).
        const key = path.join(paths.sessionsDir, `${r.pid}.${randomBytes(32).toString('hex')}.key`);
        guardWrite(key);
        fs.writeFileSync(key, 'decoy messaging secret written by tmp-profile; the app must never open *.key files');
        return file;
      },
      addHistory(entries) {
        const file = guardWrite(path.join(paths.configHome, 'history.jsonl'));
        const t0 = Date.UTC(2026, 9, 8, 9, 0, 0);
        fs.appendFileSync(file, entries.map((e, i) => JSON.stringify({ display: e.display, pastedContents: {}, timestamp: e.timestamp ?? t0 + i * 1000, project: e.project, sessionId: e.sessionId })).join('\n') + '\n');
      },
    };
    if (o.claudeMd !== undefined) { guardWrite(path.join(paths.configHome, 'CLAUDE.md')); fs.writeFileSync(path.join(paths.configHome, 'CLAUDE.md'), o.claudeMd); }
    if (o.settings) p.writeSettings(o.settings);
    p.setLogin(o.login ?? 'connected');
    if (o.usage) writeGlobal({ cachedUsageUtilization: o.usage });
    if (o.globalConfig) writeGlobal(o.globalConfig);
    if (o.catalog ?? ((o.login ?? 'connected') === 'connected')) p.addCatalog();
    return p;
  };
  return {
    root, home, appDir,
    cwd(name) {
      const d = path.join(root, 'work', name);
      fs.mkdirSync(guardWrite(d), { recursive: true });
      return fs.realpathSync.native(d);
    },
    defaultProfile: (o) => makeProfile(null, o),
    profile: (name, o) => makeProfile(path.join(home, `.claude-${name}`), o),
    externalProfile: (name, o) => makeProfile(path.join(root, 'ext', name), o),
    writePhantomGlobalConfig() {
      const f = path.join(home, '.claude', '.claude.json');
      writeJson(f, { firstStartTime: '2026-08-27T12:37:00.000Z', firstStartVersion: '2.1.246', numStartups: 1 });
      return f;
    },
    dispose() {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* AV or a watcher may hold a handle */ }
    },
    async disposeAsync() {
      // On Windows a closed fs.watch handle is released on a later tick: rmSync right after close() fails with EPERM.
      for (let i = 0; i < 40 && fs.existsSync(root); i++) {
        try { await fs.promises.rm(root, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
    },
  };
}

// ------------------------------------------------------------------ synthetic data
export function syntheticAccount(label: string, a: OAuthAccountInit = {}): Required<Pick<OAuthAccountInit, 'accountUuid' | 'emailAddress' | 'organizationUuid' | 'organizationName' | 'organizationType'>> & OAuthAccountInit {
  const slug = label.replace(/^\.claude-?/, '') || 'default';
  return {
    accountUuid: randomUUID(), emailAddress: `${slug}@example.invalid`, displayName: `Test ${slug}`, fullName: `Test ${slug}`,
    organizationUuid: randomUUID(), organizationName: `Org ${slug}`, organizationType: 'claude_max', organizationRole: 'admin',
    seatTier: null, organizationRateLimitTier: 'default_claude_max_5x', userRateLimitTier: 'default_claude_max_5x',
    ...a,
  } as Required<Pick<OAuthAccountInit, 'accountUuid' | 'emailAddress' | 'organizationUuid' | 'organizationName' | 'organizationType'>> & OAuthAccountInit;
}

/** A structure-faithful CLI 2.1.294 transcript: chain entries + the metadata re-append block. */
export function buildTranscript(o: SessionInit & { sessionId: string }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let t = o.startedAt ?? Date.UTC(2026, 9, 8, 10, 0, 0);
  const ts = (): string => new Date((t += 1000)).toISOString();
  const env = { isSidechain: false, userType: 'external', entrypoint: o.entrypoint ?? 'sdk-ts', cwd: o.cwd, sessionId: o.sessionId, version: o.version ?? '2.1.294', gitBranch: o.gitBranch ?? 'HEAD' };
  const turns = o.turns ?? [{ user: 'Bonjour', assistant: 'Bonjour ! Que puis-je faire ?' }];
  let parent: string | null = null;
  let lastPrompt = '';
  if (o.title) out.push({ type: 'custom-title', customTitle: o.title, sessionId: o.sessionId });
  turns.forEach((turn, i) => {
    const userUuid = randomUUID();
    lastPrompt = turn.user;
    out.push({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(t).toISOString(), sessionId: o.sessionId, content: turn.user });
    out.push({ type: 'queue-operation', operation: 'dequeue', timestamp: new Date(t).toISOString(), sessionId: o.sessionId });
    out.push({ parentUuid: parent, ...env, type: 'user', message: { role: 'user', content: turn.user }, uuid: userUuid, timestamp: ts(),
      promptId: randomUUID(), permissionMode: o.lastMode ?? 'default', promptSource: 'sdk', origin: { kind: 'human' }, turnOrigin: 'human' });
    parent = userUuid;
    if (i === 0 && o.instructions?.length) {
      const a = randomUUID();
      out.push({ parentUuid: parent, ...env, type: 'attachment', attachment: { type: 'instructions', files: o.instructions.map((p) => ({ path: p, content: '[instructions de test]', type: 'Project' })) }, uuid: a, timestamp: ts() });
      parent = a;
    }
    const model = turn.model ?? 'claude-haiku-5-5';
    const u = turn.usage ?? {};
    const usage = {
      input_tokens: u.input ?? 2, cache_creation_input_tokens: u.cacheWrite ?? 120, cache_read_input_tokens: u.cacheRead ?? 18_000, output_tokens: u.output ?? 40,
      cache_creation: { ephemeral_5m_input_tokens: u.ttl5m ? (u.cacheWrite ?? 120) : 0, ephemeral_1h_input_tokens: u.ttl5m ? 0 : (u.cacheWrite ?? 120) },
      service_tier: 'standard', inference_geo: 'not_available',
    };
    const msg = (content: unknown[], stop: string): Record<string, unknown> => ({ model, id: `msg_${randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', content, stop_reason: stop, stop_sequence: null, usage });
    if (turn.error) {
      const a = randomUUID();
      out.push({ parentUuid: parent, ...env, type: 'assistant', message: { ...msg([{ type: 'text', text: turn.error === 'rate_limit' ? 'Limite atteinte (test).' : 'Please run /login' }], 'stop_sequence'), model: '<synthetic>' },
        isApiErrorMessage: true, error: turn.error, ...(turn.error === 'rate_limit' ? { quotaLimits: { status: 'rejected', resetsAt: turn.resetsAt ?? Math.floor(t / 1000) + 3600, rateLimitType: 'five_hour' } } : {}),
        uuid: a, timestamp: ts() });
      parent = a;
      return;
    }
    if (turn.tool) {
      const toolId = `toolu_${randomBytes(12).toString('hex')}`;
      const a = randomUUID();
      const m = msg([{ type: 'tool_use', id: toolId, name: turn.tool.name, input: turn.tool.input, caller: { type: 'direct' } }], 'tool_use');
      out.push({ parentUuid: parent, ...env, type: 'assistant', message: m, requestId: `req_${randomBytes(12).toString('hex')}`, effort: 'medium', uuid: a, timestamp: ts() });
      const r = randomUUID();
      out.push({ parentUuid: a, ...env, type: 'user', message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: turn.tool.result, is_error: turn.tool.isError ?? false }] },
        uuid: r, timestamp: ts(), toolUseResult: turn.tool.toolUseResult ?? { stdout: turn.tool.result, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, sourceToolAssistantUUID: a });
      parent = r;
    }
    if (turn.assistant !== undefined) {
      const a = randomUUID();
      out.push({ parentUuid: parent, ...env, type: 'assistant', message: msg([{ type: 'text', text: turn.assistant }], 'end_turn'), requestId: `req_${randomBytes(12).toString('hex')}`, effort: 'medium', uuid: a, timestamp: ts() });
      parent = a;
    }
  });
  // metadata re-append block (the CLI re-appends it at the tail)
  out.push({ type: 'last-prompt', lastPrompt, leafUuid: parent, sessionId: o.sessionId });
  if (o.title) out.push({ type: 'custom-title', customTitle: o.title, sessionId: o.sessionId });
  if (o.aiTitle) out.push({ type: 'ai-title', aiTitle: o.aiTitle, sessionId: o.sessionId });
  out.push({ type: 'mode', mode: 'normal', sessionId: o.sessionId });
  if (o.lastMode) out.push({ type: 'permission-mode', permissionMode: o.lastMode, sessionId: o.sessionId });
  if (o.ownerAccountUuid) out.push({ type: 'bridge-session', bridgeSessionId: randomUUID(), lastSequenceNum: 1, ownerAccountUuid: o.ownerAccountUuid, ownerOrganizationUuid: randomUUID(), sessionId: o.sessionId });
  if (o.costUsd !== undefined) out.push({ type: 'cost-state', totalCostUSD: o.costUsd, totalAPIDuration: 1000, totalToolDuration: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalDuration: 2000, startTime: o.startedAt ?? 0, modelUsage: {}, sessionId: o.sessionId });
  for (const e of o.extraEntries ?? []) out.push(e);
  return out;
}
