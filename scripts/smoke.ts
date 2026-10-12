// scripts/smoke.ts — budgeted real-model smoke S1–S6 (SPEC §12.5). Run by the lead at M3 ONLY, never by npm test.
// PowerShell:  $env:SMC_SMOKE='1'; npm run smoke
// Env: SMC_SMOKE=1 (required guard) · SMC_SMOKE_CONFIG_DIR (WORK profile; default %USERPROFILE%\.claude-pro) · SMC_SMOKE_DIR (scratch cwds +
//      budget file; default %TEMP%\smc-smoke) · SMC_SMOKE_ONLY=S1,S2… (subset) · SMC_SMOKE_S6=1 (opt-in, may bill Sonnet) · SMC_JOBRUN (S4).
// HARD BUDGET: a persistent budget file (<dir>\smoke-budget.json) counts every API request (each main-thread or subagent
// `system:status requesting` frame, plus the one `claude -p` request of S1). A step that would exceed 8 is skipped; a run that
// reaches 8 interrupts every chat and stops. Delete the budget file by hand to grant a new budget.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type * as P from '../src/shared/protocol.ts';
import type { EngineSink, QueryFn, SdkFrame, SpawnSpec } from '../src/server/contracts.ts';
import { makeEngine } from '../src/server/engine/engine.ts';
import { createSpawner } from '../src/server/engine/spawner.ts';
import { accountEnv } from '../src/server/engine/options.ts';
import { installedClaudeExe } from '../src/server/engine/exe.ts';
import { realClock } from '../src/server/util/clock.ts';
import { memoryLogger } from '../src/server/util/log.ts';
import { execHidden, isPidAlive } from '../src/server/util/winproc.ts';
import { auxTokens, modelUsageTotal, usageTokens } from '../src/server/model/accounting.ts';

export const MAX_REQUESTS = 8;
const MODEL = 'haiku';

if (process.env['SMC_SMOKE'] !== '1') {
  console.error('smoke: refused. This sends REAL prompts (≤ 8 API requests, model haiku) on the WORK profile. Set SMC_SMOKE=1 to run it.');
  process.exit(2);
}
const CFG = fs.realpathSync.native(process.env['SMC_SMOKE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude-pro'));
const DIR = path.resolve(process.env['SMC_SMOKE_DIR'] ?? path.join(os.tmpdir(), 'smc-smoke'));
fs.mkdirSync(DIR, { recursive: true });
const BUDGET_FILE = path.join(DIR, 'smoke-budget.json');
const ONLY = new Set((process.env['SMC_SMOKE_ONLY'] ?? 'S1,S2,S3,S4,S5').split(',').map((s) => s.trim()).filter(Boolean));
if (process.env['SMC_SMOKE_S6'] === '1') ONLY.add('S6');
const EXE = installedClaudeExe();
if (!EXE) { console.error('smoke: claude.exe not found'); process.exit(2); }
const JOBRUN = process.env['SMC_JOBRUN'] && fs.existsSync(process.env['SMC_JOBRUN']) ? fs.realpathSync.native(process.env['SMC_JOBRUN']) : null;

// ---------------------------------------------------------------- budget (persistent, hard cap)
type Budget = { max: number; used: number; log: { at: string; step: string; n: number }[] };
const readBudget = (): Budget => { try { return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) as Budget; } catch { return { max: MAX_REQUESTS, used: 0, log: [] }; } };
const writeBudget = (b: Budget): void => { fs.writeFileSync(BUDGET_FILE, JSON.stringify(b, null, 1)); };
let aborted = false;
function spend(step: string, n = 1): void {
  const b = readBudget();
  b.used += n; b.log.push({ at: new Date().toISOString(), step, n });
  writeBudget(b);
  if (b.used >= Math.min(b.max, MAX_REQUESTS) && !aborted) { aborted = true; console.error(`smoke: budget reached (${b.used}/${MAX_REQUESTS}) during ${step}: stopping`); void stopAll(); }
}
function canAfford(step: string, n: number): boolean {
  const b = readBudget();
  if (aborted || b.used + n > Math.min(b.max, MAX_REQUESTS)) { console.log(`SKIP ${step}: needs ${n} request(s), budget ${b.used}/${MAX_REQUESTS}`); return false; }
  return true;
}

