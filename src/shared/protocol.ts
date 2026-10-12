// src/shared/protocol.ts — SidMultiClaude wire contract (browser <-> server). TYPES ONLY (erasable syntax).
// Changes must stay backward compatible (additive only).
// Browser JS consumes it through JSDoc: /** @typedef {import('../shared/protocol.ts').ChatSummary} ChatSummary */

export type Result<T, E> = { ok: true; data: T } | { ok: false; err: E };

// ---------------------------------------------------------------- identifiers
export type AccountId = string; // slug /^[a-z][a-z0-9-]{0,23}$/, never contains ':'
export type SessionId = string; // Claude session UUID (lower-case 8-4-4-4-12)
export type ChatId = string;    // `${AccountId}:${SessionId}`; re-keyed only on /clear or when the CLI picks another fork id
export type Uuid = string;      // client crypto.randomUUID() = SDKUserMessage.uuid = command_lifecycle.command_uuid

// ---------------------------------------------------------------- enums
export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ChatPhase = 'cold' | 'starting' | 'idle' | 'running' | 'needs_permission' | 'needs_answer' | 'needs_plan' | 'rate_limited' | 'error';
export type SubPhase = 'requesting' | 'thinking' | 'writing' | 'tool' | 'compacting' | 'retry' | 'stopping';
export type Origin = 'cli' | 'desktop' | 'app' | 'other';
export type ToolStatus = 'running' | 'asking' | 'ok' | 'error' | 'denied' | 'withdrawn' | 'interrupted';
export type Delivery = 'pending' | 'queued' | 'started' | 'folded' | 'completed' | 'cancelled' | 'refused' | 'returned';
export type AskKind = 'permission' | 'question' | 'plan' | 'elicitation';
export type Priority = 'next' | 'later' | 'now';
export type ViewMode = 'normal' | 'detailed' | 'focus';
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

// ---------------------------------------------------------------- errors
export type ErrorCode =
  | 'invalid' | 'not_found' | 'not_pending' | 'busy' | 'forbidden' | 'unsupported' | 'timeout' | 'internal' | 'too_large'
  | 'cap' | 'cap_busy' | 'external' | 'not_logged_in' | 'untrusted' | 'cwd_missing' | 'cwd_too_long' | 'cwd_refused'
  | 'exe_missing' | 'spawn_failed' | 'breaker_open' | 'not_live';
export type CapCandidate = { chatId: ChatId; title: string; warmMin: number; recacheTokens: number; stable: boolean };
export type ExternalHolder = { pid: number; kind: string; entrypoint: string; status: 'busy' | 'idle' | 'waiting' | 'blocked' };
export type WireError =
  | { code: 'cap'; message?: string; candidates: CapCandidate[] }
  | { code: 'external'; message?: string; holder: ExternalHolder }
  | { code: Exclude<ErrorCode, 'cap' | 'external'>; message?: string };

// ---------------------------------------------------------------- accounts
export type LoginState = 'connected' | 'disconnected' | 'incoherent' | 'reauth';
export type UsageRow = { key: string; label: string; pct: number; resetsAt?: number; severity: 'normal' | 'warning' | 'critical'; headline: boolean };
export type UsageView = { source: 'snapshot' | 'event' | 'refresh'; at: number; stale: boolean; rows: UsageRow[];
  status?: 'allowed' | 'allowed_warning' | 'rejected'; na?: boolean };
export type AccountView = {
  id: AccountId; name: string; color: number /* 1..8 -> --acc-n */; monogram: string;
  configDir: string | null /* null = default profile, CLAUDE_CONFIG_DIR unset */; isDefault: boolean; hidden: boolean; login: LoginState;
  identity?: { email: string; displayName?: string; org?: string; plan: string; role?: string; accountUuid: string };
  usage?: UsageView;
  defaults: { model?: string; effort?: Effort; mode?: PermissionModeId };
  diag: { leakFiles: string[]; leakExcluded: boolean; resumeStable: boolean | null; cleanupDays: number; expiringSoon: number;
          duplicateOf?: AccountId; cliVersion?: string; defaultMode?: string; baselineTokens?: number; mcp?: { ok: number; auth: number } };
  models?: ModelOption[];        // the account's model catalog (cache\model-catalog, 0 tokens); absent → aliases opus/sonnet/haiku
};
export type AccountPatch = { name?: string; color?: number; monogram?: string; hidden?: boolean; excludeForeignClaudeMd?: boolean;
  defaults?: { model?: string | null; effort?: Effort | null; mode?: PermissionModeId | null } };
