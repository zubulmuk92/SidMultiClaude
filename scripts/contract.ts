// scripts/contract.ts — 0-token real-CLI checks K1–K7 on a logged-out scratch profile (SPEC §11, §12.4).
// Usage: node scripts/contract.ts [--exe <claude.exe>] [--jobrun <jobrun.exe>] [--dir <scratch>] [--update-snapshot]
// Run after every Claude Code auto-update (≈ 30 s). Every profile used here is a fresh, EMPTY CLAUDE_CONFIG_DIR (no credentials),
// so no request can be authenticated: 0 tokens. Never pass a real profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type * as P from '../src/shared/protocol.ts';
import type { EngineSink, ExitInfo, SdkFrame, SpawnSpec } from '../src/server/contracts.ts';
import { makeEngine } from '../src/server/engine/engine.ts';
import { createSpawner } from '../src/server/engine/spawner.ts';
import { bundledClaudeExe, installedClaudeExe, INIT_RESULT_KEYS, keyDrift, hasDrift } from '../src/server/engine/exe.ts';
import { realClock } from '../src/server/util/clock.ts';
import { memoryLogger } from '../src/server/util/log.ts';
import { isPidAlive } from '../src/server/util/winproc.ts';
import { homeReal, isInside, projectKey } from '../src/server/util/paths.ts';

export type CheckId = 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6' | 'K7' | 'K8';
export type CheckResult = { id: CheckId; ok: boolean; skipped?: string; warning?: string; detail: Record<string, unknown> };
export type ContractOptions = { exe: string; jobrun: string | null; dir: string; updateSnapshot?: boolean; snapshotFile?: string; withBundled?: boolean };
export const SNAPSHOT_FILE = path.resolve(import.meta.dirname, '..', 'test', 'contract', 'init-keys.json');

type Snap = { initializationResult: string[]; systemInit: string[] };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) return false; await sleep(20); }
  return true;
}
const fwd = (s: string): string => s.split(path.sep).join('/');

/** Refuses any scratch dir inside a real Claude profile (S10/S11): the checks must only ever see empty, logged-out profiles. */
function assertScratch(dir: string): void {
  let home: string | null = null;
  try { home = homeReal(); } catch { /* no home */ }
  if (home && isInside(dir, home, false)) {
    const first = path.relative(home, dir).split(/[\\/]/)[0] ?? '';
    if (/^\.claude/i.test(first)) throw new Error(`contract: refusing a scratch dir inside a Claude profile: ${dir}`);
  }
}