// ---------------------------------------------------------------- engine (WORK profile, real claude.exe); smoke-only debugFile
const frames: { c: string; f: Record<string, unknown> }[] = [];
let stepName = 'init';
const sink: EngineSink = {
  frame(c: P.ChatId, f: SdkFrame) {
    const r = f as Record<string, unknown>;
    frames.push({ c, f: r });
    if (r['type'] === 'system' && r['subtype'] === 'status' && r['status'] === 'requesting') spend(stepName);   // every API request
  },
  facts: () => {}, ask: (a) => { pendingAsks.push(a); }, askEnd: () => {}, delivered: () => {}, sessionChanged: () => {}, exited: () => {},
};
const pendingAsks: P.PendingAsk[] = [];
const log = memoryLogger();                                          // dumped to <dir>smoke-log.json at the end
const debugFiles = new Map<string, string>();
const smokeQuery: QueryFn = ((a: { prompt: never; options?: Options }) => {
  const df = path.join(DIR, `debug-${randomUUID().slice(0, 8)}.log`);
  debugFiles.set(a.options!.sessionId ?? String(a.options!.resume), df);
  return query({ prompt: a.prompt, options: { ...a.options, debugFile: df } });   // smoke only: never in production options
}) as QueryFn;
const engine = makeEngine({ query: smokeQuery, clock: realClock, sink, log, freeMemBytes: () => os.freemem(), holder: () => null,
  spawner: createSpawner({ jobrunPath: JOBRUN, registryFile: path.join(DIR, 'children.json'), log }) });
