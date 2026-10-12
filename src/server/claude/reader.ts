// src/server/claude/reader.ts — TranscriptReader: tail-first pages, lines, search (chunked), instructions.
// Never parses a whole large file: pages are read BACKWARDS from the end (256 KiB steps up to 2 MiB, then 1 MiB steps with
// a setImmediate yield between them, which is how a 12 MB last line is crossed), only the lines of the window are parsed,
// and the latest branch is rebuilt by chain.ts (relinks, siblings). A truncated (in-flight) last line is skipped. The index
// and the walk grow with each step (rebuilt only when a compact boundary arrives), so a long walk — a 100 MB session with
// few prompts — costs what it reads, not steps × entries.
// Cursor = base64url JSON {off, leaf, b?}: the next page reads backwards from `off` and walks up from `leaf` (inclusive);
// `b` is the compact boundary behind which `leaf` lies (its relinked entries are skipped there). `off` always covers the
// leaf, the entries the walk above it already met and that boundary, so a relink that jumps forward is never lost.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { ChainPage, Logger, RawEntry, TranscriptReader } from '../contracts.ts';
import { decodeCursor, encodeCursor, isTxCursor } from '../util/ids.ts';
import { advance, extendIndex, indexChain, isCompactBoundary, latestLeaf, relinkRefs, startWalk, walkOf, withSiblings } from './chain.ts';
import type { ChainIndex, Walk, Walker } from './chain.ts';
import { TAIL_STEP_BYTES, TAIL_MAX_BYTES, SEARCH_CHUNK_BYTES, SEARCH_MAX_HITS, MAX_LOOP_BLOCK_MS } from '../../shared/limits.ts';

const MiB = 1024 * 1024;
const NL = 0x0a;
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

type Cursor = { off: number; leaf: string; b?: string };

/** Reads complete lines backwards from `end`. A line is [off, off+len) without its '\n'. */
export class BackReader {
  pos: number;
  private parts: Buffer[] = [];          // bytes of the line that spans the read position (in file order)
  private readonly fh: fs.promises.FileHandle;
  private readonly end: number;
  constructor(fh: fs.promises.FileHandle, end: number) { this.fh = fh; this.end = end; this.pos = end; }
  get done(): boolean { return this.pos <= 0 && this.parts.length === 0; }
  /** Reads up to `bytes` more; returns the newly completed lines, newest first. */
  async step(bytes: number): Promise<RawEntry[]> {
    const out: RawEntry[] = [];
    if (this.pos <= 0) { this.flushFirst(out); return out; }
    const start = Math.max(0, this.pos - bytes);
    const chunk = Buffer.allocUnsafe(this.pos - start);
    let got = 0;
    while (got < chunk.length) {
      const r = await this.fh.read(chunk, got, chunk.length - got, start + got);
      if (r.bytesRead === 0) break;
      got += r.bytesRead;
    }
    let segEnd = got;                                          // exclusive, in chunk coordinates
    let nl = chunk.lastIndexOf(NL, segEnd - 1);
    while (nl >= 0) {
      const lineOff = start + nl + 1;
      this.emit(out, lineOff, chunk.subarray(nl + 1, segEnd));
      segEnd = nl;
      nl = segEnd > 0 ? chunk.lastIndexOf(NL, segEnd - 1) : -1;
    }
    this.parts.unshift(chunk.subarray(0, segEnd));
    this.pos = start;
    if (start === 0) this.flushFirst(out);
    return out;
  }
  private flushFirst(out: RawEntry[]): void {
    if (!this.parts.length) return;
    const b = Buffer.concat(this.parts);
    this.parts = [];
    this.parse(out, 0, b);
  }
  private emit(out: RawEntry[], off: number, seg: Buffer): void {
    const b = this.parts.length ? Buffer.concat([seg, ...this.parts]) : seg;
    this.parts = [];
    this.parse(out, off, b);
  }
  private parse(out: RawEntry[], off: number, b: Buffer): void {
    let len = b.length;
    if (len && b[len - 1] === 0x0d) len--;                     // CRLF tolerance
    if (len === 0 || off + len > this.end) return;
    try {
      const e = JSON.parse(b.toString('utf8', 0, len)) as unknown;
      if (e && typeof e === 'object' && !Array.isArray(e)) out.push({ off, len, e: e as Record<string, unknown> });
    } catch { /* truncated or corrupt line: skipped */ }
  }
}

