// test/unit/claude/reader.test.ts — TranscriptReader: branches, compaction, truncation, paging, 80 MB / 12 MB files, search.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTranscriptReader } from '../../../src/server/claude/reader.ts';
import { latestChain } from '../../../src/server/claude/chain.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { canonicalPath } from '../../../src/server/util/paths.ts';
import { assistant, FIXTURES, randomTranscript, toolResult, toolUse, twoCompactions, u, user, uuids, writeJsonl, lastPrompt } from './lib.ts';
import type { E } from './lib.ts';
import { budget } from '../../helpers/perf.ts';

const reader = createTranscriptReader({ log: nullLogger });
let dir = '';
before(() => { dir = fs.mkdtempSync(path.join(canonicalPath(os.tmpdir()), 'smc-wpc-reader-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function turns(n: number, from = 0): E[] {
  const out: E[] = [];
  let parent: string | null = null;
  for (let i = from; i < from + n; i++) {
    out.push(user(u(i * 2 + 1), parent, `Question ${i}`, { i: i * 2 + 1 }));
    out.push(assistant(u(i * 2 + 2), u(i * 2 + 1), `Réponse ${i}`, { i: i * 2 + 2 }));
    parent = u(i * 2 + 2);
  }
  return out;
}

test('branches: the latest leaf wins, abandoned branch dropped', async () => {
  const p = await reader.tail(path.join(FIXTURES, 'branches.jsonl'), 30);
  assert.deepEqual(uuids(p.chain), [u(1), u(2), u(5), u(6), u(7), u(8)]);
  assert.equal(p.hasMore, false);
  assert.equal(p.cursor, null);
});

test('compaction: preserved segment relinked after the summary, older history behind the boundary', async () => {
  const p = await reader.tail(path.join(FIXTURES, 'compaction.jsonl'), 30);
  assert.deepEqual(uuids(p.chain), [u(1), u(2), u(10), u(11), u(3), u(4), u(12), u(13)]);
});

/** Concatenation of every page, newest page first, read `turns` turns at a time. */
async function pageAll(file: string, turns: number): Promise<{ all: string[]; pages: number }> {
  const all: string[] = [];
  let page = await reader.tail(file, turns);
  let pages = 1;
  all.unshift(...uuids(page.chain));
  while (page.hasMore) {
    assert.ok(page.cursor, 'hasMore without a cursor');
    page = await reader.before(file, page.cursor, turns);
    all.unshift(...uuids(page.chain));
    assert.ok(++pages < 500, 'paging does not terminate');
  }
  return { all, pages };
}

test('paging across a compaction: every entry exactly once, in order, at any page size', async () => {
  const file = path.join(FIXTURES, 'compaction.jsonl');
  const full = uuids((await reader.tail(file, 1000)).chain);
  for (const turns of [1, 2, 3]) assert.deepEqual((await pageAll(file, turns)).all, full, `turns=${turns}`);
});

test('two compactions (segment + messages) and parallel tools: chain, siblings and paging', async () => {
  for (const pad of [0, 120_000]) {                              // 120 kB entries: windows grow past 2 MiB
    const { entries, expected } = twoCompactions(pad);
    const file = writeJsonl(path.join(dir, `two-compactions-${pad}.jsonl`), entries);
    assert.deepEqual(uuids((await reader.tail(file, 1000)).chain), expected, `full chain, pad=${pad}`);
    for (const turns of [1, 2, 3]) {
      const { all, pages } = await pageAll(file, turns);
      assert.deepEqual(all, expected, `pad=${pad} turns=${turns}`);
      assert.ok(pages >= Math.ceil(9 / turns), `pad=${pad} turns=${turns}: ${pages} pages`);
    }
  }
});

test('random transcripts (retries, parallel tools, compactions, 450 kB entries): pages == the whole-file chain', async () => {
  for (let seed = 1; seed <= 8; seed++) {
    const file = writeJsonl(path.join(dir, `random-${seed}.jsonl`), randomTranscript(seed));
    let off = 0;
    const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      const r = { off, len: Buffer.byteLength(l), e: JSON.parse(l) as E };
      off += r.len + 1;
      return r;
    });
    const ref = uuids(latestChain(all));                         // the whole file parsed at once
    assert.deepEqual(uuids((await reader.tail(file, 1000)).chain), ref, `seed ${seed}: tail`);
    for (const turns of [1, 2, 3]) assert.deepEqual((await pageAll(file, turns)).all, ref, `seed ${seed}, ${turns} turn(s) per page`);
  }
});

test('parallel tool calls in a real CC 2.1.294 transcript: every tool_use has its result', async () => {
  const p = await reader.tail(path.join(FIXTURES, '..', 'pairs', 'main', 'transcript.jsonl'), 1000);
  const blocks = (r: { e: E }, type: string, key: string): string[] => {
    const c = (r.e['message'] as E | undefined)?.['content'];
    return Array.isArray(c) ? (c as E[]).filter((b) => b['type'] === type).map((b) => String(b[key])) : [];
  };
  const used = p.chain.flatMap((r) => blocks(r, 'tool_use', 'id'));
  const answered = new Set(p.chain.flatMap((r) => blocks(r, 'tool_result', 'tool_use_id')));
  assert.ok(used.length >= 6);
  assert.deepEqual(used.filter((id) => !answered.has(id)), [], 'tool_use without its tool_result');
  assert.equal(new Set(uuids(p.chain)).size, p.chain.length, 'no duplicates');
});

test('oracle (opt-in SMC_ORACLE=1): the chain equals SDK getSessionMessages after the last compaction', { skip: process.env['SMC_ORACLE'] !== '1' }, async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const cfg = path.join(dir, 'oracle-cfg');
  const proj = path.join(cfg, 'projects', 'C--work-demo');
  fs.mkdirSync(proj, { recursive: true });
  const two = writeJsonl(path.join(dir, 'oracle-two.jsonl'), twoCompactions(0).entries);
  const random = [11, 12, 13, 14].map((seed) => writeJsonl(path.join(dir, `oracle-random-${seed}.jsonl`), randomTranscript(seed)));
  const sources = ['branches.jsonl', 'compaction.jsonl', 'truncated.jsonl'].map((n) => path.join(FIXTURES, n))
    .concat(['main', 'fork', 'plan'].map((n) => path.join(FIXTURES, '..', 'pairs', n, 'transcript.jsonl')), [two], random);
  const prev = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = cfg;                        // a scratch config dir: local file reads only, 0 tokens
  try {
    for (const [k, src] of sources.entries()) {
      const sid = `9${String(k).padStart(7, '0')}-0000-4000-8000-000000000000`;
      const file = path.join(proj, `${sid}.jsonl`);
      fs.copyFileSync(src, file);
      const inFile = new Map(fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { const e = JSON.parse(l) as E; return typeof e['uuid'] === 'string' ? [[e['uuid'], e] as const] : []; } catch { return []; } }));
      const shown = (id: string): boolean => { const e = inFile.get(id); return !!e && (e['type'] === 'user' || e['type'] === 'assistant') && e['isMeta'] !== true; };
      const want = (await sdk.getSessionMessages(sid, {})).map((m) => m.uuid).filter(shown);
      const chain = uuids((await reader.tail(file, 100_000)).chain);
      const lastBoundary = chain.map((id) => inFile.get(id)?.['subtype']).lastIndexOf('compact_boundary');
      assert.deepEqual(chain.slice(lastBoundary + 1).filter(shown), want, path.basename(path.dirname(src)) + '/' + path.basename(src));
    }
  } finally { if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = prev; }
});