engine.setPolicy({ maxLive: 8, reapMin: 60 });
async function stopAll(): Promise<void> { for (const it of engine.stats().items) await engine.interrupt(it.chatId).catch(() => undefined); }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (aborted) throw new Error('aborted (budget)'); if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(25); }
}
const of = (c: string): Record<string, unknown>[] => frames.filter((x) => x.c === c).map((x) => x.f);
const results = (c: string): Record<string, unknown>[] => of(c).filter((f) => f['type'] === 'result');
function newChat(step: string, o: Partial<SpawnSpec> = {}): SpawnSpec {
  const cwd = path.join(DIR, 'cwd-' + step.toLowerCase());
  fs.mkdirSync(cwd, { recursive: true });
  const sid = randomUUID();
  return { chatId: `smoke:${sid}`, sessionId: sid, cwd: fs.realpathSync.native(cwd), account: { id: 'smoke', configDir: CFG, claudeMdExcludes: [] },
    mode: 'default', start: { kind: 'new', title: `smoke ${step}` }, model: MODEL, allowBypass: false, aiTitles: false, exe: EXE!,
    isolation: JOBRUN ? 'job' : 'plain', ...o };
}
async function turn(s: SpawnSpec, text: string, o: { priority?: P.Priority } = {}): Promise<Record<string, unknown>> {
  const n = results(s.chatId).length;
  engine.send(s.chatId, { uuid: randomUUID(), text, ...(o.priority ? { priority: o.priority } : {}) });
  await waitFor(() => results(s.chatId).length > n, 120_000, 'result');
  return results(s.chatId)[n]!;
}
const inputOf = (u: unknown): number => { const t = usageTokens(u); return t.input + t.cacheRead + t.cacheWrite; };
const report: Record<string, unknown> = {};
const check = (id: string, ok: boolean, detail: Record<string, unknown>): void => { report[id] = { ok, ...detail }; console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail)}`); };

// ---------------------------------------------------------------- scenarios
async function s1(): Promise<void> {            // 3 requests: app T1, app T2, one `claude -p`
  if (!ONLY.has('S1') || !canAfford('S1', 3)) return;
  stepName = 'S1';
  const s = newChat('S1');
  if (!(await engine.ensure(s, { why: 'send' })).ok) throw new Error('S1 ensure failed');
  const r1 = await turn(s, 'Reply with exactly: OK');
  await engine.rename(s.chatId, 'SMOKE-LIVE-TITLE');
  await waitFor(() => of(s.chatId).some((f) => f['subtype'] === 'session_title_changed' && f['title'] === 'SMOKE-LIVE-TITLE'), 10_000, 'rename frame');
  const r2 = await turn(s, 'Reply with exactly: OK2');
  const before = readBudget().used;
  await turn(s, '/usage');                       // local command: 0 requests
  const usageFree = readBudget().used === before;
  const df = debugFiles.get(s.sessionId);
  const dbg = df && fs.existsSync(df) ? fs.readFileSync(df, 'utf8') : '';
  const titleCall = /generate_session_title|session[_ ]title/i.test(dbg.replace(/session_title_changed/g, ''));
  spend('S1-cli');
  const env = accountEnv(CFG, true);
  delete env['CLAUDE_AGENT_SDK_CLIENT_APP'];
  const cli = await execHidden(EXE!, ['-p', 'Reply with exactly: OK', '--model', MODEL, '--output-format', 'json'], { cwd: s.cwd, env, timeoutMs: 120_000 });
  const cj = JSON.parse(cli.stdout || '{}') as Record<string, unknown>;
  const iApp = inputOf(r1['usage']); const iCli = inputOf(cj['usage']);
  const u2 = usageTokens(r2['usage']);
  const aux = auxTokens(modelUsageTotal(r1['modelUsage']), modelUsageTotal(r2['modelUsage']), u2);
  // Lead decision (M3, measured 2026-10-09: t2 cacheWrite 2,203 / cacheRead 37,274; iApp 37,276 vs iCli 37,343):
// - turn 2 writes only the new turn content (≈ 2.2 k), never a re-cache of the ~37 k prefix → threshold 4,000;
// - parity reference = the CLI host lane; vs plain `claude -p` the delta is the 3 deferred interaction tools → |Δ| ≤ 100.
check('S1', !titleCall && u2.cacheWrite < 4_000 && u2.cacheRead > 30_000 && Math.abs(iApp - iCli) <= 100 && aux === 0 && usageFree,
    { titleCall, t2: u2, iApp, iCli, aux, usageFree, note: 'claudeMdExcludes off for this parity check' });
  await engine.sleep(s.chatId, 'user');
}
async function s2(): Promise<void> {            // 1 request: interrupt mid-stream
  if (!ONLY.has('S2') || !canAfford('S2', 1)) return;
  stepName = 'S2';
  const s = newChat('S2');
  await engine.ensure(s, { why: 'send' });
  engine.send(s.chatId, { uuid: randomUUID(), text: 'Count from 1 to 300, one number per line, nothing else.' });
  await waitFor(() => of(s.chatId).some((f) => f['type'] === 'stream_event' && (f['event'] as { type?: string })?.type === 'content_block_delta'), 60_000, 'first delta');
  await engine.interrupt(s.chatId);
  await waitFor(() => results(s.chatId).length > 0, 30_000, 'result');
  const r = results(s.chatId)[0]!;
  const t = usageTokens(r['usage']);
  check('S2', t.input + t.output + t.cacheRead + t.cacheWrite === 0 && engine.isLive(s.chatId), { terminal: r['terminal_reason'], usage: t, alive: engine.isLive(s.chatId) });
  await engine.sleep(s.chatId, 'user');
}
async function s3(): Promise<void> {            // 1 request: Write ask, allow « pour cette session », interrupt before the follow-up request
  if (!ONLY.has('S3') || !canAfford('S3', 1)) return;
  stepName = 'S3';
  const s = newChat('S3');
  const settings = path.join(CFG, 'settings.json');
  const mt = fs.existsSync(settings) ? fs.statSync(settings).mtimeMs : 0;
  await engine.ensure(s, { why: 'send' });
  engine.send(s.chatId, { uuid: randomUUID(), text: 'Use the Write tool to create smoke.txt containing OK. Do nothing else.' });
  await waitFor(() => pendingAsks.some((a) => a.chatId === s.chatId && a.toolName === 'Write'), 60_000, 'Write ask');
  const a = pendingAsks.find((x) => x.chatId === s.chatId && x.toolName === 'Write')!;
  engine.decide(s.chatId, a.requestId, { kind: 'allow-always', scope: 'session' });
  await waitFor(() => of(s.chatId).some((f) => f['subtype'] === 'status' && f['permissionMode'] === 'acceptEdits'), 10_000, 'mode echo');
  await engine.interrupt(s.chatId);
  const mt2 = fs.existsSync(settings) ? fs.statSync(settings).mtimeMs : 0;
  check('S3', mt === mt2, { modeEcho: 'acceptEdits', profileSettingsUnchanged: mt === mt2 });
  await engine.sleep(s.chatId, 'user');
}
async function s4(): Promise<void> {            // 1 request: background Bash under jobrun, then « Mettre en veille »
  if (!ONLY.has('S4') || !canAfford('S4', 1)) return;
  if (!JOBRUN) { console.log('SKIP S4: SMC_JOBRUN not set'); return; }
  stepName = 'S4';
  const s = newChat('S4', { mode: 'acceptEdits' });
  const pidFile = path.join(s.cwd, 'bg.pid').split(path.sep).join('/');
  await engine.ensure(s, { why: 'send' });
  engine.send(s.chatId, { uuid: randomUUID(), text: `Use the Bash tool with run_in_background true to run exactly: node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(()=>{},1e9)"` });
  await waitFor(() => pendingAsks.some((a) => a.chatId === s.chatId) || fs.existsSync(pidFile), 60_000, 'ask or pid');
  const ask = pendingAsks.find((a) => a.chatId === s.chatId);
  if (ask) engine.decide(s.chatId, ask.requestId, { kind: 'allow-once' });
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 30_000, 'bg pid');
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  const info = await engine.sleep(s.chatId, 'user');   // interrupt (the follow-up request) → input.end → exit; the job takes the bg node down
  await sleep(2_000);
  check('S4', !isPidAlive(pid), { bgPid: pid, exit: info?.reason, aliveAfter: isPidAlive(pid) });
  if (isPidAlive(pid)) try { process.kill(pid); } catch { /* gone */ }
}
async function s5(): Promise<void> {            // 2 requests: priority 'now' while streaming (records the behaviour, settles C17)
  if (!ONLY.has('S5') || !canAfford('S5', 2)) return;
  stepName = 'S5';
  const s = newChat('S5');
  await engine.ensure(s, { why: 'send' });
  await waitFor(() => engine.facts(s.chatId)?.phase === 'live', 45_000, 'live');
  const caps = engine.facts(s.chatId)?.capabilities ?? [];
  engine.send(s.chatId, { uuid: randomUUID(), text: 'Count from 1 to 300, one number per line, nothing else.' });
  await waitFor(() => of(s.chatId).some((f) => f['type'] === 'stream_event'), 60_000, 'streaming');
  await turn(s, 'Reply with exactly: NOW', { priority: 'now' }).catch(() => undefined);
  await waitFor(() => results(s.chatId).length >= 2, 60_000, 'two results').catch(() => undefined);
  check('S5', true, { capabilityNow: caps.includes('interrupt_send_now_v1'), results: results(s.chatId).map((r) => ({ sub: r['subtype'], terminal: r['terminal_reason'], text: String(r['result'] ?? '').slice(0, 40), uuids: r['user_message_uuids'] })) });
  await engine.sleep(s.chatId, 'user');
}
async function s6(): Promise<void> {            // opt-in: plan approval with the full id claude-haiku-5-5 (may bill Sonnet)
  if (!ONLY.has('S6') || !canAfford('S6', 2)) return;
  stepName = 'S6';
  const s = newChat('S6', { mode: 'plan', model: 'claude-haiku-5-5' });
  await engine.ensure(s, { why: 'send' });
  engine.send(s.chatId, { uuid: randomUUID(), text: 'Plan (do not execute) creating a file plan.txt containing OK, then call ExitPlanMode.' });
  await waitFor(() => pendingAsks.some((a) => a.chatId === s.chatId && a.kind === 'plan'), 120_000, 'plan ask');
  const models = [...new Set(of(s.chatId).filter((f) => f['type'] === 'assistant').map((f) => (f['message'] as { model?: string })?.model))];
  const a = pendingAsks.find((x) => x.chatId === s.chatId && x.kind === 'plan')!;
  engine.decide(s.chatId, a.requestId, { kind: 'plan-approve', nextMode: 'default' });
  await engine.interrupt(s.chatId);
  check('S6', !models.some((m) => /sonnet/i.test(m ?? '')), { planningModels: models });
  await engine.sleep(s.chatId, 'user');
}

try {
  console.log(`smoke: profile ${CFG}, scratch ${DIR}, budget ${readBudget().used}/${MAX_REQUESTS}, jobrun ${JOBRUN ?? 'none'}`);
  for (const step of [s1, s2, s3, s4, s5, s6]) {
    if (aborted) break;
    try { await step(); } catch (e) { check(step.name.toUpperCase(), false, { error: String(e) }); }
  }
} finally {
  await engine.shutdown(15_000);
  fs.writeFileSync(path.join(DIR, 'smoke-report.json'), JSON.stringify({ report, budget: readBudget() }, null, 1));
  fs.writeFileSync(path.join(DIR, 'smoke-log.json'), JSON.stringify(log.lines, null, 1));
  console.log(`smoke: budget used ${readBudget().used}/${MAX_REQUESTS}; report ${path.join(DIR, 'smoke-report.json')}`);
}
process.exit(Object.values(report).every((r) => (r as { ok: boolean }).ok) ? 0 : 1);