/** The cursor that continues above `page` (see the header): `leaf` (+ its boundary) and an `off` that covers what it needs. */
function cursorFor(ix: ChainIndex, w: Walk, startIdx: number, pageStart: RawEntry): Cursor {
  let c: Cursor;
  let leafOff: number | null = null;
  if (startIdx > 0) {
    const leaf = w.chain[startIdx - 1]!;
    let off = pageStart.off;
    for (let i = 0; i < startIdx; i++) { const r = w.chain[i]!; off = Math.max(off, r.off + r.len); }
    c = { off, leaf: String(leaf.e['uuid']), ...(w.bs[startIdx - 1] ? { b: w.bs[startIdx - 1]! } : {}) };
    leafOff = leaf.off;
  } else c = { off: pageStart.off, leaf: w.next!, ...(w.nextB ? { b: w.nextB } : {}) };
  if (c.b) {
    const skip = ix.skip.get(c.b);
    const offs = skip ? [...skip].map((u) => ix.byUuid.get(u)?.off) : [];
    const allLoaded = offs.every((o) => o !== undefined);
    const minOff = Math.min(...offs.map((o) => o ?? -1));
    // still needed while an entry it relinked can be met above the leaf (parents precede their children on disk)
    const needed = !!skip && skip.size > 0 && (leafOff === null ? !allLoaded : leafOff > minOff);
    const bound = ix.byUuid.get(c.b);
    if (needed && bound) c.off = Math.max(c.off, bound.off + bound.len);
    else delete c.b;
  }
  // A boundary past `off` whose preserved entries the walk above the leaf may still meet (not loaded, or before the leaf)
  // stays in the next window with its summary: its relink jumps FORWARD (preserved head → summary).
  const lim = leafOff ?? Number.NEGATIVE_INFINITY;
  for (const r of ix.ordered) {
    if (r.off + r.len <= c.off) continue;
    const { anchor, members } = relinkRefs(r.e);
    if (!members.some((u) => { const m = ix.byUuid.get(u); return !m || m.off < lim; })) continue;
    c.off = Math.max(c.off, r.off + r.len);
    const a = anchor ? ix.byUuid.get(anchor) : undefined;
    if (a) c.off = Math.max(c.off, a.off + a.len);
  }
  return c;
}

/** The page, once `turns` prompts are walked and what lies above its first entry is known; null = read further back. */
function pageOf(ix: ChainIndex, w: Walker, turns: number, complete: boolean): ChainPage | null {
  if (w.prompts.length < turns) return complete || w.cur === null ? { chain: walkOf(w).chain, cursor: null, hasMore: false } : null;
  const p = w.prompts[turns - 1]!;                               // walk order (newest first): the page's first entry
  if (!complete) {
    // Decide only once what lies above the first entry is known: that entry itself, and for a compact summary its
    // boundary, whose relink may re-parent the page's first prompt (the summary's children move to the preserved tail).
    if (p === w.out.length - 1 && w.cur !== null) return null;
    const above = w.out[p + 1]?.e;
    if (above?.['isCompactSummary'] === true && !ix.byUuid.has(String(above['parentUuid']))) return null;
  }
  const walk = walkOf(w);
  const startIdx = walk.chain.length - 1 - p;
  const chain = walk.chain.slice(startIdx);
  const more = startIdx > 0 || (walk.next !== null && !complete);
  return { chain, cursor: more ? encodeCursor(cursorFor(ix, walk, startIdx, chain[0]!)) : null, hasMore: more };
}

