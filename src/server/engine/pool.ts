// src/server/engine/pool.ts — cap, protection, victim classes, single-timer reaper, low-memory rule (SPEC §2.8).
// ONE timer (util/clock.ts DeadlineScheduler) armed for the earliest reap deadline, re-armed on every relevant event.
import type * as P from '../../shared/protocol.ts';
import type { Clock, EnsureWhy, Logger } from '../contracts.ts';
import { createDeadlineScheduler } from '../util/clock.ts';
import { pathKey } from '../util/paths.ts';
import {
  CACHE_TTL_1H_MS, LOW_MEM_FREE_BYTES, LOW_MEM_MIN_CAP, MAX_LIVE_DEFAULT, MAX_LIVE_MAX, MAX_LIVE_MIN, NEVER_REQUESTED_STOP_MS,
  REAP_5M_CAP_MS, REAP_MIN_DEFAULT, WAKE_SHARED_ACCOUNT_TOKENS, WAKE_SHARED_SAME_CWD_TOKENS, WAKE_SHARED_WINDOW_MS,
} from '../../shared/limits.ts';

const MIN_MS = 60_000;

/** What the pool needs to know about one live chat (read on demand). */
export type PoolChat = {
  chatId: P.ChatId; accountId: P.AccountId; cwd: string; title: string;
  phase: 'spawning' | 'live' | 'closing';
  busy: boolean; pendingAsks: number; bgTasks: number; queued: number;
  spawnedAt: number; sentAny: boolean; lastRequestAt?: number; ttlMs: number; lastContext?: number;
};
export type Admission = { ok: true; evict: { chatId: P.ChatId; silent: 'never' | 'expired' | false }[] } | { ok: false; err: P.WireError };
export type PoolPolicy = { maxLive: number; reapMin: number | null };
export type PoolDeps = {
  clock: Clock; freeMemBytes(): number; onReap(chatId: P.ChatId): void;
  stable(accountId: P.AccountId): boolean | null;      // Account.resumeStable (orders cap candidates only)
  log?: Logger;
};
export interface Pool {
  track(chatId: P.ChatId, view: () => PoolChat): void;
  untrack(chatId: P.ChatId): void;
  /** Re-computes the reap deadline of a chat (call on every facts change). */
  touch(chatId: P.ChatId): void;
  protect(visible: ReadonlySet<P.ChatId>, keepAlive: ReadonlySet<P.ChatId>): void;
  setPolicy(p: PoolPolicy): void;
  policy(): PoolPolicy;
  isProtected(chatId: P.ChatId): boolean;
  effectiveMax(): number;
  lowMem(): boolean;
  live(): number;
  admit(o: { chatId: P.ChatId; why: EnsureWhy; evict?: P.ChatId; exceed?: boolean }): Admission;
  deadline(chatId: P.ChatId): number | null;
  timerArmed(): boolean;
  dispose(): void;
}

/** WakeEstimate formula of SPEC §2.12 (kept local: the engine must not depend on the model layer at runtime). */
export function recacheEstimate(lastContext: number, shared: 'sameCwd' | 'account' | 'none'): number {
  const minus = shared === 'sameCwd' ? WAKE_SHARED_SAME_CWD_TOKENS : shared === 'account' ? WAKE_SHARED_ACCOUNT_TOKENS : 0;
  return Math.max(0, Math.round(lastContext) - minus);
}

