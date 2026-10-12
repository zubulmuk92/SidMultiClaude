// src/server/engine/engine.ts — createEngine(): facade, sessionId→chatId map, sink fan-out (SPEC §2, §5.5 engine).
// At most one live query() per chat and per session id; every call is try/caught: one bad chat never takes the server down.
import fs from 'node:fs';
import type * as P from '../../shared/protocol.ts';
import type { CreateEngine, Engine, EnsureWhy, SpawnSpec } from '../contracts.ts';
import { BREAKER_CRASHES, BREAKER_WINDOW_MS, EST_RAM_PER_LIVE_CHAT_MB, SEND_UUID_LRU } from '../../shared/limits.ts';
import { ChatProcess, JOBRUN_FAILED, REWIND_REFUSED } from './chat-process.ts';
import { createAskRegistry } from './permissions.ts';
import { createPool } from './pool.ts';
import { EngineError } from './ctl.ts';

/** Engine plus the extras the server shell may use (asks / resetBreaker are also part of the Engine contract). */
export type EngineExtras = {
  noteStable(accountId: P.AccountId, v: boolean): void; // Account.resumeStable (orders cap candidates)
};

class Lru {
  private s = new Set<string>();
  has(k: string): boolean { return this.s.has(k); }
  add(k: string): void { this.s.delete(k); this.s.add(k); if (this.s.size > SEND_UUID_LRU) this.s.delete(this.s.values().next().value as string); }
}

export const createEngine: CreateEngine = (d) => makeEngine(d);

