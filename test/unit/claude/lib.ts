// test/unit/claude/lib.ts — transcript entry builders and small helpers for the profile-reading tests (structure of a CLI transcript).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountStore, Clock } from '../../../src/server/contracts.ts';
import type * as P from '../../../src/shared/protocol.ts';

export const FIXTURES = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'transcripts');
export const SID = '11111111-2222-4333-8444-555555555555';
export type E = Record<string, unknown>;

const T0 = Date.parse('2026-10-08T10:00:00.000Z');
let tick = 0;
export const iso = (i: number): string => new Date(T0 + i * 1000).toISOString();

function env(uuid: string, parent: string | null, i: number, cwd: string): E {
  return { parentUuid: parent, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: SID, version: '2.1.294', gitBranch: 'main', uuid, timestamp: iso(i) };
}
export function user(uuid: string, parent: string | null, text: string, o: { i?: number; cwd?: string; extra?: E } = {}): E {
  return { ...env(uuid, parent, o.i ?? ++tick, o.cwd ?? 'C:\\work\\demo'), type: 'user', message: { role: 'user', content: text }, promptId: randomUUID(), ...(o.extra ?? {}) };
}
export function assistant(uuid: string, parent: string | null, text: string, o: { i?: number; cwd?: string; msgId?: string; extra?: E; model?: string } = {}): E {
  return {
    ...env(uuid, parent, o.i ?? ++tick, o.cwd ?? 'C:\\work\\demo'), type: 'assistant', requestId: `req_${uuid.slice(0, 8)}`,
    message: { model: o.model ?? 'claude-opus-5-5', id: o.msgId ?? `msg_${uuid.replace(/-/g, '')}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } },
    ...(o.extra ?? {}),
  };
}
export function toolUse(uuid: string, parent: string, id: string, o: { i?: number } = {}): E {
  const a = assistant(uuid, parent, '', o);
  (a['message'] as E)['content'] = [{ type: 'tool_use', id, name: 'Bash', input: { command: 'dir' } }];
  (a['message'] as E)['stop_reason'] = 'tool_use';
  return a;
}
export function toolResult(uuid: string, parent: string, id: string, out: string, o: { i?: number } = {}): E {
  return { ...user(uuid, parent, '', o), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] }, toolUseResult: { stdout: out, stderr: '' } };
}
export const lastPrompt = (text: string, leaf: string): E => ({ type: 'last-prompt', lastPrompt: text, leafUuid: leaf, sessionId: SID });
export const customTitle = (t: string): E => ({ type: 'custom-title', customTitle: t, sessionId: SID });
export const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const jsonl = (entries: readonly E[]): string => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
export function writeJsonl(file: string, entries: readonly E[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(entries));
  return file;
}
/** Uuids of a chain page, in order. */
export const uuids = (chain: readonly { e: E }[]): string[] => chain.map((r) => String(r.e['uuid']));

/**
 * A seeded random transcript: retries (API errors on side branches), parallel tool calls (results on side branches),
 * compactions (preservedSegment or preservedMessages keeping the previous turn) and a few entries of 150–450 kB, so that
 * page windows end anywhere. Deterministic for a given seed.
 */
export function randomTranscript(seed: number): E[] {
  let s = seed;
  const rnd = (): number => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  let n = seed * 10_000;
  const id = (): string => u(++n);
  const out: E[] = [];
  let t = 0;
  let leaf: string | null = null;
  let lastTurn: string[] = [];
  const pad = (): string => 'p'.repeat(rnd() < 0.12 ? 150_000 + Math.floor(rnd() * 300_000) : Math.floor(rnd() * 1500));
  const push = (e: E): string => { out.push({ isSidechain: false, timestamp: iso(++t), sessionId: SID, ...e }); return e['uuid'] as string; };
  const turns = 8 + Math.floor(rnd() * 10);
  for (let k = 0; k < turns; k++) {
    if (k > 2 && rnd() < 0.25 && lastTurn.length >= 2) {
      const B = id(); const S = id();
      const cm = rnd() < 0.5 ? { preservedSegment: { headUuid: lastTurn[0], anchorUuid: S, tailUuid: lastTurn.at(-1) } } : { preservedMessages: { anchorUuid: S, uuids: [...lastTurn] } };
      push({ uuid: B, parentUuid: null, logicalParentUuid: leaf, type: 'system', subtype: 'compact_boundary', compactMetadata: cm });
      leaf = push({ uuid: S, parentUuid: B, type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Résumé' } });
    }
    const U = push({ uuid: id(), parentUuid: leaf, type: 'user', message: { role: 'user', content: `Q${k} ${pad()}` } });
    lastTurn = [U];
    leaf = U;
    if (rnd() < 0.2) push({ uuid: id(), parentUuid: U, type: 'assistant', isApiErrorMessage: true, message: { id: `msg_err${n}`, role: 'assistant', content: [{ type: 'text', text: 'API Error' }] } });
    const tools = Math.floor(rnd() * 3);
    if (tools) {
      const mid = `msg_par${n}`;
      const uses: string[] = [];
      for (let j = 0; j < tools; j++) {
        leaf = push({ uuid: id(), parentUuid: leaf, type: 'assistant', message: { id: mid, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'Read', input: {} }] } });
        uses.push(leaf);
      }
      for (const a of uses) leaf = push({ uuid: id(), parentUuid: a, type: 'user', sourceToolAssistantUUID: a, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${Number(a.slice(-12))}`, content: pad() }] } });
      lastTurn.push(...uses);
    }
    leaf = push({ uuid: id(), parentUuid: leaf, type: 'assistant', message: { id: `msg_fin${n}`, role: 'assistant', content: [{ type: 'text', text: `R${k} ${pad()}` }] } });
    lastTurn.push(leaf);
    if (rnd() < 0.3) out.push(lastPrompt(`Q${k}`, leaf));
  }
  return out;
}

