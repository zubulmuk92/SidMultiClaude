// src/server/main.ts — composition root (SPEC §3, §5.5 server shell boot/shutdown order, §2.9 crash marker).
// Flags: --open --background --supervised --port <n> --data-dir <dir> --fake-engine --profiles-root <dir> --print-boot.
// Exit codes: 0 = stop, 75 = restart requested (the launcher's supervisor restarts on anything else, ≤ 3 per 60 s).
// --print-boot contract with test/e2e/harness.ts: one stdout line `SMC_BOOT {"port":<n>,"boot":"<code>"}` once listening.
// `startApp()` is exported for the in-process integration tests; the process entry runs only when this file is main.
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../shared/protocol.ts';
import type {
  AccountStore, Engine, LiveRegistry, Logger, LoginService, PromptHistory, QueryFn, SdkHelpers, SessionIndex, TranscriptReader,
} from './contracts.ts';
import { EXIT_CODE_RESTART, EXIT_CODE_STOP, SHUTDOWN_DEADLINE_MS } from '../shared/limits.ts';
import { LEAKY_ENV } from './engine/options.ts';
import { realClock } from './util/clock.ts';
import { newBootId } from './util/ids.ts';
import { createLogger } from './util/log.ts';
import type { AppLogger } from './util/log.ts';
import { appPaths, canonicalPath, defaultAppRoot, homeReal, realpathNative } from './util/paths.ts';
import { configureFsGuard, fsGuard } from './util/fs-guard.ts';

export type Args = {
  open: boolean; background: boolean; supervised: boolean; port: number | null; dataDir: string | null; fakeEngine: boolean;
  profilesRoot: string | null; printBoot: boolean;
};
export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { open: false, background: false, supervised: false, port: null, dataDir: null, fakeEngine: false, profilesRoot: null, printBoot: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`missing value for ${k}`); return v; };
    if (k === '--open') a.open = true;
    else if (k === '--background') a.background = true;
    else if (k === '--supervised') a.supervised = true;
    else if (k === '--fake-engine') a.fakeEngine = true;
    else if (k === '--print-boot') a.printBoot = true;
    else if (k === '--port') { const n = Number(val()); if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('invalid --port'); a.port = n; }
    else if (k === '--data-dir') a.dataDir = val();
    else if (k === '--profiles-root') a.profilesRoot = val();
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}
/** Step 7: the port to persist after the bind (localStorage, notifications and the device token are scoped
 *  to http://127.0.0.1:<port>, so a fallback port must stick). null = nothing to save (--port given, test mode, unchanged). */
export function portToPersist(o: { test: boolean; argPort: number | null; bound: number; stored: number }): number | null {
  return !o.test && o.argPort === null && o.bound > 0 && o.bound !== o.stored ? o.bound : null;
}
/** Step 1: CLAUDECODE / CLAUDE_* / ANTHROPIC_* (and the other leaky names) never reach a child or the page. */
export function scrubEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const gone = Object.keys(env).filter((k) => LEAKY_ENV.test(k));
  for (const k of gone) delete env[k];
  return gone;
}

// ---------------------------------------------------------------- inert stand-ins (a module that fails to build never stops boot)
const unsupported = (): never => { throw Object.assign(new Error('module unavailable'), { code: 'unsupported' }); };
const noop = (): void => {};
export const inert = {
  index: (): SessionIndex => ({ start: async () => {}, list: () => [], get: () => undefined, reconcile: async () => {}, onChange: () => noop }),
  registry: (): LiveRegistry => ({ start: noop, holder: () => null, setOwnPids: noop, onChange: () => noop }),
  reader: (): TranscriptReader => ({ tail: async () => unsupported(), before: async () => unsupported(), line: async () => null, search: async () => [],
    firstInstructions: async () => [], hasUserUuid: async () => false }),
  helpers: (): SdkHelpers => ({ rename: async () => unsupported(), remove: async () => unsupported(), forkUpTo: async () => unsupported() }),
  history: (): PromptHistory => ({ append: noop, search: async () => [] }),
  login: (): LoginService => ({ start: (_i, _e, on) => on({ step: 'error', message: 'indisponible' }), code: noop, cancel: noop, logout: async () => unsupported() }),
  accounts: (): AccountStore => ({ start: async () => {}, list: () => [], get: () => undefined, paths: () => unsupported(), candidates: async () => [],
    add: async () => unsupported(), update: async () => unsupported(), claudeMdExcludes: () => [], trustedInCli: () => false, modelCatalog: () => [],
    cleanupDays: () => 30, noteUsage: noop, noteAuthError: noop, noteResumeStable: noop, noteBaseline: noop, onChange: () => noop }),
};
function safeCreate<T>(log: Logger, name: string, make: () => T, fallback: () => T): T {
  try { return make(); } catch (e) { log.error('module unavailable, inert stand-in used', { module: name, err: String(e).slice(0, 300) }); return fallback(); }
}

