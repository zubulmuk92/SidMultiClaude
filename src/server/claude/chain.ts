// src/server/claude/chain.ts — parentUuid chain, compaction relink, latest leaf, sidechain filter, siblings.
// Mirrors the SDK rebuild (`bu()` + `yCe()` of @anthropic-ai/claude-agent-sdk 0.3.293) on a WINDOW of the
// file (the reader is tail-first, so "not loaded yet" is a normal state):
// - chain entries: user, assistant, attachment, system (+ legacy progress: walked through, never returned); sidechains out;
// - compaction relink: preservedMessages (all or nothing) else preservedSegment. Each boundary remembers what it relinked,
//   so the walk BEHIND it (through `logicalParentUuid`) skips those entries (already shown after the summary) and follows
//   their former parents: older history stays reachable exactly once, behind the « conversation compactée » row;
// - latest leaf: the last childless entry in file order (progress / team / fork_briefing excluded) whose ancestors reach a
//   user/assistant entry; undecided (`null`) while that ancestry leaves the loaded window;
// - siblings: parallel tool calls leave tool results (and blocks of the same message.id) on side branches; they are put
//   back after the last chain entry of their message, as the SDK does.
import type { RawEntry } from '../contracts.ts';

type E = Record<string, unknown>;
const WALK_TYPES = new Set(['user', 'assistant', 'attachment', 'system', 'progress']);

export function isChainEntry(e: E): boolean {
  return typeof e['uuid'] === 'string' && WALK_TYPES.has(String(e['type'])) && e['isSidechain'] !== true;
}
const isMessage = (e: E): boolean => e['type'] === 'user' || e['type'] === 'assistant';
const isBoundary = (e: E): boolean => e['type'] === 'system' && e['subtype'] === 'compact_boundary';
const isHidden = (e: E): boolean => e['type'] === 'progress';
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const rec = (v: unknown): E | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as E) : null);
const uuidOf = (r: RawEntry): string => r.e['uuid'] as string;
/** SDK leaf filter: progress, agent-team and fork_briefing entries are neither leaves nor parents of leaves. */
const leafable = (e: E): boolean => e['type'] !== 'progress' && !e['teamName']
  && !(e['type'] === 'attachment' && rec(e['attachment'])?.['type'] === 'fork_briefing');

export type ChainIndex = {
  byUuid: Map<string, RawEntry>;
  parent: Map<string, string | null>;               // after compaction relink
  ordered: RawEntry[];                               // chain entries in file order
  /** boundary uuid → the preserved entries it relinked after its summary (skipped when walking behind it) */
  skip: Map<string, Set<string>>;
  /** boundary uuid → the parents its relink replaced (followed when walking behind it) */
  undo: Map<string, Map<string, string | null>>;
  /** boundaries (and their summaries) whose relink waits for preserved entries that are not loaded yet */
  blocked: Set<string>;
  /** those preserved entries (they precede their boundary: they come with older lines) */
  waiting: Set<string>;
};

export function indexChain(entries: readonly RawEntry[]): ChainIndex {
  const ordered = entries.filter((r) => isChainEntry(r.e)).sort((a, b) => a.off - b.off);
  const byUuid = new Map<string, RawEntry>();
  const parent = new Map<string, string | null>();
  for (const r of ordered) { byUuid.set(uuidOf(r), r); parent.set(uuidOf(r), str(r.e['parentUuid'])); }
  const ix: ChainIndex = { byUuid, parent, ordered, skip: new Map(), undo: new Map(), blocked: new Set(), waiting: new Set() };
  for (const r of ordered) if (isBoundary(r.e)) relink(ix, r);
  return ix;
}

export const isCompactBoundary = isBoundary;
/**
 * Adds OLDER lines (read further back, no compact boundary among them) to an index without rebuilding it. Parents of
 * loaded entries cannot change: children always follow their parents on disk, and relinks only come from boundaries.
 */
export function extendIndex(ix: ChainIndex, older: readonly RawEntry[]): void {
  const add = older.filter((r) => isChainEntry(r.e) && !ix.byUuid.has(uuidOf(r))).sort((a, b) => a.off - b.off);
  for (const r of add) { ix.byUuid.set(uuidOf(r), r); ix.parent.set(uuidOf(r), str(r.e['parentUuid'])); }
  if (add.length) ix.ordered = add.concat(ix.ordered);
}

