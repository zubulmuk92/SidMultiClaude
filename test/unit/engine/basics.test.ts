// test/unit/engine/basics.test.ts — InputQueue, ctl() wrapper, options/env builders (SPEC §2.2, §2.3, §5.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createInputQueue, InputClosedError } from '../../../src/server/engine/input-queue.ts';
import { ctl, ctlMethod, EngineError, hasMethod } from '../../../src/server/engine/ctl.ts';
import { accountEnv, buildOptions, LEAKY_ENV } from '../../../src/server/engine/options.ts';
import { assertSafeOptions } from '../../../src/server/engine/chat-process.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';
import type { SpawnSpec } from '../../../src/server/contracts.ts';

const msg = (t: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '', uuid: crypto.randomUUID() as SDKUserMessage['uuid'] });

test('InputQueue: buffered and awaited pushes, end drains waiters, push after end throws', async () => {
  const q = createInputQueue();
  q.push(msg('a'));
  const it = q[Symbol.asyncIterator]();
  assert.equal(((await it.next()).value as SDKUserMessage).message.content, 'a');
  const p = it.next();
  q.push(msg('b'));
  assert.equal(((await p).value as SDKUserMessage).message.content, 'b');
  const p2 = it.next();
  q.end();
  assert.equal((await p2).done, true);
  assert.equal(q.ended, true);
  assert.throws(() => q.push(msg('c')), InputClosedError);
});

test('ctl: resolves, maps failures to EngineError, times out on the fake clock, never hangs', async () => {
  const clock = createFakeClock();
  assert.equal(await ctl('ok', async () => 7, 10_000, clock), 7);
  await assert.rejects(ctl('bad', async () => { throw new Error('boom'); }, 10_000, clock), (e: unknown) => e instanceof EngineError && e.code === 'internal');
  const hang = ctl('hang', () => new Promise<never>(() => {}), 10_000, clock);
  clock.advance(10_000);
  await assert.rejects(hang, (e: unknown) => e instanceof EngineError && e.code === 'timeout');
  assert.equal(clock.pending(), 0);
});

test('ctlMethod: missing runtime-only method → unsupported; present → called with args', async () => {
  const q = { renameSession: async (t: string, s: string) => `${t}/${s}` };
  assert.equal(hasMethod(q, 'renameSession'), true);
  assert.equal(await ctlMethod(q, 'renameSession', ['T', 'S']), 'T/S');
  await assert.rejects(ctlMethod(q, 'cancelAsyncMessage', ['u']), (e: unknown) => e instanceof EngineError && e.code === 'unsupported');
});

const spec = (o: Partial<SpawnSpec> = {}): SpawnSpec => ({
  chatId: 'perso:11111111-1111-4111-8111-111111111111', sessionId: '11111111-1111-4111-8111-111111111111', cwd: 'C:/work/p',
  account: { id: 'perso', configDir: null, claudeMdExcludes: [] }, mode: 'default', start: { kind: 'new' }, allowBypass: false, aiTitles: false,
  exe: 'C:/x/claude.exe', isolation: 'plain', ...o,
});
const cb = { canUseTool: async () => ({ behavior: 'allow' as const, updatedInput: {} }), spawnClaudeCodeProcess: (() => { throw new Error('x'); }) as never, stderr: () => {} };

test('accountEnv: strips the parent session, sets the title switch and client id, CLAUDE_CONFIG_DIR only for non-default (S12)', () => {
  const base = { Path: 'C:/Windows', TEMP: 'C:/Users/JEANDU~1/AppData/Local/Temp', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', claude_config_dir: 'x',
    ANTHROPIC_API_KEY: 'k', OTEL_X: '1', NODE_OPTIONS: '--x', DEBUG: '1', AI_AGENT: 'y', ELECTRON_RUN_AS_NODE: '1', HOME: 'h' };
  const e = accountEnv(null, false, base);
  for (const k of Object.keys(e)) assert.ok(!LEAKY_ENV.test(k) || ['CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'CLAUDE_AGENT_SDK_CLIENT_APP'].includes(k), k);
  assert.equal(e['CLAUDE_CONFIG_DIR'], undefined);
  assert.equal(e['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'], '1');
  assert.match(e['CLAUDE_AGENT_SDK_CLIENT_APP']!, /^sidmulticlaude\//);
  assert.equal(e['TEMP'], base.TEMP);                                   // 8.3 kept for terminal parity
  assert.equal(Object.keys(e).filter((k) => k.toUpperCase() === 'PATH').length, 1);
  const e2 = accountEnv('C:/Users/X/.claude-pro', true, base);
  assert.equal(e2['CLAUDE_CONFIG_DIR'], 'C:/Users/X/.claude-pro');
  assert.equal(e2['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'], undefined);
});

test('buildOptions: forbidden resume=<.jsonl> without forkSession is refused; fork/resume/rewind shapes', () => {
  const o = buildOptions(spec({ start: { kind: 'fork', fromJsonl: 'C:/p/a.jsonl', title: 'T' } }), cb);
  assertSafeOptions(o);
  assert.equal(o.forkSession, true);
  assert.equal(o.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.throws(() => assertSafeOptions({ ...o, forkSession: false }), (e: unknown) => e instanceof EngineError && e.code === 'invalid');
  const r = buildOptions(spec({ start: { kind: 'rewind', atUuid: 'u1', dropsTurn: 'u2' } }), cb);
  assert.deepEqual([r.resume, r.resumeSessionAt, r.resumeDropsTurn], ['11111111-1111-4111-8111-111111111111', 'u1', 'u2']);
  const n = buildOptions(spec(), cb);
  assert.equal(n.model, undefined); assert.equal(n.effort, undefined); assert.equal(n.settings, undefined); assert.equal(n.allowDangerouslySkipPermissions, undefined);
  for (const k of ['tools', 'allowedTools', 'disallowedTools', 'agents', 'mcpServers', 'plugins', 'hooks', 'betas', 'thinking', 'maxThinkingTokens', 'plansDirectory', 'promptSuggestions', 'agentProgressSummaries', 'sessionStore', 'persistSession', 'continue', 'extraArgs']) {
    assert.equal((n as Record<string, unknown>)[k], undefined, k);
  }
});
