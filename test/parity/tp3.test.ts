// test/parity/tp3.test.ts — T-P3: request bodies of `claude.exe -p` vs the app engine against a MOCK Messages API (SPEC §11).
// 0 subscription tokens: scratch CLAUDE_CONFIG_DIR without credentials, a dummy API key and ANTHROPIC_BASE_URL → 127.0.0.1 mock.
// The env injection lives ONLY in this file (a QueryFn wrapper); production code strips ANTHROPIC_* (options.ts LEAKY_ENV).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../../src/server/contracts.ts';
import { makeEngine } from '../../src/server/engine/engine.ts';
import { createSpawner } from '../../src/server/engine/spawner.ts';
import { accountEnv } from '../../src/server/engine/options.ts';
import { installedClaudeExe } from '../../src/server/engine/exe.ts';
import { realClock } from '../../src/server/util/clock.ts';
import { execHidden } from '../../src/server/util/winproc.ts';
import { memoryLogger } from '../../src/server/util/log.ts';
import { recordingSink } from '../unit/engine/engine-helpers.ts';
import { waitFor, frames, REAL_SCRATCH } from '../integration/engine/real-helpers.ts';
import { jsonDiff, normalizeBody, startMockApi } from './mock-api.ts';
import type { MockReq } from './mock-api.ts';

const EXE = installedClaudeExe();
const PROMPT = 'Reply with exactly: OK';
const GATED = ['perTaskStopAffordance', 'enableFileCheckpointing', 'onElicitation'] as const;
let mock: Awaited<ReturnType<typeof startMockApi>>;
let base: string; let cfg: string; let cwd: string;
let inject: Record<string, string>;
const bodies: Record<string, MockReq[]> = {};

before(async () => {
  if (!EXE) return;
  mock = await startMockApi();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(REAL_SCRATCH, 'tp3-')));
  cfg = path.join(base, 'cfg'); cwd = path.join(base, 'cwd');
  fs.mkdirSync(cfg); fs.mkdirSync(cwd);
  inject = { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-mock-not-a-real-key' };   // TEST-ONLY
});
after(async () => {
  await mock?.close();
  if (base) for (const [k, v] of Object.entries(bodies)) fs.writeFileSync(path.join(base, `${k}.json`), JSON.stringify(v.map((r) => r.body), null, 1));
});

/** Runs one app turn through createEngine; `strip` removes the gated options (U1). Returns the /v1/messages requests of the run. */
async function appTurn(label: string, strip: boolean): Promise<MockReq[]> {
  const wrapped: QueryFn = ((a: { prompt: never; options?: Options }) => {
    const o: Options = { ...a.options, env: { ...a.options!.env, ...inject } };
    if (strip) for (const k of GATED) delete (o as Record<string, unknown>)[k];
    return query({ prompt: a.prompt, options: o });
  }) as QueryFn;
  const sink = recordingSink();
  const log = memoryLogger();
  const engine = makeEngine({ query: wrapped, clock: realClock, sink, log, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null,
    spawner: createSpawner({ jobrunPath: null, registryFile: path.join(base, label + '-children.json'), log }) });
  const sid = randomUUID();
  const chatId = `t:${sid}`;
  const from = mock.requests.length;
  const r = await engine.ensure({ chatId, sessionId: sid, cwd, account: { id: 't', configDir: cfg, claudeMdExcludes: [] }, mode: 'default',
    start: { kind: 'new', title: 'Parité' }, model: 'haiku', allowBypass: false, aiTitles: false, exe: EXE!, isolation: 'plain' }, { why: 'send' });
  assert.deepEqual(r, { ok: true, data: undefined }, JSON.stringify(log.lines.slice(-5)));
  engine.send(chatId, { uuid: randomUUID(), text: PROMPT });
  try {
    await waitFor(() => frames(sink, chatId).some((f) => f['type'] === 'result'), `${label} result`, 90_000);
  } catch (e) { throw new Error(`${e}: ${JSON.stringify(frames(sink, chatId).slice(-3)).slice(0, 800)} ${JSON.stringify(log.lines.slice(-5))}`); }
  const res = frames(sink, chatId).find((f) => f['type'] === 'result')!;
  assert.equal(res['subtype'], 'success', JSON.stringify(res).slice(0, 500));
  await engine.shutdown(15_000);
  const reqs = mock.requests.slice(from).filter((q) => q.method === 'POST' && /\/v1\/messages$/.test(q.path));
  bodies[label] = reqs;
  return reqs;
}
async function cliTurn(label: string, extra: string[]): Promise<MockReq[]> {
  const env = { ...accountEnv(cfg, true), ...inject };
  delete env['CLAUDE_AGENT_SDK_CLIENT_APP'];                    // a plain terminal: no app client id, no title switch
  const from = mock.requests.length;
  const r = await execHidden(EXE!, ['-p', PROMPT, '--model', 'haiku', ...extra], { cwd, env, timeoutMs: 90_000 });
  assert.equal(r.code, 0, `claude -p exit ${r.code}: ${r.stderr.slice(0, 400)}`);
  const reqs = mock.requests.slice(from).filter((q) => q.method === 'POST' && /\/v1\/messages$/.test(q.path));
  bodies[label] = reqs;
  return reqs;
}
/** The known, accepted difference besides the billing header: Bash/Monitor tool description timeout text. */
/** Allowed: inside the Bash / PowerShell / Monitor tool entries, strings that differ only by their numbers (10 vs 30 min timeouts). */
let currentToolNames: (i: number) => string | undefined = () => undefined;
const allowed = (p: string, a: unknown, b: unknown): boolean => {
  const m = /^\$\.tools\[(\d+)\]\./.exec(p);
  if (!m || !['Bash', 'PowerShell', 'Monitor'].includes(currentToolNames(Number(m[1])) ?? '')) return false;
  return typeof a === 'string' && typeof b === 'string' && a.replace(/\d[\d,_]*/g, '#') === b.replace(/\d[\d,_]*/g, '#');
};
const valueAt = (o: unknown, p: string): unknown => p.replace(/^\$/, '').split(/\.|\[|\]/).filter(Boolean).reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);

