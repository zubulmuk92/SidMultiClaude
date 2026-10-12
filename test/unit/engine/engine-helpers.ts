// test/unit/engine/engine-helpers.ts — recording sink + engine factory over fake-query (engine tests only).
import type * as P from '../../../src/shared/protocol.ts';
import type { EngineSink, ExitInfo, ProcessFacts, SdkFrame, SpawnSpec } from '../../../src/server/contracts.ts';
import { makeEngine } from '../../../src/server/engine/engine.ts';
import { createFakeQuery } from '../../fakes/fake-query.ts';
import type { FakeQueryOptions } from '../../fakes/fake-query.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';
import { memoryLogger } from '../../../src/server/util/log.ts';

export type Rec =
  | { k: 'frame'; c: string; f: Record<string, unknown> } | { k: 'facts'; c: string; f: ProcessFacts } | { k: 'ask'; a: P.PendingAsk }
  | { k: 'askEnd'; c: string; r: string; why: string } | { k: 'delivered'; c: string; uuid: string; folded: boolean; imageTypes?: string[]; imageBytes?: number[] }
  | { k: 'session'; c: string; sid: string } | { k: 'exited'; c: string; info: ExitInfo; returned: P.QueueItem[] };

export function recordingSink(): EngineSink & { log: Rec[] } {
  const log: Rec[] = [];
  return {
    log,
    frame: (c, f: SdkFrame) => { log.push({ k: 'frame', c, f: f as Record<string, unknown> }); },
    facts: (c, f) => { log.push({ k: 'facts', c, f }); },
    ask: (a) => { log.push({ k: 'ask', a }); },
    askEnd: (c, r, why) => { log.push({ k: 'askEnd', c, r, why }); },
    delivered: (c, m) => { log.push({ k: 'delivered', c, uuid: m.uuid, folded: m.folded, ...(m.imageTypes ? { imageTypes: m.imageTypes } : {}), ...(m.imageBytes ? { imageBytes: m.imageBytes } : {}) }); },
    sessionChanged: (c, sid) => { log.push({ k: 'session', c, sid }); },
    exited: (c, info, returned) => { log.push({ k: 'exited', c, info, returned }); },
  };
}

export const SID = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
export function spec(n: number, o: Partial<SpawnSpec> = {}): SpawnSpec {
  const sid = o.sessionId ?? SID(n);
  return { chatId: `acc:${sid}`, sessionId: sid, cwd: process.cwd(), account: { id: 'acc', configDir: null, claudeMdExcludes: [] }, mode: 'default',
    start: { kind: 'new' }, allowBypass: false, aiTitles: false, exe: process.execPath, isolation: 'plain', ...o };
}

export function setupEngine(fq: FakeQueryOptions = {}, o: { holder?: (a: string, s: string) => P.ExternalHolder | null; free?: number } = {}) {
  const clock = createFakeClock();
  const sink = recordingSink();
  const query = createFakeQuery(fq);
  const log = memoryLogger();
  const engine = makeEngine({ query, clock, sink, log, spawner: (() => () => { throw new Error('no spawn in fake-query tests'); }) as never,
    freeMemBytes: () => o.free ?? 8 * 1024 ** 3, holder: o.holder ?? (() => null) });
  return { clock, sink, query, engine, log };
}

/** Polls (macrotask turns) until pred() holds; fails after `turns`. */
export async function until(pred: () => boolean, what = 'condition', turns = 2_000): Promise<void> {
  for (let i = 0; i < turns; i++) { if (pred()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`timed out waiting for ${what}`);
}
export const tick = (n = 5): Promise<void> => (async () => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); })();