/**
 * Two compactions in one file (CC 2.1.294 shapes): B1 keeps a preservedSegment (head U4 … tail A4), B2 keeps
 * preservedMessages [U6, A6, U7, A7]; turn 2 runs two tools in parallel (its first result sits on a side branch).
 * `expected` = the visible chain, oldest first: older history behind each boundary, relinked entries shown once.
 */
export function twoCompactions(pad = 0): { entries: E[]; expected: string[] } {
  const x = 'x'.repeat(pad);
  const ids = Array.from({ length: 26 }, (_, i) => u(101 + i));
  const [U1, A1, U2, A2a, A2b, R2x, R2y, A2c, U3, A3, U4, A4, B1, S1, U5, A5, U6, A6, U7, A7, B2, S2, U8, A8, U9, A9] = ids;
  const tu = (uuid: string, parent: string, id: string, i: number): E => { const a = toolUse(uuid, parent, id, { i }); (a['message'] as E)['id'] = 'msg_parallel'; return a; };
  const boundary = (uuid: string, lp: string, cm: E, i: number): E => ({ parentUuid: null, logicalParentUuid: lp, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 150_000, ...cm }, uuid, timestamp: iso(i), sessionId: SID });
  const summary = (uuid: string, parent: string, i: number): E => user(uuid, parent, 'Résumé de la conversation', { i, extra: { isCompactSummary: true, isVisibleInTranscriptOnly: true } });
  const entries: E[] = [
    user(U1!, null, `Q1 ${x}`, { i: 1 }), assistant(A1!, U1!, `R1 ${x}`, { i: 2 }),
    user(U2!, A1!, 'Q2 deux outils', { i: 3 }), tu(A2a!, U2!, 'toolu_x', 4), tu(A2b!, A2a!, 'toolu_y', 5),
    toolResult(R2x!, A2a!, 'toolu_x', `sortie x ${x}`, { i: 6 }), toolResult(R2y!, A2b!, 'toolu_y', `sortie y ${x}`, { i: 7 }), assistant(A2c!, R2y!, 'R2', { i: 8 }),
    user(U3!, A2c!, `Q3 ${x}`, { i: 9 }), assistant(A3!, U3!, `R3 ${x}`, { i: 10 }), user(U4!, A3!, `Q4 conservée ${x}`, { i: 11 }), assistant(A4!, U4!, `R4 conservée ${x}`, { i: 12 }),
    boundary(B1!, A4!, { preservedSegment: { headUuid: U4, anchorUuid: S1, tailUuid: A4 } }, 13), summary(S1!, B1!, 14),
    user(U5!, S1!, `Q5 ${x}`, { i: 15 }), assistant(A5!, U5!, `R5 ${x}`, { i: 16 }), user(U6!, A5!, `Q6 ${x}`, { i: 17 }), assistant(A6!, U6!, `R6 ${x}`, { i: 18 }),
    user(U7!, A6!, `Q7 ${x}`, { i: 19 }), assistant(A7!, U7!, `R7 ${x}`, { i: 20 }),
    boundary(B2!, A7!, { preservedMessages: { anchorUuid: S2, uuids: [U6, A6, U7, A7] } }, 21), summary(S2!, B2!, 22),
    user(U8!, S2!, `Q8 ${x}`, { i: 23 }), assistant(A8!, U8!, `R8 ${x}`, { i: 24 }), user(U9!, A8!, `Q9 ${x}`, { i: 25 }), assistant(A9!, U9!, `R9 ${x}`, { i: 26 }),
    lastPrompt('Q9', A9!),
  ];
  const expected = [U1, A1, U2, A2a, A2b, R2x, R2y, A2c, U3, A3, B1, S1, U4, A4, U5, A5, B2, S2, U6, A6, U7, A7, U8, A8, U9, A9] as string[];
  return { entries, expected };
}

/** A fake clock whose timers are real (watch debounce in integration-ish tests). */
export const realishClock: Clock = {
  now: () => Date.now(),
  timer(ms, fn) { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; },
};
export async function until(cond: () => boolean | Promise<boolean>, ms = 3000, step = 20): Promise<number> {
  const t0 = performance.now();
  while (!(await cond())) {
    if (performance.now() - t0 > ms) throw new Error(`timeout after ${ms} ms`);
    await new Promise((r) => setTimeout(r, step));
  }
  return performance.now() - t0;
}
export function onlyAccounts(store: AccountStore): P.AccountId[] { return store.list().map((a) => a.id); }

// ------------------------------------------------------------------ stores over a tmp root
import { createAccountStore } from '../../../src/server/claude/accounts.ts';
import { createFsGuard } from '../../../src/server/util/fs-guard.ts';
import type { FsGuard } from '../../../src/server/util/fs-guard.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import type { TmpRoot } from '../../helpers/tmp-profile.ts';

export type Store = AccountStore & { close(): void; refreshNow(id: P.AccountId): void };
export function guardFor(root: TmpRoot, extra: () => string[] = () => []): FsGuard {
  return createFsGuard({ allowRoots: [root.appDir], home: root.home, profileDirs: extra });
}
export async function makeStore(root: TmpRoot, clock: Clock = realishClock): Promise<{ store: Store; guard: FsGuard }> {
  let store: Store | null = null;
  const guard = guardFor(root, () => (store ? store.list().map((a) => a.configDir).filter((x): x is string => !!x) : []));
  store = createAccountStore({ appDir: root.appDir, homeReal: root.home, log: nullLogger, clock, guard }) as Store;
  await store.start();
  return { store, guard };
}
