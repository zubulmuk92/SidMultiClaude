// src/server/model/chat-state.ts — createChatState(): phase/sub/flags/pending/error/limit (ux §4).
// Pure state machine: every input carries its own time; nothing reads a clock. Each on*() returns true when view() changed.
// Phase priority: error › needs_* (open asks) › rate_limited › cold (no process) › starting › running › idle.
import type { ChatStateMachine, CreateChatState, ExitInfo, FrameSignals, ProcessFacts } from '../contracts.ts';
import type * as P from '../../shared/protocol.ts';

type ErrorView = NonNullable<P.ChatStateView['error']>;
const ASK_PHASE: Record<P.AskKind, P.ChatPhase> = { permission: 'needs_permission', elicitation: 'needs_permission', question: 'needs_answer', plan: 'needs_plan' };
const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export const createChatState: CreateChatState = (seed) => {
  let facts: ProcessFacts | null = null;
  let error: ErrorView | undefined;
  let limit: P.ChatStateView['limit'];
  let asks: P.ChatStateView['pending'] = { count: 0 };
  let externalHolder: P.ExternalHolder | null = null;
  let unread = false;
  let sub: P.SubPhase | undefined;
  let subTool: string | undefined;
  let stopping = false;
  let notStarted = seed.notStarted;
  let phase: P.ChatPhase = 'cold';
  let since = 0;
  let lastAt = 0;

  // A transcript tail keeps its last error forever. A cold chat shows a limit only while it has not reset
  // (seed.now = the caller's clock), and an old `authentication_failed` marks the chat only while the account itself
  // still needs a login (reauth / disconnected); otherwise months-old entries filled « À traiter ».
  const future = (at: number | undefined): at is number => at !== undefined && at > 0 && (seed.now === undefined || at > seed.now);
  if (future(seed.limitResetsAt)) limit = { resetsAt: seed.limitResetsAt, kind: 'five_hour' };
  if (seed.lastError?.kind === 'rate_limit' && future(seed.lastError.resetsAt)) limit = { resetsAt: seed.lastError.resetsAt, kind: 'five_hour' };
  if (seed.lastError?.kind === 'auth' && (seed.accountLogin === 'reauth' || seed.accountLogin === 'disconnected')) error = { code: 'auth' };

  const computePhase = (): P.ChatPhase => {
    if (error) return 'error';
    if (facts && asks.count > 0) return ASK_PHASE[asks.kind ?? 'permission'];
    if (limit) return 'rate_limited';
    if (!facts) return 'cold';
    if (facts.phase === 'spawning') return 'starting';
    // a message handed to the CLI but not yet acknowledged (`pending`) already counts as the turn: on a wake the chat
    // used to flash « Prêt » between « Démarrage… » and « Rédaction… »
    const handing = Array.isArray(facts.queue) && facts.queue.some((q) => q?.delivery === 'pending');
    return facts.busy || handing ? 'running' : 'idle';
  };
  const build = (): P.ChatStateView => {
    const v: P.ChatStateView = {
      phase, since,
      flags: {
        live: facts !== null, unread, bgTasks: count(facts?.bgTasks),
        queued: facts && Array.isArray(facts.queue) ? facts.queue.filter((q) => q?.delivery === 'pending' || q?.delivery === 'queued').length : 0,
        external: facts ? null : externalHolder, stuck: facts?.stuck === true, notStarted,
      },
      pending: { ...asks },
    };
    if (phase === 'running') {
      const s: P.SubPhase | undefined = stopping ? 'stopping' : sub;
      if (s) v.sub = s;
      if (s === 'tool' && subTool) v.subTool = subTool;
    }
    if (error) v.error = { ...error };
    if (limit) v.limit = { ...limit };
    return v;
  };
  phase = computePhase();
  let current = build();
  let currentKey = JSON.stringify(current);

  /** Recomputes the phase (since moves only when the phase changes) and reports whether the view changed. */
  const commit = (at?: number): boolean => {
    if (at !== undefined && Number.isFinite(at)) lastAt = Math.max(lastAt, at);
    const next = computePhase();
    if (next !== phase) {
      phase = next;
      since = phase.startsWith('needs_') && asks.oldestAt !== undefined ? asks.oldestAt : at ?? lastAt;
      if (phase !== 'running') { sub = undefined; subTool = undefined; stopping = false; }
    }
    current = build();
    const key = JSON.stringify(current);
    const changed = key !== currentKey;
    currentKey = key;
    return changed;
  };

  const m: ChatStateMachine = {
    onFacts(fIn: ProcessFacts | null, at: number): boolean {
      const f = fIn !== null && typeof fIn === 'object' ? fIn : null;
      const wasSpawning = facts?.phase === 'spawning';
      if (f && f.phase === 'spawning' && !wasSpawning) error = undefined;   // a new spawn (Réessayer, wake) clears the error
      if (f?.sentAny) notStarted = false;
      if (f && !f.busy) { stopping = false; sub = undefined; subTool = undefined; }
      facts = f;
      if (!f) { asks = { count: 0 }; stopping = false; }
      return commit(at);
    },
    onSignals(sIn: FrameSignals, at: number): boolean {
      const s: FrameSignals = sIn !== null && typeof sIn === 'object' ? sIn : {};
      if (s.sub !== undefined) { sub = s.sub ?? undefined; subTool = s.sub === 'tool' ? s.subTool : undefined; }
      if (s.retry) sub = 'retry';
      if (s.rateLimit) {
        // The assistant `rate_limit` error and the usage-limit result text carry no reset time: keep the one the
        // rate_limit_event of the same request gave (0 = unknown).
        if (s.rateLimit.status === 'rejected') limit = { resetsAt: s.rateLimit.resetsAt ?? limit?.resetsAt ?? 0, kind: s.rateLimit.kind ?? limit?.kind ?? 'five_hour' };
        else limit = undefined;
      }
      if (s.authError) error = { code: 'auth' };
      else if (s.billingError) error = { code: 'billing' };
      else if (s.modelNotFound) error = { code: 'model_not_found' };
      else if (s.overloaded) error = { code: 'overloaded' };
      if (s.turnEnded) { unread = true; sub = undefined; subTool = undefined; stopping = false; }
      return commit(at);
    },
    onAsks(count: number, oldestAt: number | undefined, kind: P.AskKind | undefined): boolean {
      asks = count > 0 ? { count, ...(oldestAt !== undefined ? { oldestAt } : {}), ...(kind ? { kind } : {}) } : { count: 0 };
      return commit(oldestAt);
    },
    onExternal(h: P.ExternalHolder | null): boolean {
      externalHolder = h;
      return commit();
    },
    onExit(info: ExitInfo, at: number): boolean {
      facts = null;
      asks = { count: 0 };
      stopping = false;
      if (info.reason === 'crash') error = { code: 'crash', ...(info.code !== null ? { exitCode: info.code } : {}), ...(info.message ? { message: info.message } : {}) };
      else if (info.reason === 'spawn_failed' || info.reason === 'init_timeout') error = { code: 'startup', ...(info.message ? { message: info.message } : {}) };
      return commit(at);
    },
    onUser(ev: 'viewed' | 'interrupt' | 'send' | 'retry' | 'breaker', at: number): boolean {
      if (ev === 'viewed') unread = false;
      else if (ev === 'retry') error = undefined;              // chat.retry: the error banner goes away, nothing else changes
      else if (ev === 'breaker') { if (!facts) error = { code: 'breaker' }; }   // a send refused by the open crash breaker (cold only)
      else if (ev === 'interrupt') { if (facts?.busy || asks.count > 0) stopping = true; }
      else { unread = false; error = undefined; }
      return commit(at);
    },
    view(): P.ChatStateView { return current; },
  };
  return m;
};