async function readPage(file: string, end: number | null, start: { leaf: string; b: string | null } | null, turns: number): Promise<ChainPage> {
  const empty: ChainPage = { chain: [], cursor: null, hasMore: false };
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(file, 'r'); } catch { return empty; }
  try {
    const size = end ?? (await fh.stat()).size;
    const br = new BackReader(fh, size);
    const entries: RawEntry[] = [];
    let read = 0;
    let ix: ChainIndex | null = null;
    let w: Walker | null = null;
    let page: ChainPage | null = null;
    while (!br.done && !page) {
      const step = read < TAIL_MAX_BYTES ? TAIL_STEP_BYTES : MiB;
      if (read >= TAIL_MAX_BYTES) await yieldLoop();
      const before = br.pos;
      const fresh = await br.step(step);
      read += before - br.pos;
      if (!fresh.length && !br.done) continue;
      for (const r of fresh) entries.push(r);
      const complete = br.done;
      // Relinks only come from compact boundaries: without a new one (or one waiting for its preserved entries), the
      // index and the walk just extend, so each step costs what it reads (no rebuild, no re-walk from the leaf).
      const waiting = ix?.waiting;
      if (!ix || fresh.some((r) => isCompactBoundary(r.e) || (!!waiting?.size && waiting.has(r.e['uuid'] as string)))) {
        ix = indexChain(entries);
        w = null;
      } else extendIndex(ix, fresh);
      if (!w) {
        const from = start ? (ix.byUuid.has(start.leaf) ? start.leaf : undefined) : latestLeaf(ix, complete);
        if (!from) continue;                                     // null: the leaf is undecided until older lines load
        w = startWalk(ix, from, start?.b ?? null);
      }
      if (!w.blocked || complete) advance(ix, w);
      if (w.blocked && !complete) continue;                      // a relink waits for its preserved entries: rebuilt then
      page = pageOf(ix, w, turns, complete);
    }
    if (!page || !ix) return empty;
    if (page.chain.length > 5000) await yieldLoop();             // a huge page (few prompts): split the final work
    return { ...page, chain: withSiblings(ix, page.chain) };
  } finally { await fh.close().catch(() => undefined); }
}

