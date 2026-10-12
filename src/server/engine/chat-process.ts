// src/server/engine/chat-process.ts — one live query(): InputQueue, pump, facts tracker, watchdogs, close algorithm (SPEC §2.3, §2.7).
// State machine: spawning → live → closing → (gone). Facts follow the observed SDK behaviour: busy from command_lifecycle + turn
// boundaries, asks from the registry, bgTasks from background_tasks_changed (replace semantics), lastRequestAt from
// main-thread system:status requesting, ttl from result.usage.cache_creation.
import type { Options, Query, SDKUserMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { Readable } from 'node:stream';
import type * as P from '../../shared/protocol.ts';
import type { Clock, EngineSink, ExitInfo, Logger, ProcessFacts, QueryFn, SdkFrame, SendInput, SleepReason, SmcEngineFrame, SpawnSpec, SpawnerFactory } from '../contracts.ts';
import {
  AUTO_COMPACT_MARGIN_TOKENS, CACHE_TTL_1H_MS, CACHE_TTL_5M_MS, CLOSE_BG_TASKS_WAIT_MS, CLOSE_EXIT_WAIT_MS, CLOSE_KILL_WAIT_MS,
  CLOSE_OWN_KILL_DELAY_MS, CLOSE_RUNNING_RESULT_WAIT_MS, INIT_WATCHDOG_MS, INTERRUPT_WATCHDOG_MS, RESUME_STABLE_WINDOW_MS, STDERR_RING_LINES,
} from '../../shared/limits.ts';
import { buildOptions } from './options.ts';
import { createInputQueue } from './input-queue.ts';
import type { InputQueue } from './input-queue.ts';
import { ctl, ctlMethod, EngineError, hasMethod } from './ctl.ts';
import type { AskRegistry } from './permissions.ts';
import type { PoolChat } from './pool.ts';
import type { SpawnTag } from './spawner.ts';
import { INIT_RESULT_KEYS, hasDrift, keyDrift } from './exe.ts';
import { redact } from '../util/log.ts';

/** Request-neutrality of onElicitation is gated by T-P3 (SPEC §2.2, U1). Flip to false if T-P3 shows a body change. */
export const ELICITATION_ENABLED = true;
/** CLI refusal of a truncating resume (--resume-drops-turn). Measured on 2.1.294 (0 tokens): an error `result` whose
 *  errors[] and stderr start with this, then exit 1 before initialize is answered. ExitInfo.message is then REWIND_REFUSED. */
export const REWIND_REFUSED_PREFIX = 'Resume rejected by --resume-drops-turn:';
export const REWIND_REFUSED = 'rewind_refused';
/** jobrun.exe ran but could not set up the job or start the CLI (launcher/jobrun.cs exit codes 3/4/5 with a `jobrun:` stderr
 *  line): the CLI never ran, so this is a spawn error in job mode (SPEC §2.11) and the engine retries once in plain mode. */
export const JOBRUN_FAILED = 'jobrun_failed';
const JOBRUN_FAIL_CODES = new Set([3, 4, 5]);
/** Synthetic engine frames (type 'smc_engine') carry facts the engine learns outside the SDK stream. */
export type EngineNote = SmcEngineFrame;   // declared in contracts.ts
/** Decoded size of a base64 payload (same rule as model/blocks.ts b64Bytes: live image refs = disk rebuild). */
const b64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

type Deliv = { uuid: P.Uuid; text: string; images: number; imageTypes?: string[]; imageBytes?: number[]; priority?: P.Priority; delivery: P.Delivery };
type Child = SpawnedProcess & Partial<SpawnTag> & { pid?: number; stderr?: Readable | null; once(ev: string, fn: (...a: unknown[]) => void): unknown };

export type ChatProcessDeps = {
  spec: SpawnSpec; query: QueryFn; clock: Clock; log: Logger; sink: EngineSink; spawner: SpawnerFactory; asks: AskRegistry;
  holder(accountId: P.AccountId, sessionId: P.SessionId): P.ExternalHolder | null;
  ownPids(): ReadonlySet<number>;
  /** Facts changed (the engine coalesces them per tick and re-arms the reaper). */
  onChange(cp: ChatProcess): void;
  /** Re-key: the CLI moved to another session id (/clear) or picked its own fork id. */
  onSessionChanged(cp: ChatProcess, from: P.ChatId, to: P.ChatId): void;
  /** The process is gone: the engine drops its pending facts (a cold chat has none: facts() is null), then calls sink.exited(). */
  onExit(cp: ChatProcess, info: ExitInfo, returned: P.QueueItem[]): void;
  noteCliPid?(hostPid: number, cliPid: number): void;
  /** resumeStable observation for the account (orders cap candidates). */
  noteStable?(accountId: P.AccountId, stable: boolean): void;
  /** false for the S9-exempt probe cwd (why 'usage'): localSettings / projectSettings suggestions are then dropped. */
  cwdSafe?: boolean;
  /** ensure({force}) opened the session despite this external holder: the post-init race guard ignores it. */
  forcedHolderPid?: number;
  /** This spawn replaces a refused rewind (a plain resume) or a failed jobrun (plain isolation): its note comes first. */
  fallback?: 'rewind' | 'isolation';
};

/** Forbidden: resume = <.jsonl path> without forkSession (it would append to another profile's file). */
export function assertSafeOptions(o: Options): void {
  if (typeof o.resume === 'string' && /\.jsonl$/i.test(o.resume) && o.forkSession !== true) {
    throw new EngineError('invalid', 'resume by .jsonl path requires forkSession');
  }
}

const LOCAL_COMMANDS = new Set(['usage', 'context', 'cost', 'status', 'help', 'clear', 'config', 'permissions', 'memory', 'model', 'effort', 'rename', 'mcp', 'hooks', 'agents', 'export', 'doctor']);
const sleepImmediate = (): Promise<void> => new Promise((r) => setImmediate(r));
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class ChatProcess {
  chatId: P.ChatId;
  sessionId: P.SessionId;
  readonly spec: SpawnSpec;
  phase: 'spawning' | 'live' | 'closing' = 'spawning';
  readonly spawnedAt: number;
  unkillable = false;
  isolation: 'job' | 'plain';
  closeReason: SleepReason | null = null;
  readonly done: Promise<ExitInfo>;
  private d: ChatProcessDeps;
  private q: Query | null = null;
  private input: InputQueue = createInputQueue();
  private child: Child | null = null;
  private childGone = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private stderrRing: string[] = [];
  private deliv = new Map<P.Uuid, Deliv>();
  private turnActive = false;
  private bg: string[] = [];
  private queuedTurns = 0;
  private lastRequestAt: number | undefined;
  private lastContext: number | undefined;
  private sentAny = false;
  private ttlMs = CACHE_TTL_1H_MS;
  private mode: P.PermissionModeId;
  private model: string | undefined;
  private chosenModel: string | null;
  private chosenEffort: P.Effort | null;
  private cliVersion: string | undefined;
  private cliPid: number | undefined;
  private caps: string[] = [];
  private models: { value: string; resolvedModel?: string; supportsAutoMode?: boolean }[] = [];
  private stuck = false;
  private stuckTimer: { cancel(): void } | null = null;
  private initTimer: { cancel(): void } | null = null;
  private stableTimer: { cancel(): void } | null = null;
  private closeNote: string | undefined;            // ExitInfo.message of a reap / eviction (the sink tells them apart)
  private initTimedOut = false;
  private initDone = false;
  private sawStartHook = false;
  private stableSent = false;
  private killed = false;
  private sawFirstSid = false;
  /** A rewind spawn the CLI refused (REWIND_REFUSED_PREFIX): the engine falls back to a plain resume (SPEC §2.1). */
  rewindRefused = false;
  /** jobrun.exe failed before the CLI ran (JOBRUN_FAILED): the engine retries this chat once in plain mode (SPEC §2.11). */
  jobrunFailed = false;
  get cwdSafe(): boolean { return this.d.cwdSafe !== false; }
  get forcedHolderPid(): number | undefined { return this.d.forcedHolderPid; }
  /** Latest title announced by the CLI (system:session_title_changed): names the chat in cap.choice after a resume. */
  title: string | undefined;
  private resolveDone!: (i: ExitInfo) => void;
  private waiters: { test(): boolean; resolve(): void }[] = [];
  private closing: Promise<ExitInfo | null> | null = null;

  constructor(d: ChatProcessDeps) {
    this.d = d;
    this.spec = d.spec;
    this.chatId = d.spec.chatId;
    this.sessionId = d.spec.sessionId;
    this.spawnedAt = d.clock.now();
    this.isolation = d.spec.isolation;
    this.mode = d.spec.mode;
    this.chosenModel = d.spec.model ?? null;
    this.chosenEffort = d.spec.effort ?? null;
    this.model = d.spec.model;
    this.done = new Promise<ExitInfo>((r) => { this.resolveDone = r; });
  }

  // ---------------------------------------------------------------- spawn, init, pump
  /** Starts query(). Throws EngineError('spawn_failed' | 'invalid') synchronously when nothing could be started. */
  start(): void {
    const ctx = {
      cwd: this.spec.cwd, cwdSafe: this.d.cwdSafe !== false, allowBypass: this.spec.allowBypass,
      mode: () => this.mode, autoAvailable: () => this.autoAvailable(), exited: () => this.childGone,
    };
    const chat = (): P.ChatId => this.chatId;                 // asks land on the CURRENT id, also after a re-key (/clear, fork id)
    const options = buildOptions(this.spec, {
      canUseTool: this.d.asks.canUseTool(chat, ctx),
      spawnClaudeCodeProcess: (so) => this.spawnChild(so),
      stderr: (s) => this.pushStderr(s),
      ...(ELICITATION_ENABLED ? { onElicitation: this.d.asks.onElicitation(chat, ctx) } : {}),
    });
    assertSafeOptions(options);
    try {
      this.q = this.d.query({ prompt: this.input, options });
    } catch (e) {
      throw new EngineError('spawn_failed', e instanceof Error ? e.message : String(e));
    }
    if (this.d.fallback) this.note({ type: 'smc_engine', subtype: this.d.fallback === 'rewind' ? 'rewind_fallback' : 'isolation_fallback' });   // before any frame
    this.initTimer = this.d.clock.timer(INIT_WATCHDOG_MS, () => {
      if (this.initDone) return;
      this.initTimedOut = true;
      this.d.log.warn('engine: init watchdog fired', { chatId: this.chatId });
      this.forceStop();
    });
    const q = this.q;
    void ctl('initializationResult', () => q.initializationResult(), INIT_WATCHDOG_MS + 1_000, this.d.clock).then(
      (r) => { try { this.onInit(r && typeof r === 'object' ? r as unknown as Record<string, unknown> : {}); } catch (e) { this.d.log.error('engine: init handling failed', { chatId: this.chatId, err: String(e) }); this.changed(); } },
      (e: unknown) => { if (!this.initDone && !this.initTimedOut && !this.finished) { this.d.log.warn('engine: init failed', { chatId: this.chatId, err: String(e) }); this.forceStop(); } },
    );
    void this.pump(q);
  }

  private spawnChild(so: SpawnOptions): SpawnedProcess {
    const child = this.d.spawner(this.chatId, this.spec.isolation)(so) as Child;
    this.child = child;
    if (child.smcIsolation) this.isolation = child.smcIsolation;
    if (child.smcFallback && this.spec.isolation === 'job') this.note({ type: 'smc_engine', subtype: 'isolation_fallback' });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s: string) => this.pushStderr(s));
    const gone = (code: unknown, sig: unknown): void => {
      if (this.childGone) return;
      this.childGone = true;
      this.exitCode = typeof code === 'number' ? code : null;
      this.exitSignal = typeof sig === 'string' ? sig : null;
      this.check();
    };
    child.once('exit', gone);
    child.once('error', () => gone(null, null));
    return child;
  }

  private pushStderr(s: string): void {
    for (const line of s.split(/\r?\n/)) {
      if (!line) continue;
      this.stderrRing.push(redact(line).slice(0, 2_000));
      if (this.stderrRing.length > STDERR_RING_LINES) this.stderrRing.shift();
    }
  }

  private onInit(r: Record<string, unknown>): void {
    if (this.initDone || this.closeReason === 'force' || this.initTimedOut || this.finished) return;   // never a frame after exited()
    this.initDone = true;
    this.initTimer?.cancel();
    if (this.phase === 'spawning') this.phase = 'live';
    const pid = typeof r['pid'] === 'number' ? r['pid'] : undefined;
    this.cliPid = pid;
    if (pid !== undefined && this.child?.pid !== undefined) this.d.noteCliPid?.(this.child.pid, pid);
    if (Array.isArray(r['capabilities'])) this.caps = [...new Set([...this.caps, ...(r['capabilities'] as unknown[]).filter((c): c is string => typeof c === 'string')])];
    if (Array.isArray(r['models'])) this.models = r['models'] as typeof this.models;
    if (typeof r['current_permission_mode'] === 'string') this.mode = r['current_permission_mode'] as P.PermissionModeId;
    const account = r['account'] as { email?: unknown } | undefined;
    const drift = keyDrift(r, INIT_RESULT_KEYS);
    if (hasDrift(drift)) this.d.log.warn('engine: initialize key drift', { chatId: this.chatId, ...drift });
    this.note({ type: 'smc_engine', subtype: 'initialized', ...(pid !== undefined ? { pid } : {}), capabilities: this.caps,
      ...(typeof account?.email === 'string' ? { email: account.email } : {}), ...(hasDrift(drift) ? { drift } : {}) });
    // Never two writers: re-check the registry right after init (race guard). Our own pids are excluded.
    let h: P.ExternalHolder | null = null;
    try { h = this.d.holder(this.spec.account.id, this.sessionId); } catch (e) { this.d.log.warn('engine: registry check failed', { chatId: this.chatId, err: String(e) }); }
    if (h && !this.d.ownPids().has(h.pid) && h.pid !== this.cliPid && h.pid !== this.d.forcedHolderPid) {
      this.note({ type: 'smc_engine', subtype: 'external_holder', holder: h });
      void this.close('user');
    }
    // resumeStable = true only for a spawn that stayed up 3 s without SessionStart hook frames; cancelled by finish(), so a
    // process that exits meanwhile neither reports « stable » nor emits a frame after exited().
    this.stableTimer = this.d.clock.timer(RESUME_STABLE_WINDOW_MS, () => {
      this.stableTimer = null;
      if (!this.finished && !this.stableSent && !this.sawStartHook) { this.stableSent = true; this.note({ type: 'smc_engine', subtype: 'resume_stable', stable: true }); }
    });
    this.changed();
  }

  private note(n: EngineNote): void {
    if (n.subtype === 'resume_stable') { try { this.d.noteStable?.(this.spec.account.id, n.stable); } catch { /* ignore */ } }
    try { this.d.sink.frame(this.chatId, { ...n, session_id: this.sessionId } as SdkFrame, this.d.clock.now()); } catch (e) { this.d.log.error('engine: sink.frame threw', { err: String(e) }); }
  }

  private async pump(q: Query): Promise<void> {
    let err: unknown = null;
    try {
      for await (const m of q) this.onFrame(m as unknown as Record<string, unknown>);
    } catch (e) { err = e; }
    await this.finish(err);
  }

  // ---------------------------------------------------------------- frames → facts
  private onFrame(m: Record<string, unknown>): void {
    const now = this.d.clock.now();
    const type = str(m['type']);
    const sub = str(m['subtype']);
    const sid = str(m['session_id']);
    // A CLI-chosen fork id (or a first frame on another id): re-key BEFORE forwarding, so the frame lands on the new chat.
    if (sid && sid !== this.sessionId && type !== 'conversation_reset' && (!this.sawFirstSid || (type === 'system' && sub === 'init'))) this.rekey(sid);
    if (sid) this.sawFirstSid = true;
    try { this.d.sink.frame(this.chatId, m as SdkFrame, now); } catch (e) { this.d.log.error('engine: sink.frame threw', { chatId: this.chatId, err: String(e) }); }
    try { this.track(m, type, sub, now); } catch (e) { this.d.log.error('engine: frame tracking failed', { chatId: this.chatId, err: String(e) }); }
    this.changed();
  }

  private track(m: Record<string, unknown>, type: string | undefined, sub: string | undefined, now: number): void {
    if (type === 'command_lifecycle') {
      const u = str(m['command_uuid']);
      const state = str(m['state']);
      const dl = u ? this.deliv.get(u) : undefined;
      if (!dl || !state) return;
      if (state === 'queued') { if (dl.delivery === 'pending') dl.delivery = 'queued'; return; }
      if (state === 'started') {
        const folded = [...this.deliv.values()].some((x) => x.uuid !== dl.uuid && (x.delivery === 'started' || x.delivery === 'folded'));
        dl.delivery = folded ? 'folded' : 'started';
        try { this.d.sink.delivered(this.chatId, { uuid: dl.uuid, text: dl.text, images: dl.images, ...(dl.imageTypes ? { imageTypes: dl.imageTypes, imageBytes: dl.imageBytes ?? [] } : {}), folded, at: now }); } catch (e) { this.d.log.error('engine: sink.delivered threw', { err: String(e) }); }
        return;
      }
      // Terminal states: completed, cancelled (Retirer, interrupt) and refused (CHANGELOG; the frame itself reaches the sink,
      // the model layer marks the message). A refused message never runs: left `queued`, it would keep the chat busy (never reaped).
      if (state === 'completed' || state === 'cancelled' || state === 'refused') this.deliv.delete(dl.uuid);
      return;
    }
    if (type === 'conversation_reset') { const n = str(m['new_conversation_id']); if (n && n !== this.sessionId) this.rekey(n); return; }
    if (type === 'stream_event' && m['parent_tool_use_id'] == null) {
      const ev = m['event'] as { type?: string; message?: { usage?: Record<string, unknown> } } | undefined;
      if (ev?.type === 'message_start' && ev.message?.usage) {
        const u = ev.message.usage;
        this.lastContext = num(u['input_tokens']) + num(u['cache_read_input_tokens']) + num(u['cache_creation_input_tokens']);
      }
      return;
    }
    if (type === 'system') {
      if (sub === 'status') {
        if (m['status'] === 'requesting' && m['parent_tool_use_id'] == null) { this.lastRequestAt = now; this.turnActive = true; }
        if (typeof m['permissionMode'] === 'string') this.mode = m['permissionMode'] as P.PermissionModeId;
      } else if (sub === 'init') {
        if (typeof m['model'] === 'string') this.model = m['model'];
        if (typeof m['permissionMode'] === 'string') this.mode = m['permissionMode'] as P.PermissionModeId;
        if (typeof m['claude_code_version'] === 'string' && m['claude_code_version'] !== this.cliVersion) {
          this.cliVersion = m['claude_code_version'];
          this.d.log.info('engine: claude_code_version', { chatId: this.chatId, version: this.cliVersion, pid: this.cliPid });   // SPEC §1.3 C1
        }
        if (Array.isArray(m['capabilities'])) this.caps = [...new Set([...this.caps, ...(m['capabilities'] as unknown[]).filter((c): c is string => typeof c === 'string')])];
      } else if (sub === 'session_title_changed') {
        const t = str(m['title']);
        if (t) this.title = t;
      } else if (sub === 'background_tasks_changed') {
        const tasks = Array.isArray(m['tasks']) ? (m['tasks'] as { task_id?: unknown; ambient?: unknown }[]) : [];
        this.bg = tasks.filter((t) => t && t.ambient !== true && typeof t.task_id === 'string').map((t) => t.task_id as string);
      } else if ((sub === 'hook_started' || sub === 'hook_response') && !this.stableSent && /SessionStart/i.test(String(m['hook_event'] ?? m['hook_name'] ?? ''))) {
        // The spawn window runs until 3 s after init (SPEC §2.8): SessionStart frames before init or within that window count.
        this.sawStartHook = true;
        if (!this.stableSent) { this.stableSent = true; this.note({ type: 'smc_engine', subtype: 'resume_stable', stable: false }); }
      }
      return;
    }
    if (type === 'result') {
      if (this.spec.start.kind === 'rewind' && !this.initDone && Array.isArray(m['errors'])
        && (m['errors'] as unknown[]).some((x) => typeof x === 'string' && x.startsWith(REWIND_REFUSED_PREFIX))) this.rewindRefused = true;
      const uuids = Array.isArray(m['user_message_uuids']) ? (m['user_message_uuids'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const first = str(m['user_message_uuid']) ?? uuids[0];
      for (const u of uuids) { const dl = this.deliv.get(u); if (dl && u !== first) dl.delivery = 'folded'; }
      this.queuedTurns = num(m['queued_turn_count']);
      this.turnActive = this.queuedTurns > 0;
      const cc = (m['usage'] as { cache_creation?: Record<string, unknown> } | undefined)?.cache_creation;
      if (cc) {
        const h1 = num(cc['ephemeral_1h_input_tokens']);
        const m5 = num(cc['ephemeral_5m_input_tokens']);
        if (h1 > 0) this.ttlMs = CACHE_TTL_1H_MS; else if (m5 > 0) this.ttlMs = CACHE_TTL_5M_MS;
      }
      this.stuckTimer?.cancel();
      this.stuckTimer = null;
      this.stuck = false;
    }
  }

  private rekey(sid: P.SessionId): void {
    const from = this.chatId;
    const to = `${this.spec.account.id}:${sid}`;
    this.sessionId = sid;
    this.chatId = to;
    this.d.asks.rekey(from, to);
    try { this.d.onSessionChanged(this, from, to); } catch (e) { this.d.log.error('engine: rekey failed', { err: String(e) }); }
  }

  private changed(): void {
    try { this.d.onChange(this); } catch (e) { this.d.log.error('engine: onChange threw', { err: String(e) }); }
    this.check();
  }
  /** Wakes the close algorithm's waiters whose condition now holds. */
  private check(): void {
    for (const w of [...this.waiters]) if (w.test()) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(); }
  }
  /** Resolves true when test() holds, false after ms. */
  private waitFor(test: () => boolean, ms: number): Promise<boolean> {
    if (test()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = this.d.clock.timer(ms, () => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); resolve(test()); });
      const w = { test, resolve: () => { t.cancel(); resolve(true); } };
      this.waiters.push(w);
    });
  }

  // ---------------------------------------------------------------- exit
  private finished = false;
  private async finish(err: unknown): Promise<void> {
    // The SDK iterator is over. A CLI that still runs gets our own kill; one that survives it stays registered (phase closing,
    // `unkillable`, SPEC §2.7 step 5) until it really exits: a live process is never reported gone (no second writer).
    if (this.child && !this.childGone && !(await this.waitFor(() => this.childGone, CLOSE_KILL_WAIT_MS))) {
      if (this.phase !== 'closing') { this.phase = 'closing'; this.changed(); }
      this.killChild();
      if (!(await this.waitFor(() => this.childGone, CLOSE_KILL_WAIT_MS))) {
        if (!this.unkillable) { this.unkillable = true; this.d.log.error('engine: unkillable process', { chatId: this.chatId, pids: this.pids() }); this.changed(); }
        await new Promise<void>((resolve) => { this.waiters.push({ test: () => this.childGone, resolve }); });   // no timeout: until the exit
      }
    }
    if (this.finished) return;
    this.finished = true;
    this.initTimer?.cancel();
    this.stuckTimer?.cancel();
    this.stableTimer?.cancel();
    const msg = err instanceof Error ? err.message : err ? String(err) : undefined;
    if (this.spec.start.kind === 'rewind' && !this.initDone && !this.closeReason && this.stderrRing.some((l) => l.includes(REWIND_REFUSED_PREFIX))) this.rewindRefused = true;
    if (this.isolation === 'job' && !this.initDone && !this.closeReason && !this.initTimedOut && this.exitCode !== null && JOBRUN_FAIL_CODES.has(this.exitCode)
      && this.stderrRing.some((l) => l.startsWith('jobrun: '))) this.jobrunFailed = true;
    const codeFromMsg = msg ? /exited with code (-?\d+)/.exec(msg)?.[1] : undefined;
    const code = this.exitCode ?? (codeFromMsg !== undefined ? Number(codeFromMsg) : null);
    const reason: ExitInfo['reason'] = this.closeReason ? (this.killed ? 'killed' : 'closed')
      : this.initTimedOut ? 'init_timeout' : !this.initDone ? 'spawn_failed' : 'crash';
    const info: ExitInfo = { reason, code, signal: this.exitSignal, at: this.d.clock.now(), stderrTail: this.stderrRing.join('\n'),
      ...(this.closeNote ? { message: this.closeNote } : this.rewindRefused ? { message: REWIND_REFUSED } : this.jobrunFailed ? { message: JOBRUN_FAILED } : msg ? { message: redact(msg).slice(0, 2_000) } : {}) };
    try { this.d.asks.endAll(this.chatId, this.closeReason ? 'cancelled' : 'crash'); } catch (e) { this.d.log.error('engine: ending asks failed', { err: String(e) }); }
    const returned: P.QueueItem[] = [];
    for (const dl of this.deliv.values()) {
      if (dl.delivery === 'pending' || dl.delivery === 'queued') returned.push({ uuid: dl.uuid, text: dl.text, images: dl.images, ...(dl.priority ? { priority: dl.priority } : {}), delivery: 'returned' });
    }
    this.deliv.clear();
    this.turnActive = false;
    this.bg = [];
    this.input.end();
    this.check();
    try { this.d.onExit(this, info, returned); } catch (e) { this.d.log.error('engine: onExit threw', { err: String(e) }); }
    this.resolveDone(info);
  }

  /** Own kill of the whole tree (jobrun → TerminateProcess of the job host; plain → taskkill /T /F), then q.close(). */
  forceStop(): void {
    this.killChild();
    try { this.q?.close(); } catch { /* ignore */ }
    this.input.end();
  }
  private killChild(): void {
    this.killed = true;
    try { if (this.child && !this.childGone) this.child.kill('SIGKILL'); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- facts
  busy(): boolean {
    if (this.turnActive) return true;
    for (const dl of this.deliv.values()) if (dl.delivery === 'queued' || dl.delivery === 'started' || dl.delivery === 'folded') return true;
    return false;
  }
  pids(): number[] { return [this.child?.pid, this.cliPid].filter((p): p is number => typeof p === 'number'); }
  bgTaskIds(): readonly string[] { return this.bg; }
  isInputOpen(): boolean { return !this.input.ended && this.phase !== 'closing' && !this.finished; }
  facts(): ProcessFacts {
    const f: ProcessFacts = {
      chatId: this.chatId, sessionId: this.sessionId, phase: this.phase, busy: this.busy(), pendingAsks: this.d.asks.count(this.chatId),
      bgTasks: this.bg.length, queuedTurns: this.queuedTurns,
      queue: [...this.deliv.values()].map((dl) => ({ uuid: dl.uuid, text: dl.text, images: dl.images, ...(dl.priority ? { priority: dl.priority } : {}), delivery: dl.delivery })),
      spawnedAt: this.spawnedAt, sentAny: this.sentAny, ttlMs: this.ttlMs, mode: this.mode, capabilities: [...this.caps], stuck: this.stuck,
    };
    if (this.lastRequestAt !== undefined) f.lastRequestAt = this.lastRequestAt;
    if (this.model !== undefined) f.model = this.model;
    if (this.cliVersion !== undefined) f.cliVersion = this.cliVersion;
    if (this.cliPid !== undefined) f.cliPid = this.cliPid;
    if (this.models.length) f.autoAvailable = this.autoAvailable();   // unknown (absent) until initializationResult lists models
    return f;
  }
  poolView(title: string): PoolChat {
    let queued = 0;
    for (const dl of this.deliv.values()) if (dl.delivery === 'pending' || dl.delivery === 'queued') queued++;
    return { chatId: this.chatId, accountId: this.spec.account.id, cwd: this.spec.cwd, title, phase: this.phase, busy: this.busy(),
      pendingAsks: this.d.asks.count(this.chatId), bgTasks: this.bg.length, queued, spawnedAt: this.spawnedAt, sentAny: this.sentAny,
      ...(this.lastRequestAt !== undefined ? { lastRequestAt: this.lastRequestAt } : {}), ttlMs: this.ttlMs,
      ...(this.lastContext !== undefined ? { lastContext: this.lastContext } : {}) };
  }
  /** ModelInfo.supportsAutoMode of the CURRENT model: the one the last system:init announced (a /model typed in the chat
   *  changes it too), else the user's choice, else the CLI default. */
  autoAvailable(): boolean {
    for (const id of [this.model, this.chosenModel ?? 'default']) {
      const m = id ? this.models.find((x) => x.value === id || x.resolvedModel === id) : undefined;
      if (m) return m.supportsAutoMode === true;
    }
    return this.models.find((x) => x.value === 'default')?.supportsAutoMode === true;
  }

  // ---------------------------------------------------------------- commands
  send(m: SendInput): 'accepted' | 'not_live' {
    if (!this.q || !this.isInputOpen()) return 'not_live';
    const images = m.images ?? [];
    const content: SDKUserMessage['message']['content'] = images.length
      ? [...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.base64 } })), { type: 'text' as const, text: m.text }]
      : m.text;                                                  // slash commands are plain text: the CLI dispatches them
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', uuid: m.uuid as SDKUserMessage['uuid'],
      origin: { kind: 'human' }, ...(m.priority && m.priority !== 'next' ? { priority: m.priority } : {}) };
    this.deliv.set(m.uuid, { uuid: m.uuid, text: m.text, images: images.length, ...(images.length ? { imageTypes: images.map((i) => i.mediaType), imageBytes: images.map((i) => b64Bytes(i.base64)) } : {}), ...(m.priority ? { priority: m.priority } : {}), delivery: 'pending' });
    this.sentAny = true;
    try { this.input.push(msg); } catch { this.deliv.delete(m.uuid); return 'not_live'; }
    this.changed();
    return 'accepted';
  }

  async interrupt(): Promise<{ stillQueued: P.Uuid[] }> {
    const q = this.q;
    if (!q || this.finished) return { stillQueued: [] };
    await sleepImmediate();                                      // a just-pushed message must reach stdin first
    this.stuckTimer?.cancel();
    this.stuckTimer = this.d.clock.timer(INTERRUPT_WATCHDOG_MS, () => {
      this.stuckTimer = null;
      if (this.busy() || this.d.asks.count(this.chatId) > 0) { this.stuck = true; this.changed(); }
    });
    try {
      const r = await ctl('interrupt', () => q.interrupt(), INTERRUPT_WATCHDOG_MS, this.d.clock) as { still_queued?: unknown } | undefined;
      const sq = Array.isArray(r?.still_queued) ? (r.still_queued as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      return { stillQueued: sq };
    } catch (e) {
      this.d.log.warn('engine: interrupt failed', { chatId: this.chatId, err: String(e) });
      this.stuck = true;
      this.changed();
      return { stillQueued: [] };
    }
  }

  async cancelQueued(uuid: P.Uuid): Promise<boolean> {
    if (!this.q || this.finished || !hasMethod(this.q, 'cancelAsyncMessage')) return false;
    await sleepImmediate();                                      // the prompt goes through the iterable; control requests overtake it
    try { return (await ctlMethod<boolean>(this.q, 'cancelAsyncMessage', [uuid], undefined, this.d.clock)) === true; } catch { return false; }
  }

  private live(): Query {
    if (!this.q || this.finished || this.phase === 'closing') throw new EngineError('not_live');
    return this.q;
  }
  async setMode(m: P.PermissionModeId): Promise<void> {
    if (m === 'bypassPermissions' && !this.spec.allowBypass) throw new EngineError('forbidden', 'bypassPermissions needs allowDangerouslySkipPermissions at spawn');
    await ctlMethod(this.live(), 'setPermissionMode', [m], undefined, this.d.clock);
    this.mode = m;
    this.changed();
  }
  async setModel(model: string | null, effort: P.Effort | null): Promise<void> {
    const q = this.live();
    if (model !== this.chosenModel) {
      await ctlMethod(q, 'setModel', model === null ? [] : [model], undefined, this.d.clock);
      this.chosenModel = model;
      if (model !== null) this.model = model;
    }
    if (effort !== this.chosenEffort) {
      await ctlMethod(q, 'applyFlagSettings', [{ effortLevel: effort }], undefined, this.d.clock);
      this.chosenEffort = effort;
    }
    this.changed();
  }
  async rename(title: string): Promise<void> {
    await ctlMethod(this.live(), 'renameSession', [title, this.sessionId], undefined, this.d.clock);
  }
  async task(op: 'stop' | 'background' | 'stopAll', ref?: string): Promise<void> {
    const q = this.live();
    if (op === 'background') { await ctlMethod(q, 'backgroundTasks', ref === undefined ? [] : [ref], undefined, this.d.clock); return; }
    const ids = op === 'stopAll' ? [...this.bg] : ref ? [ref] : [];
    if (op === 'stop' && !ref) throw new EngineError('invalid', 'task id required');
    for (const id of ids) await ctlMethod(q, 'stopTask', [id], undefined, this.d.clock);
  }
  async contextSummary(): Promise<P.ContextSummary> {
    const r = await ctlMethod<Record<string, unknown>>(this.live(), 'getContextUsage', [{ detail: 'summary' }], undefined, this.d.clock);   // NEVER 'full'
    const window = num(r['rawMaxTokens']) || num(r['maxTokens']);
    const cats = Array.isArray(r['categories']) ? (r['categories'] as { name?: unknown; tokens?: unknown; kind?: unknown }[]) : [];
    const mem = Array.isArray(r['memoryFiles']) ? (r['memoryFiles'] as { path?: unknown }[]) : [];
    return { total: num(r['totalTokens']), window, autoCompactAt: Math.max(0, window - AUTO_COMPACT_MARGIN_TOKENS),
      categories: cats.filter((c) => c.kind !== 'free' && typeof c.name === 'string').map((c) => ({ name: c.name as string, tokens: num(c.tokens) })),
      memoryFiles: mem.map((f) => f.path).filter((p): p is string => typeof p === 'string') };
  }
  async rules(): Promise<P.RuleView[]> {
    const r = await ctlMethod<{ state?: { rules?: { behavior?: unknown; source?: unknown; rule?: unknown; editability?: unknown }[] } }>(this.live(), 'listPermissionRules', [], undefined, this.d.clock);
    return (r?.state?.rules ?? []).filter((x) => x.behavior === 'allow' || x.behavior === 'deny' || x.behavior === 'ask').map((x) => ({
      behavior: x.behavior as P.RuleView['behavior'], source: String(x.source ?? ''), rule: String(x.rule ?? ''),
      editable: x.editability === 'persistent' || x.editability === 'session' }));
  }
  async commands(): Promise<P.SlashCommandView[]> {
    const list = await ctlMethod<{ name: string; description?: string; argumentHint?: string; aliases?: string[]; builtin?: boolean }[]>(this.live(), 'supportedCommands', [], undefined, this.d.clock);
    return (list ?? []).map((c) => ({
      name: c.name, description: c.description ?? '', ...(c.argumentHint ? { hint: c.argumentHint } : {}),
      group: c.builtin ? 'builtin' : c.name.startsWith('mcp__') || /\(MCP\)/.test(c.description ?? '') ? 'mcp' : c.name.includes(':') ? 'plugin' : 'skill',
      local: LOCAL_COMMANDS.has(c.name), ...(c.aliases?.length ? { aliases: c.aliases } : {}) }));
  }
  async usage(): Promise<Record<string, unknown> | null> {
    try {
      return await ctlMethod<Record<string, unknown>>(this.live(), 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET', [{ skipBehaviors: true }], undefined, this.d.clock) ?? null;
    } catch (e) { if (e instanceof EngineError && e.code === 'unsupported') return null; throw e; }
  }
  async rewindFiles(userUuid: P.Uuid, dryRun: boolean): Promise<P.RewindPreview> {
    const r = await ctlMethod<{ canRewind?: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }>(this.live(), 'rewindFiles', [userUuid, { dryRun }], undefined, this.d.clock);
    if (!r?.canRewind) throw new EngineError('invalid', r?.error ?? 'rewind refused');
    const files = r.filesChanged ?? [];
    return { files: files.map((p) => (files.length === 1 ? { path: p, added: num(r.insertions), removed: num(r.deletions) } : { path: p, added: 0, removed: 0 })) };
  }

  // ---------------------------------------------------------------- close (SPEC §2.7)
  /** True when reap/evict must leave this chat alone (running, ask, tasks, queue). */
  isBusyForReap(): boolean {
    return this.busy() || this.d.asks.count(this.chatId) > 0 || this.bg.length > 0 || [...this.deliv.values()].some((x) => x.delivery === 'pending' || x.delivery === 'queued');
  }

  /**
   * Runs the closing algorithm and resolves with the ExitInfo; null when reap/evict found the chat busy.
   * A process that survives every step stays registered with `unkillable` (a later close('force') retries step 4).
   */
  close(reason: SleepReason, o: { stopTasks?: boolean; note?: string } = {}): Promise<ExitInfo | null> {
    if (this.finished) return this.done;
    if (this.closing && reason !== 'force') return this.closing;
    if ((reason === 'reap' || reason === 'evict') && this.isBusyForReap()) return Promise.resolve(null);
    this.closeReason = reason;
    // ExitInfo.message tells the sink why a process it did not stop is gone: 'reap', 'evict:never' (class 1, silent),
    // 'evict:expired' (class 2, toast chat.sleep) or 'evict' (a cap.choice victim).
    if (reason === 'reap' || reason === 'evict') this.closeNote = o.note ?? reason;
    this.phase = 'closing';
    this.changed();
    const run = this.runClose(reason, o);
    if (reason !== 'force' || !this.closing) this.closing = run;
    return run;
  }

  private exitedNow = (): boolean => this.finished || (this.child !== null && this.childGone);

  private async runClose(reason: SleepReason, o: { stopTasks?: boolean }): Promise<ExitInfo | null> {
    const W = (ms: number): Promise<boolean> => this.waitFor(this.exitedNow, ms);
    if (reason !== 'force' && this.q) {
      // 1. Running: interrupt and wait ≤ 10 s for the result (input.end() alone would block until the turn ends).
      if (this.busy() || this.d.asks.count(this.chatId) > 0) {
        const sent = this.interrupt();                           // never throws; its ctl timeout runs in parallel: step 1 is ≤ 10 s in all
        await this.waitFor(() => this.exitedNow() || (!this.busy() && this.d.asks.count(this.chatId) === 0), CLOSE_RUNNING_RESULT_WAIT_MS);
        void sent;
      }
      // 2. Background tasks: only with stopTasks (confirmed by sleep.tasks.confirm).
      if (this.bg.length > 0 && o.stopTasks && !this.exitedNow()) {
        // All stopTask requests at once, then ≤ 5 s for the set to empty: the step is bounded whatever the control calls do.
        const q = this.q;
        for (const id of [...this.bg]) void ctlMethod(q, 'stopTask', [id], undefined, this.d.clock).catch(() => undefined);
        await this.waitFor(() => this.exitedNow() || this.bg.length === 0, CLOSE_BG_TASKS_WAIT_MS);
      }
      // 3. input.end(), then ≤ 8 s for the exit (normal: 0.6–1.7 s).
      this.input.end();
      if (await W(CLOSE_EXIT_WAIT_MS)) return this.done;
    }
    // 4. q.close(), then our own kill 2 s later, then ≤ 3 s more.
    this.input.end();
    try { this.q?.close(); } catch { /* ignore */ }
    if (!(await W(CLOSE_OWN_KILL_DELAY_MS))) {
      this.killChild();
      if (!(await W(CLOSE_KILL_WAIT_MS))) {
        // 5. Still alive: keep it registered, flagged; the UI offers « Forcer l'arrêt ».
        this.unkillable = true;
        this.d.log.error('engine: unkillable process', { chatId: this.chatId, pids: this.pids() });
        this.changed();
        return { reason: 'killed', code: null, signal: null, at: this.d.clock.now(), stderrTail: this.stderrRing.join('\n'), message: 'unkillable' };
      }
    }
    // Gone (or never spawned): finish() reports the exit once the SDK iterator is over (it can trail the 'exit' event).
    if (!this.finished) await this.waitFor(() => this.finished, CLOSE_KILL_WAIT_MS);
    return this.finished ? this.done : { reason: 'killed', code: null, signal: null, at: this.d.clock.now(), stderrTail: this.stderrRing.join('\n'), message: 'unkillable' };
  }
}
