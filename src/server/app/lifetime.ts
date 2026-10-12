// src/server/app/lifetime.ts — server exit rule, reopen-window rule, crash marker, orphan flow (SPEC §2.9, C13).
// Exit rule (C13): no window for 10 min AND no live process AND no pending ask. Checked on hub.onEmpty, on `exited`, on
// `askEnd` and on its single timer (armed only while no window is connected). With --background the rule waits for the
// first window (the autostart server stays up).
// Reopen rule: an ask with no connected window and settings.reopenWindowOnAttention → the server opens a window
// (at most once per 30 s).
import fs from 'node:fs';
import type * as P from '../../shared/protocol.ts';
import type { Clock, Logger } from '../contracts.ts';
import { SERVER_IDLE_EXIT_MS } from '../../shared/limits.ts';
import type { AppPaths } from '../util/paths.ts';
import { fsGuard } from '../util/fs-guard.ts';
import { isChatId } from '../util/ids.ts';

export const REOPEN_MIN_INTERVAL_MS = 30_000;

export type LifetimeDeps = {
  clock: Clock; log: Logger;
  connections: () => number;
  liveCount: () => number;
  pendingAsks: () => number;
  reopenEnabled: () => boolean;
  openWindow: () => void;
  exit: () => void;                     // graceful shutdown (exit code 0)
  background?: boolean;
};
export interface Lifetime {
  check(): void;
  onAsk(): void;
  onConnect(): void;
  /** For tests and diagnostics: when the exit is due, or null. */
  dueAt(): number | null;
  dispose(): void;
}

export function createLifetime(d: LifetimeDeps): Lifetime {
  let noWindowSince: number | null = d.background ? null : d.clock.now();
  let seenWindow = !d.background;
  let timer: { cancel(): void } | null = null;
  let lastReopen = -Infinity;
  let exiting = false;
  const cancel = (): void => { timer?.cancel(); timer = null; };
  const busy = (): boolean => d.liveCount() > 0 || d.pendingAsks() > 0;

  function check(): void {
    if (exiting) return;
    if (d.connections() > 0) { noWindowSince = null; cancel(); return; }
    if (!seenWindow) { cancel(); return; }
    if (noWindowSince === null) noWindowSince = d.clock.now();
    if (busy()) { cancel(); return; }                       // re-checked on exited / askEnd
    const due = noWindowSince + SERVER_IDLE_EXIT_MS;
    const now = d.clock.now();
    if (now >= due) {
      exiting = true;
      cancel();
      d.log.info('lifetime: idle exit', { idleMs: now - noWindowSince });
      d.exit();
      return;
    }
    cancel();
    timer = d.clock.timer(due - now, () => { timer = null; check(); });
  }
  return {
    check,
    onAsk() {
      if (d.connections() > 0 || !d.reopenEnabled()) return;
      const now = d.clock.now();
      if (now - lastReopen < REOPEN_MIN_INTERVAL_MS) return;
      lastReopen = now;
      try { d.openWindow(); } catch (e) { d.log.warn('lifetime: reopen failed', { err: String(e) }); }
    },
    onConnect() { seenWindow = true; noWindowSince = null; cancel(); },
    dueAt: () => (timer && noWindowSince !== null ? noWindowSince + SERVER_IDLE_EXIT_MS : null),
    dispose() { exiting = true; cancel(); },
  };
}

// ------------------------------------------------------------------ crash marker + recorded children (run\*)
export type CrashMarker = { pid: number; startedAt: number; live: P.ChatId[] };
export type RecordedChild = { pid: number; createdAt: string; chatId?: string };
export type BootCrashState = { crashed: boolean; live: P.ChatId[]; children: RecordedChild[] };

/** run\children.json as written by the spawner: [..] | {children:[..]} | {v, data:[..] | {children:[..]}}. */
export function parseChildren(text: string): RecordedChild[] {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return []; }
  const pick = (x: unknown): unknown[] => (Array.isArray(x) ? x : x && typeof x === 'object' ? pick((x as Record<string, unknown>)['children'] ?? (x as Record<string, unknown>)['data'] ?? []) : []);
  const out: RecordedChild[] = [];
  for (const r of pick(o)) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    const pid = x['pid'];
    const at = x['createdAt'] ?? x['created'] ?? x['procStart'] ?? x['startedAt'];
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || (typeof at !== 'string' && typeof at !== 'number')) continue;
    out.push({ pid: pid as number, createdAt: String(at), ...(typeof x['chatId'] === 'string' ? { chatId: x['chatId'] } : {}) });
  }
  return out;
}

export function readBootCrashState(p: Pick<AppPaths, 'crashMarker' | 'children'>): BootCrashState {
  let marker: string | null = null;
  try { marker = fs.readFileSync(p.crashMarker, 'utf8'); } catch { /* clean last exit */ }
  if (marker === null) return { crashed: false, live: [], children: [] };
  let live: P.ChatId[] = [];
  try { const m = JSON.parse(marker) as Partial<CrashMarker>; live = Array.isArray(m.live) ? m.live.filter(isChatId) : []; } catch { /* old/empty marker */ }
  let children: RecordedChild[] = [];
  try { children = parseChildren(fs.readFileSync(p.children, 'utf8')); } catch { /* none */ }
  return { crashed: true, live, children };
}

export function writeCrashMarker(file: string, m: CrashMarker): void {
  try { fsGuard().writeFileAtomicSync(file, JSON.stringify(m), { backup: false }); } catch { /* best effort */ }
}
export function clearRunFiles(p: Pick<AppPaths, 'crashMarker' | 'instance'>): void {
  for (const f of [p.crashMarker, p.instance]) { try { fsGuard().rmSync(f, { force: true }); } catch { /* best effort */ } }
}