test('the latest leaf is not decided while its ancestry is outside the window (no abandoned branch)', async () => {
  const U = u(301);
  const F = u(302);
  const entries: E[] = [
    ...turns(2),
    user(U, u(4), 'La vraie question', { i: 50 }),
    { type: 'attachment', uuid: F, parentUuid: U, isSidechain: false, timestamp: '2026-10-08T10:01:00.000Z', attachment: { type: 'file', content: 'z'.repeat(300_000) } },
    assistant(u(303), U, 'API Error', { i: 52, extra: { isApiErrorMessage: true } }),
    { type: 'attachment', uuid: u(304), parentUuid: F, isSidechain: false, timestamp: '2026-10-08T10:01:02.000Z', attachment: { type: 'date' } },
    { type: 'attachment', uuid: u(305), parentUuid: u(304), isSidechain: false, timestamp: '2026-10-08T10:01:03.000Z', attachment: { type: 'model' } },
  ];
  const file = writeJsonl(path.join(dir, 'undecided-leaf.jsonl'), entries);
  const p = await reader.tail(file, 1);
  assert.deepEqual(uuids(p.chain), [U, F, u(304), u(305)]);
});

test('a truncated (in-flight) last line is skipped', async () => {
  const p = await reader.tail(path.join(FIXTURES, 'truncated.jsonl'), 30);
  assert.deepEqual(uuids(p.chain), [u(1), u(2), u(3), u(4)]);
});

