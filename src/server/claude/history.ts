// src/server/claude/history.ts — PromptHistory: app prompts.jsonl + read-only history.jsonl.
// App side: state\prompts.jsonl (one {c, t, at, cwd?} line per prompt sent from the app; 5,000 lines, rotated by an atomic
// rewrite). Terminal side: <cfg>\history.jsonl of each profile, READ-ONLY: newest first, filtered by the
// normalised project path (or the session id), deduplicated on text. `pastedContents` hashes are never resolved here.
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../../shared/protocol.ts';
import type { AccountStore, PromptHistory } from '../contracts.ts';
import { appPaths, samePath } from '../util/paths.ts';
import { parseChatId } from '../util/ids.ts';
import { fsGuard } from '../util/fs-guard.ts';
import type { FsGuard } from '../util/fs-guard.ts';
import { createMutex } from '../util/mutex.ts';
import { PROMPTS_MAX_LINES } from '../../shared/limits.ts';

const MAX_HITS = 100;
const MAX_TEXT = 20_000;
const HISTORY_READ_MAX = 4 * 1024 * 1024;
const ROTATE_SLACK = 500;

type AppLine = { c: P.ChatId; t: string; at: number; cwd?: string };
export type PromptHistoryDeps = {
  accounts: AccountStore; appDir: string; guard?: FsGuard;
  /** Recorded cwd of a chat (SessionIndex / MetaStore), used to match terminal prompts of the same project. */
  cwdOf?: (chatId: P.ChatId) => string | undefined;
};

function readTail(file: string, max: number): string {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return ''; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const b = Buffer.allocUnsafe(size - start);
    const n = fs.readSync(fd, b, 0, b.length, start);
    const s = b.toString('utf8', 0, n);
    return start > 0 ? s.slice(s.indexOf('\n') + 1) : s;
  } catch { return ''; } finally { fs.closeSync(fd); }
}
function parseLines<T>(text: string, pick: (o: Record<string, unknown>) => T | null): T[] {
  const out: T[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l) as unknown; if (o && typeof o === 'object') { const v = pick(o as Record<string, unknown>); if (v) out.push(v); } } catch { /* torn line */ }
  }
  return out;
}
/** Last `max` bytes of a read-only file (complete lines), read asynchronously. */
async function readTailAsync(file: string, max: number): Promise<string> {
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(file, 'r'); } catch { return ''; }
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - max);
    const b = Buffer.allocUnsafe(size - start);
    const { bytesRead } = await fh.read(b, 0, b.length, start);
    const s = b.toString('utf8', 0, bytesRead);
    return start > 0 ? s.slice(s.indexOf('\n') + 1) : s;
  } catch { return ''; } finally { await fh.close().catch(() => undefined); }
}
const SLICE_MS = 3;
/** Like parseLines, yielding to the event loop every few ms; lines that cannot match `raw` are not parsed at all. */
async function parseLinesAsync<T>(text: string, raw: RegExp | null, pick: (o: Record<string, unknown>) => T | null): Promise<T[]> {
  const out: T[] = [];
  let t0 = performance.now();
  for (const l of text.split('\n')) {
    if (performance.now() - t0 > SLICE_MS) { await new Promise((r) => setImmediate(r)); t0 = performance.now(); }
    if (!l.trim() || (raw && !raw.test(l))) continue;
    try { const o = JSON.parse(l) as unknown; if (o && typeof o === 'object') { const v = pick(o as Record<string, unknown>); if (v) out.push(v); } } catch { /* torn line */ }
  }
  return out;
}
/** The needle as written inside a JSON string, case-insensitive (a cheap pre-filter before JSON.parse). */
const rawNeedle = (needle: string): RegExp | null =>
  needle ? new RegExp(JSON.stringify(needle).slice(1, -1).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'), 'iu') : null;

export function createPromptHistory(d: PromptHistoryDeps): PromptHistory & { flush(): Promise<void> } {
  const file = appPaths(d.appDir).prompts;
  const guard = (): FsGuard => d.guard ?? fsGuard();
  const mutex = createMutex();
  let lines: AppLine[] | null = null;
  const pending: AppLine[] = [];
  let scheduled = false;
  const load = (): AppLine[] => {
    lines ??= parseLines(readTail(file, 64 * 1024 * 1024), (o) =>
      typeof o['c'] === 'string' && typeof o['t'] === 'string' && typeof o['at'] === 'number'
        ? { c: o['c'], t: o['t'], at: o['at'], ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'] } : {}) } : null).slice(-PROMPTS_MAX_LINES);
    return lines;
  };

  return {
    append(chatId, text, at) {
      const t = String(text ?? '').trim().slice(0, MAX_TEXT);
      if (!t || !parseChatId(chatId)) return;
      const cwd = d.cwdOf?.(chatId);
      const line: AppLine = { c: chatId, t, at, ...(cwd ? { cwd } : {}) };
      load().push(line);
      pending.push(line);
      if (scheduled) return;
      scheduled = true;
      void mutex.run(async () => {                               // one batched write per burst
        scheduled = false;
        const batch = pending.splice(0);
        if (!batch.length) return;
        const all = load();
        await guard().mkdir(appPaths(d.appDir).stateDir, { recursive: true });
        if (all.length > PROMPTS_MAX_LINES + ROTATE_SLACK) {
          all.splice(0, all.length - PROMPTS_MAX_LINES);
          await guard().writeFileAtomic(file, all.map((l) => JSON.stringify(l)).join('\n') + '\n', { backup: false });
        } else await guard().appendFile(file, batch.map((l) => JSON.stringify(l)).join('\n') + '\n');
      }).catch(() => undefined);
    },
    async search(q, chatId) {
      const needle = String(q ?? '').trim().toLowerCase();
      const want = (s: string): boolean => !needle || s.toLowerCase().includes(needle);
      const ids = chatId ? parseChatId(chatId) : null;
      const cwd = chatId ? d.cwdOf?.(chatId) : undefined;
      const hits: P.PromptHit[] = [];
      for (const l of load()) {
        if (chatId && l.c !== chatId && !(cwd && l.cwd && samePath(cwd, l.cwd))) continue;
        if (want(l.t)) hits.push({ text: l.t, at: l.at, source: 'app', chatId: l.c });
      }
      const accounts = ids ? [ids.accountId] : d.accounts.list().map((a) => a.id);
      const raw = rawNeedle(needle);
      for (const id of accounts) {
        if (!d.accounts.get(id)) continue;
        const hist = path.join(d.accounts.paths(id).configHome, 'history.jsonl');
        for (const h of await parseLinesAsync(await readTailAsync(hist, HISTORY_READ_MAX), raw, (o) =>
          typeof o['display'] === 'string' && typeof o['timestamp'] === 'number' ? o : null)) {
          if (ids && h['sessionId'] !== ids.sessionId && !(cwd && typeof h['project'] === 'string' && samePath(cwd, h['project']))) continue;
          const text = String(h['display']).trim();
          if (text && want(text)) hits.push({ text, at: h['timestamp'] as number, source: 'terminal' });
        }
      }
      hits.sort((a, b) => b.at - a.at);
      const seen = new Set<string>();
      return hits.filter((h) => { if (seen.has(h.text)) return false; seen.add(h.text); return true; }).slice(0, MAX_HITS);
    },
    flush() { return mutex.idle(); },
  };
}