/** The summary (anchor) and the preserved entries a compact_boundary relinks; no members when it relinks nothing. */
export function relinkRefs(e: E): { anchor: string | null; members: string[] } {
  const cm = isBoundary(e) ? rec(e['compactMetadata']) : null;
  const pm = rec(cm?.['preservedMessages']);
  if (pm && Array.isArray(pm['uuids'])) {
    return { anchor: str(pm['anchorUuid']), members: (pm['uuids'] as unknown[]).filter((u): u is string => typeof u === 'string') };
  }
  const ps = rec(cm?.['preservedSegment']);
  const ends = [str(ps?.['headUuid']), str(ps?.['tailUuid'])].filter((u): u is string => !!u);
  return { anchor: str(ps?.['anchorUuid']), members: ends.length === 2 ? ends : [] };
}

/** Applies one compact_boundary's relink (SDK `bu`), in file order, recording what it changed. */
function relink(ix: ChainIndex, b: RawEntry): void {
  const cm = rec(b.e['compactMetadata']);
  if (!cm) return;
  const { byUuid, parent } = ix;
  const id = uuidOf(b);
  const undo = new Map<string, string | null>();
  const move = (u: string, p: string): void => { if (!undo.has(u)) undo.set(u, parent.get(u) ?? null); parent.set(u, p); };
  const wait = (anchor: string, members: string[]): void => {
    ix.blocked.add(id); ix.blocked.add(anchor);
    for (const u of members) if (!byUuid.has(u)) ix.waiting.add(u);
  };
  const pm = rec(cm['preservedMessages']);
  if (pm && Array.isArray(pm['uuids'])) {                       // SDK: preservedMessages wins, all or nothing
    const uuids = (pm['uuids'] as unknown[]).filter((u): u is string => typeof u === 'string');
    const anchor = str(pm['anchorUuid']);
    if (!uuids.length || !anchor) return;
    if (uuids.some((u) => !byUuid.has(u))) { wait(anchor, uuids); return; }
    if (!byUuid.has(anchor)) return;
    let prev = anchor;
    for (const u of uuids) { move(u, prev); prev = u; }
    for (const [u, p] of [...parent]) if (p === anchor && u !== uuids[0]) move(u, prev);
    ix.skip.set(id, withAttached(ix, new Set(uuids)));
    ix.undo.set(id, undo);
    return;
  }
  const ps = rec(cm['preservedSegment']);
  const head = str(ps?.['headUuid']);
  const anchor = str(ps?.['anchorUuid']);
  const tail = str(ps?.['tailUuid']);
  if (!head || !anchor || !tail) return;
  if (!byUuid.has(head) || !byUuid.has(tail)) { wait(anchor, [head, tail]); return; }
  if (!byUuid.has(anchor)) return;
  const seg = new Set<string>();                                 // tail … head, as linked before this relink
  for (let cur: string | null = tail, n = ix.ordered.length; cur && n > 0 && !seg.has(cur); n--) {
    seg.add(cur);
    if (cur === head) break;
    cur = parent.get(cur) ?? null;
  }
  move(head, anchor);
  for (const [u, p] of [...parent]) if (p === anchor && u !== head) move(u, tail);
  if (seg.has(head)) ix.skip.set(id, withAttached(ix, seg));
  ix.undo.set(id, undo);
}
/** Adds the siblings shown with the preserved entries after the summary (tool results, same message.id), so the walk
 * behind the boundary does not show them a second time. */
function withAttached(ix: ChainIndex, set: Set<string>): Set<string> {
  const members = [...set].map((u) => ix.byUuid.get(u)).filter((r): r is RawEntry => !!r).sort((a, b) => a.off - b.off);
  for (const ins of siblingPlan(ix, members).values()) for (const x of ins) set.add(uuidOf(x));
  return set;
}

