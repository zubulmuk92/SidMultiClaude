// test/helpers/fake-clock.ts — manual Clock for unit tests (SPEC §12.1: "fake Clock").
// Time only moves when the test calls advance()/set(). Timers fire in deadline order (FIFO for equal deadlines), and a
// timer armed by a callback fires in the same advance() if its deadline is reached.
import type { Clock } from '../../src/server/contracts.ts';

type Timer = { id: number; at: number; fn: () => void; cancelled: boolean };

export interface FakeClock extends Clock {
  /** Moves time forward by ms, firing every timer whose deadline is reached (including timers armed meanwhile). */
  advance(ms: number): void;
  /** Jumps to an absolute time (≥ now), firing due timers. */
  set(at: number): void;
  /** Fires timers until none is left (bounded; throws on runaway re-arming). Returns how many fired. */
  runAll(maxSteps?: number): number;
  /** Fires the next timer only (time jumps to its deadline). Returns false if none. */
  runNext(): boolean;
  /** Pending (armed, not cancelled) timers. */
  pending(): number;
  /** Deadline of the next pending timer, or null. */
  nextAt(): number | null;
  /** Max number of simultaneously pending timers ever seen (single-timer assertions, SPEC §2.8). */
  readonly maxPending: number;
  /** Total timers ever armed. */
  readonly armedCount: number;
}

export function createFakeClock(start = Date.UTC(2026, 9, 8, 12, 0, 0)): FakeClock {
  let now = start;
  let seq = 0;
  let maxPending = 0;
  let armedCount = 0;
  const timers: Timer[] = [];
  const live = (): Timer[] => timers.filter((t) => !t.cancelled);
  const prune = (): void => { for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.cancelled) timers.splice(i, 1); };
  const nextTimer = (): Timer | undefined => {
    let best: Timer | undefined;
    for (const t of timers) if (!t.cancelled && (!best || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t;
    return best;
  };
  function fireUntil(limit: number): void {
    for (;;) {
      const t = nextTimer();
      if (!t || t.at > limit) break;
      now = Math.max(now, t.at);
      t.cancelled = true;
      prune();
      t.fn();
    }
    now = Math.max(now, limit);
  }
  return {
    now: () => now,
    timer(ms, fn) {
      const t: Timer = { id: ++seq, at: now + Math.max(0, ms), fn, cancelled: false };
      timers.push(t);
      armedCount++;
      maxPending = Math.max(maxPending, live().length);
      return { cancel: () => { t.cancelled = true; prune(); } };
    },
    advance(ms) { fireUntil(now + Math.max(0, ms)); },
    set(at) { fireUntil(Math.max(now, at)); },
    runAll(maxSteps = 10_000) {
      let n = 0;
      while (nextTimer()) {
        if (++n > maxSteps) throw new Error('fake-clock: runaway timers');
        const t = nextTimer()!;
        fireUntil(t.at);
      }
      return n;
    },
    runNext() {
      const t = nextTimer();
      if (!t) return false;
      fireUntil(t.at);
      return true;
    },
    pending: () => live().length,
    nextAt: () => nextTimer()?.at ?? null,
    get maxPending() { return maxPending; },
    get armedCount() { return armedCount; },
  };
}
