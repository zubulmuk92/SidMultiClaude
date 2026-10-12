// src/server/claude/watch.ts — 8.3-safe watchers: projects (recursive), sessions, global config parent.
// Rules (SPEC §7.3):
// - assertNo83(dir) right before fs.watch: libuv aborts the WHOLE process on a path with an 8.3 component (JEANDU~1).
//   Callers pass realpathNative() paths; an 8.3 path is a programming error and throws here, before any handle exists.
// - Debounced per name (one write gives ≥ 2 events); a `null` filename (buffer overflow) is delivered as `null` = rescan.
// - 0 CPU while idle: no polling, timers only while events are pending.
import fs from 'node:fs';
import type { Clock, Logger } from '../contracts.ts';
import { assertNo83 } from '../util/paths.ts';
import { realClock } from '../util/clock.ts';
import { WATCH_DEBOUNCE_MS } from '../../shared/limits.ts';

export type WatchOptions = {
  recursive: boolean;
  debounceMs?: number;
  filter?: (name: string | null) => boolean;
  clock?: Clock;
  log?: Logger;
  /** Called once when the watcher dies (e.g. the directory was deleted). The watcher is already closed. */
  onError?: (e: Error) => void;
};
export type DirWatcher = { close(): void; readonly closed: boolean };

const NULL_KEY = '\u0000';

/** assertNo83(dir) BEFORE fs.watch (util/paths.ts): an 8.3 path aborts the whole process. */
export function watchDir(dir: string, o: WatchOptions, onChange: (name: string | null) => void): DirWatcher {
  assertNo83(dir);
  const clock = o.clock ?? realClock;
  const debounce = o.debounceMs ?? WATCH_DEBOUNCE_MS;
  const pending = new Map<string, { cancel(): void }>();
  let closed = false;
  const w = fs.watch(dir, { recursive: o.recursive, persistent: false });
  const fire = (key: string): void => {
    pending.delete(key);
    if (closed) return;
    try { onChange(key === NULL_KEY ? null : key); } catch (e) { o.log?.warn('watch: handler failed', { dir, err: e }); }
  };
  w.on('change', (_ev: string, filename: string | Buffer | null) => {
    if (closed) return;
    const name = filename === null || filename === undefined ? null : String(filename);
    if (o.filter && !o.filter(name)) return;
    const key = name ?? NULL_KEY;
    pending.get(key)?.cancel();
    pending.set(key, clock.timer(debounce, () => fire(key)));
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const t of pending.values()) t.cancel();
    pending.clear();
    try { w.close(); } catch { /* already closed */ }
  };
  w.on('error', (e: Error) => {
    o.log?.warn('watch: watcher error', { dir, err: e });
    close();
    try { o.onError?.(e); } catch { /* owner handler */ }
  });
  return { close, get closed() { return closed; } };
}

/** Case-insensitive file-name filter for a non-recursive parent-folder watch (global config, credentials). */
export function nameFilter(...names: string[]): (name: string | null) => boolean {
  const set = new Set(names.map((n) => n.toLowerCase()));
  return (name) => name === null || set.has(name.toLowerCase());
}
