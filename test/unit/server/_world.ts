// Test world for the WP-D command and orchestrator tests: real hub + rpc + orchestrator + commands + MetaStore + platform
// (S9 on a tmp home), with the fake engine and small in-memory stand-ins for the WP-C stores.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type * as P from '../../../src/shared/protocol.ts';
import type { Account, AccountStore, LiveRegistry, Logger, LoginService, PromptHistory, SdkHelpers, SessionIndex, SessionMeta, TranscriptReader, RawEntry } from '../../../src/server/contracts.ts';
import { createHub } from '../../../src/server/ws/hub.ts';
import type { Conn, WsLike } from '../../../src/server/ws/hub.ts';
import { createRpc } from '../../../src/server/ws/rpc.ts';
import { createOrchestrator } from '../../../src/server/app/orchestrator.ts';
import { createCommands } from '../../../src/server/app/commands.ts';
import { createMetaStore } from '../../../src/server/app/meta.ts';
import { createPlatform } from '../../../src/server/platform/win.ts';
import { configureFsGuard } from '../../../src/server/util/fs-guard.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { createLiveReducer } from '../../../src/server/model/live-reducer.ts';
import { createChatState } from '../../../src/server/model/chat-state.ts';
import { diskToTurns, detailFromEntry } from '../../../src/server/model/disk-turns.ts';
import { activityLine, deriveTitle } from '../../../src/server/model/derive.ts';
import { wakeEstimate } from '../../../src/server/model/accounting.ts';
import { createFakeEngine } from '../../fakes/fake-engine.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';
import type { TmpRoot } from '../../helpers/tmp-profile.ts';

export class FakeWs extends EventEmitter implements WsLike {
  readyState = 1; bufferedAmount = 0; sent: P.S2C[][] = [];
  send(data: string): void { this.sent.push(JSON.parse(data) as P.S2C[]); }
  close(): void { this.readyState = 3; this.emit('close'); }
  msgs(): P.S2C[] { return this.sent.flat(); }
}
export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