// ---------------------------------------------------------------- the app
import type { Clock, EngineSink } from './contracts.ts';
import { createMetaStore } from './app/meta.ts';
import { createOrchestrator } from './app/orchestrator.ts';
import type { Orchestrator } from './app/orchestrator.ts';
import { createCommands } from './app/commands.ts';
import { createLifetime, readBootCrashState, writeCrashMarker, clearRunFiles } from './app/lifetime.ts';
import { createHub } from './ws/hub.ts';
import type { HubImpl } from './ws/hub.ts';
import { createRpc } from './ws/rpc.ts';
import { createGuardedServer } from './http/guard.ts';
import { buildStatic } from './http/static.ts';
import { askRunningInstanceToOpen, bindFirstFree, createPlatform, holdInstanceLock, pipePath, portCandidates, PROJECT_ROOT } from './platform/win.ts';
import { createAccountStore } from './claude/accounts.ts';
import { createSessionIndex } from './claude/session-index.ts';
import { createLiveRegistry } from './claude/registry.ts';
import { createTranscriptReader } from './claude/reader.ts';
import { createSdkHelpers } from './claude/sdk-helpers.ts';
import { createPromptHistory } from './claude/history.ts';
import { createLoginService } from './claude/login.ts';
import { createEngine } from './engine/engine.ts';
import { createSpawner } from './engine/spawner.ts';
import { createLiveReducer } from './model/live-reducer.ts';
import { createChatState } from './model/chat-state.ts';
import { diskToTurns, detailFromEntry } from './model/disk-turns.ts';
import { activityLine, deriveTitle } from './model/derive.ts';
import { wakeEstimate } from './model/accounting.ts';

export type AppOptions = {
  args: Args;
  env?: NodeJS.ProcessEnv;
  /** Injected engine (tests). It receives the orchestrator's sink through setSink(). */
  engine?: Engine & { setSink?(s: EngineSink): void };
  clock?: Clock;
  exit?: (code: number) => void;                     // default process.exit
  openWindow?: (port: number, bootCode: string) => void;
  singleInstance?: boolean;                          // default true (tests may skip the pipe)
  logConsole?: boolean;
};
export type AppHandle = {
  port: number; origin: string; boot: string; listenMs: number;
  newBootCode(): string; openWindow(): void;
  hub: HubImpl; orch: Orchestrator; engine: Engine; meta: ReturnType<typeof createMetaStore>; log: AppLogger;
  shutdown(code?: number): Promise<void>;
};
/** Thrown by startApp when another instance owns the pipe (it was asked to open a window). */
export class AlreadyRunning extends Error { constructor() { super('already running'); this.name = 'AlreadyRunning'; } }

