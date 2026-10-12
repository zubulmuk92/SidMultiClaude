// src/server/util/mutex.ts — promise-chain mutex.
// Used by SdkHelpers (the SDK session helpers read process.env.CLAUDE_CONFIG_DIR: one call at a time, SPEC §5.5) and by
// json-store (one write per file at a time). FIFO; a failing task never breaks the chain; tasks never overlap.

export interface Mutex {
  /** Runs fn after every previously queued task settled; resolves/rejects with fn's outcome. */
  run<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Tasks queued or running. */
  readonly pending: number;
  /** Resolves when the queue is empty. */
  idle(): Promise<void>;
}

export function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    run<T>(fn: () => T | Promise<T>): Promise<T> {
      pending++;
      // `finally` runs before the returned promise settles, so callers always observe the decremented count.
      const result = tail.then(() => fn()).finally(() => { pending--; });
      tail = result.then(() => {}, () => {});
      return result;
    },
    get pending() { return pending; },
    idle() { return tail; },
  };
}

/** A keyed set of mutexes (e.g. one per account or per file), created on demand and dropped when idle. */
export function createKeyedMutex(): { run<T>(key: string, fn: () => T | Promise<T>): Promise<T>; size(): number } {
  const map = new Map<string, Mutex>();
  return {
    run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
      let m = map.get(key);
      if (!m) { m = createMutex(); map.set(key, m); }
      const mm = m;
      return mm.run(fn).finally(() => { if (mm.pending === 0 && map.get(key) === mm) map.delete(key); });
    },
    size: () => map.size,
  };
}
