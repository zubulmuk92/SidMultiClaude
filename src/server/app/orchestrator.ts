// src/server/app/orchestrator.ts — per-chat runtime (reducer + state), engine sink, index merge, summaries (SPEC §5.5, server shell).
// Runtime = {reducer?, state, lastSummary, …}: created when a chat is live or viewed, dropped 5 min after
// neither. Summary = SessionMeta ⊕ ChatMeta ⊕ state ⊕ activity; `chats` upserts ≤ 2/s per chat, phase changes at once.
// One try/catch per sink callback: a bad frame or a failing chat never reaches the event loop (§2.9, S20).
import type * as P from '../../shared/protocol.ts';
import type {
  AccountStore, ChatMeta, ChatStateMachine, Clock, CreateChatState, CreateLiveReducer, ActivityLine, DeriveTitle, Engine, EngineSink,
  ExitInfo, LiveReducer, Logger, MetaStore, SessionIndex, LiveRegistry, PromptHistory, WakeEstimate, HeavyLoc, ProcessFacts, SdkHelpers,
  FrameSignals, SessionMeta, CostBaseline, SmcEngineFrame,
} from '../contracts.ts';
import type { HubImpl } from '../ws/hub.ts';
import {
  CACHE_TTL_1H_MS, PROCS_PUSH_MIN_INTERVAL_MS, RUNTIME_DROP_MS, SUMMARY_UPSERT_MIN_INTERVAL_MS, WAKE_DIALOG_IDLE_MS,
  WAKE_DIALOG_MIN_CONTEXT, WAKE_SHARED_WINDOW_MS,
} from '../../shared/limits.ts';
import { makeChatId, parseChatId } from '../util/ids.ts';

export type ModelFns = { createLiveReducer: CreateLiveReducer; createChatState: CreateChatState; deriveTitle: DeriveTitle; activityLine: ActivityLine; wakeEstimate: WakeEstimate };
export type OrchestratorDeps = {
  clock: Clock; log: Logger; hub: HubImpl; meta: MetaStore; accounts: AccountStore; index: SessionIndex; registry: LiveRegistry;
  history: PromptHistory; model: ModelFns; boot: string; helpers?: SdkHelpers;
  onLifetime?: (ev: 'exited' | 'askEnd' | 'ask') => void;
  /** The set of live chats changed (a process spawned or exited): main.ts rewrites run\crash.marker (§2.9). */
  onLiveSet?: () => void;
};
type Runtime = {
  chatId: P.ChatId; reducer: LiveReducer | null; state: ChatStateMachine; lastSummary: P.ChatSummary | null; lastUpsertAt: number;
  upsertTimer: { cancel(): void } | null; dropTimer: { cancel(): void } | null; tool?: { name: string; description?: string };
  renameTried: boolean; renameRetried?: boolean; renamePending: string | null; notice: P.UiTurn | null;
  exited: boolean; returned: P.QueueItem[]; lastQueue: string; limitTimer: { cancel(): void } | null; lastText?: string;
  /** Seed of the next live reducer: cost baseline from the transcript tail for resume / fork / rewind. */
  spawnSeed: { baseline: CostBaseline | null; resumed: boolean } | null;
  autoAvailable?: boolean;                               // last ProcessFacts.autoAvailable (kept while cold: last known)
  identityMismatch?: { expected: string; actual: string };
};

export interface Orchestrator {
  readonly sink: EngineSink;
  attachEngine(e: Engine): void;
  start(): void;
  known(chatId: P.ChatId): boolean;
  summary(chatId: P.ChatId): P.ChatSummary | null;
  summaries(): P.ChatSummary[];
  snapshot(chatId: P.ChatId): P.ChatSnapshot | null;
  hello(): Extract<P.S2C, { t: 'hello' }>;
  asks(): P.PendingAsk[];
  pendingAskCount(): number;
  upsert(chatId: P.ChatId, urgent?: boolean): void;
  remove(chatId: P.ChatId): void;
  onUser(chatId: P.ChatId, ev: 'viewed' | 'interrupt' | 'send' | 'retry' | 'breaker'): void;
  /** Called by commands right before engine.ensure(): seeds the next live reducer (cost baseline, resumed flag). */
  prepareSpawn(chatId: P.ChatId, seed: { baseline: CostBaseline | null; resumed: boolean }): void;
  /** Identity cross-check result of the chat's last init (« Infos de session » note), if the email differed. */
  identityMismatch(chatId: P.ChatId): { expected: string; actual: string } | undefined;
  onViewChange(): void;
  detail(chatId: P.ChatId, id: string, field: P.DetailField): P.DetailPayload | null;
  setHeavy(chatId: P.ChatId, heavy: HeavyLoc[], lastTurnId: string | null): void;
  heavy(chatId: P.ChatId, id: string, field: P.DetailField): HeavyLoc | undefined;
  addNotice(chatId: P.ChatId, row: P.UiSystemRow): void;
  noteAccepted(chatId: P.ChatId, uuid: P.Uuid): boolean;   // false when already seen (outbox duplicate)
  /**
   * A message handed back by a crash (« Non envoyé ») leaves the chat's queue — re-sent under a new uuid, taken back
   * into the editor or removed (chat.cancelQueued on a cold chat). Every window gets the new queue. False if unknown.
   */
  dropReturned(chatId: P.ChatId, uuid: P.Uuid): boolean;
  procs(): P.ProcStats;
  pushProcs(): void;
  pushAccounts(): void;
  /** The account as pushed to windows (AccountView.models filled from the model catalog). */
  accountView(id: P.AccountId): P.AccountView | undefined;
  dispose(): void;
}
const NO_ENGINE_STATS: P.ProcStats = { live: 0, max: 0, effectiveMax: 0, lowMem: false, estRamMB: 0, isolation: 'plain', items: [] };
const SEEN_UUIDS_MAX = 2_000;
const INDEX_NUDGE_MIN_MS = 2_000;                                // first-turn index reconcile, per account
const DAY_MS = 86_400_000;
const HEAVY_CHATS_MAX = 32;
const errText = (e: unknown): string => String((e as Error)?.stack ?? e).slice(0, 2_000);