export function createWorld(tmp: TmpRoot, label: string) {
  const appDir = path.join(tmp.root, `app-${label}`);
  fs.mkdirSync(appDir, { recursive: true });
  configureFsGuard({ allowRoots: [appDir], home: tmp.home });
  const clock = createFakeClock(Date.now());
  const views: P.AccountView[] = (['perso', 'pro'] as const).map((id, i) => ({
    id, name: id, color: i + 1, monogram: id[0]!.toUpperCase(), configDir: id === 'perso' ? null : path.join(tmp.home, '.claude-pro'), isDefault: id === 'perso',
    hidden: false, login: id === 'perso' ? 'connected' : 'disconnected', defaults: {},
    diag: { leakFiles: [], leakExcluded: false, resumeStable: null, cleanupDays: 30, expiringSoon: 0 },
  }));
  const trusted = new Set<string>();
  const accountUpdates: [string, P.AccountPatch][] = [];
  const accountCbs = new Set<(id: P.AccountId) => void>();
  const accounts: AccountStore & { usage: unknown[]; stable: [string, boolean][]; baselines: [string, number][]; catalog: P.ModelOption[] } = {
    usage: [], stable: [], baselines: [], catalog: [],
    start: async () => {}, list: () => views, get: (id) => { const v = views.find((x) => x.id === id); return v ? ({ id: v.id, name: v.name, color: v.color, monogram: v.monogram, configDir: v.configDir, hidden: false, excludeForeignClaudeMd: false, resumeStable: null, defaults: v.defaults } satisfies Account) : undefined; },
    paths: (id) => { const c = id === 'perso' ? path.join(tmp.home, '.claude') : path.join(tmp.home, '.claude-pro'); return { configHome: c, globalConfig: '', projectsDir: path.join(c, 'projects'), sessionsDir: '', credentials: '' }; },
    candidates: async () => [], add: async () => views[0]!, update: async (id, p) => { accountUpdates.push([id, p]); return views[0]!; }, claudeMdExcludes: () => [],
    trustedInCli: (_id, cwd) => trusted.has(cwd.toLowerCase()), modelCatalog() { return this.catalog; }, cleanupDays: () => 30,
    noteUsage(_id, u) { this.usage.push(u); }, noteAuthError: () => {}, noteResumeStable(id, v) { this.stable.push([id, v]); }, noteBaseline(id, t) { this.baselines.push([id, t]); },
    onChange: (cb) => { accountCbs.add(cb); return () => { accountCbs.delete(cb); }; },
  };
  /** Simulates an AccountStore change of one account (mutate `views` first, e.g. its login state). */
  const emitAccount = (id: P.AccountId): void => { for (const cb of accountCbs) cb(id); };
  const sessions = new Map<P.ChatId, SessionMeta>();
  const indexCbs = new Set<(u: SessionMeta[], r: P.ChatId[]) => void>();
  const index: SessionIndex & { put(m: SessionMeta): void } = {
    start: async () => {}, list: () => [...sessions.values()], get: (id) => sessions.get(id), reconcile: async () => {},
    onChange: (cb) => { indexCbs.add(cb); return () => indexCbs.delete(cb); },
    put(m) { sessions.set(m.chatId, m); for (const cb of indexCbs) cb([m], []); },
  };
  const holders = new Map<string, P.ExternalHolder>();
  const registry: LiveRegistry = { start: () => {}, holder: (a, s) => holders.get(`${a}:${s}`) ?? null, setOwnPids: () => {}, onChange: () => () => {} };
  const chains = new Map<string, RawEntry[]>();
  const reader: TranscriptReader = {
    tail: async (file) => ({ chain: chains.get(file) ?? [], cursor: null, hasMore: false }),
    before: async () => { throw Object.assign(new Error('cursor'), { code: 'invalid' }); },
    line: async (file, off) => chains.get(file)?.find((r) => r.off === off)?.e ?? null,
    search: async () => [], firstInstructions: async () => [path.join(tmp.home, '.claude', 'CLAUDE.md')], hasUserUuid: async () => false,
  };
  const helperCalls: unknown[][] = [];
  const helpers: SdkHelpers = {
    rename: async (a, s, t) => { helperCalls.push(['rename', a.id, s, t]); },
    remove: async (a, s) => { helperCalls.push(['remove', a.id, s]); },
    forkUpTo: async (a, s, u) => { helperCalls.push(['forkUpTo', a.id, s, u]); return '9adf4c63-b504-4be1-804b-92a88963e275'; },
  };
  const prompts: string[] = [];
  const history: PromptHistory = { append: (_c, t) => { prompts.push(t); }, search: async (q, c) => [{ text: `hit:${q}`, at: 1, source: 'app', ...(c ? { chatId: c } : {}) }] };
  const loginCalls: unknown[][] = [];
  const loginSteps = new Map<string, (s: P.LoginStep) => void>();
  const login: LoginService = {
    start: (i, e, on) => { loginCalls.push(['start', i, e]); loginSteps.set(i, on); on({ step: 'url', url: 'https://claude.ai/oauth' }); },
    code: (i, c) => { loginCalls.push(['code', i, c]); }, cancel: (i) => { loginCalls.push(['cancel', i]); },
    logout: async (i) => { loginCalls.push(['logout', i]); },
  };
  const logged: { level: string; msg: string; f?: Record<string, unknown> }[] = [];
  const cmdLog: Logger = {
    info: (msg, f) => { logged.push({ level: 'info', msg, ...(f ? { f } : {}) }); }, warn: (msg, f) => { logged.push({ level: 'warn', msg, ...(f ? { f } : {}) }); },
    error: (msg, f) => { logged.push({ level: 'error', msg, ...(f ? { f } : {}) }); },
  };
  const meta = createMetaStore({ appDir, log: nullLogger, clock });
  const platform = createPlatform({ appDir, log: nullLogger, home: tmp.home, probeCwd: path.join(appDir, 'probe-cwd') });
  const engine = createFakeEngine({ now: () => clock.now(), autoReply: true });
  const hub = createHub({ clock, log: nullLogger });
  const orch = createOrchestrator({ clock, log: nullLogger, hub, meta, accounts, index, registry, history, helpers, boot: 'boot-1',
    model: { createLiveReducer, createChatState, deriveTitle, activityLine, wakeEstimate } });
  engine.setSink(orch.sink);
  orch.attachEngine(engine);
  orch.start();
  const quits: number[] = [];
  const commands = createCommands({ clock, log: cmdLog, hub, orch, meta, accounts, index, reader, helpers, history, login, registry, platform,
    engine: () => engine, model: { diskToTurns, deriveTitle, detailFromEntry },
    exe: () => ({ ok: true, data: 'C:\\fake\\claude.exe' }), home: tmp.home, probeCwd: path.join(appDir, 'probe-cwd'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }), quit: () => { quits.push(1); }, lastOrphans: () => [{ pid: 4242, name: 'node.exe' }] });
  const rpc = createRpc<Conn>({ handlers: commands, log: nullLogger, sendAck: (c, a) => hub.send(c, [a], true) });
  hub.onMessage((c, text) => { void rpc.handle(c, text); });
  hub.onViewChange(() => orch.onViewChange());
  let nextId = 1;
  function window() {
    const ws = new FakeWs();
    const conn = hub.attach(ws);
    hub.send(conn, [orch.hello()], true);
    return {
      ws, conn,
      async req<T = unknown>(body: Record<string, unknown>): Promise<{ ok: true; data?: T } | { ok: false; err: P.WireError }> {
        const id = nextId++;
        await rpc.handle(conn, JSON.stringify({ id, ...body }));
        await tick();
        const a = ws.msgs().find((m) => m.t === 'ack' && m.id === id);
        if (!a || a.t !== 'ack') throw new Error(`no ack for ${id}`);
        if (!a.ok) return { ok: false, err: a.err };
        return a.data === undefined ? { ok: true } : { ok: true, data: a.data as T };
      },
    };
  }
  return { clock, accounts, views, trusted, index, holders, chains, helperCalls, prompts, meta, platform, engine, hub, orch, window, quits, appDir,
    reader, loginCalls, loginSteps, logged, accountUpdates, commands, emitAccount };
}
