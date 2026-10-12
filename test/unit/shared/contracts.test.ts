// Self-check of the frozen contracts (options, environment, protocol types), split into cases.
// Type-checks against SDK 0.3.293 types AND runs under Node 24 type stripping (0 model calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptions, accountEnv, LEAKY_ENV, APP_UA } from '../../../src/server/engine/options.ts';
import type { SpawnSpec } from '../../../src/server/contracts.ts';
import type { C2S, S2C, AckData, UiAnswer, WireError } from '../../../src/shared/protocol.ts';

const base: SpawnSpec = {
  chatId: 'w:11111111-2222-4333-8444-555555555555', sessionId: '11111111-2222-4333-8444-555555555555',
  cwd: 'C:\\Users\\Jean Dupont\\Desktop\\SidMultiClaude',
  account: { id: 'w', configDir: 'C:\\Users\\Jean Dupont\\.claude-pro', claudeMdExcludes: ['C:/Users/Jean Dupont/.claude/CLAUDE.md', 'C:/Users/Jean Dupont/.claude/rules/**'] },
  mode: 'default', start: { kind: 'new' }, allowBypass: false, aiTitles: false,
  exe: 'C:\\Users\\Jean Dupont\\.local\\bin\\claude.exe', isolation: 'job',
};
const cb = { canUseTool: async () => ({ behavior: 'deny' as const, message: 'x' }), spawnClaudeCodeProcess: (() => { throw new Error('no'); }) as never, stderr: () => {} };

const fakeEnv = { Path: 'C:\\Windows', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: 'x', CLAUDE_EFFORT: 'max',
  ANTHROPIC_API_KEY: 'k', claude_code_session_id: 's', NODE_OPTIONS: '--x', TEMP: 'C:\\Users\\JEANDU~1\\AppData\\Local\\Temp' };

test('accountEnv: blacklist copy, default profile leaves CLAUDE_CONFIG_DIR unset, title switch', () => {
  const e1 = accountEnv(null, false, fakeEnv);
  assert.deepEqual(Object.keys(e1).sort(), ['CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'Path', 'TEMP']);
  const e2 = accountEnv('C:\\Users\\Jean Dupont\\.claude-pro', true, fakeEnv);
  assert.equal(e2.CLAUDE_CONFIG_DIR, 'C:\\Users\\Jean Dupont\\.claude-pro');
  assert.equal(e2.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, undefined);
  // extra checks around the same contract
  assert.equal(e1.CLAUDE_AGENT_SDK_CLIENT_APP, APP_UA);
  assert.equal(e1.TEMP, fakeEnv.TEMP, 'TEMP keeps its 8.3 form (terminal parity)');
  for (const k of ['CLAUDECODE', 'CLAUDE_EFFORT', 'ANTHROPIC_API_KEY', 'claude_code_session_id', 'NODE_OPTIONS', 'OTEL_X', 'AI_AGENT', 'DEBUG', 'ELECTRON_RUN_AS_NODE'])
    assert.ok(LEAKY_ENV.test(k), k);
  assert.ok(!LEAKY_ENV.test('Path') && !LEAKY_ENV.test('TEMP') && !LEAKY_ENV.test('HTTPS_PROXY'));
});

test('buildOptions: new chat on a non-default profile', () => {
  const n = buildOptions(base, cb);
  assert.equal(n.sessionId, base.sessionId); assert.equal(n.resume, undefined); assert.equal(n.title, undefined);
  assert.deepEqual(n.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(n.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(n.settings, { claudeMdExcludes: base.account.claudeMdExcludes });
  for (const k of ['model', 'effort', 'tools', 'allowedTools', 'mcpServers', 'agents', 'plugins', 'hooks', 'betas', 'thinking', 'plansDirectory', 'toolConfig', 'allowDangerouslySkipPermissions'])
    assert.equal((n as Record<string, unknown>)[k], undefined, k);
});

test('buildOptions: resume on the default profile', () => {
  const r = buildOptions({ ...base, account: { ...base.account, configDir: null, claudeMdExcludes: [] }, start: { kind: 'resume' } }, cb);
  assert.equal(r.resume, base.sessionId); assert.equal(r.sessionId, undefined); assert.equal(r.settings, undefined);
  assert.equal((r.env as Record<string, string>).CLAUDE_CONFIG_DIR, undefined);
});

test('buildOptions: fork and rewind', () => {
  const f = buildOptions({ ...base, start: { kind: 'fork', fromJsonl: 'C:\\x\\a.jsonl', title: 'T (bifurcation)' } }, cb);
  assert.equal(f.forkSession, true); assert.equal(f.resume, 'C:\\x\\a.jsonl'); assert.equal(f.sessionId, base.sessionId);
  const w = buildOptions({ ...base, start: { kind: 'rewind', atUuid: 'u1', dropsTurn: 'u2' } }, cb);
  assert.equal(w.resumeSessionAt, 'u1'); assert.equal(w.resumeDropsTurn, 'u2');
});

test('protocol unions are usable', () => {
  const c2s: C2S = { id: 1, t: 'chat.send', chatId: base.chatId, uuid: 'u', text: 'bonjour', priority: 'later' };
  const err: WireError = { code: 'cap', candidates: [{ chatId: 'w:x', title: 't', warmMin: 12, recacheTokens: 45_000, stable: false }] };
  const s2c: S2C[] = [{ t: 'ack', id: 1, ok: false, err }, { t: 'ack', id: 2, ok: true, data: { accepted: 'new' } satisfies AckData['chat.send'] }];
  const a: UiAnswer = { kind: 'allow-always', scope: 'session' };
  assert.ok(c2s && s2c.length === 2 && a);
});