// ------------------------------------------------------------------ search
const VALUE_RE = /"(?:text|content|command|thinking|prompt|description|plan)":"((?:[^"\\]|\\.)*)"/g;
const unescape = (s: string): string => { try { return JSON.parse(`"${s}"`) as string; } catch { return s; } };
function snippetAround(text: string, at: number, qlen: number): string {
  const a = Math.max(0, at - 60);
  const b = Math.min(text.length, at + qlen + 80);
  return ((a > 0 ? '…' : '') + text.slice(a, b) + (b < text.length ? '…' : '')).replace(/\s+/g, ' ');
}
/** The needle as written inside JSON strings, matched case-insensitively without lower-casing (copying) the text. */
function rawNeedle(needle: string): RegExp {
  const esc = JSON.stringify(needle).slice(1, -1);
  return new RegExp(esc.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'), 'giu');
}
/**
 * Visible-text match in one user/assistant line: string values of text/content/command/… keys only (never JSON keys).
 * Lines that cannot contain the needle are rejected first by one native regex scan.
 */
function matchLine(line: string, needle: string, raw: RegExp): string | null {
  if (!/"type":"(?:user|assistant)"/.test(line) || line.includes('"isMeta":true') || line.includes('"isSidechain":true')) return null;
  raw.lastIndex = 0;
  if (!raw.test(line)) return null;
  VALUE_RE.lastIndex = 0;
  for (let m = VALUE_RE.exec(line); m; m = VALUE_RE.exec(line)) {
    const raw = m[1] ?? '';
    if (raw.length < needle.length) continue;
    const v = unescape(raw);
    const i = v.toLowerCase().indexOf(needle);
    if (i >= 0) return snippetAround(v, i, needle.length);
  }
  return null;
}
// Lines longer than this are searched piecewise (raw JSON text, base64 runs ignored), so no single line's work can hold
// the event loop for long: measured ≈ 1.2 ms for a 512 KiB line on this machine's P-cores (about twice on E-cores).
const GIANT_LINE = 512 * 1024;
const SLICE_MS = MAX_LOOP_BLOCK_MS / 3;                         // yield well before the 8 ms budget
const B64_CTX = 24;
const isBase64Run = (s: string): boolean => s.length > 0 && /^[A-Za-z0-9+/=]+$/.test(s);
/** True when [i, i+len) lies inside a JSON key: the next real quote closes a short, escape-free string followed by ':'. */
function inKey(text: string, i: number, len: number): boolean {
  const q2 = text.indexOf('"', i + len);
  if (q2 < 0 || text[q2 + 1] !== ':' || text[q2 - 1] === '\\') return false;
  const q1 = text.lastIndexOf('"', i - 1);
  return q1 >= 0 && q2 - q1 <= 64 && !/[\s\\]/.test(text.slice(q1 + 1, q2));
}
/** First needle occurrence in raw JSON text outside base64 runs (image data) and keys: [index, length] or null. */
function rawFind(text: string, raw: RegExp): [number, number] | null {
  raw.lastIndex = 0;
  for (let m = raw.exec(text); m; m = raw.exec(text)) {
    const i = m.index;
    const len = m[0].length;
    if (!isBase64Run(text.slice(Math.max(0, i - B64_CTX), i + len + B64_CTX)) && !inKey(text, i, len)) return [i, len];
    raw.lastIndex = i + 1;
  }
  return null;
}
const cleanRaw = (s: string): string => s.replace(/\\[nrt]/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
type Giant = { snippet: string | null; typed: boolean; skip: boolean; tail: string; dec: StringDecoder };

async function searchFile(file: string, q: string, limit: number, signal: AbortSignal): Promise<{ off: number; len: number; snippet: string }[]> {
  const needle = q.trim().toLowerCase();
  const max = Math.max(0, Math.min(limit, SEARCH_MAX_HITS));
  const hits: { off: number; len: number; snippet: string }[] = [];
  if (!needle || max === 0) return hits;
  const raw = rawNeedle(needle);                                 // as written inside JSON strings, case-insensitive
  const carry = Math.max(B64_CTX * 2, JSON.stringify(needle).length * 4);
  const abort = (): never => { throw signal.reason instanceof Error ? signal.reason : new DOMException('Recherche annulée', 'AbortError'); };
  if (signal.aborted) abort();
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(SEARCH_CHUNK_BYTES);
    let pos = 0;
    let lineStart = 0;
    let parts: Buffer[] = [];
    let partBytes = 0;
    let giant: Giant | null = null;                              // a long line: searched piecewise, decided at its end
    let t0 = performance.now();
    const pace = async (): Promise<void> => {
      if (performance.now() - t0 < SLICE_MS) return;
      await yieldLoop();
      if (signal.aborted) abort();
      t0 = performance.now();
    };
    const feed = (b: Buffer, end = false): void => {
      const g: Giant = (giant ??= { snippet: null, typed: false, skip: false, tail: '', dec: new StringDecoder('utf8') });
      const text = g.tail + (end ? g.dec.end(b) : g.dec.write(b));
      if (!g.snippet) {
        const f = rawFind(text, raw);
        if (f) {
          const a = Math.max(0, f[0] - 60);
          g.snippet = ((a > 0 ? '…' : '') + cleanRaw(text.slice(a, f[0] + f[1] + 80)) + '…').replace(/\s+/g, ' ');
        }
      }
      g.typed ||= /"type":"(?:user|assistant)"/.test(text);
      g.skip ||= text.includes('"isMeta":true') || text.includes('"isSidechain":true');
      g.tail = text.slice(-carry);
    };
    const finishLine = (endOff: number, last: Buffer): void => {
      const len = endOff - lineStart;
      const g = giant;
      if (g) {
        feed(last, true);
        if (g.snippet && g.typed && !g.skip) hits.push({ off: lineStart, len, snippet: g.snippet });
        giant = null;
      } else {
        const b = parts.length ? Buffer.concat([...parts, last]) : last;
        const s = matchLine(b.toString('utf8'), needle, raw);
        if (s) hits.push({ off: lineStart, len, snippet: s });
      }
      parts = []; partBytes = 0;
    };
    for (;;) {
      if (signal.aborted) abort();
      const r = await fh.read(buf, 0, buf.length, pos);
      if (r.bytesRead === 0) break;
      const chunk = buf.subarray(0, r.bytesRead);
      let segStart = 0;
      let nl = chunk.indexOf(NL);
      while (nl >= 0 && hits.length < max) {
        await pace();                                            // `buf` is only read again after this chunk is done
        finishLine(pos + nl, chunk.subarray(segStart, nl));
        segStart = nl + 1;
        lineStart = pos + segStart;
        nl = chunk.indexOf(NL, segStart);
      }
      if (hits.length >= max) break;
      if (segStart < chunk.length) { parts.push(Buffer.from(chunk.subarray(segStart))); partBytes += chunk.length - segStart; }
      if (partBytes > GIANT_LINE || (giant && partBytes > 0)) {
        for (const p of parts) { await pace(); feed(p); }
        parts = []; partBytes = 0;
      }
      pos += r.bytesRead;
      await pace();
    }
    if ((parts.length || giant) && hits.length < max) finishLine(pos, Buffer.alloc(0));
    return hits.slice(0, max);
  } finally { await fh.close().catch(() => undefined); }
}

// ------------------------------------------------------------------ small readers
async function readLine(file: string, off: number, len: number): Promise<Record<string, unknown> | null> {
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < 0 || len <= 0) return null;
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(file, 'r'); } catch { return null; }
  try {
    const b = Buffer.allocUnsafe(len);
    const r = await fh.read(b, 0, len, off);
    const o = JSON.parse(b.toString('utf8', 0, r.bytesRead)) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch { return null; } finally { await fh.close().catch(() => undefined); }
}