export type AccountCandidate = {
  configDir: string | null; login: LoginState; email?: string; added: boolean;
  plan?: string; org?: string /* team / enterprise organization only (never "<email>'s Organization") */;
  /** First run: name (org name or « Perso », « Perso 2 »…), colour and monogram to pre-fill; only on not-added ones. */
  suggested?: { name: string; color: number; monogram: string };
};
export type ModelOption = { value: string /* alias or catalog id, never free text */; label: string; efforts: Effort[]; isDefault?: boolean };
export type LoginStep = { step: 'url'; url: string } | { step: 'waiting' } | { step: 'done'; email: string; plan: string }
  | { step: 'error'; message: string; key?: string /* i18n key (login.err.*); `message` = raw CLI detail */ };

// ---------------------------------------------------------------- chat summary (sidebar, tabs, attention) — every known session
export type ChatStateView = {
  phase: ChatPhase; sub?: SubPhase; subTool?: string; since: number;
  flags: { live: boolean; unread: boolean; bgTasks: number; queued: number; external: ExternalHolder | null; stuck: boolean; notStarted: boolean };
  pending: { count: number; oldestAt?: number; kind?: AskKind };
  error?: { code: 'crash' | 'auth' | 'billing' | 'overloaded' | 'model_not_found' | 'startup' | 'breaker' | 'cwd' | 'exe'; message?: string; exitCode?: number };
  limit?: { resetsAt: number; kind: string };
};
export type ChatSummary = {
  chatId: ChatId; accountId: AccountId; sessionId: SessionId;
  title: string; titleSource: 'custom' | 'ai' | 'lastPrompt' | 'firstPrompt' | 'app' | 'none';
  cwd: string; branch?: string; origin: Origin; firstPrompt?: string;
  createdAt: number; updatedAt: number /* last user/assistant timestamp, NOT mtime */; size: number /* 0 = no .jsonl yet */;
  model?: string; mode?: PermissionModeId;
  pinned: boolean; archived: boolean; muted: boolean; keepAlive: boolean;
  state: ChatStateView; activity: string /* deterministic one-liner, never model-generated */;
  wake?: { lastContext: number; recacheTokens: number; idleMs: number; dialog: boolean };
  expiresInDays: number | null; foreignOwner: boolean; costUsd?: number;
  links?: { forkedFrom?: ChatId; continuedFrom?: ChatId; continuedTo?: ChatId };
};

// ---------------------------------------------------------------- chat detail (panes)
export type SlashCommandView = { name: string; description: string; hint?: string; group: 'builtin' | 'skill' | 'plugin' | 'mcp'; local: boolean; aliases?: string[] };
export type ChatMetaView = { title: string; cwd: string; branch?: string; mode: PermissionModeId; model?: string; effort?: Effort; cliVersion?: string;
  tools?: number; mcp?: { name: string; status: string }[]; commands?: SlashCommandView[]; capabilities?: string[];
  autoAvailable?: boolean /* ModelInfo.supportsAutoMode of the current model; undefined = unknown → hide Auto */ };
export type ChatMetrics = { contextTokens?: number; contextWindow?: number; autoCompactAt?: number; lastRequestAt?: number;
  cacheTtlMs?: number; cacheWarmUntil?: number; costUsd?: number; lastTurn?: TurnFooter };