test('paging with opaque cursors walks every turn exactly once', async () => {
  const file = writeJsonl(path.join(dir, 'paging.jsonl'), [...turns(100), lastPrompt('Question 99', u(200))]);
  const seen: string[] = [];
  let page = await reader.tail(file, 30);
  assert.equal(page.chain.length, 60);
  assert.equal(page.hasMore, true);
  seen.unshift(...uuids(page.chain));
  while (page.hasMore) {
    assert.ok(page.cursor && /^[A-Za-z0-9_-]+$/.test(page.cursor));
    page = await reader.before(file, page.cursor, 30);
    seen.unshift(...uuids(page.chain));
  }
  assert.deepEqual(seen, turns(100).map((e) => e['uuid']));
  const bad = await reader.before(file, 'not-a-cursor', 30);
  assert.deepEqual(bad, { chain: [], cursor: null, hasMore: false });
});

test('line(), hasUserUuid(), firstInstructions()', async () => {
  const entries = turns(3);
  entries.splice(1, 0, { type: 'attachment', uuid: u(900), parentUuid: u(1), isSidechain: false, attachment: { type: 'instructions', files: ['C:/Users/x/.claude/CLAUDE.md', 'C:/work/demo/CLAUDE.md'] } });
  const file = writeJsonl(path.join(dir, 'small.jsonl'), entries);
  const p = await reader.tail(file, 1);
  const last = p.chain.at(-1)!;
  assert.deepEqual(await reader.line(file, last.off, last.len), last.e);
  assert.equal(await reader.line(file, -1, 3), null);
  assert.equal(await reader.hasUserUuid(file, u(5), 1 << 20), true);
  assert.equal(await reader.hasUserUuid(file, u(6), 1 << 20), false);   // an assistant uuid
  assert.deepEqual(await reader.firstInstructions(file), ['C:/Users/x/.claude/CLAUDE.md', 'C:/work/demo/CLAUDE.md']);
});

/** ~80 MB: each turn = prompt, tool_use, tool_result with a 16 KB toolUseResult, answer (about 65 % tool bytes, like real transcripts). */
function writeBig(file: string, targetBytes: number): number {
  const fd = fs.openSync(file, 'w');
  const blob = 'x'.repeat(16 * 1024);
  let size = 0;
  let parent: string | null = null;
  let i = 0;
  try {
    while (size < targetBytes) {
      const b = i * 4;
      const tr = toolResult(u(b + 3), u(b + 2), `toolu_${i}`, 'ok', { i: b + 3 });
      tr['toolUseResult'] = { stdout: blob, stderr: '' };
      const lines = [user(u(b + 1), parent, `Question ${i} aiguille${i % 997 === 0 ? 'rare' : ''}`, { i: b + 1 }), toolUse(u(b + 2), u(b + 1), `toolu_${i}`, { i: b + 2 }), tr, assistant(u(b + 4), u(b + 3), `Réponse ${i}`, { i: b + 4 })];
      const s = lines.map((e) => JSON.stringify(e)).join('\n') + '\n';
      fs.writeSync(fd, s);
      size += Buffer.byteLength(s);
      parent = u(b + 4);
      i++;
    }
  } finally { fs.closeSync(fd); }
  return i;
}