/** First-turn attachment{type:'instructions'}.files (the CLAUDE.md files the CLI loaded), forward ≤ 2 MiB. */
async function firstInstructions(file: string): Promise<string[]> {
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(file, 'r'); } catch { return []; }
  try {
    const buf = Buffer.allocUnsafe(TAIL_STEP_BYTES);
    let pos = 0;
    let carry = '';
    while (pos < TAIL_MAX_BYTES) {
      const r = await fh.read(buf, 0, buf.length, pos);
      if (r.bytesRead === 0) break;
      pos += r.bytesRead;
      const lines = (carry + buf.toString('utf8', 0, r.bytesRead)).split('\n');
      carry = lines.pop() ?? '';
      if (carry.length > TAIL_MAX_BYTES) carry = '';
      for (const l of lines) {
        if (!l.includes('"instructions"')) continue;
        try {
          const e = JSON.parse(l) as Record<string, unknown>;
          const a = e['attachment'] as Record<string, unknown> | undefined;
          if (e['type'] !== 'attachment' || a?.['type'] !== 'instructions' || !Array.isArray(a['files'])) continue;
          return (a['files'] as unknown[]).map((f) => (typeof f === 'string' ? f : String((f as Record<string, unknown> | null)?.['path'] ?? ''))).filter(Boolean);
        } catch { /* partial */ }
      }
    }
    return [];
  } finally { await fh.close().catch(() => undefined); }
}

/** True when a `type:user` entry with this uuid is in the last `maxBytes` of the file (delivery confirmation). */
async function hasUserUuid(file: string, uuid: string, maxBytes: number): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return false;
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(file, 'r'); } catch { return false; }
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - Math.max(0, maxBytes));
    const b = Buffer.allocUnsafe(size - start);
    const r = await fh.read(b, 0, b.length, start);
    const hay = b.subarray(0, r.bytesRead);
    const needle = Buffer.from(`"uuid":"${uuid}"`);
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
      const s = hay.lastIndexOf(NL, i) + 1;
      const eIdx = hay.indexOf(NL, i);
      const line = hay.toString('utf8', s, eIdx < 0 ? hay.length : eIdx);
      if (line.includes('"type":"user"')) return true;
    }
    return false;
  } catch { return false; } finally { await fh.close().catch(() => undefined); }
}

export function createTranscriptReader(d: { log: Logger }): TranscriptReader {
  return {
    async tail(file, turns) {
      return readPage(file, null, null, Math.max(1, Math.floor(turns)));
    },
    async before(file, cursor, turns) {
      const c = decodeCursor<Cursor>(cursor, isTxCursor);
      if (!c) { d.log.warn('reader: invalid cursor'); return { chain: [], cursor: null, hasMore: false }; }
      return readPage(file, c.off, { leaf: c.leaf, b: typeof c.b === 'string' ? c.b : null }, Math.max(1, Math.floor(turns)));
    },
    line: readLine,
    search: searchFile,
    firstInstructions,
    hasUserUuid,
  };
}