export function createPool(d: PoolDeps): Pool {
  const views = new Map<P.ChatId, () => PoolChat>();
  let visible: ReadonlySet<P.ChatId> = new Set();
  let keepAlive: ReadonlySet<P.ChatId> = new Set();
  let pol: PoolPolicy = { maxLive: MAX_LIVE_DEFAULT, reapMin: REAP_MIN_DEFAULT };
  const sched = createDeadlineScheduler<P.ChatId>(d.clock, (keys, now) => {
    for (const k of keys) {
      const at = deadlineOf(k);
      if (at === null || !views.has(k)) continue;
      if (at > now) { sched.set(k, at); continue; }
      try { d.onReap(k); } catch (e) { d.log?.error('pool: reap failed', { chatId: k, err: String(e) }); }
    }
  });

  const view = (c: P.ChatId): PoolChat | null => { const v = views.get(c); return v ? v() : null; };
  function protectedView(v: PoolChat): boolean {
    return v.phase !== 'live' || v.busy || v.pendingAsks > 0 || v.bgTasks > 0 || v.queued > 0 || visible.has(v.chatId) || keepAlive.has(v.chatId);
  }
  const neverRequested = (v: PoolChat): boolean => !v.sentAny || v.lastRequestAt === undefined;
  function deadlineOf(c: P.ChatId): number | null {
    const v = view(c);
    if (!v || protectedView(v)) return null;
    if (neverRequested(v)) return v.spawnedAt + NEVER_REQUESTED_STOP_MS;
    if (pol.reapMin === null) return null;
    const reapMs = pol.reapMin * MIN_MS;
    return v.lastRequestAt! + (v.ttlMs < CACHE_TTL_1H_MS ? Math.min(reapMs, REAP_5M_CAP_MS) : reapMs);
  }
  const touch = (c: P.ChatId): void => sched.set(c, deadlineOf(c));
  const liveCount = (): number => [...views.keys()].filter((c) => view(c)?.phase !== 'closing').length;
  const lowMem = (): boolean => { try { return d.freeMemBytes() < LOW_MEM_FREE_BYTES; } catch { return false; } };
  const effectiveMax = (): number => (lowMem() ? Math.min(pol.maxLive, Math.max(LOW_MEM_MIN_CAP, liveCount())) : pol.maxLive);

  function candidate(v: PoolChat, now: number, all: PoolChat[]): P.CapCandidate {
    const ctx = v.lastContext ?? 0;
    const others = all.filter((o) => o.chatId !== v.chatId && o.accountId === v.accountId && o.lastRequestAt !== undefined && now - o.lastRequestAt < WAKE_SHARED_WINDOW_MS);
    const shared = others.some((o) => pathKey(o.cwd) === pathKey(v.cwd)) ? 'sameCwd' : others.length ? 'account' : 'none';
    const warmMs = (v.lastRequestAt ?? now) + v.ttlMs - now;
    return { chatId: v.chatId, title: v.title, warmMin: Math.max(0, Math.ceil(warmMs / MIN_MS)), recacheTokens: recacheEstimate(ctx, shared), stable: d.stable(v.accountId) === true };
  }

  return {
    track(c, v) { views.set(c, v); touch(c); },
    untrack(c) { views.delete(c); sched.delete(c); },
    touch,
    protect(v, k) { visible = new Set(v); keepAlive = new Set(k); for (const c of views.keys()) touch(c); },
    setPolicy(p) {
      pol = { maxLive: Math.min(MAX_LIVE_MAX, Math.max(MAX_LIVE_MIN, Math.round(p.maxLive))), reapMin: p.reapMin === null ? null : Math.max(1, p.reapMin) };
      for (const c of views.keys()) touch(c);
    },
    policy: () => ({ ...pol }),
    isProtected: (c) => { const v = view(c); return v ? protectedView(v) : false; },
    effectiveMax, lowMem, live: liveCount,
    admit(o) {
      if (o.exceed || liveCount() < effectiveMax()) return { ok: true, evict: [] };
      const now = d.clock.now();
      const all = [...views.keys()].map((c) => view(c)).filter((v): v is PoolChat => !!v && v.chatId !== o.chatId);
      const idle = all.filter((v) => !protectedView(v));
      if (o.evict) {
        const v = idle.find((x) => x.chatId === o.evict);
        if (v) return { ok: true, evict: [{ chatId: v.chatId, silent: false }] };
      }
      const c1 = idle.filter(neverRequested).sort((a, b) => a.spawnedAt - b.spawnedAt)[0];
      if (c1) return { ok: true, evict: [{ chatId: c1.chatId, silent: 'never' }] };
      const c2 = idle.filter((v) => now > v.lastRequestAt! + v.ttlMs).sort((a, b) => a.lastRequestAt! - b.lastRequestAt!)[0];
      if (c2) return { ok: true, evict: [{ chatId: c2.chatId, silent: 'expired' }] };
      if (o.why === 'prespawn') return { ok: false, err: { code: 'cap_busy', message: 'prespawn' } };   // never evicts a warm cache
      if (!idle.length) return { ok: false, err: { code: 'cap_busy' } };
      const cands = idle.map((v) => candidate(v, now, all))
        .sort((a, b) => Number(b.stable) - Number(a.stable) || (view(a.chatId)!.lastRequestAt! - view(b.chatId)!.lastRequestAt!));
      return { ok: false, err: { code: 'cap', candidates: cands } };
    },
    deadline: (c) => sched.get(c) ?? null,
    timerArmed: () => sched.armed(),
    dispose: () => sched.dispose(),
  };
}
