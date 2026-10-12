// test/fakes/fake-engine.ts — Engine fake for server tests.
// A scriptable in-memory Engine: ensure() makes a chat "live" (or answers a queued error), send() records the message and
// can auto-play a short turn through the sink (delivered → frames → result), and every sink callback can be driven by hand.
// It also serves `--fake-engine` in main.ts (E2E security / shell runs without any claude process).
import type * as P from '../../src/shared/protocol.ts';
import type { Engine, EngineSink, EnsureOpts, ExitInfo, ProcessFacts, SendInput, SleepReason, SpawnSpec } from '../../src/server/contracts.ts';

export type FakeCall = { m: string; chatId?: P.ChatId; args: unknown[] };
export type FakeEngineOptions = {
  now?: () => number;
  /** Auto-play a tiny turn for every accepted send: delivered + one text frame + result (default false). */
  autoReply?: boolean;
  maxLive?: number;
};
export type FakeEngine = Engine & {
  readonly calls: FakeCall[];
  readonly specs: Map<P.ChatId, SpawnSpec>;
  readonly sent: Map<P.ChatId, SendInput[]>;
  setSink(s: EngineSink): void;
  /** The next ensure() answers this error (once). */
  failNextEnsure(err: P.WireError): void;
  /** decide() answers 'ok' only for these request ids (first-wins); askNow() registers one through the sink. */
  askNow(a: P.PendingAsk): void;
  /** Ends a live chat as a crash (asks → askEnd crash, queue returned). */
  crash(chatId: P.ChatId, code?: number): void;
  pushFacts(chatId: P.ChatId, patch?: Partial<ProcessFacts>): void;
  /** Turns auto-reply on/off after creation (tests that drive the frames by hand). */
  setAutoReply(on: boolean): void;
  throwOn: Set<string>;
};

