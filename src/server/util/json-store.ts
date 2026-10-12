// src/server/util/json-store.ts — atomic versioned JSON with a .bak, and a debounced writer.
// File format: an envelope { "v": <version>, "data": <T> } (config.json and state\chats.json are `v:1`, SPEC §7.1).
// Write: tmp + fsync + rename through fs-guard; the previous version first becomes <file>.bak (hard link or copy, then an
// atomic rename), so a kill at any point leaves either the old or the new file, and a valid .bak (tested:
// "kill mid-write").
// Ordering: every change bumps a generation; a write commits only if its generation is newer than the one on disk, so a
// flushSync() that lands while an async flush() is in flight is never overwritten by that older snapshot.
// Read: <file> → <file>.bak → defaults. Never throws on a corrupt or missing file.
import fs from 'node:fs';
import type { Clock, Logger } from '../contracts.ts';
import { fsGuard } from './fs-guard.ts';
import type { FsGuard } from './fs-guard.ts';
import { realClock } from './clock.ts';
import { createMutex } from './mutex.ts';
import { META_DEBOUNCE_MS } from '../../shared/limits.ts';

export type Envelope<T> = { v: number; data: T };
export type LoadSource = 'file' | 'bak' | 'defaults';
export type LoadResult<T> = { data: T; source: LoadSource; problems: string[] };

export type JsonStoreOptions<T> = {
  file: string;
  version: number;
  defaults: () => T;
  /** Validates/normalises the parsed `data` of the CURRENT version; return undefined to reject it (then .bak, then defaults). */
  accept?: (data: unknown) => T | undefined;
  /** Upgrades the data of an OLDER version; return undefined to reject it. Newer versions are always rejected. */
  migrate?: (data: unknown, fromVersion: number) => T | undefined;
  debounceMs?: number;                // default META_DEBOUNCE_MS (1 s), counted from the first unflushed change
  backup?: boolean;                   // default true
  clock?: Clock;
  fs?: FsGuard;                       // default: the app-wide guard
  log?: Logger;
};

export interface JsonStore<T> {
  readonly file: string;
  readonly loadedFrom: LoadSource;
  get(): T;
  set(next: T): void;                 // replaces the value and schedules a debounced write
  update(fn: (cur: T) => T | void): T; // mutate in place (return nothing) or return a new value
  dirty(): boolean;
  flush(): Promise<void>;             // write now if dirty (serialised with any write in flight)
  flushSync(): void;                  // shutdown / crash paths
  close(): Promise<void>;             // flush and cancel the timer
}

export function encodeEnvelope<T>(version: number, data: T): string {
  return JSON.stringify({ v: version, data } satisfies Envelope<T>, null, 1) + '\n';
}

function parseEnvelope(text: string): Envelope<unknown> {
  const o: unknown = JSON.parse(text);
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
  const e = o as Record<string, unknown>;
  if (typeof e['v'] !== 'number' || !Number.isInteger(e['v']) || !('data' in e)) throw new Error('missing v/data envelope');
  return { v: e['v'], data: e['data'] };
}

/** Synchronous load: <file> → <file>.bak → defaults(). */
export function loadVersioned<T>(o: Pick<JsonStoreOptions<T>, 'file' | 'version' | 'defaults' | 'accept' | 'migrate'>): LoadResult<T> {
  const problems: string[] = [];
  for (const [source, f] of [['file', o.file], ['bak', o.file + '.bak']] as const) {
    let text: string;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`${source}: ${(e as Error).message}`);
      continue;
    }
    try {
      const env = parseEnvelope(text);
      let data: T | undefined;
      if (env.v === o.version) data = o.accept ? o.accept(env.data) : (env.data as T);
      else if (env.v < o.version && o.migrate) data = o.migrate(env.data, env.v);
      else throw new Error(`unsupported version ${env.v} (expected ${o.version})`);
      if (data === undefined) throw new Error('rejected by accept/migrate');
      return { data, source, problems };
    } catch (e) {
      problems.push(`${source}: ${(e as Error).message}`);
    }
  }
  return { data: o.defaults(), source: 'defaults', problems };
}

export function openJsonStore<T>(o: JsonStoreOptions<T>): JsonStore<T> {
  const clock = o.clock ?? realClock;
  const debounceMs = o.debounceMs ?? META_DEBOUNCE_MS;
  const guard = (): FsGuard => o.fs ?? fsGuard();
  const loaded = loadVersioned(o);
  if (loaded.problems.length) o.log?.warn('json-store: recovered', { file: o.file, source: loaded.source, problems: loaded.problems });
  let value = loaded.data;
  let isDirty = false;
  let gen = 0;                                           // bumped by every set()/update()
  let diskGen = 0;                                       // generation of the newest version committed to disk
  let timer: { cancel(): void } | null = null;
  const lock = createMutex();

  const snapshot = (): string => encodeEnvelope(o.version, value);
  const arm = (): void => {
    if (timer) return;
    timer = clock.timer(debounceMs, () => { timer = null; flush().catch((e) => o.log?.error('json-store: write failed', { file: o.file, err: String(e) })); });
  };
  const touch = (): void => { gen++; isDirty = true; arm(); };
  async function flush(): Promise<void> {
    await lock.run(async () => {
      if (!isDirty) return;
      if (timer) { timer.cancel(); timer = null; }
      const myGen = gen;
      isDirty = false;                                   // changes made during the write re-dirty the store
      try {
        // shouldCommit runs synchronously right before the rename: a newer flushSync() may have landed during the async part.
        await guard().writeFileAtomic(o.file, snapshot(), { backup: o.backup ?? true, shouldCommit: () => myGen > diskGen });
        diskGen = Math.max(diskGen, myGen);
      } catch (e) {
        if (myGen > diskGen) isDirty = true;
        throw e;
      }
    });
  }
  return {
    file: o.file,
    loadedFrom: loaded.source,
    get: () => value,
    set(next) { value = next; touch(); },
    update(fn) {
      const r = fn(value);
      if (r !== undefined) value = r as T;
      touch();
      return value;
    },
    dirty: () => isDirty,
    flush,
    flushSync() {
      if (!isDirty) return;
      if (timer) { timer.cancel(); timer = null; }
      const myGen = gen;
      guard().writeFileAtomicSync(o.file, snapshot(), { backup: o.backup ?? true });
      diskGen = Math.max(diskGen, myGen);
      isDirty = false;
    },
    async close() { await flush(); if (timer) { timer.cancel(); timer = null; } },
  };
}

/** One-shot atomic write of an envelope (no store). */
export async function writeVersioned<T>(file: string, version: number, data: T, g: FsGuard = fsGuard()): Promise<void> {
  await g.writeFileAtomic(file, encodeEnvelope(version, data));
}