// transcript model — block ids are identical live and on disk ("live = reload" invariant)
//   user   `u:${uuid}`                 (queued_command attachment on disk: `u:${commandUuid}` when present, else `u:${entry uuid}`)
//   text / thinking `a:${message.id}:${index}` (live: content_block index; disk: apiBlockIndex, else ordinal among entries of that message.id)
//   tool   `t:${tool_use_id}`          (the tool_result patches the same block)
//   system `x:${uuid}`                 (synthetic rows created by the app: `x:app:${n}`)
export type ImageRef = { ref: string; mediaType: string; bytes?: number; approxTokens?: number };
export type UiUserMsg = { uuid: Uuid; text: string; images?: ImageRef[]; origin: 'human' | 'peer' | 'task' | 'auto' | 'command'; delivery?: Delivery };
export type ToolInputView = { summary: string; fields: Record<string, string | number | boolean>; truncated?: string[] };
export type PatchHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };
export type UiToolResult = { isError: boolean; summary: string; head?: string; tail?: string; totalLines?: number; truncated?: boolean;
  patch?: PatchHunk[]; images?: ImageRef[]; denial?: 'user' | 'rule' | 'auto' | 'autoNa' | 'interrupted' | 'withdrawn';
  data?: Record<string, string | number | boolean> };
export type UiSystemRow = { kind: 'compact' | 'interrupted' | 'retry' | 'notice' | 'error' | 'cleared' | 'hook' | 'refusal' | 'cacheMiss'
  | 'rateLimit' | 'crash' | 'local' | 'task' | 'modeChange'; text?: string; data?: Record<string, string | number | boolean> };
export type UiBlock =
  | { k: 'user'; id: string; msg: UiUserMsg }
  | { k: 'text'; id: string; md: string; model?: string; aborted?: boolean; live?: boolean }
  | { k: 'thinking'; id: string; chars: number; tokens?: number; redacted?: boolean; live?: boolean }
  | { k: 'tool'; id: string; toolUseId: string; name: string; input: ToolInputView; status: ToolStatus; result?: UiToolResult;
      parentToolUseId?: string; agentId?: string; elapsedMs?: number; taskId?: string; askId?: string; model?: string }
  | { k: 'system'; id: string; row: UiSystemRow };
export type TurnFooter = { durationMs?: number; input: number; cacheRead: number; cacheWrite: number; output: number; costUsd?: number;
  auxTokens?: number /* Δ modelUsage(all models) − main usage: parity sentinel, must be 0 */; models: string[]; interrupted?: boolean; terminal?: string };
export type UiTurnHead = { id: string /* id of the opening user block, or `x:` id for system-only turns */; at: number; user: UiUserMsg | null };
export type UiTurn = UiTurnHead & { blocks: UiBlock[]; footer?: TurnFooter; beforeCompaction?: boolean };
export type DeltaPart = [blockId: string, append: string];
export type TranscriptPage = { turns: UiTurn[]; cursor: string | null; hasMore: boolean };
export type DetailField = 'output' | 'input' | 'thinking' | 'image' | 'originalFile' | 'raw';
export type DetailPayload = { text?: string; dataUrl?: string; mediaType?: string; truncated?: boolean };
export type SearchHit = { turnId: string; blockId?: string; snippet: string };

