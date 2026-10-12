// src/server/app/commands.ts — C2S handlers (business rules of SPEC §6.3).
// Every handler returns an AckOut or throws (WireFail / an error carrying a known code); rpc.ts turns that into exactly
// one ack. Handlers never touch the WebSocket directly: broadcasts go through the hub, chat state through the orchestrator.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type * as P from '../../shared/protocol.ts';
import type {
  Account, AccountStore, ChatMeta, Clock, DeriveTitle, DiskToTurns, Engine, LiveRegistry, Logger, LoginService, MetaStore, Platform,
  PromptHistory, SdkHelpers, SessionIndex, SpawnSpec, SpawnStart, TranscriptReader, EnsureWhy, CostBaseline,
} from '../contracts.ts';
import type { Conn, HubImpl } from '../ws/hub.ts';
import type { AckOut, Handlers } from '../ws/rpc.ts';
import { fail, WireFail } from '../ws/rpc.ts';
import type { Orchestrator } from './orchestrator.ts';
import { FS_MENTIONS_MAX, LOG_CLIENT_PER_MIN, MAX_DETAIL_BYTES, SEARCH_MAX_HITS, USAGE_REFRESH_MIN_INTERVAL_MS } from '../../shared/limits.ts';
import { encodeCursor, makeChatId, parseChatId } from '../util/ids.ts';
import { isInside } from '../util/paths.ts';
import { readTailEntries } from '../claude/headtail.ts';
import { baselineFromEntries } from '../model/accounting.ts';

export type CommandModel = {
  diskToTurns: DiskToTurns; deriveTitle: DeriveTitle;
  detailFromEntry: (e: Record<string, unknown>, id: string, field: P.DetailField) => P.DetailPayload | null;
};
export type CommandsDeps = {
  clock: Clock; log: Logger; hub: HubImpl; orch: Orchestrator; meta: MetaStore; accounts: AccountStore; index: SessionIndex;
  reader: TranscriptReader; helpers: SdkHelpers; history: PromptHistory; login: LoginService; registry: LiveRegistry;
  platform: Platform; engine: () => Engine; model: CommandModel;
  exe: (pref: 'installed' | 'bundled') => P.Result<string, 'exe_missing'>;   // honours SMC_CLAUDE_EXE in test mode
  home: string; probeCwd: string; ensureDir: (dir: string) => void;
  quit: () => void;                                                         // graceful shutdown (bye{quit}, exit 0)
  lastOrphans: () => readonly { pid: number; name: string }[];
};

const RECENT_UUIDS_MAX = 2_000;
const MODEL_ALIASES: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku', 'fable']);   // CLI aliases (SPEC §2.2)
const RECONCILE_MIN_INTERVAL_MS = 2_000;                     // focus reconcile: stat-only pass, at most every 2 s
const errCode = (e: unknown): string | undefined => { const c = (e as { code?: unknown } | null)?.code; return typeof c === 'string' ? c : undefined; };