function harness(o: { exe: string; jobrun: string | null; root: string }) {
  const frames: { c: string; f: Record<string, unknown> }[] = [];
  const exits: { c: string; info: ExitInfo }[] = [];
  const sink: EngineSink = {
    frame: (c: P.ChatId, f: SdkFrame) => { frames.push({ c, f: f as Record<string, unknown> }); }, facts: () => {}, ask: () => {}, askEnd: () => {},
    delivered: () => {}, sessionChanged: () => {}, exited: (c, info) => { exits.push({ c, info }); },
  };
  const log = memoryLogger();
  const spawner = createSpawner({ jobrunPath: o.jobrun, registryFile: path.join(o.root, 'children.json'), log });
  const engine = makeEngine({ query, clock: realClock, sink, spawner, log, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null });
  engine.setPolicy({ maxLive: 8, reapMin: 60 });
  const profile = (name: string): { cfg: string; cwd: string } => {
    const cfg = path.join(o.root, name, 'cfg'); const cwd = path.join(o.root, name, 'cwd');
    fs.mkdirSync(cfg, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
    return { cfg: fs.realpathSync.native(cfg), cwd: fs.realpathSync.native(cwd) };
  };
  const spec = (p: { cfg: string; cwd: string }, isolation: 'job' | 'plain', title: string): SpawnSpec => {
    const sid = randomUUID();
    return { chatId: `k:${sid}`, sessionId: sid, cwd: p.cwd, account: { id: 'k', configDir: p.cfg, claudeMdExcludes: [] }, mode: 'default',
      start: { kind: 'new', title }, allowBypass: false, aiTitles: false, exe: o.exe, isolation };
  };
  const of = (c: string): Record<string, unknown>[] => frames.filter((x) => x.c === c).map((x) => x.f);
  return { engine, log, spawner, profile, spec, of, exits };
}

/** K1–K6 against one binary. */
export async function runChecks(o: ContractOptions): Promise<CheckResult[]> {
  assertScratch(o.dir);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(o.dir, 'k-')));
  const isolation = o.jobrun ? 'job' : 'plain';
  const h = harness({ exe: o.exe, jobrun: o.jobrun, root });
  const out: CheckResult[] = [];
  try {
    // ---- K1: our exact flags initialize (no prompt) · K5: registry entry appears / disappears · K6: exit on input.end() ≤ 8 s
    const pA = h.profile('a');
    const a = h.spec(pA, isolation, 'contract-k1');
    const t0 = Date.now();
    const ens = await h.engine.ensure(a, { why: 'prespawn' });
    const live = ens.ok && await waitFor(() => h.engine.facts(a.chatId)?.phase === 'live' || !h.engine.isLive(a.chatId), 45_000);
    const fa = h.engine.facts(a.chatId);
    const init = h.of(a.chatId).find((f) => f['type'] === 'smc_engine' && f['subtype'] === 'initialized');
    out.push({ id: 'K1', ok: !!live && fa?.phase === 'live', detail: { initMs: Date.now() - t0, ensure: ens, cliPid: fa?.cliPid, capabilities: fa?.capabilities, isolation: h.engine.stats().isolation, drift: init?.['drift'] ?? null } });
    const cli = fa?.cliPid;
    const reg = (): string[] => { try { return fs.readdirSync(path.join(pA.cfg, 'sessions')).filter((n) => /^\d+\.json$/.test(n)); } catch { return []; } };
    const appeared = cli !== undefined && await waitFor(() => reg().includes(`${cli}.json`), 10_000);
    const own = cli !== undefined && h.engine.ownPids().has(cli);
    const t1 = Date.now();
    const info = await h.engine.sleep(a.chatId, 'user');
    const closeMs = Date.now() - t1;
    out.push({ id: 'K6', ok: info?.reason === 'closed' && closeMs <= 8_000 && (cli === undefined || !isPidAlive(cli)), detail: { closeMs, reason: info?.reason, code: info?.code } });
    const gone = cli !== undefined && await waitFor(() => !reg().includes(`${cli}.json`), 5_000);
    out.push({ id: 'K5', ok: appeared && gone && own, detail: { appeared, gone, ownPidsHasCli: own, files: reg() } });

    // ---- K8 (auditor, M2; spec U2): the flag sets the SDK passes for a fork (--resume=<jsonl> --fork-session --session-id)
    // and a rewind (--resume=<id> --resume-session-at --resume-drops-turn) start the CLI (init answered, no prompt: 0 tokens)
    const pC = h.profile('c');
    const src = randomUUID();
    const [u1, a1, u2, a2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const ts = new Date().toISOString();
    const base = { sessionId: src, cwd: pC.cwd, version: '2.1.294', gitBranch: 'HEAD', userType: 'external', entrypoint: 'sdk-ts', isSidechain: false, timestamp: ts };
    const asst = (uuid: string, parentUuid: string, text: string): Record<string, unknown> => ({ ...base, parentUuid, type: 'assistant', uuid,
      message: { id: `msg_${uuid.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
    const proj = path.join(pC.cfg, 'projects', projectKey(pC.cwd));
    fs.mkdirSync(proj, { recursive: true });
    const jsonl = path.join(proj, `${src}.jsonl`);
    fs.writeFileSync(jsonl, [{ ...base, parentUuid: null, type: 'user', uuid: u1, message: { role: 'user', content: 'un' } }, asst(a1, u1, 'un'),
      { ...base, parentUuid: a1, type: 'user', uuid: u2, message: { role: 'user', content: 'deux' } }, asst(a2, u2, 'deux')].map((l) => JSON.stringify(l) + '\n').join(''));
    const k8: Record<string, unknown> = {};
    for (const [label, sp] of [['fork', { ...h.spec(pC, isolation, 'contract-k8'), start: { kind: 'fork', fromJsonl: jsonl, title: 'contract-k8' } }],
      ['rewind', { ...h.spec(pC, isolation, 'contract-k8r'), chatId: `k:${src}`, sessionId: src, start: { kind: 'rewind', atUuid: a1, dropsTurn: u2 } }]] as [string, SpawnSpec][]) {
      const e8 = await h.engine.ensure(sp, { why: 'send' });
      const up = e8.ok && await waitFor(() => h.engine.facts(sp.chatId)?.phase === 'live' || !h.engine.isLive(sp.chatId), 45_000) && h.engine.facts(sp.chatId)?.phase === 'live';
      k8[label] = { live: up, ensure: e8, exit: h.exits.find((x) => x.c === sp.chatId)?.info ?? null };
      if (h.engine.isLive(sp.chatId)) await h.engine.sleep(sp.chatId, 'user');
    }
    out.push({ id: 'K8', ok: Object.values(k8).every((x) => (x as { live: boolean }).live), detail: k8 });

    // ---- K2 (init key sets) + K4 (logged-out prompt → auth signal): one prompt on an EMPTY profile (cannot authenticate)
    const pB = h.profile('b');
    const b = h.spec(pB, isolation, 'contract-k4');
    await h.engine.ensure(b, { why: 'send' });
    await waitFor(() => h.engine.facts(b.chatId)?.phase === 'live' || !h.engine.isLive(b.chatId), 45_000);
    h.engine.send(b.chatId, { uuid: randomUUID(), text: 'contract check (logged out, never answered)' });
    await waitFor(() => h.of(b.chatId).some((f) => f['type'] === 'result') || !h.engine.isLive(b.chatId), 60_000);
    const fb = h.of(b.chatId);
    const sysInit = fb.find((f) => f['type'] === 'system' && f['subtype'] === 'init');
    const res = fb.find((f) => f['type'] === 'result');
    const textOf = (f: Record<string, unknown>): string => JSON.stringify(f['result'] ?? (f['message'] as Record<string, unknown> | undefined)?.['content'] ?? '');
    const authFrame = fb.find((f) => f['error'] === 'authentication_failed' || /Please run \/login|Not logged in|authenticat/i.test(textOf(f)));
    const usage = (res?.['usage'] ?? {}) as Record<string, number>;
    const tokens = (usage['input_tokens'] ?? 0) + (usage['output_tokens'] ?? 0) + (usage['cache_read_input_tokens'] ?? 0) + (usage['cache_creation_input_tokens'] ?? 0);
    out.push({ id: 'K4', ok: !!authFrame && tokens === 0, detail: { authSignal: authFrame ? (authFrame['error'] ?? textOf(authFrame).slice(0, 120)) : null, resultSubtype: res?.['subtype'], isError: res?.['is_error'], tokens } });
    await h.engine.sleep(b.chatId, 'user');
    const snapFile = o.snapshotFile ?? SNAPSHOT_FILE;
    const sysKeys = sysInit ? Object.keys(sysInit).sort() : [];
    const initDrift = (init?.['drift'] as { added: string[]; removed: string[] } | undefined) ?? { added: [], removed: [] };
    let snap: Snap | null = null;
    try { snap = JSON.parse(fs.readFileSync(snapFile, 'utf8')) as Snap; } catch { /* first run */ }
    if (o.updateSnapshot || !snap) {
      const initKeys = [...new Set([...INIT_RESULT_KEYS, ...initDrift.added])].filter((k) => !initDrift.removed.includes(k)).sort();
      snap = { initializationResult: initKeys, systemInit: sysKeys };
      fs.writeFileSync(snapFile, JSON.stringify(snap, null, 1) + '\n');
    }
    const sysDrift = keyDrift(sysKeys, snap.systemInit);
    const drift = hasDrift(initDrift) || hasDrift(sysDrift);
    out.push({ id: 'K2', ok: !!sysInit && !!init, ...(drift ? { warning: 'initialize / system:init key drift: review, then refresh with --update-snapshot (and exe.ts INIT_RESULT_KEYS)' } : {}),
      detail: { initDrift, sysDrift, version: sysInit?.['claude_code_version'] } });

    // ---- K3: a SessionStart hook grandchild (started in the background through the CLI's shell) dies under jobrun
    if (!o.jobrun) out.push({ id: 'K3', ok: true, skipped: 'jobrun.exe not available', detail: {} });
    else {
      const pC = h.profile('c');
      const pidFile = path.join(pC.cfg, 'gc.pid'); const gc = path.join(pC.cfg, 'gc.cjs');
      fs.writeFileSync(gc, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1e6);");
      fs.writeFileSync(path.join(pC.cfg, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${fwd(gc)}" "${fwd(pidFile)}" > /dev/null 2>&1 &` }] }] } }));
      const c = h.spec(pC, 'job', 'contract-k3');
      await h.engine.ensure(c, { why: 'prespawn' });
      const started = await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 30_000);
      const gpid = started ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : 0;
      const before = gpid > 0 && isPidAlive(gpid);
      await h.engine.sleep(c.chatId, 'user');
      const dead = gpid > 0 && await waitFor(() => !isPidAlive(gpid), 5_000);
      if (gpid > 0 && isPidAlive(gpid)) try { process.kill(gpid); } catch { /* gone */ }
      out.push({ id: 'K3', ok: before && dead, detail: { grandchild: gpid, aliveBefore: before, deadAfterSleep: dead } });
    }
  } finally {
    await h.engine.shutdown(15_000);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* files still locked on Windows */ }
  }
  return out;
}

