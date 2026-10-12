// src/server/util/clock.ts — the real Clock and the single-deadline scheduler.
// SPEC §2.8: the server arms ONE setTimeout per scheduler, for the earliest deadline, re-armed on every relevant event.
// No periodic (interval) timer exists anywhere in src/server: test/unit/util/hygiene.test.ts greps the whole tree for it.
import type { Clock } from '../contracts.ts';

/** setTimeout max delay (2^31 − 1 ms ≈ 24.8 days); longer deadlines are re-checked when this fires. */
export const MAX_TIMER_MS = 2_147_483_647;

export const realClock: Clock = {
  now: () => Date.now(),
  timer(ms, fn) {
    const t = setTimeout(fn, Math.min(Math.max(0, ms), MAX_TIMER_MS));
    return { cancel: () => clearTimeout(t) };
  },
};

export interface DeadlineScheduler<K = string> {
  /** Sets (or moves) the deadline of `key`; null / Infinity removes it. Re-arms the single timer only when needed. */
  set(key: K, at: number | null): void;
  delete(key: K): void;
  get(key: K): number | undefined;
  /** Earliest pending deadline, if any. */
  next(): { key: K; at: number } | null;
  /** True while the one timer is armed (tests assert at most one). */
  armed(): boolean;
  size(): number;
  /** Fires everything already due, synchronously (e.g. after the clock jumped). */
  poke(): void;
  dispose(): void;
}

/**
 * One timer for many deadlines. When the timer fires, every key whose deadline is <= now is removed and passed to onDue
 * (in deadline order), then the timer is re-armed for the next deadline. onDue may set new deadlines.
 */
export function createDeadlineScheduler<K = string>(clock: Clock, onDue: (keys: K[], now: number) => void): DeadlineScheduler<K> {
  const deadlines = new Map<K, number>();
  let timer: { cancel(): void } | null = null;
  let armedAt = Infinity;                       // deadline the timer is armed for
  let disposed = false;
  let firing = false;

  function earliest(): { key: K; at: number } | null {
    let best: { key: K; at: number } | null = null;
    for (const [key, at] of deadlines) if (!best || at < best.at) best = { key, at };
    return best;
  }
  function rearm(): void {
    if (disposed || firing) return;
    const e = earliest();
    const target = e ? e.at : Infinity;
    if (timer && target === armedAt) return;    // already armed for the right deadline
    if (timer) { timer.cancel(); timer = null; }
    armedAt = target;
    if (target === Infinity) return;
    timer = clock.timer(Math.max(0, target - clock.now()), fire);
  }
  function fire(): void {
    timer = null;
    armedAt = Infinity;
    if (disposed) return;
    const now = clock.now();
    const due = [...deadlines].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    for (const k of due) deadlines.delete(k);
    firing = true;
    try { if (due.length) onDue(due, now); } finally { firing = false; rearm(); }
  }
  return {
    set(key, at) {
      if (at === null || at === Infinity || Number.isNaN(at)) deadlines.delete(key);
      else deadlines.set(key, at);
      rearm();
    },
    delete(key) { deadlines.delete(key); rearm(); },
    get: (key) => deadlines.get(key),
    next: earliest,
    armed: () => timer !== null,
    size: () => deadlines.size,
    poke() { if (timer) { timer.cancel(); timer = null; armedAt = Infinity; } fire(); },
    dispose() { disposed = true; if (timer) timer.cancel(); timer = null; deadlines.clear(); },
  };
}