export function createCommands(d: CommandsDeps): Handlers<Conn> {
  const sent = new Map<P.ChatId, Set<P.Uuid>>();             // uuids accepted by the engine (outbox replay on a cold chat)
  const logins = new Set<P.AccountId>();
  // SPEC §2.6: usage refresh at most once per 10 min per account; the cap-exempt probe processes run one at a
  // time per account, and identical concurrent requests share one answer
  const usageAt = new Map<P.AccountId, number>();
  const probeLock = new Map<P.AccountId, Promise<void>>();
  const inflight = new Map<string, Promise<unknown>>();
  function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const cur = inflight.get(key);
    if (cur) return cur as Promise<T>;
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }
  // After « Restaurer la conversation » the transcript's latest leaf is still the old branch until the next
  // message: tx.page shows the chain up to the rewind point instead (cleared by the next accepted send or another rewind)
  const rewoundAt = new Map<P.ChatId, { atUuid: P.Uuid; off: number }>();
  const logWindow: number[] = [];
  let lastReconcile = -Infinity;
  const now = (): number => d.clock.now();
  const engine = (): Engine => d.engine();

  // ---------------------------------------------------------------- lookups
  function chatOf(chatId: P.ChatId): { accountId: P.AccountId; sessionId: P.SessionId } {
    const p = parseChatId(chatId);
    if (!p || (!d.orch.known(chatId) && !engine().isLive(chatId))) fail('not_found');
    return p!;
  }
  /** SPEC §2.2: a model is a CLI alias or an id of the account's catalog, never free text (an unknown string makes the
   *  CLI send a billable `model_validation` request). The server is the trust boundary, not the client's menus. */
  function knownModel(accountId: P.AccountId, model: string): boolean {
    if (MODEL_ALIASES.has(model)) return true;
    try { return d.accounts.modelCatalog(accountId).some((o) => o.value === model); } catch { return false; }
  }
  /** chat.setModel's model: a known one; or the chat's own model echoed back by the client (an effort-only change sends the
   *  model the CLI reported) → the user's stored choice, so nothing new reaches the CLI. Anything else is refused. */
  function pickedModel(chatId: P.ChatId, accountId: P.AccountId, model: string | null): string | null {
    if (model === null || knownModel(accountId, model)) return model;
    const stored = d.meta.chat(chatId)?.model ?? null;
    if (model === stored) return stored;
    const reported = [engine().facts(chatId)?.model, d.orch.snapshot(chatId)?.meta.model, d.index.get(chatId)?.model];
    if (reported.includes(model)) return stored;
    fail('invalid');
    return null;
  }
  function accountOf(id: P.AccountId): Account {
    const a = d.accounts.get(id);
    if (!a) fail('not_found');
    return a!;
  }
  function requireLogin(id: P.AccountId): void {
    const v = d.accounts.list().find((a) => a.id === id);
    if (!v) fail('not_found');
    if (v!.login !== 'connected') fail('not_logged_in');
  }
  const configDirs = (): string[] => d.accounts.list().map((a) => a.configDir).filter((x): x is string => !!x);
  function checkCwd(cwd: string): string {
    const r = d.platform.checkCwd(cwd, configDirs());
    if (!r.ok) fail(r.err);
    return (r as { ok: true; data: string }).data;
  }
  const recordedCwd = (chatId: P.ChatId): string => d.meta.chat(chatId)?.cwd ?? d.index.get(chatId)?.cwd ?? '';
  /**
   * The transcript to read for a chat: its own, else (fork / « Continuer sur » not sent yet) the source it will be copied
   * from, read-only, so the new chat shows its history at once (otherwise it looks empty until a reload).
   */
  /**
   * The index entry of a chat whose transcript may be newer than the index (its first turn just ended, the watcher of a
   * projects folder created after start is not running yet): one stat-only reconcile of its account, then a second look.
   * For explicit actions (fork, rewind) and reads of a live chat only.
   */
  async function indexed(chatId: P.ChatId): Promise<ReturnType<SessionIndex['get']>> {
    const hit = d.index.get(chatId);
    if (hit) return hit;
    const p = parseChatId(chatId);
    if (p) await d.index.reconcile(p.accountId).catch((e: unknown) => d.log.warn('index.reconcile failed', { err: String(e) }));
    return d.index.get(chatId);
  }
  const transcriptOf = (chatId: P.ChatId): string | undefined => {
    const own = d.index.get(chatId)?.path;
    if (own) return own;
    const ps = d.meta.chat(chatId)?.pendingStart;
    return ps?.kind === 'fork' ? ps.fromJsonl : undefined;
  };
  /** The ChatMeta of a chat, created from the index the first time the app stores something about it. */
  function ensureMeta(chatId: P.ChatId): ChatMeta {
    const cur = d.meta.chat(chatId);
    if (cur) return cur;
    const p = chatOf(chatId);
    const sm = d.index.get(chatId);
    const m: ChatMeta = { chatId, accountId: p.accountId, sessionId: p.sessionId, cwd: sm?.cwd ?? '', createdAt: sm?.createdAt ?? now() };
    d.meta.upsert(m);
    return m;
  }
  function holder(chatId: P.ChatId): P.ExternalHolder | null {
    const p = parseChatId(chatId);
    try { return p ? d.registry.holder(p.accountId, p.sessionId) : null; } catch { return null; }
  }
  function noteSent(chatId: P.ChatId, uuid: P.Uuid): void {
    let s = sent.get(chatId);
    if (!s) { s = new Set(); sent.set(chatId, s); }
    s.add(uuid);
    if (s.size > RECENT_UUIDS_MAX) s.delete(s.values().next().value!);
  }
  const ok = (data?: unknown): AckOut => (data === undefined ? { ok: true } : { ok: true, data });
  const wire = (err: P.WireError): AckOut => ({ ok: false, err });

  // ---------------------------------------------------------------- spawn specs (§2.2, §2.10)
  function startOf(chatId: P.ChatId, sendText?: string): SpawnStart {
    const cm = d.meta.chat(chatId);
    const ps = cm?.pendingStart;
    if (ps?.kind === 'new') {
      let title = cm?.title;
      if (!title && sendText !== undefined) {
        title = d.model.deriveTitle(sendText) || undefined;
        if (title) d.meta.patch(chatId, { title });
      }
      return title ? { kind: 'new', title } : { kind: 'new' };
    }
    if (ps?.kind === 'fork') return { kind: 'fork', fromJsonl: ps.fromJsonl, title: cm?.title ?? d.orch.summary(ps.fromChatId)?.title ?? '' };
    return { kind: 'resume' };
  }
  function buildSpec(chatId: P.ChatId, start: SpawnStart, cwd: string): SpawnSpec {
    const p = chatOf(chatId);
    const acc = accountOf(p.accountId);
    const cm = d.meta.chat(chatId);
    const st = d.meta.settings();
    const fresh = acc.defaults.mode && acc.defaults.mode !== 'bypassPermissions' ? acc.defaults.mode : 'default';
    let mode: P.PermissionModeId = cm?.mode ?? d.index.get(chatId)?.lastMode ?? acc.defaults.mode ?? 'default';
    if (mode === 'bypassPermissions' && (start.kind !== 'new' || !st.allowBypass)) {    // S7: never restored on wake
      mode = fresh;
      if (cm) d.meta.patch(chatId, { mode });
      d.orch.addNotice(chatId, { kind: 'notice', text: 'mode.bypass.downgraded', data: { key: 'mode.bypass.downgraded' } });
    }
    const exe = d.exe(st.exe);
    if (!exe.ok) fail('exe_missing');
    const spec: SpawnSpec = {
      chatId, sessionId: p.sessionId, cwd,
      account: { id: acc.id, configDir: acc.configDir, claudeMdExcludes: d.accounts.claudeMdExcludes(acc.id) },
      mode, start, allowBypass: st.allowBypass, aiTitles: st.aiTitles,
      exe: (exe as { ok: true; data: string }).data,
      isolation: st.isolation === 'job' && d.platform.jobrunAvailable() ? 'job' : 'plain',
    };
    if (cm?.model) {
      if (knownModel(acc.id, cm.model)) spec.model = cm.model;
      else d.log.warn('unknown model dropped at spawn', { chatId });            // stale catalog id / other account → CLI default
    }
    if (cm?.effort) spec.effort = cm.effort;
    return spec;
  }
  /** Spawns the chat when it is cold (S9 check first). Returns the engine's WireError instead of throwing it. */
  async function ensureLive(chatId: P.ChatId, why: EnsureWhy, o: { start?: SpawnStart; text?: string; evict?: P.ChatId; exceed?: boolean; force?: boolean } = {}): Promise<P.WireError | null> {
    if (engine().isLive(chatId)) return null;
    const p = chatOf(chatId);
    requireLogin(p.accountId);
    const cwd = checkCwd(recordedCwd(chatId));
    const spec = buildSpec(chatId, o.start ?? startOf(chatId, o.text), cwd);
    d.orch.prepareSpawn(chatId, await spawnSeed(chatId, spec.start));
    if (engine().isLive(chatId)) return null;                                    // spawned meanwhile (the tail read is async)
    const eo: Parameters<Engine['ensure']>[1] = { why };
    if (o.evict) eo.evict = o.evict;
    if (o.exceed) eo.exceed = true;
    if (o.force) eo.force = true;
    const r = await engine().ensure(spec, eo);
    return r.ok ? null : r.err;
  }
  /** Seed of the live reducer: a resumed / forked / rewound process starts from the transcript's last cost-state. */
  async function spawnSeed(chatId: P.ChatId, start: SpawnStart): Promise<{ baseline: CostBaseline | null; resumed: boolean }> {
    if (start.kind === 'new') return { baseline: null, resumed: false };
    const file = start.kind === 'fork' ? start.fromJsonl : d.index.get(chatId)?.path;
    let baseline: CostBaseline | null = null;
    if (file) { try { baseline = baselineFromEntries(await readTailEntries(file)); } catch (e) { d.log.warn('cost baseline unreadable', { chatId, err: String(e) }); } }
    return { baseline, resumed: true };
  }
  /** A transient no-prompt process in probe-cwd (usage / baseline, explicit click only), closed right after. */
  async function withProbe<T>(accountId: P.AccountId, fn: (chatId: P.ChatId) => Promise<T>): Promise<T> {
    requireLogin(accountId);
    const prev = probeLock.get(accountId) ?? Promise.resolve();               // one probe process per account at a time
    let release!: () => void;
    const tail = prev.then(() => new Promise<void>((r) => { release = r; }));
    probeLock.set(accountId, tail);
    void tail.then(() => { if (probeLock.get(accountId) === tail) probeLock.delete(accountId); });
    await prev;
    let started: P.ChatId | null = null;
    try {
      return await probe(accountId, (c) => { started = c; return fn(c); });
    } finally {
      const c: P.ChatId | null = started;
      if (c) void engine().sleep(c, 'user').catch(() => {}).then(release);   // released once the process is closed
      else release();
    }
  }
  async function probe<T>(accountId: P.AccountId, fn: (chatId: P.ChatId) => Promise<T>): Promise<T> {
    d.ensureDir(d.probeCwd);
    const chatId = makeChatId(accountId, randomUUID());
    const acc = accountOf(accountId);
    const st = d.meta.settings();
    const exe = d.exe(st.exe);
    if (!exe.ok) fail('exe_missing');
    const spec: SpawnSpec = {
      chatId, sessionId: chatId.slice(chatId.indexOf(':') + 1), cwd: checkCwd(d.probeCwd),
      account: { id: acc.id, configDir: acc.configDir, claudeMdExcludes: d.accounts.claudeMdExcludes(acc.id) },
      mode: 'default', start: { kind: 'new' }, allowBypass: false, aiTitles: false, exe: (exe as { ok: true; data: string }).data,
      isolation: st.isolation === 'job' && d.platform.jobrunAvailable() ? 'job' : 'plain',
    };
    const r = await engine().ensure(spec, { why: 'usage', exceed: true });
    if (!r.ok) throw new WireFail(r.err);
    return await fn(chatId);
  }

  // ---------------------------------------------------------------- chat commands
  const h: Handlers<Conn> = {
    view(m, { conn }) {
      if (m.t !== 'view') return;
      const known = (id: P.ChatId): boolean => d.orch.known(id) || engine().isLive(id);
      d.hub.setView(conn, m.full.filter(known), m.focused && known(m.focused) ? m.focused : null, m.windowFocused);                      // hub.onViewChange → orch.onViewChange
      if (m.windowFocused && now() - lastReconcile >= RECONCILE_MIN_INTERVAL_MS) {     // SessionIndex.reconcile runs on window focus (§5.5, Claude data)
        lastReconcile = now();
        void d.index.reconcile().catch((e: unknown) => d.log.warn('index.reconcile failed', { err: String(e) }));
      }
    },
    async 'chat.create'(m) {
      if (m.t !== 'chat.create') return;
      accountOf(m.accountId);
      requireLogin(m.accountId);
      if (m.mode === 'bypassPermissions') fail('forbidden');                     // S7: bypass needs typed proof (chat.setMode)
      if (m.model && !knownModel(m.accountId, m.model)) fail('invalid');      // alias or catalog id only
      const cwd = checkCwd(m.cwd);
      if (!(d.accounts.trustedInCli(m.accountId, cwd) || d.meta.appTrusted(m.accountId, cwd) || m.trust)) fail('untrusted');
      if (m.trust) d.meta.trust(m.accountId, cwd);
      const sessionId = randomUUID();
      const chatId = makeChatId(m.accountId, sessionId);
      const meta: ChatMeta = { chatId, accountId: m.accountId, sessionId, cwd, createdAt: now(), mode: m.mode, pendingStart: { kind: 'new' }, trusted: true };
      if (m.title?.trim()) meta.title = m.title.trim();
      if (m.model) meta.model = m.model;
      if (m.effort) meta.effort = m.effort;
      d.meta.upsert(meta);
      await d.meta.flush();                                                     // flushed at once on create (§7.1)
      d.orch.upsert(chatId, true);
      return ok({ chatId });
    },
    'chat.prespawn'(m) {
      if (m.t !== 'chat.prespawn') return;
      if (!d.meta.settings().prespawn || engine().isLive(m.chatId) || holder(m.chatId)) return ok();
      void ensureLive(m.chatId, 'prespawn').catch(() => { /* best effort */ });
      return ok();
    },
    async 'chat.send'(m) {
      if (m.t !== 'chat.send') return;
      const p = chatOf(m.chatId);
      if (sent.get(m.chatId)?.has(m.uuid)) return ok({ accepted: 'duplicate' });
      const input = (uuid: P.Uuid, text: string, priority?: P.Priority): Parameters<Engine['send']>[1] => {
        const x: Parameters<Engine['send']>[1] = { uuid, text };
        if (uuid === m.uuid && m.images?.length) x.images = m.images;
        if (priority) x.priority = priority;
        return x;
      };
      let r = engine().isLive(m.chatId) ? engine().send(m.chatId, input(m.uuid, m.text, m.priority)) : 'not_live';
      if (r === 'not_live') {
        requireLogin(p.accountId);
        const o: Parameters<typeof ensureLive>[2] = { text: m.text };
        if (m.evict) o.evict = m.evict;
        if (m.exceed) o.exceed = true;
        if (m.force) o.force = true;
        const err = await ensureLive(m.chatId, d.meta.chat(m.chatId)?.pendingStart ? 'send' : 'wake', o);
        if (err?.code === 'breaker_open') d.orch.onUser(m.chatId, 'breaker');      // banner err.breaker + « Réessayer » (SPEC §2.9)
        if (err) return wire(err);
        if (m.wake === 'summary') engine().send(m.chatId, input(randomUUID(), '/compact'));
        r = engine().send(m.chatId, input(m.uuid, m.text, m.wake === 'summary' ? 'later' : m.priority));
      }
      if (r === 'not_live') fail('not_live');
      noteSent(m.chatId, m.uuid);
      if (r === 'accepted') { rewoundAt.delete(m.chatId); d.orch.onUser(m.chatId, 'send'); }
      return ok({ accepted: r === 'duplicate' ? 'duplicate' : 'new' });
    },
    'chat.retry'(m) {
      if (m.t !== 'chat.retry') return;
      chatOf(m.chatId);
      engine().resetBreaker(m.chatId);                                          // never spawns; the user re-sends
      d.orch.onUser(m.chatId, 'retry');
      return ok();
    },
    async 'chat.interrupt'(m) {
      if (m.t !== 'chat.interrupt') return;
      chatOf(m.chatId);
      if (!engine().isLive(m.chatId)) return ok({ stillQueued: [] });
      d.orch.onUser(m.chatId, 'interrupt');
      return ok(await engine().interrupt(m.chatId));
    },
    async 'chat.cancelQueued'(m) {
      if (m.t !== 'chat.cancelQueued') return;
      chatOf(m.chatId);
      // a message a crash handed back (« Non envoyé ») is dropped from the chat's queue (Renvoyer, ✎, ↑, ✕)
      if (d.orch.dropReturned(m.chatId, m.uuid)) return ok({ cancelled: true });
      return ok({ cancelled: engine().isLive(m.chatId) ? await engine().cancelQueued(m.chatId, m.uuid) : false });
    },
    'chat.decide'(m) {
      if (m.t !== 'chat.decide') return;
      if (engine().decide(m.chatId, m.requestId, m.answer) === 'not_pending') fail('not_pending');
      return ok();
    },
    async 'chat.setMode'(m) {
      if (m.t !== 'chat.setMode') return;
      chatOf(m.chatId);
      if (m.mode === 'bypassPermissions' && (!d.meta.settings().allowBypass || m.typed !== 'CONTOURNER')) fail('forbidden');
      if (engine().isLive(m.chatId)) await engine().setMode(m.chatId, m.mode);
      ensureMeta(m.chatId);
      d.meta.patch(m.chatId, { mode: m.mode });
      d.orch.upsert(m.chatId);
      return ok();
    },
    async 'chat.setModel'(m) {
      if (m.t !== 'chat.setModel') return;
      const p = chatOf(m.chatId);
      const model = pickedModel(m.chatId, p.accountId, m.model);
      if (engine().isLive(m.chatId)) await engine().setModel(m.chatId, model, m.effort);
      ensureMeta(m.chatId);
      d.meta.patch(m.chatId, { model: model ?? undefined, effort: m.effort ?? undefined });
      d.orch.upsert(m.chatId);
      return ok();
    },
    async 'chat.rename'(m) {
      if (m.t !== 'chat.rename') return;
      const p = chatOf(m.chatId);
      if (holder(m.chatId)) fail('forbidden');
      const title = m.title.trim();
      if (!title) fail('invalid');
      let done = false;
      if (engine().isLive(m.chatId)) { try { await engine().rename(m.chatId, title); done = true; } catch (e) { if (errCode(e) !== 'not_live') throw e; } }
      if (!done && d.index.get(m.chatId)) await d.helpers.rename(accountOf(p.accountId), p.sessionId, title);
      ensureMeta(m.chatId);
      d.meta.patch(m.chatId, { title });
      d.orch.upsert(m.chatId, true);
      return ok();
    },
    'chat.flags'(m) {
      if (m.t !== 'chat.flags') return;
      chatOf(m.chatId);
      ensureMeta(m.chatId);
      const patch: Partial<ChatMeta> = {};
      for (const k of ['pinned', 'archived', 'keepAlive', 'muted'] as const) if (m[k] !== undefined) patch[k] = m[k];
      d.meta.patch(m.chatId, patch);
      if (m.keepAlive !== undefined) d.orch.onViewChange();                     // re-protects through engine.protect
      d.orch.upsert(m.chatId, true);
      return ok();
    },
    'chat.setCwd'(m) {
      if (m.t !== 'chat.setCwd') return;
      chatOf(m.chatId);
      if (engine().isLive(m.chatId)) fail('busy');
      const cwd = checkCwd(m.cwd);
      ensureMeta(m.chatId);
      d.meta.patch(m.chatId, { cwd });
      d.orch.upsert(m.chatId, true);
      return ok();
    },
    async 'chat.sleep'(m) {
      if (m.t !== 'chat.sleep') return;
      chatOf(m.chatId);
      if (!engine().isLive(m.chatId)) return ok();
      const f = engine().facts(m.chatId);
      if (f && f.bgTasks > 0 && !m.stopTasks && !m.force) fail('busy');
      await engine().sleep(m.chatId, m.force ? 'force' : 'user', m.stopTasks ? { stopTasks: true } : {});
      return ok();
    },
    async 'chat.delete'(m) {
      if (m.t !== 'chat.delete') return;
      const p = chatOf(m.chatId);
      if (engine().isLive(m.chatId)) fail('busy');
      if (holder(m.chatId)) fail('forbidden');
      if (d.index.get(m.chatId)) await d.helpers.remove(accountOf(p.accountId), p.sessionId);
      d.meta.remove(m.chatId);
      d.meta.saveDraft(m.chatId, null);
      sent.delete(m.chatId);
      d.orch.remove(m.chatId);
      return ok();
    },
    async 'chat.fork'(m) {
      if (m.t !== 'chat.fork') return;
      const src = chatOf(m.chatId);
      const target = m.accountId ?? src.accountId;
      const other = target !== src.accountId;
      if (other && m.upToUuid) fail('invalid');
      accountOf(target);
      requireLogin(target);
      const sm = await indexed(m.chatId);
      if (!sm) fail('invalid');                                                 // nothing on disk to copy yet
      const srcTitle = d.orch.summary(m.chatId)?.title ?? '';
      let sessionId: P.SessionId;
      let pendingStart: ChatMeta['pendingStart'];
      if (m.upToUuid) {
        sessionId = await d.helpers.forkUpTo(accountOf(src.accountId), src.sessionId, m.upToUuid, srcTitle);
        // the SDK wrote the new transcript: index it now (tx.page of the new chat), not at the next watcher event
        await d.index.reconcile(src.accountId).catch((e: unknown) => d.log.warn('index.reconcile failed', { err: String(e) }));
      }
      else { sessionId = randomUUID(); pendingStart = { kind: 'fork', fromChatId: m.chatId, fromJsonl: sm!.path }; }
      const chatId = makeChatId(target, sessionId);
      const meta: ChatMeta = { chatId, accountId: target, sessionId, cwd: recordedCwd(m.chatId), createdAt: now(),
        links: other ? { continuedFrom: m.chatId } : { forkedFrom: m.chatId } };
      if (srcTitle) meta.title = srcTitle;
      if (pendingStart) meta.pendingStart = pendingStart;
      const srcMeta = d.meta.chat(m.chatId);
      if (srcMeta?.mode && srcMeta.mode !== 'bypassPermissions') meta.mode = srcMeta.mode;
      d.meta.upsert(meta);
      if (other) { const s = ensureMeta(m.chatId); d.meta.patch(m.chatId, { links: { ...(s.links ?? {}), continuedTo: chatId } }); }
      await d.meta.flush();                                                     // flushed at once on fork (§7.1)
      d.orch.upsert(chatId, true);
      if (other) d.orch.upsert(m.chatId, true);
      return ok({ chatId });
    },
    async 'chat.rewind'(m) {
      if (m.t !== 'chat.rewind') return;
      chatOf(m.chatId);
      if (holder(m.chatId)) fail('forbidden');
      let preview: P.RewindPreview = { files: [] };
      if (m.action !== 'conv' || m.dryRun) {
        const err = await ensureLive(m.chatId, 'rewind');
        if (err) return wire(err);
        preview = await engine().rewindFiles(m.chatId, m.userUuid, m.dryRun);
        if (m.dryRun || m.action === 'code') return ok(preview);
      }
      const file = (await indexed(m.chatId))?.path;
      if (!file) fail('not_found');
      const atUuid = await entryBefore(file!, m.userUuid);
      if (!atUuid) fail('not_found');
      await engine().sleep(m.chatId, 'rewind');
      const err = await ensureLive(m.chatId, 'rewind', { start: { kind: 'rewind', atUuid: atUuid!, dropsTurn: m.userUuid }, exceed: true });
      if (err) return wire(err);
      try { rewoundAt.set(m.chatId, { atUuid: atUuid!, off: (await fs.promises.stat(file!)).size }); } catch { rewoundAt.delete(m.chatId); }
      d.hub.emit(m.chatId, [{ k: 'reset', reason: 'rewind' }], true);
      return ok(preview);
    },
    async 'chat.task'(m) {
      if (m.t !== 'chat.task') return;
      chatOf(m.chatId);
      if (!engine().isLive(m.chatId)) fail('not_live');
      await engine().task(m.chatId, m.op, m.ref);
      return ok();
    },
    async 'chat.info'(m) {
      if (m.t !== 'chat.info') return;
      const p = chatOf(m.chatId);
      if (m.what === 'session') return ok(await sessionInfo(m.chatId, p.accountId, p.sessionId));
      if (!engine().isLive(m.chatId)) fail('not_live');
      if (m.what === 'context') return ok(await engine().contextSummary(m.chatId));
      if (m.what === 'rules') return ok(await engine().rules(m.chatId));
      return ok(await engine().commands(m.chatId));
    },
    async 'chat.terminal'(m) {
      if (m.t !== 'chat.terminal') return;
      const p = chatOf(m.chatId);
      const acc = accountOf(p.accountId);
      const exe = d.exe('installed');
      if (!exe.ok) fail('exe_missing');
      const spec = { cwd: recordedCwd(m.chatId), configDir: acc.configDir, sessionId: p.sessionId, exe: (exe as { ok: true; data: string }).data };
      const cmd = d.platform.terminalCommand(spec);
      if (!cmd.ok) fail('cwd_refused');
      const command = (cmd as { ok: true; data: string }).data;
      if (m.copyOnly) return ok({ command });
      checkCwd(spec.cwd);
      if (engine().isLive(m.chatId)) await engine().sleep(m.chatId, 'terminal');
      const r = d.platform.openTerminal(spec);
      if (!r.ok) fail('cwd_refused');
      return ok({ command });
    },

    // -------------------------------------------------------------- transcript and history
    async 'tx.page'(m) {
      if (m.t !== 'tx.page') return;
      const p = chatOf(m.chatId);
      // a live chat not indexed yet (window reloaded during its first turns): reconcile once rather than show it empty
      const file = transcriptOf(m.chatId) ?? (engine().isLive(m.chatId) ? (await indexed(m.chatId))?.path : undefined);
      if (!file) return ok({ turns: [], cursor: null, hasMore: false } satisfies P.TranscriptPage);
      let page: Awaited<ReturnType<TranscriptReader['tail']>>;
      const rw = m.before ? undefined : rewoundAt.get(m.chatId);
      try {
        page = m.before ? await d.reader.before(file, m.before, m.limit)
          : rw ? await d.reader.before(file, encodeCursor({ off: rw.off, leaf: rw.atUuid }), m.limit) : await d.reader.tail(file, m.limit);
      }
      catch (e) { if (errCode(e) === 'ENOENT') return ok({ turns: [], cursor: null, hasMore: false }); if (m.before) fail('invalid'); throw e; }
      const { turns, heavy } = d.model.diskToTurns(page.chain, { sessionId: p.sessionId, closed: !!m.before || !engine().isLive(m.chatId) });
      d.orch.setHeavy(m.chatId, heavy, m.before ? null : (turns[turns.length - 1]?.id ?? null));
      return ok({ turns, cursor: page.cursor, hasMore: page.hasMore } satisfies P.TranscriptPage);
    },
    async 'tx.detail'(m) {
      if (m.t !== 'tx.detail') return;
      chatOf(m.chatId);
      const blockId = m.blockId;
      let out = d.orch.detail(m.chatId, blockId, m.field);
      if (!out) {
        const loc = d.orch.heavy(m.chatId, blockId, m.field);
        const file = transcriptOf(m.chatId);
        if (!loc || !file) fail('not_found');
        if (loc!.len > MAX_DETAIL_BYTES * 2) fail('too_large');
        const e = await d.reader.line(file!, loc!.off, loc!.len);
        out = e ? d.model.detailFromEntry(e, blockId, m.field) : null;
        if (!out) fail('not_found');
      }
      if ((out!.text?.length ?? 0) + (out!.dataUrl?.length ?? 0) > MAX_DETAIL_BYTES) fail('too_large');
      return ok(out);
    },
    async 'tx.search'(m, { conn }) {
      if (m.t !== 'tx.search') return;
      chatOf(m.chatId);
      (conn.data['search'] as AbortController | undefined)?.abort();             // a new search aborts the previous one
      const ac = new AbortController();
      conn.data['search'] = ac;
      const file = transcriptOf(m.chatId);
      if (!file) return ok([]);
      try {
        const hits = await d.reader.search(file, m.q, SEARCH_MAX_HITS, ac.signal);
        const out: P.SearchHit[] = [];
        for (const hit of hits) {
          const e = await d.reader.line(file, hit.off, hit.len).catch(() => null);
          out.push({ ...searchIds(e), snippet: hit.snippet });
        }
        return ok(out);
      } catch (e) { if (ac.signal.aborted) return ok([]); throw e; }
      finally { if (conn.data['search'] === ac) delete conn.data['search']; }
    },
    async 'prompts.search'(m) {
      if (m.t !== 'prompts.search') return;
      return ok(await d.history.search(m.q, m.chatId));
    },

    // -------------------------------------------------------------- accounts
    async 'account.candidates'() { return ok(await d.accounts.candidates()); },
    async 'account.add'(m) {
      if (m.t !== 'account.add') return;
      const v = await d.accounts.add({ configDir: m.configDir, name: m.name, color: m.color, monogram: m.monogram });
      d.orch.pushAccounts();
      return ok(d.orch.accountView(v.id) ?? v);                                // with AccountView.models
    },
    async 'account.update'(m) {
      if (m.t !== 'account.update') return;
      accountOf(m.accountId);
      const dm = m.patch.defaults?.model;
      if (dm && !knownModel(m.accountId, dm)) fail('invalid');                 // the default model is offered by NewChat
      await d.accounts.update(m.accountId, m.patch);
      d.orch.pushAccounts();
      return ok();
    },
    'account.login'(m) {
      if (m.t !== 'account.login') return;
      accountOf(m.accountId);
      if (logins.has(m.accountId)) fail('busy');
      logins.add(m.accountId);
      const id = m.accountId;
      d.login.start(id, m.email, (step) => {
        d.hub.push(null, [{ t: 'login', accountId: id, step }], true);
        if (step.step === 'done' || step.step === 'error') { logins.delete(id); d.orch.pushAccounts(); }
      });
      return ok();
    },
    'account.loginCode'(m) {
      if (m.t !== 'account.loginCode') return;
      if (!logins.has(m.accountId)) fail('not_pending');
      d.login.code(m.accountId, m.code);
      return ok();
    },
    'account.loginCancel'(m) {
      if (m.t !== 'account.loginCancel') return;
      d.login.cancel(m.accountId);
      if (logins.delete(m.accountId)) {                                         // every window leaves the login flow
        d.hub.push(null, [{ t: 'login', accountId: m.accountId, step: { step: 'error', key: 'login.err.cancelled', message: 'cancelled' } }], true);
      }
      return ok();
    },
    async 'account.logout'(m) {
      if (m.t !== 'account.logout') return;
      accountOf(m.accountId);
      if (logins.has(m.accountId)) fail('busy');
      const live = engine().stats().items.map((i) => i.chatId).filter((c) => parseChatId(c)?.accountId === m.accountId);
      await Promise.all(live.map((c) => engine().sleep(c, 'logout').catch(() => null)));
      await d.login.logout(m.accountId);
      d.orch.pushAccounts();
      return ok();
    },
    async 'account.usage'(m) {
      if (m.t !== 'account.usage') return;
      accountOf(m.accountId);
      const id = m.accountId;
      const cached = (): P.AccountView['usage'] | null => d.accounts.list().find((a) => a.id === id)?.usage ?? null;
      const last = usageAt.get(id);
      if (last !== undefined && now() - last < USAGE_REFRESH_MIN_INTERVAL_MS) return ok(cached());   // throttled
      await once(`usage:${id}`, async () => {
        const live = engine().stats().items.map((i) => i.chatId).find((c) => parseChatId(c)?.accountId === id);
        const data = live ? await engine().usage(live) : await withProbe(id, (c) => engine().usage(c));
        usageAt.set(id, now());
        if (data) d.accounts.noteUsage(id, { kind: 'refresh', data });
      });
      d.orch.pushAccounts();
      return ok(cached());
    },
    async 'account.baseline'(m) {
      if (m.t !== 'account.baseline') return;
      accountOf(m.accountId);
      const id = m.accountId;
      const sum = await once(`baseline:${id}`, () => withProbe(id, (c) => engine().contextSummary(c)));   // deduplicated
      d.accounts.noteBaseline(id, sum.total);
      d.orch.pushAccounts();
      return ok(sum);
    },

    // -------------------------------------------------------------- miscellaneous
    async 'fs.mentions'(m) {
      if (m.t !== 'fs.mentions') return;
      chatOf(m.chatId);
      const cwd = checkCwd(recordedCwd(m.chatId));
      return ok(await d.platform.fileIndex(cwd, m.q, FS_MENTIONS_MAX));
    },
    async 'fs.dirs'(m) {
      if (m.t !== 'fs.dirs') return;
      try { return ok(await d.platform.listDirs(m.path)); }
      catch (e) { const c = errCode(e); if (c === 'ENOENT' || c === 'ENOTDIR') fail('not_found'); if (c === 'EPERM' || c === 'EACCES') fail('forbidden'); throw Object.assign(new Error('fs.dirs'), { code: c === 'invalid' ? 'invalid' : 'internal' }); }
    },
    open(m) {
      if (m.t !== 'open') return;
      if (m.what === 'url') { d.platform.openExternal(m.target); return ok(); }
      if (!m.chatId) fail('invalid');
      chatOf(m.chatId!);
      const root = checkCwd(recordedCwd(m.chatId!));
      const rel = path.win32.isAbsolute(m.target) ? (isInside(m.target, root) ? path.win32.relative(root, m.target) : null) : m.target;
      const real = rel === null ? null : d.platform.confine(root, rel);
      if (!real) fail('invalid');
      d.platform.openPath(real!, m.what);
      return ok();
    },
    'ui.save'(m) { if (m.t === 'ui.save') d.meta.saveUi(m.ui); return ok(); },
    'draft.save'(m) {
      if (m.t !== 'draft.save') return;
      const cur = d.meta.drafts()[m.chatId];
      if (m.draft && cur && cur.at > m.draft.at) return ok();                  // last write wins by `at`
      d.meta.saveDraft(m.chatId, m.draft);
      return ok();
    },
    'settings.set'(m) {
      if (m.t !== 'settings.set') return;
      const s = d.meta.saveSettings(m.patch);
      if (m.patch.maxLive !== undefined || m.patch.reapMin !== undefined) engine().setPolicy({ maxLive: s.maxLive, reapMin: s.reapMin });
      d.hub.push(null, [{ t: 'settings', settings: s }]);
      return ok();
    },
    async 'orphans.kill'(m) {
      if (m.t !== 'orphans.kill') return;
      const allowed = new Set(d.lastOrphans().map((o) => o.pid));
      if (!m.pids.every((p) => allowed.has(p))) fail('invalid');
      await d.platform.killPids(m.pids);
      return ok();
    },
    'app.quit'(m) {
      if (m.t !== 'app.quit') return;
      if (engine().stats().live > 0 && !m.force) fail('busy');
      setImmediate(() => d.quit());                                             // after the ack is flushed
      return ok();
    },
    'log.client'(m) {
      if (m.t !== 'log.client') return;
      const t = now();
      while (logWindow.length && t - logWindow[0]! > 60_000) logWindow.shift();
      if (logWindow.length >= LOG_CLIENT_PER_MIN) return ok();
      logWindow.push(t);
      d.log[m.level]('client', { msg: m.msg.slice(0, 2_000), chatId: m.chatId });
      return ok();
    },
  };

  // ---------------------------------------------------------------- helpers that read the transcript
  /** The chain entry right before the user prompt `uuid` (latest branch), walking pages tail-first. */
  async function entryBefore(file: string, uuid: P.Uuid): Promise<string | null> {
    let page = await d.reader.tail(file, 50);
    for (let i = 0; i < 200; i++) {
      const k = page.chain.findIndex((r) => r.e['uuid'] === uuid);
      if (k > 0) return String(page.chain[k - 1]!.e['uuid'] ?? '') || null;
      if (k === 0) { const pu = page.chain[0]!.e['parentUuid']; return typeof pu === 'string' ? pu : null; }
      if (!page.hasMore || !page.cursor) return null;
      page = await d.reader.before(file, page.cursor, 50);
    }
    return null;
  }
  async function sessionInfo(chatId: P.ChatId, accountId: P.AccountId, sessionId: P.SessionId): Promise<P.SessionInfo> {
    const sm = d.index.get(chatId);
    const snap = d.orch.snapshot(chatId);
    const f = engine().facts(chatId);
    const info: P.SessionInfo = { sessionId, accountId, cwd: recordedCwd(chatId), transcriptPath: sm?.path ?? '', size: sm?.size ?? 0, instructions: [] };
    const cli = f?.cliVersion ?? snap?.meta.cliVersion;
    if (cli) info.cliVersion = cli;
    const model = f?.model ?? snap?.meta.model ?? sm?.model;
    if (model) info.model = model;
    if (snap?.meta.tools !== undefined) info.tools = snap.meta.tools;
    if (snap?.meta.mcp) info.mcp = snap.meta.mcp;
    if (sm?.ownerAccountUuid) info.ownerAccountUuid = sm.ownerAccountUuid;
    if (sm?.path) {
      let own = '';
      try { own = d.accounts.paths(accountId).configHome; } catch { /* unknown */ }
      const others = [path.join(d.home, '.claude'), ...d.accounts.list().filter((a) => a.id !== accountId).map((a) => { try { return d.accounts.paths(a.id).configHome; } catch { return ''; } })]
        .filter((x) => x && (!own || x.toLowerCase() !== own.toLowerCase()));
      const files = await d.reader.firstInstructions(sm.path).catch(() => [] as string[]);
      info.instructions = files.map((p) => ({ path: p, foreign: others.some((o) => isInside(p, o)) }));
    }
    return info;
  }
  /** Ids of a search hit: the opening user block for a prompt, else the assistant block (the client finds its turn). */
  function searchIds(e: Record<string, unknown> | null): { turnId: string; blockId?: string } {
    if (!e) return { turnId: '' };
    const msg = e['message'] as { id?: unknown } | undefined;
    if (e['type'] === 'user' && typeof e['uuid'] === 'string') return { turnId: `u:${e['uuid']}` };
    if (e['type'] === 'assistant' && typeof msg?.id === 'string') { const id = `a:${msg.id}:0`; return { turnId: id, blockId: id }; }
    return { turnId: typeof e['uuid'] === 'string' ? `x:${e['uuid']}` : '' };
  }

  return h;
}