/** K1–K6 on the installed binary, then K7 = the same on the bundled binary when present. */
export async function runContract(o: Omit<ContractOptions, 'exe'> & { exe?: string }): Promise<CheckResult[]> {
  const exe = o.exe ?? installedClaudeExe();
  if (!exe) throw new Error('contract: claude.exe not found');
  const res = await runChecks({ ...o, exe });
  const bundled = o.withBundled === false ? null : bundledClaudeExe();
  if (!bundled) res.push({ id: 'K7', ok: true, skipped: 'bundled binary not installed (npm run fetch-bundled-cli)', detail: {} });
  else {
    const r2 = await runChecks({ ...o, exe: bundled, updateSnapshot: false });
    res.push({ id: 'K7', ok: r2.every((r) => r.ok), detail: Object.fromEntries(r2.map((r) => [r.id, { ok: r.ok, ...(r.warning ? { warning: r.warning } : {}) }])) });
  }
  return res;
}

if (import.meta.main) {
  const arg = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const dir = arg('--dir') ?? path.join(os.tmpdir(), 'smc-contract');
  fs.mkdirSync(dir, { recursive: true });
  const jobrun = arg('--jobrun') ?? null;
  const res = await runContract({ dir: fs.realpathSync.native(dir), jobrun: jobrun && fs.existsSync(jobrun) ? fs.realpathSync.native(jobrun) : null,
    ...(arg('--exe') ? { exe: arg('--exe')! } : {}), updateSnapshot: process.argv.includes('--update-snapshot') });
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.skipped ? ` (skipped: ${r.skipped})` : ''}${r.warning ? ` WARNING: ${r.warning}` : ''} ${JSON.stringify(r.detail)}`);
  process.exit(res.every((r) => r.ok) ? 0 : 1);
}