export function makeEngine(d: Parameters<CreateEngine>[0]): Engine & EngineExtras {
  const procs = new Map<P.ChatId, ChatProcess>();
  const bySession = new Map<P.SessionId, P.ChatId>();
  const seen = new Map<P.ChatId, Lru>();
  const crashes = new Map<P.ChatId, number[]>();
  const titles = new Map<P.ChatId, string>();
  const stable = new Map<P.AccountId, boolean>();
  const dirty = new Set<P.ChatId>();
  let flushArmed = false;
  let isolationSeen: 'job' | 'plain' = 'job';
  const safe = (what: string, fn: () => void): void => { try { fn(); } catch (e) { d.log.error(`engine: sink.${what} threw`, { err: String(e) }); } };

  const asks = createAskRegistry({ sink: d.sink, clock: d.clock, log: d.log, onChange: (c) => markDirty(c) });
  const pool = createPool({ clock: d.clock, freeMemBytes: d.freeMemBytes, log: d.log, stable: (a) => stable.get(a) ?? null,
    onReap: (c) => { void engine.sleep(c, 'reap').catch((e: unknown) => d.log.error('engine: reap failed', { chatId: c, err: String(e) })); } });

  function flushOne(c: P.ChatId): void {
    dirty.delete(c);
    const p = procs.get(c);
    if (p) { safe('facts', () => d.sink.facts(p.chatId, p.facts())); pool.touch(p.chatId); }
  }
  function markDirty(c: P.ChatId): void {
    dirty.add(c);
    if (flushArmed) return;
    flushArmed = true;
    setImmediate(() => { flushArmed = false; for (const x of [...dirty]) flushOne(x); });   // ≤ 1 facts per chat per tick
  }
  const lru = (c: P.ChatId): Lru => { let s = seen.get(c); if (!s) { s = new Lru(); seen.set(c, s); } return s; };
  function breakerOpen(c: P.ChatId): boolean {
    const now = d.clock.now();
    const list = (crashes.get(c) ?? []).filter((t) => now - t < BREAKER_WINDOW_MS);
    crashes.set(c, list);
    return list.length >= BREAKER_CRASHES;
  }
  const ownPids = (): ReadonlySet<number> => {
    const s = new Set<number>();
    for (const p of procs.values()) for (const pid of p.pids()) s.add(pid);
    const ext = (d.spawner as { ownPids?: () => ReadonlySet<number> }).ownPids;
    if (typeof ext === 'function') for (const pid of ext()) s.add(pid);
    return s;
  };
  const get = (c: P.ChatId): ChatProcess => { const p = procs.get(c); if (!p || p.unkillable && p.phase === 'closing') throw new EngineError('not_live'); return p; };

  function spawn(spec: SpawnSpec, why: EnsureWhy, forcedHolderPid?: number, fallback?: 'rewind' | 'isolation'): void {
    const cp = new ChatProcess({
      spec, query: d.query, clock: d.clock, log: d.log, sink: d.sink, spawner: d.spawner, asks, holder: d.holder, ownPids,
      cwdSafe: why !== 'usage',                            // the probe cwd of usage processes is the only S9 exemption (SPEC §10 S9)
      ...(forcedHolderPid !== undefined ? { forcedHolderPid } : {}),
      ...(fallback ? { fallback } : {}),
      onChange: (p) => markDirty(p.chatId),
      noteStable: (a, v) => { stable.set(a, v); },
      noteCliPid: (host, cli) => { const f = (d.spawner as { noteCliPid?: (c: string, h: number, p: number) => void }).noteCliPid; if (typeof f === 'function') f(cp.chatId, host, cli); },
      onSessionChanged: (p, from, to) => {
        procs.delete(from); procs.set(to, p);
        bySession.delete(from.slice(from.indexOf(':') + 1)); bySession.set(p.sessionId, to);
        const s = seen.get(from); if (s) { seen.set(to, s); }
        const t = titles.get(from); if (t) titles.set(to, t);
        pool.untrack(from); pool.track(to, () => p.poolView(p.title ?? titles.get(p.chatId) ?? p.chatId));
        dirty.delete(from);
        safe('sessionChanged', () => d.sink.sessionChanged(from, p.sessionId));
      },
      onExit: (p, info, returned) => {
        dirty.delete(p.chatId);
        if (procs.get(p.chatId) === p) procs.delete(p.chatId);
        if (bySession.get(p.sessionId) === p.chatId) bySession.delete(p.sessionId);
        pool.untrack(p.chatId);
        isolationSeen = p.isolation;
        // Neither is a crash (no breaker count), and the CLI never ran: a refused rewind (SPEC §2.1) goes on as a plain resume of
        // the same session (0 tokens until the next send, note rewind_fallback); a jobrun.exe that failed before starting the CLI
        // (SPEC §2.11) retries once in plain mode (note isolation_fallback). With messages typed meanwhile, the chat exits instead
        // and they go back to the composer (ExitInfo.message rewind_refused / jobrun_failed).
        const retry = info.message === REWIND_REFUSED && p.rewindRefused ? { start: { kind: 'resume' as const } }
          : info.message === JOBRUN_FAILED && p.jobrunFailed ? { isolation: 'plain' as const } : null;
        if (retry && !p.closeReason && returned.length === 0 && !procs.has(p.chatId)) {
          try { spawn({ ...p.spec, chatId: p.chatId, sessionId: p.sessionId, ...retry }, p.cwdSafe ? 'send' : 'usage', p.forcedHolderPid, 'start' in retry ? 'rewind' : 'isolation'); return; }
          catch (e) { d.log.error('engine: fallback spawn failed', { chatId: p.chatId, err: String(e) }); }
        }
        if ((info.reason === 'crash' || info.reason === 'spawn_failed' || info.reason === 'init_timeout') && !retry) {
          crashes.set(p.chatId, [...(crashes.get(p.chatId) ?? []), info.at]);
        }
        safe('exited', () => d.sink.exited(p.chatId, info, returned));     // after the last frame()
      },
    });
    procs.set(spec.chatId, cp);
    bySession.set(spec.sessionId, spec.chatId);
    if (spec.start.kind === 'new' && spec.start.title) titles.set(spec.chatId, spec.start.title);
    if (spec.start.kind === 'fork') titles.set(spec.chatId, spec.start.title);
    try { cp.start(); } catch (e) { procs.delete(spec.chatId); bySession.delete(spec.sessionId); throw e; }
    pool.track(spec.chatId, () => cp.poolView(cp.title ?? titles.get(cp.chatId) ?? cp.chatId));
    markDirty(spec.chatId);
  }

  const engine: Engine & EngineExtras = {
    isLive: (c) => procs.has(c),
    facts: (c) => procs.get(c)?.facts() ?? null,
    stats(): P.ProcStats {
      const items = [...procs.values()].map((p) => {
        const f = p.facts();
        const kinds = asks.list(p.chatId).map((a) => a.kind);
        const phase: P.ChatPhase = f.phase === 'spawning' ? 'starting' : kinds.includes('plan') ? 'needs_plan' : kinds.includes('question') ? 'needs_answer'
          : kinds.length ? 'needs_permission' : f.busy ? 'running' : 'idle';
        return { chatId: p.chatId, ...(f.cliPid ?? p.pids()[0] ? { pid: f.cliPid ?? p.pids()[0] } : {}), phase, since: f.spawnedAt,
          ...(f.lastRequestAt !== undefined ? { lastRequestAt: f.lastRequestAt, warmUntil: f.lastRequestAt + f.ttlMs } : {}),
          neverRequested: f.lastRequestAt === undefined, protected: pool.isProtected(p.chatId) };
      });
      return { live: procs.size, max: pool.policy().maxLive, effectiveMax: pool.effectiveMax(), lowMem: pool.lowMem(),
        estRamMB: procs.size * EST_RAM_PER_LIVE_CHAT_MB,
        isolation: procs.size ? ([...procs.values()].some((p) => p.isolation === 'plain') ? 'plain' : 'job') : isolationSeen, items };
    },
    async ensure(spec, o) {
      try {
        const cur = procs.get(spec.chatId);
        if (cur) return cur.phase === 'closing' ? { ok: false, err: { code: 'busy', message: 'closing' } } : { ok: true, data: undefined };
        if (breakerOpen(spec.chatId)) return { ok: false, err: { code: 'breaker_open' } };
        const other = bySession.get(spec.sessionId);
        if (other && procs.has(other)) return { ok: false, err: { code: 'busy', message: 'session already live' } };
        let forcedHolderPid: number | undefined;
        if (spec.start.kind !== 'new') {
          const h = d.holder(spec.account.id, spec.sessionId);
          if (h && !ownPids().has(h.pid)) {
            if (!o.force) return { ok: false, err: { code: 'external', holder: h } };
            forcedHolderPid = h.pid;                          // opened anyway: the post-init race guard ignores THIS holder
          }
        }
        // A victim being closed no longer counts as live, so a concurrent ensure() can take the slot it frees. When that
        // happened (the live count did not drop by the victims closed), the admission runs again (bounded): the cap holds
        // without `exceed`. It never re-runs otherwise: under low memory max(2, live) shrinks with each eviction.
        for (let round = 0; ; round++) {
          const adm = pool.admit({ chatId: spec.chatId, why: o.why, ...(o.evict ? { evict: o.evict } : {}), ...(o.exceed ? { exceed: true } : {}) });
          if (!adm.ok) return { ok: false, err: adm.err };
          if (round === 0 && !fs.existsSync(spec.exe)) return { ok: false, err: { code: 'exe_missing' } };
          if (!adm.evict.length) break;
          const before = pool.live();
          let freed = 0;
          for (const v of adm.evict) {
            const victim = procs.get(v.chatId);
            if (!victim) continue;                              // gone meanwhile: its slot is free
            const note = v.silent === 'never' ? 'evict:never' : v.silent === 'expired' ? 'evict:expired' : 'evict';
            if (!(await victim.close('evict', { note }))) return { ok: false, err: { code: 'cap_busy' } };   // became busy: never touched
            freed++;
          }
          if (procs.has(spec.chatId)) return { ok: true, data: undefined };
          if (pool.live() <= before - freed || round >= 2) break;
        }
        spawn(spec, o.why, forcedHolderPid);
        return { ok: true, data: undefined };
      } catch (e) {
        const code = e instanceof EngineError ? e.code : 'spawn_failed';
        d.log.error('engine: ensure failed', { chatId: spec.chatId, err: String(e) });
        return { ok: false, err: { code: code === 'cap' || code === 'external' ? 'spawn_failed' : code, message: e instanceof Error ? e.message : String(e) } };
      }
    },
    send(c, m) {
      const p = procs.get(c);
      if (lru(c).has(m.uuid)) return 'duplicate';
      if (!p) return 'not_live';
      const r = p.send(m);
      if (r === 'accepted') lru(c).add(m.uuid);
      return r;
    },
    async interrupt(c) { const p = procs.get(c); return p ? p.interrupt() : { stillQueued: [] }; },
    async cancelQueued(c, u) { const p = procs.get(c); return p ? p.cancelQueued(u) : false; },
    decide: (c, r, a) => asks.decide(c, r, a),
    setMode: (c, m) => get(c).setMode(m),
    setModel: (c, m, e) => get(c).setModel(m, e),
    async rename(c, t) { await get(c).rename(t); titles.set(c, t); },
    task: (c, op, ref) => get(c).task(op, ref),
    contextSummary: (c) => get(c).contextSummary(),
    rules: (c) => get(c).rules(),
    commands: (c) => get(c).commands(),
    usage: (c) => get(c).usage(),
    rewindFiles: (c, u, dry) => get(c).rewindFiles(u, dry),
    async sleep(c, reason, o) {
      const p = procs.get(c);
      if (!p) return null;
      return p.close(reason, o ?? {});
    },
    protect: (v, k) => pool.protect(v, k),
    setPolicy: (p) => pool.setPolicy(p),
    ownPids,
    async shutdown(deadlineMs) {
      const all = [...procs.values()];
      const closing = Promise.allSettled(all.map((p) => p.close('shutdown')));
      let t: { cancel(): void } | null = null;
      const timeout = new Promise<'timeout'>((r) => { t = d.clock.timer(deadlineMs, () => r('timeout')); });
      const r = await Promise.race([closing.then(() => 'ok' as const), timeout]);
      (t as { cancel(): void } | null)?.cancel();
      if (r === 'timeout') for (const p of procs.values()) p.forceStop();
      pool.dispose();
    },
    resetBreaker: (c) => { crashes.delete(c); },
    asks: (c) => asks.list(c),
    noteStable: (a, v) => { stable.set(a, v); },
  };
  return engine;
}