// ---------------------------------------------------------------- asks
export type AskQuestion = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string; preview?: string }[] };
export type PendingAsk = {
  chatId: ChatId; requestId: string; toolUseId: string; kind: AskKind; toolName: string;
  displayName?: string; description?: string; decisionReason?: string; blockedPath?: string; agentId?: string;
  mcpServer?: { name: string; source: string }; matchedAskRule?: string;
  input: Record<string, unknown>;                 // lite: strings > 256 KB cut (Edit/Write keep up to 256 KB for the preview)
  diffBase?: { path: string; text: string } | { unavailable: true }; // Write preview base, read by the server inside the cwd only
  offerAlways: boolean; alwaysRules: string[];    // monospace rule text shown in the tooltip, e.g. Bash(npm ci)
  offerAuto: boolean;                             // « Autoriser et passer en mode Auto »
  defaultToNo: boolean;
  plan?: string; planFilePath?: string;           // ExitPlanMode: from the ask input (fresh), never from the assistant frame
  questions?: AskQuestion[];
  elicitation?: { mode: 'form' | 'url'; server: string; message: string; schema?: Record<string, unknown>; url?: string };
  since: number;
};
export type UiAnswer =
  | { kind: 'allow-once' }
  | { kind: 'allow-edited'; input: Record<string, unknown> }
  | { kind: 'allow-always'; scope: 'session' | 'localSettings' | 'projectSettings' }   // never 'userSettings'
  | { kind: 'allow-and-auto' }
  | { kind: 'deny'; message: string; stopTurn?: boolean }
  | { kind: 'answers'; answers: Record<string, string>; notes?: Record<string, string>; response?: string }
  | { kind: 'skip-question' }
  | { kind: 'plan-approve'; nextMode: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions'; editedPlan?: string }
  | { kind: 'plan-reject'; feedback: string }
  | { kind: 'elicit'; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
export type AskEndReason = 'answered' | 'cancelled' | 'crash';

// ---------------------------------------------------------------- queue, tasks, todos
export type QueueItem = { uuid: Uuid; text: string; images: number; priority?: Priority; delivery: Delivery };
export type TaskView = { id: string; kind: 'agent' | 'bash' | 'workflow' | 'monitor' | 'other'; title: string;
  status: 'running' | 'done' | 'failed' | 'stopped'; startedAt: number; detail?: string; toolUseId?: string;
  tokens?: number; tools?: number; depth?: number; background: boolean };
export type TodoItem = { text: string; status: 'pending' | 'in_progress' | 'completed' | 'blocked'; activeForm?: string };

// ---------------------------------------------------------------- per-chat events (only to windows showing the chat in a pane)
export type ChatEvent =
  | { k: 'state'; state: ChatStateView }
  | { k: 'meta'; meta: Partial<ChatMetaView> }
  | { k: 'metrics'; metrics: ChatMetrics }
  | { k: 'turn.start'; turn: UiTurnHead }
  | { k: 'block'; turnId: string; block: UiBlock }                  // upsert by block.id (full replacement, freezes a live block)
  | { k: 'delta'; parts: DeltaPart[] }                              // text appends to live text blocks, coalesced ≤ every 50 ms
  | { k: 'progress'; blockId: string; elapsedMs?: number; chars?: number; tokens?: number } // ≤ 1/s per block
  | { k: 'tool.result'; turnId: string; toolUseId: string; status: ToolStatus; result: UiToolResult }
  | { k: 'turn.end'; turnId: string; footer: TurnFooter }
  | { k: 'system'; turnId?: string; id: string; row: UiSystemRow }
  | { k: 'queue'; items: QueueItem[] }                              // replace
  | { k: 'tasks'; tasks: TaskView[] }                               // replace
  | { k: 'todos'; todos: TodoItem[] | null }                        // replace
  | { k: 'reset'; reason: 'clear' | 'rewind' | 'resume' };          // drop rendered turns, then tx.page

export type ChatSnapshot = { chatId: ChatId; seq: number; state: ChatStateView; meta: ChatMetaView; metrics: ChatMetrics;
  queue: QueueItem[]; tasks: TaskView[]; todos: TodoItem[] | null; live: UiTurn | null; lastDiskTurnId: string | null };

// ---------------------------------------------------------------- misc payloads
export type ImageInput = { mediaType: ImageMediaType; base64: string };
export type Draft = { text: string; attachments: { name: string; mediaType: ImageMediaType; base64: string }[]; at: number }; // ≤ 1 MB
export type ProcStats = { live: number; max: number; effectiveMax: number; lowMem: boolean; estRamMB: number; isolation: 'job' | 'plain';
  items: { chatId: ChatId; pid?: number; phase: ChatPhase; since: number; lastRequestAt?: number; warmUntil?: number; neverRequested: boolean; protected: boolean }[] };
export type DirListing = { path: string; parent?: string; dirs: string[]; drives?: string[]; warning?: 'home' | 'ancestor' };
export type FileHit = { path: string; dir: boolean };
export type PromptHit = { text: string; at: number; source: 'app' | 'terminal'; chatId?: ChatId };
export type ContextSummary = { total: number; window: number; autoCompactAt: number; categories: { name: string; tokens: number }[]; memoryFiles: string[] };
export type RewindPreview = { files: { path: string; added: number; removed: number; deleted?: boolean }[] };
export type SessionInfo = { sessionId: SessionId; accountId: AccountId; cwd: string; transcriptPath: string; size: number; cliVersion?: string;
  model?: string; tools?: number; mcp?: { name: string; status: string }[]; instructions: { path: string; foreign: boolean }[]; ownerAccountUuid?: string };
export type RuleView = { behavior: 'allow' | 'deny' | 'ask'; source: string; rule: string; editable: boolean };

export type Settings = {
  port: number; browser: 'edge' | 'chrome'; exe: 'installed' | 'bundled'; isolation: 'job' | 'plain';
  maxLive: number /* 2..8, default 4 */; reapMin: number | null /* 15|30|60|120|null=never; default 60 */;
  prespawn: boolean; allowBypass: boolean; aiTitles: boolean;
  notifications: boolean; sound: boolean; volume: number; onlyWhenAway: boolean; dndUntil: number | null; reopenWindowOnAttention: boolean;
  ctrlEnterSends: boolean; shiftTabModes: boolean; showOtherOrigins: boolean; wakeNeverAsk: boolean;
  theme: 'system' | 'light' | 'dark'; density: 'compact' | 'comfortable'; defaultView: ViewMode;
};
export type UiState = {
  layout: 1 | 2 | 3 | 4; tabs: ChatId[]; closed: ChatId[]; panes: (ChatId | null)[]; focusedPane: number;
  sidebar: { width: number; collapsed: boolean; grouping: 'account' | 'folder' | 'state'; showArchived: boolean };
  scroll: Record<ChatId, { turnId: string; offset: number }>; views: Record<ChatId, ViewMode>;
};

// ---------------------------------------------------------------- frames
// Server -> client: every WebSocket frame is a JSON ARRAY of S2C messages (flushed once per tick).
export type S2C =
  | { t: 'hello'; v: 1; boot: string; now: number; settings: Settings; accounts: AccountView[]; chats: ChatSummary[];
      asks: PendingAsk[]; ui: UiState; drafts: Record<ChatId, Draft>; procs: ProcStats }
  | { t: 'device-token'; token: string }
  | { t: 'ack'; id: number; ok: true; data?: unknown }
  | { t: 'ack'; id: number; ok: false; err: WireError }
  | { t: 'accounts'; accounts: AccountView[] }                                    // replace
  | { t: 'chats'; upsert: ChatSummary[]; remove: ChatId[]; rekey?: { from: ChatId; to: ChatId }[] } // all windows, all chats
  | { t: 'ask'; ask: PendingAsk }                                                  // all windows (Peek, À traiter); before the needs_* upsert
  | { t: 'askEnd'; chatId: ChatId; requestId: string; reason: AskEndReason }
  | { t: 'snap'; snap: ChatSnapshot }
  | { t: 'ev'; c: ChatId; s: number; ev: ChatEvent }                               // s = per-chat seq, contiguous after snap.seq
  | { t: 'procs'; procs: ProcStats }
  | { t: 'settings'; settings: Settings }
  | { t: 'login'; accountId: AccountId; step: LoginStep }
  | { t: 'orphans'; items: { pid: number; name: string }[] }
  | { t: 'toast'; level: 'info' | 'warn' | 'error'; key: string; args?: Record<string, string | number>; chatId?: ChatId }
  | { t: 'bye'; reason: 'quit' | 'restart' };

// Client -> server: one object per frame; every request gets exactly one ack with the same id.
export type C2S = { id: number } & (
  | { t: 'view'; full: ChatId[]; focused: ChatId | null; windowFocused: boolean }      // replaces this window's view; server answers snaps
  | { t: 'chat.create'; accountId: AccountId; cwd: string; title?: string; mode: PermissionModeId; model?: string; effort?: Effort; trust?: boolean }
  | { t: 'chat.prespawn'; chatId: ChatId }
  | { t: 'chat.send'; chatId: ChatId; uuid: Uuid; text: string; images?: ImageInput[]; priority?: 'later' | 'now';
      wake?: 'asIs' | 'summary'; evict?: ChatId; exceed?: boolean; force?: boolean }  // idempotent on uuid
  | { t: 'chat.interrupt'; chatId: ChatId }
  | { t: 'chat.cancelQueued'; chatId: ChatId; uuid: Uuid }
  | { t: 'chat.decide'; chatId: ChatId; requestId: string; answer: UiAnswer }
  | { t: 'chat.setMode'; chatId: ChatId; mode: PermissionModeId; typed?: string }     // bypass needs typed === 'CONTOURNER'
  | { t: 'chat.setModel'; chatId: ChatId; model: string | null; effort: Effort | null }
  | { t: 'chat.rename'; chatId: ChatId; title: string }
  | { t: 'chat.flags'; chatId: ChatId; pinned?: boolean; archived?: boolean; keepAlive?: boolean; muted?: boolean }
  | { t: 'chat.setCwd'; chatId: ChatId; cwd: string }                                // cold chats only (recorded folder gone)
  | { t: 'chat.sleep'; chatId: ChatId; stopTasks?: boolean; force?: boolean }             // force = « Forcer l'arrêt » (skips the graceful steps)
  | { t: 'chat.retry'; chatId: ChatId }                                                     // « Réessayer » / « Relancer »: resets the crash breaker and clears the error state; no spawn by itself
  | { t: 'chat.delete'; chatId: ChatId; confirm: true }
  | { t: 'chat.fork'; chatId: ChatId; upToUuid?: Uuid; accountId?: AccountId }
  | { t: 'chat.rewind'; chatId: ChatId; userUuid: Uuid; action: 'both' | 'conv' | 'code'; dryRun: boolean }
  | { t: 'chat.task'; chatId: ChatId; op: 'stop' | 'background' | 'stopAll'; ref?: string }
  | { t: 'chat.info'; chatId: ChatId; what: 'context' | 'rules' | 'session' | 'commands' }
  | { t: 'chat.terminal'; chatId: ChatId; copyOnly: boolean }
  | { t: 'tx.page'; chatId: ChatId; before?: string; limit: number }
  | { t: 'tx.detail'; chatId: ChatId; blockId: string; field: DetailField }           // was `id`, which collided with the request id
  | { t: 'tx.search'; chatId: ChatId; q: string }
  | { t: 'prompts.search'; q: string; chatId?: ChatId }
  | { t: 'account.candidates' }
  | { t: 'account.add'; configDir: string | null; name: string; color: number; monogram: string }
  | { t: 'account.update'; accountId: AccountId; patch: AccountPatch }
  | { t: 'account.login'; accountId: AccountId; email?: string }
  | { t: 'account.loginCode'; accountId: AccountId; code: string }
  | { t: 'account.loginCancel'; accountId: AccountId }
  | { t: 'account.logout'; accountId: AccountId }
  | { t: 'account.usage'; accountId: AccountId }
  | { t: 'account.baseline'; accountId: AccountId }
  | { t: 'fs.mentions'; chatId: ChatId; q: string }
  | { t: 'fs.dirs'; path: string | null }
  | { t: 'open'; what: 'url' | 'explorer' | 'vscode'; target: string; chatId?: ChatId }
  | { t: 'ui.save'; ui: UiState }
  | { t: 'draft.save'; chatId: ChatId; draft: Draft | null }
  | { t: 'settings.set'; patch: Partial<Settings> }
  | { t: 'orphans.kill'; pids: number[] }
  | { t: 'app.quit'; force?: boolean }
  | { t: 'log.client'; level: 'warn' | 'error'; msg: string; chatId?: ChatId } );

export type C2SType = C2S['t'];
// ack.data per request type (requests not listed ack with no data)
export type AckData = {
  'chat.create': { chatId: ChatId };
  'chat.fork': { chatId: ChatId };
  'chat.send': { accepted: 'new' | 'duplicate' };
  'chat.interrupt': { stillQueued: Uuid[] };
  'chat.cancelQueued': { cancelled: boolean };
  'chat.rewind': RewindPreview;
  'chat.info': ContextSummary | RuleView[] | SessionInfo | SlashCommandView[];
  'chat.terminal': { command: string };
  'tx.page': TranscriptPage;
  'tx.detail': DetailPayload;
  'tx.search': SearchHit[];
  'prompts.search': PromptHit[];
  'account.candidates': AccountCandidate[];
  'account.add': AccountView;
  'account.usage': UsageView | null;
  'account.baseline': ContextSummary;
  'fs.mentions': FileHit[];
  'fs.dirs': DirListing;
};