export async function startApp(o: AppOptions): Promise<AppHandle> {
  const t0 = performance.now();
  const marks: Record<string, number> = {};
  const mark = (k: string): void => { marks[k] = Math.round(performance.now() - t0); };
  const a = o.args;
  const env = o.env ?? process.env;
  const clock = o.clock ?? realClock;
  const test = env['SMC_TEST'] === '1';
  // 2. app paths and log (every write goes through fs-guard, confined to the app folder)
  const root = a.dataDir ? path.resolve(a.dataDir) : defaultAppRoot(env);
  const home = a.profilesRoot ? realpathNative(path.resolve(a.profilesRoot)) : homeReal();
  let accounts: AccountStore = inert.accounts();
  configureFsGuard({ allowRoots: [canonicalPath(root)], home, profileDirs: () => accounts.list().map((x) => x.configDir).filter((x): x is string => !!x) });
  fsGuard().mkdirSync(root, { recursive: true });                             // even the app root goes through fs-guard (S11: never under a profile)
  const paths = appPaths(realpathNative(root));
  for (const dir of [paths.stateDir, paths.runDir, paths.logsDir, paths.cacheDir]) fsGuard().mkdirSync(dir, { recursive: true });
  const log = createLogger({ dir: paths.logsDir, console: o.logConsole ?? false, clock });
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const ensureDir = (dir: string): void => { fsGuard().mkdirSync(dir, { recursive: true }); };

  // 3. single instance: the pipe has one verb, "open a window" (S18)
  let openWindowRef: () => void = () => {};
  const pipe = pipePath(a.dataDir ? paths.root : null, env);
  let lock: import('node:net').Server | null = null;
  if (o.singleInstance !== false) {
    lock = await holdInstanceLock(pipe, () => openWindowRef());
    if (!lock) {
      const answered = await askRunningInstanceToOpen(pipe);
      log.info('second launch: hand-off to the running instance', { answered });
      log.close();
      throw new AlreadyRunning();
    }
  }
  mark('lock');
  // 4. crash marker: read the previous one, then write ours
  const crash = readBootCrashState(paths);
  const startedAt = clock.now();
  writeCrashMarker(paths.crashMarker, { pid: process.pid, startedAt, live: [] });

  // 5. MetaStore → AccountStore → SessionIndex → LiveRegistry → Engine (the SDK is imported at the first spawn)
  const meta = createMetaStore({ appDir: paths.root, log: log.child('meta'), clock });
  accounts = safeCreate(log, 'accounts', () => createAccountStore({ appDir: paths.root, homeReal: home, log: log.child('accounts'), clock }), inert.accounts);
  try { await accounts.start(); } catch (e) { log.error('accounts.start failed', { err: String(e) }); accounts = inert.accounts(); }
  mark('accounts');
  const index = safeCreate(log, 'index', () => createSessionIndex({ accounts, cacheDir: paths.cacheDir, log: log.child('index'), clock }), inert.index);
  const registry = safeCreate(log, 'registry', () => createLiveRegistry({ accounts, log: log.child('registry') }), inert.registry);
  const reader = safeCreate(log, 'reader', () => createTranscriptReader({ log: log.child('reader') }), inert.reader);
  const helpers = safeCreate(log, 'helpers', () => createSdkHelpers({ log: log.child('helpers') }), inert.helpers);
  const history = safeCreate(log, 'history', () => createPromptHistory({ accounts, appDir: paths.root,
    cwdOf: (id) => { try { return meta.chat(id)?.cwd ?? index.get(id)?.cwd; } catch { return undefined; } } }), inert.history);
  const platform = createPlatform({ appDir: paths.root, log: log.child('platform'), home, helpersFile: paths.helpers, edgeProfile: paths.edgeProfile,
    probeCwd: paths.probeCwd, configDirs: () => accounts.list().map((x) => x.configDir).filter((x): x is string => !!x) });
  const exe = (pref: 'installed' | 'bundled'): P.Result<string, 'exe_missing'> => platform.claudeExe(pref);
  const cliPath = (): string => { const r = exe(meta.settings().exe); return r.ok ? r.data : 'claude.exe'; };
  // SMC_TEST only (the only case where the CLI can be a script, engine/exe.ts): the fake runs under this node.exe, as the SDK does
  const scriptCli = (): boolean => test && /\.m?js$/i.test(cliPath());
  const login = safeCreate(log, 'login', () => createLoginService({ accounts, log: log.child('login'),
    exe: () => (scriptCli() ? process.execPath : cliPath()), argsPrefix: () => (scriptCli() ? [cliPath()] : []) }), inert.login);
  const hub = createHub({ clock, log: log.child('hub') });
  const boot = newBootId();
  let lifetimeRef: { check(): void; onAsk(): void } | null = null;
  const orch = createOrchestrator({ clock, log: log.child('orch'), hub, meta, accounts, index, registry, history, helpers, boot,
    model: { createLiveReducer, createChatState, deriveTitle, activityLine, wakeEstimate },
    onLifetime: (ev) => { if (ev === 'ask') lifetimeRef?.onAsk(); else lifetimeRef?.check(); markerDirty(); },
    onLiveSet: () => { markerDirty(); liveSetChanged(); } });                                      // spawn or exit: run\crash.marker lists the live chats

  mark('modules');
  // SMC_TEST only: SMC_TEST_FREE_MEM_MB pins the free memory the pool sees (E2E suites must not depend on the machine's RAM:
  // under 1.5 GB free the cap drops to max(2, live)). Never read outside test mode.
  const pinnedFreeMb = test && /^\d+$/.test(env['SMC_TEST_FREE_MEM_MB'] ?? '') ? Number(env['SMC_TEST_FREE_MEM_MB']) : null;
  const freeMemBytes = (): number => (pinnedFreeMb !== null ? pinnedFreeMb * 1024 * 1024 : platform.freeMemBytes());
  // engine: injected (tests), --fake-engine, or the real one with the SDK loaded lazily at the first spawn
  let engine: Engine;
  if (o.engine) { engine = o.engine; o.engine.setSink?.(orch.sink); }
  else if (a.fakeEngine) {
    const { createFakeEngine } = await import('../../test/fakes/fake-engine.ts');
    const fe = createFakeEngine({ now: () => clock.now(), autoReply: true });
    fe.setSink(orch.sink);
    engine = fe;
  } else {
    let sdk: { query: QueryFn } | null = null;
    const loadSdk = async (): Promise<void> => { sdk ??= (await import('@anthropic-ai/claude-agent-sdk')) as unknown as { query: QueryFn }; };
    const query = ((args: Parameters<QueryFn>[0]) => {
      if (!sdk) throw Object.assign(new Error('sdk not loaded'), { code: 'spawn_failed' });
      return sdk.query(args);
    }) as QueryFn;
    const spawner = createSpawner({ jobrunPath: platform.jobrunPath(), registryFile: paths.children, log: log.child('spawner') });
    const real = createEngine({ query, clock, sink: orch.sink, spawner, log: log.child('engine'), freeMemBytes,
      holder: (acc, sid) => registry.holder(acc, sid) });
    const ensure = real.ensure.bind(real);
    real.ensure = async (spec, eo) => {
      try { await loadSdk(); } catch (e) { log.error('sdk import failed', { err: String(e) }); return { ok: false, err: { code: 'spawn_failed' } }; }
      return ensure(spec, eo);
    };
    engine = real;
  }
  orch.attachEngine(engine);
  const st0 = meta.settings();
  engine.setPolicy({ maxLive: st0.maxLive, reapMin: st0.reapMin });

  /** SessionIndex.setLive at once (not debounced): the index must stop treating an exited chat as live before the
   *  reconcile the orchestrator starts on exit. */
  function liveSetChanged(): void {
    try { closers.index.setLive?.(new Set(engine.stats().items.map((x) => x.chatId))); } catch (e) { log.warn('index.setLive failed', { err: String(e) }); }
  }
  // Claude data extras (feature-detected: an inert stand-in has none of them)
  const closers = {
    index: index as SessionIndex & { setLive?(s: ReadonlySet<P.ChatId>): void; close?(): Promise<void> },
    registry: registry as LiveRegistry & { close?(): void },
    accounts: () => accounts as AccountStore & { close?(): void },
    history: history as PromptHistory & { flush?(): Promise<void> },
  };
  // crash marker: the live chats, rewritten (debounced) when the live set changes
  let markerTimer: { cancel(): void } | null = null;
  let closing = false;
  function markerDirty(): void {
    if (markerTimer || closing) return;
    markerTimer = clock.timer(1_000, () => {
      markerTimer = null;
      if (closing) return;
      try { writeCrashMarker(paths.crashMarker, { pid: process.pid, startedAt, live: engine.stats().items.map((x) => x.chatId) }); } catch { /* best effort */ }
    });
  }

  mark('engine');
  // 6. static map + guard + hub
  const st = buildStatic({ webRoot: path.join(PROJECT_ROOT, 'src', 'web'), nodeModules: path.join(PROJECT_ROOT, 'node_modules'), assetsDir: path.join(PROJECT_ROOT, 'assets') });
  let deviceToken: string | null = null;
  try { const dv = JSON.parse(fs.readFileSync(paths.device, 'utf8')) as { data?: { token?: unknown } }; if (typeof dv.data?.token === 'string') deviceToken = dv.data.token; } catch { /* first run */ }
  let orphans: { pid: number; name: string }[] = [];
  const guard = createGuardedServer({
    indexHtml: st.indexHtml, importMap: st.importMap, staticFiles: st.files, deviceToken, clock, addSecret: (s) => log.addSecret(s),
    saveDeviceToken: (token) => { try { fsGuard().writeFileAtomicSync(paths.device, JSON.stringify({ v: 1, data: { token } }), { backup: false }); } catch (e) { log.error('device token not saved', { err: String(e) }); } },
    onDenied: (why) => log.warn('ws upgrade denied', { why }),
    onClient: (ws) => {
      let hello: P.S2C;
      try { hello = orch.hello(); } catch (e) {                                  // S20: never a window left without hello
        log.error('hello failed', { err: String((e as Error)?.stack ?? e).slice(0, 2_000) });
        try { ws.close(1011, 'hello'); } catch { /* closing */ }
        return;
      }
      const c = hub.attach(ws);
      hub.send(c, [hello], true);
      if (orphans.length) hub.send(c, [{ t: 'orphans', items: orphans }]);
    },
  });
  const commands = createCommands({ clock, log: log.child('cmd'), hub, orch, meta, accounts, index, reader, helpers, history, login, registry, platform,
    engine: () => engine, model: { diskToTurns, deriveTitle, detailFromEntry }, exe, home, probeCwd: paths.probeCwd, ensureDir,
    quit: () => { void shutdown(EXIT_CODE_STOP); }, lastOrphans: () => orphans });
  const rpc = createRpc({ handlers: commands, log: log.child('rpc'), sendAck: (c, ack) => hub.send(c, [ack], true) });
  hub.onMessage((c, text) => { void rpc.handle(c, text); });
  hub.onViewChange(() => orch.onViewChange());

  mark('static');
  // lifetime (C13) and the window
  const openWindow = (): void => {
    const code = guard.newBootCode();
    if (o.openWindow) { o.openWindow(guard.port, code); return; }
    if (test) { process.stdout.write(`SMC_BOOT ${JSON.stringify({ port: guard.port, boot: code })}\n`); return; }
    const pid = platform.openAppWindow(guard.port, code, meta.settings().browser);
    if (pid === undefined) log.warn('no browser found for the app window');
  };
  openWindowRef = openWindow;
  const lifetime = createLifetime({ clock, log: log.child('lifetime'), connections: () => hub.connections(), liveCount: () => engine.stats().live,
    pendingAsks: () => orch.pendingAskCount(), reopenEnabled: () => meta.settings().reopenWindowOnAttention, openWindow,
    exit: () => { void shutdown(EXIT_CODE_STOP); }, background: a.background });
  lifetimeRef = lifetime;
  hub.onConnect(() => lifetime.onConnect());
  hub.onEmpty(() => lifetime.check());

  // 7. bind 127.0.0.1 (preferred port, then 41732–41750, persisted)
  const preferred = a.port ?? (test ? 0 : meta.settings().port);
  const port = await bindFirstFree((p) => guard.listen(p), portCandidates(preferred));
  const keep = portToPersist({ test, argPort: a.port, bound: port, stored: meta.settings().port });
  if (keep !== null) meta.saveSettings({ port: keep });
  const listenMs = performance.now() - t0;
  log.info('listening', { port, ms: Math.round(listenMs), boot, marks });

  // 8. run\instance.json, background starts, --open / --print-boot, lifetime rule
  try { fsGuard().writeFileAtomicSync(paths.instance, JSON.stringify({ pid: process.pid, port, startedAt }), { backup: false }); } catch (e) { log.warn('instance.json not written', { err: String(e) }); }
  orch.start();
  try { registry.start(); } catch (e) { log.error('registry.start failed', { err: String(e) }); }
  void Promise.resolve().then(() => index.start()).catch((e: unknown) => log.error('index.start failed', { err: String(e) }));
  if (crash.crashed) {
    log.warn('previous run crashed', { live: crash.live.length, children: crash.children.length });
    for (const id of crash.live) orch.addNotice(id, { kind: 'notice', text: 'sys.serverRestart', data: { key: 'sys.serverRestart' } });
    const plain = meta.settings().isolation === 'plain' || !platform.jobrunAvailable();
    if (plain && crash.children.length) {
      void platform.listOrphans(crash.children).then((items) => {
        orphans = items;
        if (items.length) hub.push(null, [{ t: 'orphans', items }]);
      }, (e: unknown) => log.warn('orphan scan failed', { err: String(e) }));
    }
  }
  if (a.printBoot) process.stdout.write(`SMC_BOOT ${JSON.stringify({ port, boot: guard.newBootCode() })}\n`);
  if (a.open) openWindow();
  lifetime.check();

  // shutdown order: lifetime off → engine (deadline) → bye → flush → close server → run files → exit
  let shuttingDown: Promise<void> | null = null;
  function shutdown(code: number = EXIT_CODE_STOP): Promise<void> {
    shuttingDown ??= (async () => {
      closing = true;
      markerTimer?.cancel();
      lifetime.dispose();
      log.info('shutdown', { code });
      // Everything below runs within SHUTDOWN_DEADLINE_MS (15 s): the engine gets the bulk, each later step what is left.
      const t0s = performance.now();
      const left = (): number => Math.max(0, SHUTDOWN_DEADLINE_MS - (performance.now() - t0s));
      const within = async (what: string, p: () => Promise<unknown> | unknown, reserveMs = 0): Promise<void> => {
        let timer: NodeJS.Timeout | undefined;
        const ms = Math.max(0, left() - reserveMs);
        const cut = new Promise<void>((r) => { timer = setTimeout(() => { log.warn('shutdown step cut by the deadline', { what }); r(); }, ms); timer.unref(); });
        try { await Promise.race([Promise.resolve().then(p).then(() => undefined, (e: unknown) => log.error(`${what} failed`, { err: String(e) })), cut]); }
        finally { clearTimeout(timer); }
      };
      await within('engine shutdown', () => engine.shutdown(SHUTDOWN_DEADLINE_MS - 3_000), 1_500);
      hub.push(null, [{ t: 'bye', reason: code === EXIT_CODE_RESTART ? 'restart' : 'quit' }], true);
      hub.flushNow();
      await new Promise((r) => setTimeout(r, Math.min(50, left())));
      await within('meta flush', () => meta.flush());
      await within('history flush', () => closers.history.flush?.());
      await within('index close', () => closers.index.close?.());
      await within('registry close', () => closers.registry.close?.());
      await within('accounts close', () => closers.accounts().close?.());
      orch.dispose();
      hub.closeAll(1001, 'bye');
      await within('server close', () => guard.close());
      lock?.close();
      clearRunFiles(paths);
      log.info('bye', { code });
      log.close();
      exit(code);
    })();
    return shuttingDown;
  }
  return { port, origin: guard.origin, boot, listenMs, newBootCode: () => guard.newBootCode(), openWindow, hub, orch, engine, meta, log, shutdown };
}

// ---------------------------------------------------------------- process entry
async function main(): Promise<void> {
  let args: Args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${String((e as Error).message)}\n`); process.exit(2); }
  scrubEnv();                                                                   // 1. before anything reads process.env
  let app: AppHandle | null = null;
  // S20: never exit on an unhandled rejection or exception; log it (attributed by the handlers' own try/catch)
  process.on('unhandledRejection', (e) => { app?.log.error('unhandledRejection', { err: String((e as Error)?.stack ?? e).slice(0, 2_000) }); });
  process.on('uncaughtException', (e) => { app?.log.error('uncaughtException', { err: String(e?.stack ?? e).slice(0, 2_000) }); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => { if (app) void app.shutdown(EXIT_CODE_STOP); else process.exit(EXIT_CODE_STOP); });
  try {
    app = await startApp({ args, logConsole: process.env['SMC_LOG_CONSOLE'] === '1' });
  } catch (e) {
    if (e instanceof AlreadyRunning) process.exit(EXIT_CODE_STOP);            // the running instance opens the window
    process.stderr.write(`SidMultiClaude: boot failed: ${String((e as Error)?.stack ?? e)}\n`);
    process.exit(1);
  }
}
if (import.meta.main) void main();
