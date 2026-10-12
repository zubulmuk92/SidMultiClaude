// test/parity/options.test.ts — T-P1: options snapshot {new, resume, fork, rewind} × {default, non-default} × {bypass off, on} (SPEC §11).
// Regenerate (only after a deliberate change of src/server/engine/options.ts and a T-P3 run): SMC_UPDATE_SNAPSHOT=1 npm run test:parity
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { buildOptions } from '../../src/server/engine/options.ts';
import type { SpawnSpec, SpawnStart } from '../../src/server/contracts.ts';

const SNAP = path.join(import.meta.dirname, 'options.snapshot.json');
const SID = '11111111-2222-4333-8444-555555555555';
const starts: Record<string, SpawnStart> = {
  new: { kind: 'new', title: 'Nouveau chat' },
  resume: { kind: 'resume' },
  fork: { kind: 'fork', fromJsonl: 'C:/Users/X/.claude-pro/projects/C--work-p/aaaaaaaa-0000-4000-8000-000000000000.jsonl', title: 'Copie' },
  rewind: { kind: 'rewind', atUuid: 'bbbbbbbb-0000-4000-8000-000000000000', dropsTurn: 'cccccccc-0000-4000-8000-000000000000' },
};
const profiles = {
  default: { id: 'perso', configDir: null, claudeMdExcludes: [] as string[] },
  other: { id: 'acme', configDir: 'C:/Users/X/.claude-pro', claudeMdExcludes: ['C:/Users/X/.claude/CLAUDE.md', 'C:/Users/X/.claude/rules/**'] },
};
const fn = (): never => { throw new Error('unused'); };
const cb = { canUseTool: fn as never, spawnClaudeCodeProcess: fn as never, stderr: fn as never, onElicitation: fn as never };

/** Options made comparable: callbacks → '[fn]', env → only the keys the app sets (the rest is the machine's own env). */
function view(o: Options): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof v === 'function') out[k] = '[fn]';
    else if (k === 'env') out[k] = Object.fromEntries(Object.entries(v as Record<string, string>).filter(([e]) => /^(CLAUDE|ANTHROPIC)/i.test(e)).sort());
    else out[k] = v;
  }
  return out;
}
function matrix(): Record<string, Record<string, unknown>> {
  const m: Record<string, Record<string, unknown>> = {};
  for (const [sk, start] of Object.entries(starts)) for (const [pk, account] of Object.entries(profiles)) for (const bypass of [false, true]) {
    const s: SpawnSpec = { chatId: `${account.id}:${SID}`, sessionId: SID, cwd: 'C:/work/p', account, mode: bypass ? 'bypassPermissions' : 'default', start,
      allowBypass: bypass, aiTitles: false, exe: 'C:/Users/X/.local/bin/claude.exe', isolation: 'job' };
    m[`${sk}/${pk}/${bypass ? 'bypass' : 'nobypass'}`] = view(buildOptions(s, cb));
  }
  return m;
}

test('T-P1: buildOptions matrix equals test/parity/options.snapshot.json', () => {
  const m = matrix();
  assert.equal(Object.keys(m).length, 16);
  if (process.env['SMC_UPDATE_SNAPSHOT'] === '1' || !fs.existsSync(SNAP)) fs.writeFileSync(SNAP, JSON.stringify(m, null, 1) + '\n');
  assert.deepEqual(m, JSON.parse(fs.readFileSync(SNAP, 'utf8')));
});

test('T-P1: invariants of every entry (preset, sources, explicit mode, never-passed options)', () => {
  for (const [k, o] of Object.entries(matrix())) {
    assert.deepEqual(o['systemPrompt'], { type: 'preset', preset: 'claude_code' }, k);
    assert.deepEqual(o['settingSources'], ['user', 'project', 'local'], k);
    assert.ok(typeof o['permissionMode'] === 'string', k);
    assert.equal(o['includePartialMessages'], true, k);
    for (const banned of ['tools', 'allowedTools', 'disallowedTools', 'agents', 'mcpServers', 'plugins', 'hooks', 'skills', 'betas', 'thinking',
      'maxThinkingTokens', 'appendSystemPrompt', 'toolConfig', 'plansDirectory', 'promptSuggestions', 'agentProgressSummaries', 'sessionStore',
      'persistSession', 'continue', 'extraArgs', 'model', 'effort']) assert.equal(o[banned], undefined, `${k}: ${banned}`);
    const env = o['env'] as Record<string, string>;
    assert.equal(env['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'], '1', k);
    assert.equal('CLAUDE_CONFIG_DIR' in env, k.includes('/other/'), k);
    assert.equal(o['settings'] !== undefined, k.includes('/other/'), k);
    assert.equal(o['allowDangerouslySkipPermissions'] === true, k.endsWith('/bypass'), k);
    if (k.startsWith('fork/')) assert.equal(o['forkSession'], true, k);
    if (typeof o['resume'] === 'string' && /\.jsonl$/.test(o['resume'] as string)) assert.equal(o['forkSession'], true, k);
  }
});