let big: { file: string; n: number } | null = null;
/** The ~80 MB transcript, written once and shared (so each test also runs alone, e.g. with --test-name-pattern). */
function bigFile(): { file: string; n: number } {
  if (!big) { const file = path.join(dir, 'big.jsonl'); big = { file, n: writeBig(file, 80 * 1024 * 1024) }; }
  return big;
}
/** Event-loop turns (a setImmediate ping) while `run` executes, with the MAIN-THREAD CPU time charged inside each gap
 *  (process.threadCpuUsage); the ping always stops. */
type Loop = { gap: number; turns: number; long: number; cpuBlocked: number; worstCpu: number };
async function loopGap<T>(run: () => Promise<T>): Promise<Loop & { value: T }> {
  const l: Loop = { gap: 0, turns: 0, long: 0, cpuBlocked: 0, worstCpu: 0 };
  let last = performance.now();
  let lc = process.threadCpuUsage();
  let on = true;
  const ping = (): void => {
    const t = performance.now();
    const c = process.threadCpuUsage();
    const g = t - last;
    const cpu = (c.user - lc.user + c.system - lc.system) / 1000;
    l.turns++; l.gap = Math.max(l.gap, g); l.worstCpu = Math.max(l.worstCpu, cpu);
    if (g >= 8) l.long++;
    if (cpu >= CPU_BLOCKED_MS) l.cpuBlocked++;
    last = t; lc = c;
    if (on) setImmediate(ping);
  };
  setImmediate(ping);
  try { const value = await run(); return { ...l, value }; } finally { on = false; }
}
/** "Never blocks the loop > 8 ms" (measured). Alone, the search's worst wall-clock gap is 1–5 ms (≈ 15,000–40,000 loop
 *  turns per 80 MB search). Under full-suite load single gaps reach 28–150 ms, but with 0 ms of main-thread CPU inside them:
 *  OS preemption, not blocking. Windows charges thread CPU per 15.6 ms clock tick, so the default tier asserts what that
 *  clock can prove without false alarms: no gap with ≥ 2 ticks of main-thread CPU (a slice ≥ 31 ms always shows 2 ticks; a
 *  preempted ≤ 4 ms slice never does), and the loop got turns throughout (≥ 200). SMC_PERF=1 (idle machine) adds the strict
 *  wall-clock bound: best of 3 runs with a worst gap < 8 ms. */
const CPU_BLOCKED_MS = 31;
const PERF = process.env['SMC_PERF'] === '1';
function loopOk(l: Loop): boolean { return l.turns >= 200 && l.cpuBlocked === 0 && (!PERF || l.gap < 8); }
const loopText = (ls: readonly Loop[]): string =>
  ls.map((l) => `${l.turns} turns, max gap ${l.gap.toFixed(1)} ms wall (${l.long} ≥ 8 ms), max ${l.worstCpu.toFixed(1)} ms main-thread CPU in a gap`).join(' / ');
async function bestGap<T>(run: () => Promise<T>): Promise<{ loops: Loop[]; ok: boolean; value: T }> {
  const loops: Loop[] = [];
  let value: T | undefined;
  for (let k = 0; k < 3 && !loops.some(loopOk); k++) { const { value: v, ...l } = await loopGap(run); loops.push(l); value = v; }
  return { loops, ok: loops.some(loopOk), value: value as T };
}

test('80 MB transcript: the last 30 turns in < 150 ms', async () => {
  const { file, n } = bigFile();
  assert.ok(fs.statSync(file).size >= 80 * 1024 * 1024);
  let t0 = performance.now();
  const p = await reader.tail(file, 30);
  let ms = performance.now() - t0;
  assert.equal(p.chain.filter((r) => r.e['type'] === 'user' && typeof (r.e['message'] as E)['content'] === 'string').length, 30);
  assert.equal(p.chain.at(-1)!.e['uuid'], u((n - 1) * 4 + 4));
  assert.equal(p.hasMore, true);
  // best of 3 for the budget: the parallel unit suite's load must not fail it; a regression fails every run
  for (let k = 0; k < 2 && ms >= 150; k++) { t0 = performance.now(); await reader.tail(file, 30); ms = Math.min(ms, performance.now() - t0); }
  assert.ok(ms < budget(150), `tail took ${ms.toFixed(1)} ms`);
  console.log(`# 80 MB tail(30): ${ms.toFixed(1)} ms`);
});