/**
 * Latest leaf (SDK): the last childless entry in file order whose ancestors reach a user/assistant entry. `null` while the
 * newest candidate's ancestry leaves the loaded window (undecided: read further back, unless `complete`); undefined if none.
 */
export function latestLeaf(ix: ChainIndex, complete = false): string | null | undefined {
  const hasChild = new Set<string>();
  for (const r of ix.ordered) if (leafable(r.e)) { const p = ix.parent.get(uuidOf(r)); if (p) hasChild.add(p); }
  const dead = new Set<string>();                                // ancestors of rejected candidates: no message above them
  for (let i = ix.ordered.length - 1; i >= 0; i--) {
    const r = ix.ordered[i]!;
    const u = uuidOf(r);
    if (!leafable(r.e) || hasChild.has(u)) continue;
    const seen: string[] = [];
    for (let cur: string | null = u; cur && !dead.has(cur) && !seen.includes(cur);) {
      const ent = ix.byUuid.get(cur);
      if (!ent) { if (!complete) return null; break; }
      if (isMessage(ent.e)) return u;
      seen.push(cur);
      cur = ix.parent.get(cur) ?? null;
    }
    for (const s of seen) dead.add(s);
  }
  if (!complete) return undefined;
  // SDK fallback for odd files: the newest user/assistant entry (non-meta, non-team preferred)
  let any: string | undefined;
  for (let i = ix.ordered.length - 1; i >= 0; i--) {
    const e = ix.ordered[i]!.e;
    if (!isMessage(e)) continue;
    if (!e['isMeta'] && !e['teamName']) return e['uuid'] as string;
    any ??= e['uuid'] as string;
  }
  return any;
}

export type Walk = {
  chain: RawEntry[];            // oldest → newest
  next: string | null;          // uuid needed above chain[0] that is not loaded (null = the real root was reached)
  bs: (string | null)[];        // per chain entry: the boundary behind which it was reached (its skip set applies above it)
  nextB: string | null;         // the same, for `next`
  blocked: boolean;             // the walk met a boundary whose relink waits for entries not loaded yet
};
/**
 * Walks up from `start` (inclusive) to the root. A compact_boundary (a new root) is crossed through `logicalParentUuid`;
 * behind it, the entries it relinked after its summary are walked through unseen, by their former parents. `startB` is
 * the boundary behind which `start` lies (from a cursor), so a page that starts behind a boundary skips the same entries.
 */
export function walkFrom(ix: ChainIndex, start: string, startB: string | null = null): Walk {
  const w = startWalk(ix, start, startB);
  advance(ix, w);
  return walkOf(w);
}

/** A resumable walk (newest → oldest): `advance` continues from `cur` once more (older) lines are loaded. */
export type Walker = {
  out: RawEntry[];              // walk order: newest first
  bs: (string | null)[];        // per `out` entry, see Walk.bs
  prompts: number[];            // indices into `out` of human prompts
  pushed: Set<string>;
  passed: Set<string>;
  b: string | null;             // the boundary behind which the walk now is
  cur: string | null;           // next uuid to visit (null: the root was reached)
  blocked: boolean;
};
export function startWalk(ix: ChainIndex, start: string, startB: string | null = null): Walker {
  return { out: [], bs: [], prompts: [], pushed: new Set(), passed: new Set(), b: startB && ix.byUuid.has(startB) ? startB : null, cur: start, blocked: false };
}
/** Walks on until an entry is not loaded (`cur` keeps its uuid) or the root is reached (`cur` = null). */
export function advance(ix: ChainIndex, w: Walker): void {
  let skip = w.b ? ix.skip.get(w.b) ?? null : null;
  let undo = w.b ? ix.undo.get(w.b) ?? null : null;
  for (let guard = ix.ordered.length * 2 + 4; w.cur && guard > 0; guard--) {
    const cur: string = w.cur;
    const ent = ix.byUuid.get(cur);
    if (!ent) return;
    if (ix.blocked.has(cur)) w.blocked = true;
    let p: string | null;
    if (skip?.has(cur)) {                                        // shown after the summary already
      if (w.passed.has(cur)) { w.cur = null; return; }
      w.passed.add(cur);
      p = undo?.has(cur) ? undo.get(cur) ?? null : ix.parent.get(cur) ?? null;
    } else {
      if (w.pushed.has(cur)) { w.cur = null; return; }          // a cycle in a corrupt file
      w.pushed.add(cur);
      if (!isHidden(ent.e)) {
        if (isHumanPrompt(ent.e)) w.prompts.push(w.out.length);
        w.out.push(ent);
        w.bs.push(w.b);
      }
      p = ix.parent.get(cur) ?? null;
    }
    if (!p && isBoundary(ent.e)) {
      const lp = str(ent.e['logicalParentUuid']);
      if (lp) { w.b = cur; skip = ix.skip.get(cur) ?? null; undo = ix.undo.get(cur) ?? null; p = lp; }
    }
    w.cur = p;
  }
  w.cur = null;                                                  // guard exhausted: treat as the root
}
/** The walker as a Walk (chain oldest → newest). */
export function walkOf(w: Walker): Walk {
  return { chain: [...w.out].reverse(), next: w.cur, bs: [...w.bs].reverse(), nextB: w.cur ? w.b : null, blocked: w.blocked };
}