/** Tools the CLI adds only when a host answers permission prompts (--permission-prompt-tool stdio), as in the interactive TUI. */
const INTERACTIVE_TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
const withoutTools = (b: unknown, names: readonly string[]): unknown => {
  const o = b as { tools?: { name: string }[] };
  return { ...o, tools: (o.tools ?? []).filter((x) => !names.includes(x.name)) };
};
function diffBodies(c: unknown, a: unknown): string[] {
  const cn = normalizeBody(c); const an = normalizeBody(a);
  currentToolNames = (i) => ((cn as { tools?: { name: string }[] }).tools ?? [])[i]?.name;
  return jsonDiff(cn, an).filter((p) => !allowed(p, valueAt(cn, p), valueAt(an, p)));
}

test('T-P3: one /v1/messages per app turn; body equals the CLI headless lane (-p, stream-json, stdio prompts)', { skip: EXE ? false : 'claude.exe not installed', timeout: 300_000 }, async (t) => {
  const cli = await cliTurn('cli-sdklane', ['--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio']);
  const app = await appTurn('app', false);
  t.diagnostic(`requests: cli ${cli.length}, app ${app.length}; app models ${app.map((r) => r.body?.['model']).join(',')}`);
  assert.equal(app.length, 1, `app made ${app.length} /v1/messages requests`);
  assert.equal(cli.length, 1, `cli made ${cli.length} /v1/messages requests`);
  const diff = diffBodies(cli[0]!.body, app[0]!.body);
  t.diagnostic(`body diff paths (after billing header + timeout text): ${JSON.stringify(diff).slice(0, 1500)}`);
  assert.deepEqual(diff, []);
});

test('T-P3: vs plain `claude -p --model haiku`: only thinking.display and the 3 interactive tools differ (reported, see WP-A notes)', { skip: EXE ? false : 'claude.exe not installed', timeout: 300_000 }, async (t) => {
  const cli = await cliTurn('cli-plain', []);
  const app = bodies['app'] ?? await appTurn('app', false);
  assert.equal(cli.length, 1);
  const a = app[0]!.body as { tools: { name: string }[]; thinking: { display?: string } };
  const extra = a.tools.filter((x) => INTERACTIVE_TOOLS.includes(x.name));
  t.diagnostic(`interactive tools present only in the app: ${extra.map((x) => x.name).join(', ')} = ${JSON.stringify(extra).length} chars; thinking.display ${(cli[0]!.body as typeof a).thinking.display} → ${a.thinking.display}`);
  const diff = diffBodies(withoutTools(cli[0]!.body, INTERACTIVE_TOOLS), withoutTools(app[0]!.body, INTERACTIVE_TOOLS)).filter((p) => p !== '$.thinking.display');
  assert.deepEqual(diff, []);
});

test('T-P3: bodies identical with and without perTaskStopAffordance / enableFileCheckpointing / onElicitation', { skip: EXE ? false : 'claude.exe not installed', timeout: 300_000 }, async (t) => {
  const full = bodies['app'] ?? await appTurn('app', false);
  const bare = await appTurn('bare', true);
  assert.equal(bare.length, 1);
  const diff = jsonDiff(normalizeBody(full[0]!.body), normalizeBody(bare[0]!.body));
  t.diagnostic(`gated-options diff: ${JSON.stringify(diff).slice(0, 1500)}`);
  assert.deepEqual(diff, [], 'a gated option changes the request body: drop it from options.ts and update T-P1');
});