test('search: ≤ 50 hits, never blocks the loop > 8 ms, abortable', async () => {
  const { file } = bigFile();
  const t0 = performance.now();
  const { loops, ok, value: hits } = await bestGap(() => reader.search(file, 'AIGUILLErare', 50, new AbortController().signal));
  const ms = (performance.now() - t0) / loops.length;
  assert.ok(hits.length > 0 && hits.length <= 50);
  assert.ok(hits.every((h) => /aiguillerare/i.test(h.snippet)));
  const all = await reader.search(file, 'Question', 500, new AbortController().signal);
  assert.equal(all.length, 50);
  console.log(`# search 80 MB: ${ms.toFixed(0)} ms per run; ${loopText(loops)}`);
  assert.ok(ok, `loop blocked: ${loopText(loops)}`);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5);
  await assert.rejects(reader.search(file, 'introuvable-zzz', 50, ac.signal), (e: Error) => e.name === 'AbortError');
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(reader.search(file, 'x', 50, pre.signal), (e: Error) => e.name === 'AbortError');
});

test('search over long lines: searched piecewise, base64 runs and meta lines ignored, loop never blocked > 8 ms', async () => {
  const filler = (n: number): string => 'du texte ordinaire, '.repeat(Math.ceil(n / 20)).slice(0, n);
  const longText = toolResult(u(601), u(600), 'toolu_l', `${filler(400_000)} trouve AIGUILLE-LONGUE ici ${filler(400_000)}`, { i: 601 });
  const medium = user(u(602), u(601), `${filler(150_000)} AIGUILLE-LONGUE au milieu ${filler(150_000)}`, { i: 602 });
  const image = { ...user(u(603), u(602), '', { i: 603 }), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `${'BwcH'.repeat(200_000)}AIGUILLELONGUE${'BwcH'.repeat(200_000)}` } }] } };
  const meta = user(u(604), u(603), `${filler(600_000)} AIGUILLE-LONGUE ${filler(1000)}`, { i: 604, extra: { isMeta: true } });
  const lines: E[] = [];
  for (let k = 0; k < 8; k++) lines.push(longText, medium, image, meta);
  const file = writeJsonl(path.join(dir, 'long-lines.jsonl'), lines);
  const { loops, ok, value: hits } = await bestGap(() => reader.search(file, 'aiguille-longue', 50, new AbortController().signal));
  assert.equal(hits.length, 16, 'the long text and the medium line of each group; no image, no meta');
  assert.ok(hits.every((h) => /aiguille-longue/i.test(h.snippet) && h.snippet.length < 400), 'short snippets around the match');
  assert.equal(new Set(hits.map((h) => h.off)).size, 16);
  assert.equal((await reader.search(file, 'aiguillelongue', 50, new AbortController().signal)).length, 0, 'never inside base64');
  assert.equal((await reader.search(file, 'toolUseResult', 50, new AbortController().signal)).length, 0, 'never a JSON key');
  console.log(`# search long lines: ${loopText(loops)}`);
  assert.ok(ok, `loop blocked: ${loopText(loops)}`);
});

test('a 12 MB last line: tail crosses it', async () => {
  const entries = turns(40);
  entries.push(toolUse(u(499), u(80), 'toolu_huge', { i: 499 }));
  const huge = toolResult(u(500), u(499), 'toolu_huge', 'ok', { i: 500 });
  huge['toolUseResult'] = { stdout: 'y'.repeat(12 * 1024 * 1024), stderr: '' };
  entries.push(huge);
  const file = writeJsonl(path.join(dir, 'giant.jsonl'), entries);
  const t0 = performance.now();
  const p = await reader.tail(file, 3);
  const ms = performance.now() - t0;
  assert.equal(p.chain.at(-1)!.e['uuid'], u(500));
  assert.deepEqual(uuids(p.chain).slice(0, 2), [u(75), u(76)]);
  console.log(`# 12 MB last line tail(3): ${ms.toFixed(1)} ms`);
});
