// test/unit/model/replay.ts — replays recorded SDK frames through a live reducer, simulating the engine's
// `delivered` calls (lifecycle `started` → userStarted, folded when another delivery is still running).
import type * as P from '../../../src/shared/protocol.ts';
import type { FrameSignals } from '../../../src/server/contracts.ts';
import { createLiveReducerX } from '../../../src/server/model/live-reducer.ts';
import type { LiveReducerX, LiveSeed } from '../../../src/server/model/live-reducer.ts';
import type { FrameRec, InputRec } from '../../helpers/scenario.ts';

export const emptyMeta = (): P.ChatMetaView => ({ title: '', cwd: '', mode: 'default' });

export type Replay = { r: LiveReducerX; turns: P.UiTurn[]; events: P.ChatEvent[]; signals: FrameSignals[]; modeTrail: string[]; titles: string[] };

export function replay(frames: readonly FrameRec[], inputs: readonly InputRec[], seed: Partial<LiveSeed> = {}): Replay {
  const r = createLiveReducerX({ chatId: seed.chatId ?? 'acc:00000000-0000-0000-0000-000000000000', meta: seed.meta ?? emptyMeta(), metrics: seed.metrics ?? {},
    ...(seed.baseline ? { baseline: seed.baseline } : {}), ...(seed.resumed ? { resumed: true } : {}) });
  const byUuid = new Map(inputs.map((i) => [i.uuid, i]));
  const running = new Set<string>();
  const turns: P.UiTurn[] = [];
  const events: P.ChatEvent[] = [];
  const signals: FrameSignals[] = [];
  const modeTrail: string[] = [];
  const titles: string[] = [];
  // `before` = the live turn before the step: a turn.start emitted by step() (a CLI-initiated system turn) replaces it
  const collect = (ev: P.ChatEvent[], before: P.UiTurn | null): void => {
    for (const e of ev) {
      events.push(e);
      if (e.k === 'turn.start' && before && before.id !== e.turn.id) turns.push(before);
      if (e.k === 'meta' && e.meta.mode && modeTrail[modeTrail.length - 1] !== e.meta.mode) modeTrail.push(e.meta.mode);
      if (e.k === 'meta' && e.meta.title) titles.push(e.meta.title);
    }
  };
  for (const { t, m } of frames) {
    const f = m as Record<string, unknown>;
    if (f['type'] === 'command_lifecycle') {
      const u = String(f['command_uuid']);
      const st = String(f['state']);
      if (st === 'started') {
        const inp = byUuid.get(u);
        const folded = running.size > 0;
        running.add(u);
        // a turn.start pushes the previous live turn: capture it before userStarted replaces it
        const before = r.liveTurn();
        const ev = r.userStarted({ uuid: u, text: inp?.text ?? '', images: inp?.images ?? 0, folded, at: t });
        if (!folded && before) turns.push(before);
        for (const e of ev) { events.push(e); }
      } else if (st === 'completed' || st === 'cancelled') running.delete(u);
    }
    const before = r.liveTurn();
    const out = r.step(m, t);
    signals.push(out.signals);
    collect(out.events, before);
  }
  const last = r.liveTurn();
  if (last) turns.push(last);
  return { r, turns: dedupe(turns), events, signals, modeTrail, titles };
}
function dedupe(turns: P.UiTurn[]): P.UiTurn[] {
  const seen = new Map<string, number>();
  const out: P.UiTurn[] = [];
  for (const t of turns) { const i = seen.get(t.id); if (i === undefined) { seen.set(t.id, out.length); out.push(t); } else out[i] = t; }
  return out;
}

/** What "live = reload" compares: ids, kinds, texts, statuses and tool summaries. */
export function shape(turns: readonly P.UiTurn[]): unknown[] {
  return turns.map((t) => ({
    id: t.id,
    user: t.user ? t.user.text : null,
    blocks: t.blocks.map((b) => {
      if (b.k === 'user') return { id: b.id, k: b.k, text: b.msg.text };
      if (b.k === 'text') return { id: b.id, k: b.k, md: b.md, model: b.model ?? null };   // + the per-block model badge
      if (b.k === 'thinking') return { id: b.id, k: b.k };
      if (b.k === 'tool') return { id: b.id, k: b.k, name: b.name, status: b.status, summary: b.input.summary, result: b.result?.summary ?? null, model: b.model ?? null };
      return { id: b.id, k: b.k, kind: b.row.kind, text: b.row.text ?? null };
    }),
  }));
}