/** The whole latest branch of a fully loaded transcript (tests, small files). */
export function latestChain(entries: readonly RawEntry[]): RawEntry[] {
  const ix = indexChain(entries);
  const leaf = latestLeaf(ix, true);
  return leaf ? withSiblings(ix, walkFrom(ix, leaf).chain) : [];
}

/** A human prompt (a turn start): user entry, not meta, not a compact summary, not a tool result. */
export function isHumanPrompt(e: Record<string, unknown>): boolean {
  if (e['type'] !== 'user' || e['isMeta'] === true || e['isCompactSummary'] === true) return false;
  const c = (e['message'] as Record<string, unknown> | undefined)?.['content'];
  if (typeof c === 'string') return true;
  return Array.isArray(c) && !c.some((b) => b && typeof b === 'object' && (b as Record<string, unknown>)['type'] === 'tool_result');
}

// ------------------------------------------------------------------ siblings (SDK `yCe`)
const msgId = (e: E): string | null => (e['type'] === 'assistant' ? str(rec(e['message'])?.['id']) : null);
function blockIds(e: E, type: string, key: string): string[] {
  const c = rec(e['message'])?.['content'];
  if (!Array.isArray(c)) return [];
  const out: string[] = [];
  for (const b of c as unknown[]) { const o = rec(b); if (o && o['type'] === type && typeof o[key] === 'string') out.push(o[key] as string); }
  return out;
}
const isToolResult = (e: E): boolean => e['type'] === 'user' && !!str(e['parentUuid']) && blockIds(e, 'tool_result', 'tool_use_id').length > 0;
const sameSide = (a: E, b: E): boolean => (a['isSidechain'] ?? false) === (b['isSidechain'] ?? false) && a['agentId'] === b['agentId'];
const byTimestamp = (a: RawEntry, b: RawEntry): number => String(a.e['timestamp'] ?? '').localeCompare(String(b.e['timestamp'] ?? ''));

/**
 * Puts back what parallel tool calls leave on side branches (SDK `yCe`): the other entries of each chain message.id and
 * the tool results answering its tool_use blocks, inserted after the last chain entry of that message.
 */