export function createOrchestrator(d: OrchestratorDeps): Orchestrator {
  const rts = new Map<P.ChatId, Runtime>();
  const askMap = new Map<P.ChatId, Map<string, P.PendingAsk>>();
  const lastFacts = new Map<P.ChatId, ProcessFacts>();
  const lastIndexNudge = new Map<P.AccountId, number>();
  const crashAsked = new Map<P.ChatId, Set<string>>();             // tool_use ids of asks a crash ended (askEnd before exited)
  const seen = new Map<P.ChatId, Set<P.Uuid>>();
  const heavyMap = new Map<P.ChatId, { locs: Map<string, HeavyLoc>; lastTurnId: string | null }>();
  const unsubs: (() => void)[] = [];
  let engine: Engine | null = null;
  let procsTimer: { cancel(): void } | null = null;
  let lastProcsAt = -Infinity;
  let accountViews: P.AccountView[] | null = null;
  let noticeN = 0;
  let disposed = false;                                   // after dispose(): no timer is ever armed again
  const now = (): number => d.clock.now();
  const guard = (what: string, chatId: P.ChatId | null, fn: () => void): void => {
    try { fn(); } catch (e) { d.log.error(`orchestrator: ${what} failed`, { chatId, err: errText(e) }); }
  };
  const views = (): P.AccountView[] => (accountViews ??= d.accounts.list().map(withModels));
  /** AccountView.models from the account's model catalog (0 tokens); absent when the catalog is empty. */
  function withModels(v: P.AccountView): P.AccountView {
    let models: P.ModelOption[] = [];
    try { models = d.accounts.modelCatalog(v.id); } catch (e) { d.log.warn('modelCatalog failed', { accountId: v.id, err: String(e) }); }
    return models.length ? { ...v, models } : v;
  }

  // ---------------------------------------------------------------- runtimes
  function seedOf(chatId: P.ChatId): Parameters<CreateChatState>[0] {
    const sm = d.index.get(chatId);
    const cm = d.meta.chat(chatId);
    const le = sm?.lastError;
    const t = now();
    const seed: Parameters<CreateChatState>[0] = { notStarted: !sm && !!cm?.pendingStart, now: t };
    // The transcript tail's last error is history. A rate limit is seeded only while it has not reset, an
    // `auth` error only while the account itself still needs a login: stale ones must not fill « À traiter ».
    const login = views().find((a) => a.id === parseChatId(chatId)?.accountId)?.login;
    if (login) seed.accountLogin = login;
    if (le?.kind === 'rate_limit' && le.resetsAt && le.resetsAt > t) { seed.lastError = le; seed.limitResetsAt = le.resetsAt; }
    else if (le?.kind === 'auth' && (login === 'reauth' || login === 'disconnected')) seed.lastError = le;
    return seed;
  }
  function holderOf(chatId: P.ChatId): P.ExternalHolder | null {
    const p = parseChatId(chatId);
    if (!p) return null;
    try { return d.registry.holder(p.accountId, p.sessionId); } catch { return null; }
  }
  function rt(chatId: P.ChatId): Runtime {
    let r = rts.get(chatId);
    if (r) return r;
    const state = d.model.createChatState(seedOf(chatId));
    state.onExternal(holderOf(chatId));
    r = { chatId, reducer: null, state, lastSummary: null, lastUpsertAt: -Infinity, upsertTimer: null, dropTimer: null, renameTried: false,
      renamePending: null, notice: null, exited: false, returned: [], lastQueue: '[]', limitTimer: null, spawnSeed: null };
    rts.set(chatId, r);
    armLimit(r);
    return r;
  }
  function reducerOf(r: Runtime): LiveReducer {
    if (r.reducer) return r.reducer;
    const s = summaryOf(r.chatId);
    const cm = d.meta.chat(r.chatId);
    const meta: P.ChatMetaView = { title: s?.title ?? '', cwd: s?.cwd ?? cm?.cwd ?? '', mode: s?.mode ?? cm?.mode ?? 'default' };
    if (s?.branch) meta.branch = s.branch;
    if (s?.model) meta.model = s.model;
    if (cm?.effort) meta.effort = cm.effort;
    if (r.autoAvailable !== undefined) meta.autoAvailable = r.autoAvailable;
    // resumed / forked / rewound: the transcript's last cost-state is the baseline (else the first result shows the cumulative
    // cost and false auxTokens); a brand-new session starts from 0. Without a prepared seed: resumed when the session exists on disk.
    const seed = r.spawnSeed ?? { baseline: null, resumed: cm?.pendingStart ? cm.pendingStart.kind === 'fork' : !!d.index.get(r.chatId) };
    r.reducer = d.model.createLiveReducer({ chatId: r.chatId, meta, metrics: {}, baseline: seed.baseline, resumed: seed.resumed });
    r.notice = null;
    return r.reducer;
  }
  function armLimit(r: Runtime): void {
    const lim = r.state.view().limit;
    if (!lim) { r.limitTimer?.cancel(); r.limitTimer = null; return; }
    if (r.limitTimer || disposed) return;
    r.limitTimer = d.clock.timer(Math.max(0, lim.resetsAt - now()), () => {
      r.limitTimer = null;
      guard('limit reset', r.chatId, () => { if (r.state.onSignals({ rateLimit: { status: 'allowed', info: {} } }, now())) stateChanged(r); armDrop(r); });
    });
  }
  function armDrop(r: Runtime): void {
    r.dropTimer?.cancel();
    r.dropTimer = null;
    if (disposed) return;
    if (engine?.isLive(r.chatId) || d.hub.visible().has(r.chatId)) return;
    r.dropTimer = d.clock.timer(RUNTIME_DROP_MS, () => {
      r.dropTimer = null;
      const v = r.state.view();
      if (engine?.isLive(r.chatId) || d.hub.visible().has(r.chatId) || v.error || v.limit || (askMap.get(r.chatId)?.size ?? 0) > 0 || r.renamePending) return;
      r.upsertTimer?.cancel();
      r.limitTimer?.cancel();
      rts.delete(r.chatId);
    });
  }
  function stateChanged(r: Runtime): void {
    d.hub.emit(r.chatId, [{ k: 'state', state: r.state.view() }], true);
    armLimit(r);
    upsert(r.chatId);
  }
  /** An OLD auth error (transcript tail) counts only while its account is 'reauth' or 'disconnected', so
   *  a login state change summarises that account's chats again: a cold chat re-seeds against the new state, and once
   *  the account is connected again a runtime that is not live drops its auth error (the re-login answered it). */
  function onLoginChange(accountId: P.AccountId, login: P.LoginState): void {
    for (const id of allIds()) {
      if (parseChatId(id)?.accountId !== accountId) continue;
      guard('login change', id, () => {
        const r = rts.get(id);
        if (r) {
          if (login === 'connected' && r.state.view().error?.code === 'auth' && !engine?.isLive(id) && r.state.onUser('retry', now())) stateChanged(r);
        } else if (d.index.get(id)?.lastError?.kind === 'auth') upsert(id);
      });
    }
  }

  // ---------------------------------------------------------------- summaries (SessionMeta ⊕ ChatMeta ⊕ state ⊕ activity)
  function titleOf(sm: SessionMeta | undefined, cm: ChatMeta | undefined): { title: string; titleSource: P.ChatSummary['titleSource'] } {
    if (sm && (sm.titleSource === 'custom' || sm.titleSource === 'ai')) return { title: sm.title, titleSource: sm.titleSource };
    if (cm?.title) return { title: cm.title, titleSource: 'app' };
    if (sm && sm.titleSource !== 'none' && sm.title) return { title: sm.title, titleSource: sm.titleSource };
    return { title: sm?.title ?? '', titleSource: 'none' };
  }
  function sharedPrefix(accountId: P.AccountId, cwd: string, chatId: P.ChatId): 'sameCwd' | 'account' | 'none' {
    let out: 'sameCwd' | 'account' | 'none' = 'none';
    const t = now();
    for (const [id, f] of lastFacts) {
      if (id === chatId || parseChatId(id)?.accountId !== accountId) continue;
      if (f.lastRequestAt === undefined || t - f.lastRequestAt > WAKE_SHARED_WINDOW_MS) continue;
      const c = d.meta.chat(id)?.cwd ?? d.index.get(id)?.cwd;
      if (c && cwd && c.toLowerCase() === cwd.toLowerCase()) return 'sameCwd';
      out = 'account';
    }
    return out;
  }
  function summaryOf(chatId: P.ChatId): P.ChatSummary | null {
    const p = parseChatId(chatId);
    if (!p) return null;
    const sm = d.index.get(chatId);
    const cm = d.meta.chat(chatId);
    if (!sm && !cm) return null;
    const r = rts.get(chatId);
    let state: P.ChatStateView;
    if (r) state = r.state.view();
    else {
      const sm2 = d.model.createChatState(seedOf(chatId)); sm2.onExternal(holderOf(chatId)); state = sm2.view();
      // A cold chat still under a (future) limit gets its runtime, whose timer clears the limit once it resets
      if (state.limit && !disposed) state = rt(chatId).state.view();
    }
    const f = lastFacts.get(chatId);
    const { title, titleSource } = titleOf(sm, cm);
    const cwd = cm?.cwd ?? sm?.cwd ?? '';
    const updatedAt = Math.max(sm?.updatedAt ?? 0, cm?.lastRequestAt ?? 0, sm ? 0 : cm?.createdAt ?? 0);
    const s: P.ChatSummary = {
      chatId, accountId: p.accountId, sessionId: p.sessionId, title, titleSource, cwd, origin: sm?.origin ?? 'app',
      createdAt: sm?.createdAt ?? cm?.createdAt ?? updatedAt, updatedAt, size: sm?.size ?? 0,
      pinned: !!cm?.pinned, archived: !!cm?.archived, muted: !!cm?.muted, keepAlive: !!cm?.keepAlive,
      state, activity: '', expiresInDays: null, foreignOwner: false,
    };
    if (sm?.branch) s.branch = sm.branch;
    if (sm?.firstPrompt) s.firstPrompt = sm.firstPrompt;
    const model = f?.model ?? cm?.model ?? sm?.model;
    if (model) s.model = model;
    const mode = f?.mode ?? cm?.mode ?? sm?.lastMode;
    if (mode) s.mode = mode;
    if (sm?.costUsd !== undefined) s.costUsd = sm.costUsd;
    if (cm?.links) s.links = cm.links;
    const ask = [...(askMap.get(chatId)?.values() ?? [])].sort((a, b) => a.since - b.since)[0];
    const act: Parameters<ActivityLine>[0] = {};
    if (ask) act.ask = ask;
    if (r?.tool && state.phase === 'running') act.tool = r.tool;
    if (r?.lastText) act.lastText = r.lastText;
    if (sm?.firstPrompt) act.firstPrompt = sm.firstPrompt;
    try { s.activity = d.model.activityLine(act); } catch { s.activity = ''; }
    const acc = views().find((a) => a.id === p.accountId);
    if (sm?.ownerAccountUuid && acc?.identity?.accountUuid && sm.ownerAccountUuid !== acc.identity.accountUuid) s.foreignOwner = true;
    if (sm && sm.size > 0) {
      let days = 30;
      try { days = d.accounts.cleanupDays(p.accountId); } catch { /* default */ }
      s.expiresInDays = Math.max(0, Math.ceil(days - (now() - (sm.updatedAt || sm.mtimeMs)) / DAY_MS));
    }
    const lastContext = cm?.lastContext ?? sm?.lastContext;
    if (!f && lastContext) {
      const last = cm?.lastRequestAt ?? sm?.lastRequestAt ?? sm?.updatedAt ?? updatedAt;
      const idleMs = Math.max(0, now() - last);
      let recache = lastContext;
      try { recache = d.model.wakeEstimate(lastContext, sharedPrefix(p.accountId, cwd, chatId)); } catch { /* raw */ }
      const dialog = idleMs > WAKE_DIALOG_IDLE_MS && lastContext > WAKE_DIALOG_MIN_CONTEXT && !d.meta.settings().wakeNeverAsk;
      s.wake = { lastContext, recacheTokens: recache, idleMs, dialog };
    }
    return s;
  }
  function upsert(chatId: P.ChatId, urgent = false): void {
    const s = summaryOf(chatId);
    if (!s) return;
    const r = rts.get(chatId);
    if (!r) { d.hub.push(null, [{ t: 'chats', upsert: [s], remove: [] }], urgent); return; }
    const same = r.lastSummary !== null && JSON.stringify({ ...r.lastSummary, wake: undefined }) === JSON.stringify({ ...s, wake: undefined });
    if (same && !urgent) return;
    const phaseChanged = !r.lastSummary || r.lastSummary.state.phase !== s.state.phase || r.lastSummary.state.pending.count !== s.state.pending.count;
    const due = r.lastUpsertAt + SUMMARY_UPSERT_MIN_INTERVAL_MS;
    if (urgent || phaseChanged || now() >= due) {
      r.upsertTimer?.cancel();
      r.upsertTimer = null;
      r.lastSummary = s;
      r.lastUpsertAt = now();
      d.hub.push(null, [{ t: 'chats', upsert: [s], remove: [] }], urgent || phaseChanged);
      return;
    }
    if (!r.upsertTimer && !disposed) r.upsertTimer = d.clock.timer(due - now(), () => { r.upsertTimer = null; guard('upsert', chatId, () => upsert(chatId)); });
  }

  // ---------------------------------------------------------------- engine sink (one try/catch per callback: S20)
  function onSignals(r: Runtime, sig: FrameSignals): void {
    const p = parseChatId(r.chatId)!;
    if (sig.rateLimit) guard('noteUsage', r.chatId, () => d.accounts.noteUsage(p.accountId, { kind: 'event', info: sig.rateLimit!.info }));
    if (sig.authError) guard('noteAuthError', r.chatId, () => d.accounts.noteAuthError(p.accountId));
    if (r.state.onSignals(sig, now())) stateChanged(r);
    if (sig.turnEnded) {
      // A chat whose transcript the index does not know yet (first turn of a new chat in a profile whose
      // projects folder had no watcher) is picked up now, not at exit: tx.page after a reload, fork and « Continuer sur »
      // need index.get(chatId). Stat-only, at most every 2 s per account; the reconcile also starts the missing watcher.
      if (!d.index.get(r.chatId) && !disposed && now() - (lastIndexNudge.get(p.accountId) ?? -Infinity) >= INDEX_NUDGE_MIN_MS) {
        lastIndexNudge.set(p.accountId, now());
        void d.index.reconcile(p.accountId).catch((e: unknown) => d.log.warn('index.reconcile failed', { accountId: p.accountId, err: String(e) }));
      }
      if (d.hub.looking(r.chatId) && r.state.onUser('viewed', now())) stateChanged(r);
      if (r.renamePending && !r.renameRetried) { r.renameRetried = true; tryRename(r, r.renamePending); }   // §2.4: one retry after the first result
    }
  }
  function trackActivity(r: Runtime, events: readonly P.ChatEvent[]): void {
    for (const ev of events) {
      if (ev.k === 'block' && ev.block.k === 'tool' && ev.block.status === 'running') r.tool = { name: ev.block.name, description: ev.block.input.summary };
      else if (ev.k === 'block' && ev.block.k === 'text' && !ev.block.live) r.lastText = ev.block.md.slice(0, 400);
      else if (ev.k === 'tool.result' || ev.k === 'turn.end') r.tool = undefined;
    }
  }
  /** Live q.renameSession; on failure the title stays pending (retried once after a result, then offline after sleep). */
  function tryRename(r: Runtime, t: string): void {
    r.renamePending = null;
    if (!engine) { r.renamePending = t; return; }
    engine.rename(r.chatId, t).catch(() => { r.renamePending = t; if (r.exited) offlineRename(r.chatId, t); });
  }
  function offlineRename(chatId: P.ChatId, title: string): void {
    const p = parseChatId(chatId);
    const acc = p ? d.accounts.get(p.accountId) : undefined;
    if (!p || !acc || !d.helpers) return;
    d.helpers.rename(acc, p.sessionId, title).then(() => { const r = rts.get(chatId); if (r?.renamePending === title) r.renamePending = null; },
      (e: unknown) => d.log.warn('offline rename failed', { chatId, err: String(e) }));
  }

  /** Synthetic engine notes (contracts.ts SmcEngineFrame): toasts, identity check, resumeStable, « Ouvert ailleurs ». */
  function engineNote(r: Runtime, n: SmcEngineFrame): void {
    const p = parseChatId(r.chatId)!;
    const toast = (key: string, args?: Record<string, string | number>): void =>
      d.hub.push(null, [{ t: 'toast', level: 'warn', key, ...(args ? { args } : {}), chatId: r.chatId }], true);
    switch (n.subtype) {
      case 'initialized': {
        const acc = views().find((a) => a.id === p.accountId);
        const expected = acc?.identity?.email;
        if (n.email && expected && n.email.trim().toLowerCase() !== expected.trim().toLowerCase()) {
          r.identityMismatch = { expected, actual: n.email };
          d.log.warn('identity mismatch at init', { chatId: r.chatId, accountId: p.accountId });
          toast('account.mismatch', { account: acc.name, expected, actual: n.email });
          o.addNotice(r.chatId, { kind: 'notice', text: 'account.mismatch', data: { key: 'account.mismatch', account: acc.name, expected, actual: n.email } });
        } else if (n.email && expected) r.identityMismatch = undefined;
        return;
      }
      case 'isolation_fallback': toast('isolation.fallback'); return;
      case 'rewind_fallback': toast('rewind.fallback'); return;
      case 'resume_stable': guard('noteResumeStable', r.chatId, () => d.accounts.noteResumeStable(p.accountId, n.stable)); return;
      case 'external_holder': if (r.state.onExternal(n.holder)) stateChanged(r); return;
    }
  }
  const sink: EngineSink = {
    frame(chatId, f, at) {
      guard('frame', chatId, () => {
        const r = rt(chatId);
        if (f.type === 'smc_engine') { engineNote(r, f as SmcEngineFrame); return; }
        const out = reducerOf(r).step(f, at);
        trackActivity(r, out.events);
        if (out.events.length) d.hub.emit(chatId, out.events, out.urgent);
        onSignals(r, out.signals);
        if (out.events.some((e) => e.k === 'meta' && e.meta.title !== undefined)) upsert(chatId);
      });
    },
    facts(chatId, f) {
      guard('facts', chatId, () => {
        const r = rt(chatId);
        // returned messages (« Non envoyé ») outlive the next process: they leave only through dropReturned (explicit click)
        if (f.phase === 'spawning' && r.exited) { r.exited = false; r.reducer = null; r.tool = undefined; }
        const prev = lastFacts.get(chatId);
        lastFacts.set(chatId, f);
        r.dropTimer?.cancel();
        r.dropTimer = null;
        const items = queueOf(r, f);
        const q = JSON.stringify(items);
        if (q !== r.lastQueue) { r.lastQueue = q; d.hub.emit(chatId, [{ k: 'queue', items }]); }
        if (f.lastRequestAt !== undefined && f.lastRequestAt !== prev?.lastRequestAt && d.meta.chat(chatId)) d.meta.patch(chatId, { lastRequestAt: f.lastRequestAt });
        if (f.cliPid !== prev?.cliPid && engine) { const e = engine; guard('ownPids', chatId, () => d.registry.setOwnPids(e.ownPids())); }
        if (f.autoAvailable !== undefined && f.autoAvailable !== r.autoAvailable) {
          r.autoAvailable = f.autoAvailable;
          d.hub.emit(chatId, [{ k: 'meta', meta: { autoAvailable: f.autoAvailable } }], true);
        }
        if (r.state.onFacts(f, now())) stateChanged(r); else upsert(chatId);
        pushProcs();
        if (!prev) d.onLiveSet?.();                       // first facts of a process: the chat just became live
      });
    },
    ask(a) {
      guard('ask', a.chatId, () => {
        let m = askMap.get(a.chatId);
        if (!m) { m = new Map(); askMap.set(a.chatId, m); }
        m.set(a.requestId, a);
        d.hub.push(null, [{ t: 'ask', ask: a }], true);
        askCountChanged(a.chatId);
        d.onLifetime?.('ask');
      });
    },
    askEnd(chatId, requestId, reason) {
      guard('askEnd', chatId, () => {
        const m = askMap.get(chatId);
        const ask = m?.get(requestId);
        if (!m?.delete(requestId)) return;
        if (!m.size) askMap.delete(chatId);
        // the engine ends a crashed chat's asks BEFORE exited(): keep their tools for processExited (→ withdrawn)
        if (reason === 'crash' && ask) (crashAsked.get(chatId) ?? crashAsked.set(chatId, new Set()).get(chatId)!).add(ask.toolUseId);
        d.hub.push(null, [{ t: 'askEnd', chatId, requestId, reason }], true);
        askCountChanged(chatId);
        d.onLifetime?.('askEnd');
      });
    },
    delivered(chatId, m) {
      guard('delivered', chatId, () => {
        const r = rt(chatId);
        const evs = reducerOf(r).userStarted(m);
        if (evs.length) d.hub.emit(chatId, evs, true);
        guard('history', chatId, () => d.history.append(chatId, m.text, m.at));
        if (d.meta.chat(chatId)?.pendingStart) d.meta.patch(chatId, { pendingStart: undefined });   // the CLI now owns the transcript
        if (!r.renameTried && titleOf(d.index.get(chatId), d.meta.chat(chatId)).titleSource === 'none') {
          r.renameTried = true;
          const t = d.model.deriveTitle(m.text);
          if (t) {
            if (d.meta.chat(chatId)) d.meta.patch(chatId, { title: t });
            tryRename(r, t);
            upsert(chatId);
          }
        }
      });
    },
    sessionChanged(chatId, sessionId) { guard('sessionChanged', chatId, () => rekey(chatId, sessionId)); },
    exited(chatId, info, returned) {
      guard('exited', chatId, () => {
        const r = rt(chatId);
        lastFacts.delete(chatId);
        r.exited = true;
        r.tool = undefined;
        if (r.reducer?.processExited) {
          const asked = new Set([...(askMap.get(chatId)?.values() ?? [])].map((a) => a.toolUseId).concat([...(crashAsked.get(chatId) ?? [])]));
          crashAsked.delete(chatId);
          const evs = r.reducer.processExited(asked);
          if (evs.length) d.hub.emit(chatId, evs, true);
        }
        if (info.reason !== 'closed' && info.reason !== 'killed') {
          const row: P.UiSystemRow = { kind: 'crash', data: { code: info.code ?? -1, reason: info.reason } };
          const evs = reducerOf(r).localRow(row, info.at);
          if (evs.length) d.hub.emit(chatId, evs, true);
        }
        r.returned = [...r.returned.filter((q) => !returned.some((x) => x.uuid === q.uuid)), ...returned];
        const qs = JSON.stringify(r.returned);                                   // the live queue is gone with the process
        if (qs !== r.lastQueue) { r.lastQueue = qs; d.hub.emit(chatId, [{ k: 'queue', items: r.returned }], true); }
        if (returned.length) {
          d.hub.push(null, [{ t: 'toast', level: 'warn', key: 'queue.returned.toast', args: { n: returned.length }, chatId }]);
        }
        const left = askMap.get(chatId);
        if (left) for (const id of [...left.keys()]) sink.askEnd(chatId, id, 'crash');
        r.state.onExit(info, now());
        stateChanged(r);
        if (r.renamePending) offlineRename(chatId, r.renamePending);
        if (engine) { const e = engine; guard('ownPids', chatId, () => d.registry.setOwnPids(e.ownPids())); }
        armDrop(r);
        pushProcs();
        d.onLiveSet?.();
        // the process wrote its last lines (and, for a first spawn, maybe created the projects folder the index does not
        // watch yet): a stat-only reconcile of that account picks the transcript up
        const acc = parseChatId(chatId)?.accountId;
        if (acc && !disposed) void d.index.reconcile(acc).catch((e: unknown) => d.log.warn('index.reconcile failed', { accountId: acc, err: String(e) }));
        d.onLifetime?.('exited');
      });
    },
  };
  function askCountChanged(chatId: P.ChatId): void {
    const r = rt(chatId);
    const list = [...(askMap.get(chatId)?.values() ?? [])].sort((a, b) => a.since - b.since);
    if (r.state.onAsks(list.length, list[0]?.since, list[0]?.kind)) stateChanged(r); else upsert(chatId, true);
  }

  // ---------------------------------------------------------------- re-key (/clear, CLI-chosen fork id)
  function rekey(from: P.ChatId, sessionId: P.SessionId): void {
    const p = parseChatId(from);
    if (!p) return;
    const to = makeChatId(p.accountId, sessionId);
    if (to === from) return;
    const cm = d.meta.chat(from);
    if (cm) d.meta.rekey(from, to);
    else {
      const sm = d.index.get(from);
      d.meta.upsert({ chatId: to, accountId: p.accountId, sessionId, cwd: sm?.cwd ?? '', createdAt: now() });
      void d.meta.flush().catch(() => {});
    }
    const r = rts.get(from);
    if (r) { rts.delete(from); r.chatId = to; r.lastSummary = null; rts.set(to, r); }
    for (const m of [askMap, lastFacts, seen, heavyMap] as Map<P.ChatId, unknown>[]) { const v = m.get(from); if (v !== undefined) { m.delete(from); m.set(to, v); } }
    for (const a of askMap.get(to)?.values() ?? []) a.chatId = to;
    d.hub.rekey(from, to);
    const up = [summaryOf(to), summaryOf(from)].filter((x): x is P.ChatSummary => !!x);
    d.hub.push(null, [{ t: 'chats', upsert: up, remove: up.some((x) => x.chatId === from) ? [] : [from], rekey: [{ from, to }] }], true);
    d.hub.emit(to, [{ k: 'reset', reason: 'clear' }], true);
  }

  // ---------------------------------------------------------------- snapshots, hello, procs
  function snapshot(chatId: P.ChatId): P.ChatSnapshot | null {
    const s = summaryOf(chatId);
    if (!s) return null;
    const r = rt(chatId);
    const f = lastFacts.get(chatId);
    const cm = d.meta.chat(chatId);
    const red = r.reducer;
    let meta: P.ChatMetaView;
    if (red) meta = r.autoAvailable !== undefined ? { ...red.meta(), autoAvailable: r.autoAvailable } : red.meta();
    else {
      meta = { title: s.title, cwd: s.cwd, mode: s.mode ?? cm?.mode ?? 'default' };
      if (s.branch) meta.branch = s.branch;
      if (s.model) meta.model = s.model;
      if (cm?.effort) meta.effort = cm.effort;
      if (r.autoAvailable !== undefined) meta.autoAvailable = r.autoAvailable;
    }
    const metrics: P.ChatMetrics = red ? red.metrics() : {};
    if (!red) {
      const lc = cm?.lastContext ?? d.index.get(chatId)?.lastContext;
      const lr = cm?.lastRequestAt ?? d.index.get(chatId)?.lastRequestAt;
      if (lc) metrics.contextTokens = lc;
      if (lr) { metrics.lastRequestAt = lr; metrics.cacheTtlMs = CACHE_TTL_1H_MS; metrics.cacheWarmUntil = lr + CACHE_TTL_1H_MS; }
    }
    return {
      chatId, seq: d.hub.seq(chatId), state: r.state.view(), meta, metrics,
      queue: queueOf(r, f), tasks: red ? red.tasks() : [], todos: red ? red.todos() : null,
      live: (red ? red.liveTurn() : null) ?? r.notice, lastDiskTurnId: heavyMap.get(chatId)?.lastTurnId ?? null,
    };
  }
  function allIds(): P.ChatId[] {
    const ids = new Set<P.ChatId>();
    for (const s of d.index.list()) ids.add(s.chatId);
    for (const m of d.meta.chats()) ids.add(m.chatId);
    for (const id of rts.keys()) ids.add(id);
    const known = new Set(views().map((a) => a.id));
    return [...ids].filter((id) => { const p = parseChatId(id); return !!p && known.has(p.accountId); });
  }
  /** The chat's queue as windows see it: messages a crash handed back (until the user acts), then the live process's queue. */
  function queueOf(r: Runtime, f: ProcessFacts | undefined): P.QueueItem[] {
    return r.returned.length ? [...r.returned, ...(f?.queue ?? [])] : (f?.queue ?? []);
  }
  function procs(): P.ProcStats {
    if (!engine) return NO_ENGINE_STATS;
    try { return engine.stats(); } catch (e) { d.log.warn('engine.stats failed', { err: String(e) }); return NO_ENGINE_STATS; }
  }
  function pushProcs(): void {
    const due = lastProcsAt + PROCS_PUSH_MIN_INTERVAL_MS;
    if (now() >= due) { lastProcsAt = now(); d.hub.push(null, [{ t: 'procs', procs: procs() }]); return; }
    if (!procsTimer && !disposed) procsTimer = d.clock.timer(due - now(), () => { procsTimer = null; guard('procs', null, pushProcs); });
  }
  function allAsks(): P.PendingAsk[] {
    const out: P.PendingAsk[] = [];
    for (const m of askMap.values()) out.push(...m.values());
    return out.sort((a, b) => a.since - b.since);
  }
  function keepAliveSet(): Set<P.ChatId> {
    return new Set(d.meta.chats().filter((m) => m.keepAlive).map((m) => m.chatId));
  }

  const o: Orchestrator = {
    sink,
    attachEngine(e) { engine = e; },
    start() {
      unsubs.push(d.index.onChange((up, removed) => {
        for (const s of up) guard('index upsert', s.chatId, () => upsert(s.chatId));
        const gone = removed.filter((id) => !d.meta.chat(id) && !engine?.isLive(id));
        if (gone.length) d.hub.push(null, [{ t: 'chats', upsert: [], remove: gone }]);
      }));
      // (the raw list: views() would cache the account views, models included, before the first hello)
      const logins = new Map<P.AccountId, P.LoginState>();
      try { for (const a of d.accounts.list()) logins.set(a.id, a.login); } catch (e) { d.log.warn('accounts.list failed', { err: String(e) }); }
      unsubs.push(d.accounts.onChange((id) => {
        accountViews = null;
        o.pushAccounts();
        const login = views().find((a) => a.id === id)?.login;
        const was = logins.get(id);
        if (login) logins.set(id, login); else logins.delete(id);
        if (login && was && was !== login) guard('login change', null, () => onLoginChange(id, login));
      }));
      unsubs.push(d.registry.onChange((acc, sid, h) => {
        const id = makeChatId(acc, sid);
        const r = rts.get(id);
        guard('external', id, () => { if (r) { if (r.state.onExternal(h)) stateChanged(r); } else upsert(id); });
      }));
    },
    known: (chatId) => !!d.index.get(chatId) || !!d.meta.chat(chatId),
    summary: summaryOf,
    summaries() {
      const out: P.ChatSummary[] = [];
      for (const id of allIds()) { try { const s = summaryOf(id); if (s) out.push(s); } catch (e) { d.log.warn('summary failed', { chatId: id, err: String(e) }); } }
      return out;
    },
    snapshot,
    hello() {
      return { t: 'hello', v: 1, boot: d.boot, now: now(), settings: d.meta.settings(), accounts: views(), chats: o.summaries(), asks: allAsks(),
        ui: d.meta.ui(), drafts: d.meta.drafts(), procs: procs() };
    },
    asks: allAsks,
    pendingAskCount() { let n = 0; for (const m of askMap.values()) n += m.size; return n; },
    upsert,
    remove(chatId) {
      const r = rts.get(chatId);
      if (r) { r.upsertTimer?.cancel(); r.dropTimer?.cancel(); r.limitTimer?.cancel(); rts.delete(chatId); }
      lastFacts.delete(chatId); heavyMap.delete(chatId); seen.delete(chatId);
      d.hub.push(null, [{ t: 'chats', upsert: [], remove: [chatId] }], true);
    },
    onUser(chatId, ev) { guard('onUser', chatId, () => { const r = rt(chatId); if (r.state.onUser(ev, now())) stateChanged(r); }); },
    prepareSpawn(chatId, seed) { rt(chatId).spawnSeed = seed; },
    identityMismatch: (chatId) => rts.get(chatId)?.identityMismatch,
    onViewChange() {
      const visible = d.hub.visible();
      for (const id of visible) {
        const r = rt(id);
        r.dropTimer?.cancel();
        r.dropTimer = null;
        if (d.hub.looking(id)) guard('viewed', id, () => { if (r.state.onUser('viewed', now())) stateChanged(r); });
      }
      for (const r of rts.values()) if (!visible.has(r.chatId) && !r.dropTimer) armDrop(r);
      if (engine) { const e = engine; guard('protect', null, () => e.protect(visible, keepAliveSet())); }
    },
    detail(chatId, id, field) { return rts.get(chatId)?.reducer?.detail(id, field) ?? null; },
    setHeavy(chatId, heavy, lastTurnId) {
      const cur = heavyMap.get(chatId) ?? { locs: new Map<string, HeavyLoc>(), lastTurnId: null };
      for (const h of heavy) cur.locs.set(`${h.id}|${h.field}`, h);
      if (lastTurnId !== null || !heavyMap.has(chatId)) cur.lastTurnId = lastTurnId ?? cur.lastTurnId;
      heavyMap.delete(chatId);
      heavyMap.set(chatId, cur);
      while (heavyMap.size > HEAVY_CHATS_MAX) heavyMap.delete(heavyMap.keys().next().value!);
    },
    heavy: (chatId, id, field) => heavyMap.get(chatId)?.locs.get(`${id}|${field}`),
    addNotice(chatId, row) {
      guard('notice', chatId, () => {
        const r = rt(chatId);
        if (r.reducer && !r.exited) { const evs = r.reducer.localRow(row, now()); if (evs.length) d.hub.emit(chatId, evs, true); return; }
        const id = `x:app:${++noticeN}`;
        const block: P.UiBlock = { k: 'system', id, row };
        r.notice = r.notice ? { ...r.notice, blocks: [...r.notice.blocks, block] } : { id, at: now(), user: null, blocks: [block] };
        d.hub.emit(chatId, [{ k: 'system', turnId: r.notice.id, id, row }], true);
      });
    },
    noteAccepted(chatId, uuid) {
      let s = seen.get(chatId);
      if (!s) { s = new Set(); seen.set(chatId, s); }
      if (s.has(uuid)) return false;
      s.add(uuid);
      if (s.size > SEEN_UUIDS_MAX) s.delete(s.values().next().value!);
      return true;
    },
    dropReturned(chatId, uuid) {
      const r = rts.get(chatId);
      if (!r || !r.returned.some((q) => q.uuid === uuid)) return false;
      r.returned = r.returned.filter((q) => q.uuid !== uuid);
      const items = queueOf(r, lastFacts.get(chatId));
      r.lastQueue = JSON.stringify(items);
      d.hub.emit(chatId, [{ k: 'queue', items }], true);
      return true;
    },
    procs,
    pushProcs,
    accountView: (id) => views().find((a) => a.id === id),
    pushAccounts() { accountViews = null; d.hub.push(null, [{ t: 'accounts', accounts: views() }]); },
    dispose() {
      disposed = true;
      for (const u of unsubs.splice(0)) { try { u(); } catch { /* ignore */ } }
      procsTimer?.cancel();
      for (const r of rts.values()) { r.upsertTimer?.cancel(); r.dropTimer?.cancel(); r.limitTimer?.cancel(); }
    },
  };
  d.hub.setSnapshotProvider(snapshot);
  return o;
}
