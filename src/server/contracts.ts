// src/server/contracts.ts — server-internal module contracts. TYPES ONLY.
// Every module is built against these interfaces and tested with fakes (test/fakes/*).
import type { query, SDKMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type * as P from '../shared/protocol.ts';

// ============================================================ shared plumbing (src/server/util/*)
export type QueryFn = typeof query;                          // injection point: real SDK | test/fakes/fake-query.ts
export interface Clock { now(): number; timer(ms: number, fn: () => void): { cancel(): void } }
export interface Logger { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void; error(msg: string, f?: Record<string, unknown>): void }
export type SdkFrame = SDKMessage | { type: string; subtype?: string; [k: string]: unknown };  // + runtime-only frames (command_lifecycle…)
export type SleepReason = 'user' | 'reap' | 'evict' | 'logout' | 'terminal' | 'shutdown' | 'rewind' | 'force';

// ============================================================ Claude data (src/server/claude/*)
export type Account = {
  id: P.AccountId; name: string; color: number; monogram: string;
  configDir: string | null;              // null = default profile: CLAUDE_CONFIG_DIR UNSET (never set it to ~\.claude)
  hidden: boolean;
  excludeForeignClaudeMd: boolean;       // default true for non-default profiles, forced false for the default one
  resumeStable: boolean | null;          // null unknown; false when SessionStart hook frames are seen on a spawn
  defaults: { model?: string; effort?: P.Effort; mode?: P.PermissionModeId };
};
export type ProfilePaths = { configHome: string; globalConfig: string; projectsDir: string; sessionsDir: string; credentials: string };
export type UsageInput = { kind: 'event'; info: Record<string, unknown> } | { kind: 'refresh'; data: Record<string, unknown> };
export interface AccountStore {
  start(): Promise<void>;                                     // read config.json + profiles; watch global configs; 0 processes
  list(): P.AccountView[];
  get(id: P.AccountId): Account | undefined;
  paths(id: P.AccountId): ProfilePaths;                       // realpathSync.native, long form
  candidates(): Promise<P.AccountCandidate[]>;
  add(a: { configDir: string | null; name: string; color: number; monogram: string }): Promise<P.AccountView>;
  update(id: P.AccountId, patch: P.AccountPatch): Promise<P.AccountView>;
  claudeMdExcludes(id: P.AccountId): string[];                // [] for the default profile
  trustedInCli(id: P.AccountId, cwd: string): boolean;        // projects[path].hasTrustDialogAccepted, normalised
  modelCatalog(id: P.AccountId): P.ModelOption[];             // cache\model-catalog\*.json, 0 tokens
  cleanupDays(id: P.AccountId): number;                       // settings.json cleanupPeriodDays ?? 30 (display only)
  noteUsage(id: P.AccountId, u: UsageInput): void;            // rate_limit_event / usage_EXPERIMENTAL result
  noteAuthError(id: P.AccountId): void;                       // -> login 'reauth'
  noteResumeStable(id: P.AccountId, v: boolean): void;
  noteBaseline(id: P.AccountId, tokens: number): void;        // account.baseline result → AccountView.diag.baselineTokens
  onChange(cb: (id: P.AccountId) => void): () => void;
}
export interface LoginService {                                // `claude.exe auth login|logout`, hidden, piped, clean env
  start(id: P.AccountId, email: string | undefined, onStep: (s: P.LoginStep) => void): void;
  code(id: P.AccountId, code: string): void;                  // writes `code#state\n` to stdin
  cancel(id: P.AccountId): void;
  logout(id: P.AccountId): Promise<void>;                     // caller sleeps the account's chats first
}
export type SessionMeta = {
  accountId: P.AccountId; sessionId: P.SessionId; chatId: P.ChatId; path: string /* absolute .jsonl */; cwd: string /* recorded */;
  title: string; titleSource: P.ChatSummary['titleSource']; firstPrompt?: string; branch?: string; origin: P.Origin; entrypoint?: string;
  createdAt: number; updatedAt: number; mtimeMs: number; size: number; model?: string; lastMode?: P.PermissionModeId;
  lastContext?: number; lastRequestAt?: number; costUsd?: number; ownerAccountUuid?: string;
  lastError?: { kind: 'rate_limit' | 'auth' | 'other'; resetsAt?: number };
};
export interface SessionIndex {
  start(): Promise<void>;                                     // cache-assisted stat pass + head/tail of changed files + watchers
  list(accountId?: P.AccountId): SessionMeta[];
  get(chatId: P.ChatId): SessionMeta | undefined;
  reconcile(accountId?: P.AccountId): Promise<void>;          // stat-only, on window focus
  onChange(cb: (upsert: SessionMeta[], removed: P.ChatId[]) => void): () => void;
}
export type RawEntry = { off: number; len: number; e: Record<string, unknown> };   // one parsed JSONL line and its byte range
export type ChainPage = { chain: RawEntry[]; cursor: string | null; hasMore: boolean };
export interface TranscriptReader {                            // tail-first; never parses a whole large file on the main thread
  tail(path: string, turns: number): Promise<ChainPage>;      // latest leaf, compaction relink, 256 KiB→2 MiB backwards steps
  before(path: string, cursor: string, turns: number): Promise<ChainPage>;
  line(path: string, off: number, len: number): Promise<Record<string, unknown> | null>;
  search(path: string, q: string, limit: number, signal: AbortSignal): Promise<{ off: number; len: number; snippet: string }[]>;
  firstInstructions(path: string): Promise<string[]>;         // first-turn attachment{type:'instructions'}.files
  hasUserUuid(path: string, uuid: P.Uuid, maxBytes: number): Promise<boolean>;
}
export interface LiveRegistry {                                // <cfg>\sessions\<pid>.json (never *.key)
  start(): void;
  holder(accountId: P.AccountId, sessionId: P.SessionId): P.ExternalHolder | null;   // pid alive + procStart match + not ours
  setOwnPids(pids: ReadonlySet<number>): void;
  onChange(cb: (accountId: P.AccountId, sessionId: P.SessionId, h: P.ExternalHolder | null) => void): () => void;
}
export interface SdkHelpers {                                  // ONE promise-chain mutex: the helpers read process.env.CLAUDE_CONFIG_DIR
  rename(acc: Account, sessionId: P.SessionId, title: string, dir?: string): Promise<void>;
  remove(acc: Account, sessionId: P.SessionId, dir?: string): Promise<void>;
  forkUpTo(acc: Account, sessionId: P.SessionId, upToUuid: P.Uuid, title: string, dir?: string): Promise<P.SessionId>;
}
export interface PromptHistory {                               // app prompts.jsonl + read-only <cfg>\history.jsonl
  append(chatId: P.ChatId, text: string, at: number): void;
  search(q: string, chatId?: P.ChatId): Promise<P.PromptHit[]>;
}

// ============================================================ engine (src/server/engine/*)
export type SpawnStart =
  | { kind: 'new'; title?: string }                                 // options.sessionId = spec.sessionId (app-chosen UUID)
  | { kind: 'resume' }                                              // options.resume = spec.sessionId, recorded cwd
  | { kind: 'fork'; fromJsonl: string; title: string }              // resume = absolute .jsonl, forkSession, sessionId = new UUID
  | { kind: 'rewind'; atUuid: P.Uuid; dropsTurn?: P.Uuid };         // resume + resumeSessionAt (+ resumeDropsTurn)
export type SpawnSpec = {
  chatId: P.ChatId; sessionId: P.SessionId;
  cwd: string;                                                      // realpathSync.native, < 259 chars, S9-checked by the caller
  account: { id: P.AccountId; configDir: string | null; claudeMdExcludes: string[] };
  mode: P.PermissionModeId;                                         // ALWAYS explicit
  start: SpawnStart;
  model?: string; effort?: P.Effort;                                // ONLY when the user picked them (aliases / catalog ids)
  allowBypass: boolean; aiTitles: boolean;
  exe: string; isolation: 'job' | 'plain';
};
export type ProcessFacts = {
  chatId: P.ChatId; sessionId: P.SessionId; phase: 'spawning' | 'live' | 'closing';
  busy: boolean;                 // a delivery queued|started, or a turn between status:requesting and its result with queued_turn_count 0
  pendingAsks: number; bgTasks: number; queuedTurns: number;
  queue: P.QueueItem[];          // deliveries not yet completed/cancelled (chips)
  spawnedAt: number; lastRequestAt?: number; sentAny: boolean;
  ttlMs: number;                 // 3_600_000, or 300_000 when the last cache write was ephemeral_5m only
  mode: P.PermissionModeId; model?: string; cliVersion?: string; cliPid?: number; capabilities: string[];
  stuck: boolean;                // interrupt watchdog (10 s) fired
  autoAvailable?: boolean;       // ModelInfo.supportsAutoMode of the current model; absent = unknown (→ ChatMetaView.autoAvailable)
};
/** `message`: an engine marker, never shown raw —
 *  'reap' (idle reaper, silent) · 'evict:never' (cap victim never used, silent) · 'evict:expired' (cap victim whose cache had
 *  expired: toast chat.sleep) · 'evict' (victim picked in the cap dialog) · 'unkillable' (the tree survived every kill step) ·
 *  'rewind_refused' (the CLI refused --resume-drops-turn and messages were typed meanwhile: they come back as `returned`) ·
 *  'jobrun_failed' (jobrun.exe failed before starting the CLI, same rule). Any other value is a free-form diagnostic. */
export type ExitInfo = { reason: 'closed' | 'crash' | 'killed' | 'spawn_failed' | 'init_timeout'; code: number | null; signal: string | null;
  at: number; stderrTail: string; message?: string };
/** Synthetic frames the engine emits through `EngineSink.frame` (type 'smc_engine'; never from the CLI). The live reducer
 *  ignores them; the orchestrator acts on them:
 *  - initialized: initializationResult() resolved → identity cross-check (`email` vs the profile identity);
 *  - isolation_fallback: this chat runs in plain mode (job spawn failed) → toast isolation.fallback;
 *  - rewind_fallback: the CLI refused the rewind, this process is a plain resume → toast rewind.fallback;
 *  - resume_stable: SessionStart hooks seen (false) or not (true) after init → AccountStore.noteResumeStable;
 *  - external_holder: the post-init registry re-check found another writer; the chat goes back to sleep → « Ouvert ailleurs ». */
export type SmcEngineFrame =
  | { type: 'smc_engine'; subtype: 'initialized'; pid?: number; capabilities: string[]; email?: string; drift?: { added: string[]; removed: string[] } }
  | { type: 'smc_engine'; subtype: 'isolation_fallback' }
  | { type: 'smc_engine'; subtype: 'rewind_fallback' }
  | { type: 'smc_engine'; subtype: 'resume_stable'; stable: boolean }
  | { type: 'smc_engine'; subtype: 'external_holder'; holder: P.ExternalHolder };
/** A delivered user message. `imageTypes`: media types of the SendInput images, in order (live user blocks = disk rebuild);
 *  `imageBytes`: their decoded sizes, same order. Both absent when the message had no image. */
export type DeliveredMsg = { uuid: P.Uuid; text: string; images: number; imageTypes?: string[]; imageBytes?: number[]; folded: boolean; at: number };
export interface EngineSink {
  frame(chatId: P.ChatId, f: SdkFrame, at: number): void;             // every SDK message, in order (+ SmcEngineFrame notes)
  facts(chatId: P.ChatId, f: ProcessFacts): void;                     // on change (coalesced per tick)
  ask(a: P.PendingAsk): void;
  askEnd(chatId: P.ChatId, requestId: string, reason: P.AskEndReason): void;
  delivered(chatId: P.ChatId, m: DeliveredMsg): void;                  // lifecycle 'started' / fold
  sessionChanged(chatId: P.ChatId, sessionId: P.SessionId): void;    // conversation_reset (/clear) or CLI-chosen fork id
  exited(chatId: P.ChatId, info: ExitInfo, returned: P.QueueItem[]): void;
}
export type EnsureWhy = 'prespawn' | 'send' | 'wake' | 'usage' | 'rewind';
export type EnsureOpts = { why: EnsureWhy; evict?: P.ChatId; exceed?: boolean; force?: boolean };
export type SendInput = { uuid: P.Uuid; text: string; images?: P.ImageInput[]; priority?: P.Priority };
export interface Engine {
  isLive(chatId: P.ChatId): boolean;
  facts(chatId: P.ChatId): ProcessFacts | null;
  stats(): P.ProcStats;
  /** Spawn or no-op; cap / external / breaker errors. While the chat's process is closing (or unkillable) it returns
   *  {code:'busy', message:'closing'}: the caller retries after the exit. */
  ensure(spec: SpawnSpec, o: EnsureOpts): Promise<P.Result<void, P.WireError>>;
  send(chatId: P.ChatId, m: SendInput): 'accepted' | 'duplicate' | 'not_live';   // pushes into the InputQueue (works while spawning)
  interrupt(chatId: P.ChatId): Promise<{ stillQueued: P.Uuid[] }>;
  cancelQueued(chatId: P.ChatId, uuid: P.Uuid): Promise<boolean>;
  decide(chatId: P.ChatId, requestId: string, a: P.UiAnswer): 'ok' | 'not_pending';
  setMode(chatId: P.ChatId, m: P.PermissionModeId): Promise<void>;
  setModel(chatId: P.ChatId, model: string | null, effort: P.Effort | null): Promise<void>;
  rename(chatId: P.ChatId, title: string): Promise<void>;                        // live only (q.renameSession)
  task(chatId: P.ChatId, op: 'stop' | 'background' | 'stopAll', ref?: string): Promise<void>;
  contextSummary(chatId: P.ChatId): Promise<P.ContextSummary>;                    // getContextUsage({detail:'summary'}) ONLY
  rules(chatId: P.ChatId): Promise<P.RuleView[]>;                                  // runtime-only listPermissionRules, feature-detected
  commands(chatId: P.ChatId): Promise<P.SlashCommandView[]>;
  usage(chatId: P.ChatId): Promise<Record<string, unknown> | null>;               // usage_EXPERIMENTAL…({skipBehaviors:true}), on click only
  rewindFiles(chatId: P.ChatId, userUuid: P.Uuid, dryRun: boolean): Promise<P.RewindPreview>;
  sleep(chatId: P.ChatId, reason: SleepReason, o?: { stopTasks?: boolean }): Promise<ExitInfo | null>;
  protect(visible: ReadonlySet<P.ChatId>, keepAlive: ReadonlySet<P.ChatId>): void;
  setPolicy(p: { maxLive: number; reapMin: number | null }): void;
  ownPids(): ReadonlySet<number>;                                                  // jobrun + claude.exe pids (registry exclusion)
  asks(chatId?: P.ChatId): P.PendingAsk[];                                         // open asks, oldest first (hello.asks)
  resetBreaker(chatId: P.ChatId): void;                                            // chat.retry (« Réessayer » / « Relancer »); never spawns
  shutdown(deadlineMs: number): Promise<void>;
}
/** The spawner factory (src/server/engine/spawner.ts createSpawner({jobrunPath, registryFile, log, fs?})). `fs`:
 *  the write guard for run\children.json; default = the app-wide fsGuard() once main.ts configured it, plain node:fs only where
 *  no guard exists (tests, scripts). The real spawner also carries SpawnerExtras, which the engine feature-detects:
 *  ownPids() (every live jobrun + CLI pid), noteCliPid(chatId, hostPid, cliPid) (job mode: CLI pid known only from
 *  initializationResult().pid), records() (run\children.json rows, orphan scan after a crash). */
export type SpawnerFactory = (chatId: P.ChatId, isolation: 'job' | 'plain') => (o: SpawnOptions) => SpawnedProcess;
export type EngineDeps = {
  query: QueryFn; clock: Clock; sink: EngineSink; spawner: SpawnerFactory; log: Logger;
  freeMemBytes: () => number; holder: (accountId: P.AccountId, sessionId: P.SessionId) => P.ExternalHolder | null;
};
export type CreateEngine = (d: EngineDeps) => Engine;

// ============================================================ model, pure (src/server/model/*)
export type FrameSignals = {
  sub?: P.SubPhase | null; subTool?: string; retry?: { attempt: number; max: number; inMs: number; status?: number };
  rateLimit?: { status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number; kind?: string; info: Record<string, unknown> };
  authError?: boolean; billingError?: boolean; modelNotFound?: boolean; overloaded?: boolean; turnEnded?: boolean;
};
export type ReduceOut = { events: P.ChatEvent[]; urgent: boolean; signals: FrameSignals };
export interface LiveReducer {                                   // one per live chat; pure state machine over SDK frames
  step(f: SdkFrame, at: number): ReduceOut;
  userStarted(m: DeliveredMsg): P.ChatEvent[];
  localRow(row: P.UiSystemRow, at: number): P.ChatEvent[];       // crash, notices, cache-miss
  /** The process exited without ending its turn: open tools → interrupted, live text frozen, tasks stopped. */
  processExited?(asked?: ReadonlySet<string>): P.ChatEvent[];     // asked: tool_use ids of the asks still open → withdrawn
  liveTurn(): P.UiTurn | null;
  meta(): P.ChatMetaView; metrics(): P.ChatMetrics; tasks(): P.TaskView[]; todos(): P.TodoItem[] | null;
  detail(id: string, field: P.DetailField): P.DetailPayload | null;   // heavy fields of the live turn (≤ 8 MB per chat)
}
/** Cost baseline of a resumed / forked process: the last `cost-state` entry of the transcript tail (SPEC §2.12). */
export type CostBaseline = { costUsd?: number; modelUsage?: Record<string, unknown>; tokens?: number };
/** `baseline`: from baselineFromEntries(transcript tail) for resumed / forked / rewound chats; `resumed`: not a new session. */
export type CreateLiveReducer = (seed: { chatId: P.ChatId; meta: P.ChatMetaView; metrics: P.ChatMetrics; baseline?: CostBaseline | null; resumed?: boolean }) => LiveReducer;
export interface ChatStateMachine {                              // returns true when ChatStateView changed
  onFacts(f: ProcessFacts | null, at: number): boolean;
  onSignals(s: FrameSignals, at: number): boolean;
  onAsks(count: number, oldestAt: number | undefined, kind: P.AskKind | undefined): boolean;
  onExternal(h: P.ExternalHolder | null): boolean;
  onExit(info: ExitInfo, at: number): boolean;
  onUser(ev: 'viewed' | 'interrupt' | 'send' | 'retry' | 'breaker', at: number): boolean;   // 'retry' (chat.retry): clears error only
  // 'breaker': a send was refused with breaker_open → error {code:'breaker'} (SPEC §2.9; « Réessayer » = chat.retry)
  view(): P.ChatStateView;
}
/** `now` = the caller's clock (a limit whose resetsAt ≤ now is not seeded); `accountLogin` = the account's login state
 *  now (a disk `auth` lastError marks the chat only while it is 'reauth' or 'disconnected'). */
export type CreateChatState = (seed: { notStarted: boolean; limitResetsAt?: number; lastError?: SessionMeta['lastError']; now?: number; accountLogin?: P.LoginState }) => ChatStateMachine;
export type HeavyLoc = { id: string; field: P.DetailField; off: number; len: number };
/** `closed`: no process can still answer the page's last turn (cold chat, or an older page): its tools left
 *  without a result are « interrupted » too (otherwise only those of earlier turns are). */
export type DiskToTurns = (chain: readonly RawEntry[], o: { sessionId: P.SessionId; closed?: boolean }) => { turns: P.UiTurn[]; heavy: HeavyLoc[] };
export type DeriveTitle = (prompt: string) => string;          // 1st line, no @mentions or /commands, ≤ 60 chars
export type WakeEstimate = (lastContext: number, shared: 'sameCwd' | 'account' | 'none') => number; // max(0, ctx − 19k | 16.8k | 0)
export type ActivityLine = (s: { ask?: P.PendingAsk; tool?: { name: string; description?: string }; lastText?: string; firstPrompt?: string }) => string;

// ============================================================ server shell (src/server/app/*, http/*, ws/*, platform/*)
export type ChatMeta = {
  chatId: P.ChatId; accountId: P.AccountId; sessionId: P.SessionId; cwd: string; createdAt: number; title?: string;
  pinned?: boolean; archived?: boolean; keepAlive?: boolean; muted?: boolean;
  mode?: P.PermissionModeId; model?: string; effort?: P.Effort;
  pendingStart?: { kind: 'new' } | { kind: 'fork'; fromChatId: P.ChatId; fromJsonl: string };
  links?: { forkedFrom?: P.ChatId; continuedFrom?: P.ChatId; continuedTo?: P.ChatId };
  lastRequestAt?: number; lastContext?: number; trusted?: boolean;
};
export interface MetaStore {                                   // %LOCALAPPDATA%\SidMultiClaude\state\*.json, atomic + .bak, 1 s debounce
  chat(id: P.ChatId): ChatMeta | undefined; chats(): ChatMeta[];
  upsert(m: ChatMeta): void; patch(id: P.ChatId, p: Partial<ChatMeta>): void; remove(id: P.ChatId): void; rekey(from: P.ChatId, to: P.ChatId): void;
  ui(): P.UiState; saveUi(s: P.UiState): void;
  drafts(): Record<P.ChatId, P.Draft>; saveDraft(id: P.ChatId, d: P.Draft | null): void;
  settings(): P.Settings; saveSettings(p: Partial<P.Settings>): P.Settings;
  appTrusted(accountId: P.AccountId, cwd: string): boolean; trust(accountId: P.AccountId, cwd: string): void;
  flush(): Promise<void>;
}
export type CwdCheck = P.Result<string, 'cwd_missing' | 'cwd_too_long' | 'cwd_refused'>;
export interface Platform {
  claudeExe(pref: 'installed' | 'bundled'): P.Result<string, 'exe_missing'>;
  checkCwd(p: string, configDirs: readonly string[]): CwdCheck;  // realpath.native, < 259, S9 (home itself / inside a profile refused)
  confine(root: string, rel: string): string | null;
  jobrunAvailable(): boolean;                                     // launcher\jobrun.exe present and hash OK
  openExternal(url: string): void;                                // explorer.exe, http/https only
  openPath(p: string, how: 'explorer' | 'vscode'): void;
  terminalCommand(s: { cwd: string; configDir: string | null; sessionId: P.SessionId; exe: string }): P.Result<string, 'cwd_refused'>;
  openTerminal(s: { cwd: string; configDir: string | null; sessionId: P.SessionId; exe: string }): P.Result<void, 'cwd_refused'>;
  fileIndex(cwd: string, q: string, limit: number): Promise<P.FileHit[]>;
  listDirs(p: string | null): Promise<P.DirListing>;
  openAppWindow(port: number, bootCode: string, browser: 'edge' | 'chrome'): number | undefined;
  listOrphans(recorded: { pid: number; createdAt: string }[]): Promise<{ pid: number; name: string }[]>;
  killPids(pids: number[]): Promise<void>;
  freeMemBytes(): number;
}
export interface Hub {                                            // WebSocket fan-out
  push(chatId: P.ChatId | null, msgs: P.S2C[]): void;            // chatId → only connections whose view.full has it; null → all
  visible(): ReadonlySet<P.ChatId>;                              // union of view.full over connections
  looking(chatId: P.ChatId): boolean;                            // shown in a pane of a focused, visible window
  connections(): number;
  onEmpty(cb: () => void): () => void;                           // last window disconnected
}