export function withSiblings(ix: ChainIndex, chain: readonly RawEntry[]): RawEntry[] {
  const after = siblingPlan(ix, chain);
  if (!after.size) return [...chain];
  const out: RawEntry[] = [];
  for (const r of chain) { out.push(r); const ins = after.get(uuidOf(r)); if (ins) out.push(...ins); }
  return out;
}
/** chain entry uuid → the siblings to insert right after it. */
function siblingPlan(ix: ChainIndex, chain: readonly RawEntry[]): Map<string, RawEntry[]> {
  const after = new Map<string, RawEntry[]>();
  const assistants = chain.filter((r) => r.e['type'] === 'assistant');
  if (!assistants.length) return after;
  const inChain = new Set<string>();
  let start = Number.POSITIVE_INFINITY;
  for (const r of chain) { inChain.add(uuidOf(r)); if (r.off < start) start = r.off; }
  // Only entries OFF the chain can be put back, and a sibling is written after its message (so after the page's first
  // entry): with none, nothing to do — the common case, kept O(n) even for a 50,000-entry page.
  const off = ix.ordered.filter((r) => r.off >= start && !inChain.has(uuidOf(r)));
  if (!off.length) return after;
  const lastOf = new Map<string, RawEntry>();                    // message.id → its last chain entry
  for (const r of assistants) { const id = msgId(r.e); if (id) lastOf.set(id, r); }
  const byMsg = new Map<string, RawEntry[]>();
  const owner = new Map<string, RawEntry | null>();              // tool_use id → its entry (null: ambiguous)
  const results: RawEntry[] = [];
  for (const r of [...assistants, ...off].sort((a, b) => a.off - b.off)) {
    const id = msgId(r.e);
    if (id) {
      const g = byMsg.get(id);
      if (g) g.push(r); else byMsg.set(id, [r]);
      for (const t of blockIds(r.e, 'tool_use', 'id')) { const o = owner.get(t); owner.set(t, o === undefined || (o !== null && msgId(o.e) === id) ? r : null); }
    } else if (!inChain.has(uuidOf(r)) && isToolResult(r.e)) results.push(r);
  }
  const kids = new Map<string, RawEntry[]>();
  const addKid = (p: string, r: RawEntry): void => {
    const l = kids.get(p);
    if (!l) kids.set(p, [r]); else if (!l.includes(r)) l.push(r);
  };
  for (const r of results) {
    addKid(r.e['parentUuid'] as string, r);
    const src = str(r.e['sourceToolAssistantUUID']);
    const s = src && src !== r.e['parentUuid'] ? ix.byUuid.get(src) : undefined;
    if (s && sameSide(r.e, s.e)) addKid(uuidOf(s), r);
    for (const t of blockIds(r.e, 'tool_result', 'tool_use_id')) { const w = owner.get(t); if (w && sameSide(r.e, w.e)) addKid(uuidOf(w), r); }
  }
  const answered = new Set<string>();
  for (const r of chain) for (const t of blockIds(r.e, 'tool_result', 'tool_use_id')) answered.add(t);
  const done = new Set<string>();
  for (const r of assistants) {
    const id = msgId(r.e);
    if (!id || done.has(id)) continue;
    done.add(id);
    const group = byMsg.get(id) ?? [r];
    // fast path (almost every message): all its entries and all their tool results are on the chain already
    if (group.every((g) => inChain.has(uuidOf(g)) && (kids.get(uuidOf(g)) ?? []).every((k) => inChain.has(uuidOf(k))))) continue;
    const own = new Set(group.map(uuidOf));
    const missing = group.filter((x) => !inChain.has(uuidOf(x)));
    const direct: RawEntry[] = [];
    const other: RawEntry[] = [];
    const seen = new Set<string>();
    for (const g of group) {
      for (const k of kids.get(uuidOf(g)) ?? []) {
        if (inChain.has(uuidOf(k)) || seen.has(uuidOf(k))) continue;
        seen.add(uuidOf(k));
        (own.has(k.e['parentUuid'] as string) ? direct : other).push(k);
      }
    }
    if (other.length) {                                          // attached elsewhere: only if it answers this message
      const extra = new Set<string>();                           // answered here, on top of `answered` (never copied)
      for (const k of direct) for (const t of blockIds(k.e, 'tool_result', 'tool_use_id')) extra.add(t);
      other.sort((a, b) => a.off - b.off);
      for (const k of other) {
        const ts = blockIds(k.e, 'tool_result', 'tool_use_id');
        if (!ts.some((t) => { const w = owner.get(t); return !answered.has(t) && !extra.has(t) && !!w && own.has(uuidOf(w)); })) continue;
        for (const t of ts) extra.add(t);
        direct.push(k);
      }
    }
    if (!missing.length && !direct.length) continue;
    missing.sort(byTimestamp);
    direct.sort(byTimestamp);
    const ins = [...missing, ...direct];
    for (const x of ins) inChain.add(uuidOf(x));
    after.set(uuidOf(lastOf.get(id)!), ins);
  }
  return after;
}