export function createFakeEngine(o: FakeEngineOptions = {}): FakeEngine {
  const now = o.now ?? Date.now;
  const calls: FakeCall[] = [];
  const specs = new Map<P.ChatId, SpawnSpec>();
  const sent = new Map<P.ChatId, SendInput[]>();
  const live = new Map<P.ChatId, ProcessFacts>();
  const seen = new Map<P.ChatId, Set<P.Uuid>>();
  const asks = new Map<string, P.PendingAsk>();
  const failures: P.WireError[] = [];
  const throwOn = new Set<string>();
  let sink: EngineSink | null = null;
  let policy = { maxLive: o.maxLive ?? 4, reapMin: 60 as number | null };
  let pid = 50_000;
  let autoReply = o.autoReply ?? false;
  const note = (m: string, chatId?: P.ChatId, ...args: unknown[]): void => {
    calls.push({ m, ...(chatId ? { chatId } : {}), args });
    if (throwOn.has(m)) throw Object.assign(new Error(`fake ${m} failure`), { code: 'timeout' });
  };
  const facts = (chatId: P.ChatId, patch: Partial<ProcessFacts> = {}): ProcessFacts => {
    const cur = live.get(chatId);
    const spec = specs.get(chatId);
    const f: ProcessFacts = {
      chatId, sessionId: spec?.sessionId ?? chatId.slice(chatId.indexOf(':') + 1), phase: 'live', busy: false, pendingAsks: 0, bgTasks: 0,
      queuedTurns: 0, queue: [], spawnedAt: now(), sentAny: false, ttlMs: 3_600_000, mode: spec?.mode ?? 'default', capabilities: [], stuck: false,
      cliPid: ++pid, cliVersion: 'fake', ...cur, ...patch,
    };
    live.set(chatId, f);
    return f;
  };
  const exitInfo = (reason: ExitInfo['reason'], code: number | null): ExitInfo => ({ reason, code, signal: null, at: now(), stderrTail: '' });
  function end(chatId: P.ChatId, info: ExitInfo): void {
    const f = live.get(chatId);
    if (!f) return;
    for (const [id, a] of asks) if (a.chatId === chatId) { asks.delete(id); sink?.askEnd(chatId, id, info.reason === 'crash' ? 'crash' : 'cancelled'); }
    live.delete(chatId);
    const returned = f.queue.filter((q) => q.delivery === 'pending' || q.delivery === 'queued').map((q) => ({ ...q, delivery: 'returned' as const }));
    sink?.exited(chatId, info, returned);
  }
  function play(chatId: P.ChatId, m: SendInput): void {
    const at = now();
    const imgs = m.images ?? [];
    sink?.delivered(chatId, { uuid: m.uuid, text: m.text, images: imgs.length,
      ...(imgs.length ? { imageTypes: imgs.map((i) => i.mediaType), imageBytes: imgs.map((i) => Math.floor((i.base64.length * 3) / 4) - (i.base64.endsWith('==') ? 2 : i.base64.endsWith('=') ? 1 : 0)) } : {}),
      folded: false, at });
    const msgId = `msg_fake_${m.uuid.slice(0, 8)}`;
    sink?.frame(chatId, { type: 'assistant', message: { id: msgId, role: 'assistant', model: 'fake', content: [{ type: 'text', text: `echo: ${m.text}` }] }, uuid: m.uuid }, at);
    sink?.frame(chatId, { type: 'result', subtype: 'success', is_error: false, uuid: m.uuid, usage: {}, total_cost_usd: 0 }, at);
    sink?.facts(chatId, facts(chatId, { busy: false, sentAny: true, lastRequestAt: at }));
  }

  const e: FakeEngine = {
    calls, specs, sent, throwOn,
    setSink(s) { sink = s; },
    failNextEnsure(err) { failures.push(err); },
    askNow(a) { asks.set(a.requestId, a); sink?.ask(a); sink?.facts(a.chatId, facts(a.chatId, { pendingAsks: [...asks.values()].filter((x) => x.chatId === a.chatId).length })); },
    crash(chatId, code = 1) { end(chatId, exitInfo('crash', code)); },
    pushFacts(chatId, patch) { sink?.facts(chatId, facts(chatId, patch)); },
    setAutoReply(on) { autoReply = on; },
    isLive: (c) => live.has(c),
    facts: (c) => live.get(c) ?? null,
    stats: () => ({ live: live.size, max: policy.maxLive, effectiveMax: policy.maxLive, lowMem: false, estRamMB: live.size * 450, isolation: 'plain',
      items: [...live.values()].map((f) => ({ chatId: f.chatId, ...(f.cliPid ? { pid: f.cliPid } : {}), phase: f.busy ? 'running' : 'idle', since: f.spawnedAt, neverRequested: !f.sentAny, protected: false })) }),
    async ensure(spec: SpawnSpec, opts: EnsureOpts) {
      note('ensure', spec.chatId, spec, opts);
      if (live.has(spec.chatId)) return { ok: true, data: undefined };
      const err = failures.shift();
      if (err) return { ok: false, err };
      specs.set(spec.chatId, spec);
      sink?.facts(spec.chatId, facts(spec.chatId, { phase: 'spawning', spawnedAt: now() }));
      sink?.facts(spec.chatId, facts(spec.chatId, { phase: 'live' }));
      return { ok: true, data: undefined };
    },
    send(chatId, m) {
      note('send', chatId, m);
      if (!live.has(chatId)) return 'not_live';
      let s = seen.get(chatId);
      if (!s) { s = new Set(); seen.set(chatId, s); }
      if (s.has(m.uuid)) return 'duplicate';
      s.add(m.uuid);
      const l = sent.get(chatId) ?? [];
      l.push(m);
      sent.set(chatId, l);
      if (autoReply) setImmediate(() => { if (live.has(chatId)) play(chatId, m); });
      return 'accepted';
    },
    async interrupt(chatId) { note('interrupt', chatId); return { stillQueued: [] }; },
    async cancelQueued(chatId, uuid) { note('cancelQueued', chatId, uuid); return false; },
    decide(chatId, requestId, a) {
      note('decide', chatId, requestId, a);
      const ask = asks.get(requestId);
      if (!ask || ask.chatId !== chatId) return 'not_pending';
      asks.delete(requestId);
      sink?.askEnd(chatId, requestId, 'answered');
      sink?.facts(chatId, facts(chatId, { pendingAsks: [...asks.values()].filter((x) => x.chatId === chatId).length }));
      return 'ok';
    },
    async setMode(chatId, m) {
      note('setMode', chatId, m);
      if (m === 'bypassPermissions' && !specs.get(chatId)?.allowBypass) throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
      sink?.facts(chatId, facts(chatId, { mode: m }));
    },
    async setModel(chatId, model, effort) { note('setModel', chatId, model, effort); },
    async rename(chatId, title) { note('rename', chatId, title); if (!live.has(chatId)) throw Object.assign(new Error('not_live'), { code: 'not_live' }); },
    async task(chatId, op, ref) { note('task', chatId, op, ref); },
    async contextSummary(chatId) { note('contextSummary', chatId); return { total: 18_000, window: 200_000, autoCompactAt: 167_000, categories: [], memoryFiles: [] }; },
    async rules(chatId) { note('rules', chatId); return []; },
    async commands(chatId) { note('commands', chatId); return []; },
    async usage(chatId) { note('usage', chatId); return null; },
    async rewindFiles(chatId, userUuid, dryRun) { note('rewindFiles', chatId, userUuid, dryRun); return { files: [] }; },
    async sleep(chatId: P.ChatId, reason: SleepReason, so?: { stopTasks?: boolean }) {
      note('sleep', chatId, reason, so);
      if (!live.has(chatId)) return null;
      const info = exitInfo('closed', 0);
      end(chatId, info);
      return info;
    },
    protect(visible, keepAlive) { calls.push({ m: 'protect', args: [[...visible], [...keepAlive]] }); },
    setPolicy(p) { note('setPolicy', undefined, p); policy = p; },
    asks: (chatId) => [...asks.values()].filter((a) => !chatId || a.chatId === chatId).sort((a, b) => a.since - b.since),
    resetBreaker(chatId) { note('resetBreaker', chatId); },
    ownPids: () => new Set([...live.values()].map((f) => f.cliPid).filter((x): x is number => typeof x === 'number')),
    async shutdown(deadlineMs) { note('shutdown', undefined, deadlineMs); for (const c of [...live.keys()]) end(c, exitInfo('closed', 0)); },
  };
  return e;
}
