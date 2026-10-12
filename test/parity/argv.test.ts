// test/parity/argv.test.ts — T-P2: argv / env NAMES / initialize captured by fake-claude behind the REAL SDK (SPEC §11). 0 tokens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LEAKY_ENV } from '../../src/server/engine/options.ts';
import { realEngine, waitFor, frames } from '../integration/engine/real-helpers.ts';
import type { SpawnSpec } from '../../src/server/contracts.ts';

type Rec = { kind: string; argv?: string[]; envNames?: string[]; env?: Record<string, string>; request?: Record<string, unknown> };
const E = realEngine('tp2');
E.engine.setPolicy({ maxLive: 8, reapMin: 60 });
const RECORD = path.join(E.dirs.root, 'record.jsonl');
process.env['SMC_FAKE_RECORD'] = RECORD;                     // passes accountEnv (not a leaky name); read by the fake only
after(async () => { delete process.env['SMC_FAKE_RECORD']; await E.dispose(); });

/** Spawns one chat, waits for init, returns the spawn record + the initialize request of that process. */
async function capture(p: Partial<SpawnSpec>): Promise<{ argv: string[]; names: string[]; env: Record<string, string>; init: Record<string, unknown> }> {
  fs.rmSync(RECORD, { force: true });
  const s = E.spec(p);
  assert.deepEqual(await E.engine.ensure(s, { why: 'prespawn' }), { ok: true, data: undefined });
  await waitFor(() => E.engine.facts(s.chatId)?.phase === 'live', 'live');
  const recs = fs.readFileSync(RECORD, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec);
  const sp = recs.find((r) => r.kind === 'spawn')!;
  const init = recs.find((r) => r.kind === 'control' && r.request?.['subtype'] === 'initialize')!.request!;
  await E.engine.sleep(s.chatId, 'user');
  return { argv: sp.argv!, names: sp.envNames!, env: sp.env!, init };
}
const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i < 0) return undefined;
  return argv[i]!.includes('=') ? argv[i]!.slice(name.length + 1) : argv[i + 1];
};
const SDK_ADDED = new Set(['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_SDK_READS_SESSION_STATE', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'CLAUDE_CONFIG_DIR']);

test('T-P2: new chat, non-default profile with excludes: exact flags, --settings, --session-id, clean env', async () => {
  const sid = randomUUID();
  const c = await capture({ sessionId: sid, chatId: `t:${sid}`, start: { kind: 'new', title: 'Titre' },
    account: { id: 't', configDir: E.dirs.cfg, claudeMdExcludes: ['C:/Users/X/.claude/CLAUDE.md'] } });
  assert.ok(c.argv.includes('--setting-sources=user,project,local') || flag(c.argv, '--setting-sources') === 'user,project,local', c.argv.join(' '));
  assert.equal(flag(c.argv, '--permission-mode'), 'default');
  assert.equal(flag(c.argv, '--permission-prompt-tool'), 'stdio');
  assert.ok(c.argv.includes('--include-partial-messages'));
  assert.equal(flag(c.argv, '--session-id'), sid);
  assert.deepEqual(JSON.parse(flag(c.argv, '--settings')!), { claudeMdExcludes: ['C:/Users/X/.claude/CLAUDE.md'] });
  assert.equal(flag(c.argv, '--model'), undefined);
  assert.equal(flag(c.argv, '--effort'), undefined);
  assert.equal(flag(c.argv, '--resume'), undefined);
  assert.equal(c.init['title'], 'Titre');
  assert.equal(c.init['systemPrompt'] === undefined || typeof c.init['systemPrompt'] === 'object' || typeof c.init['systemPrompt'] === 'string', true);
  for (const n of c.names) if (LEAKY_ENV.test(n)) assert.ok(SDK_ADDED.has(n), `leaked env name ${n}`);
  assert.equal(c.names.filter((n) => n.toUpperCase() === 'PATH').length, 1);
  assert.equal(c.env['CLAUDE_CONFIG_DIR'], E.dirs.cfg);
  assert.equal(c.env['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'], '1');
  assert.equal(c.env['CLAUDE_CODE_ENTRYPOINT'], 'sdk-ts');
  assert.match(c.env['CLAUDE_AGENT_SDK_CLIENT_APP']!, /^sidmulticlaude\//);
});

test('T-P2: default profile: no CLAUDE_CONFIG_DIR, no --settings; chosen model/effort only when picked', async () => {
  const c = await capture({ account: { id: 't', configDir: null, claudeMdExcludes: [] }, model: 'haiku', effort: 'low', mode: 'plan' });
  assert.equal('CLAUDE_CONFIG_DIR' in c.env, false);
  assert.equal(c.names.includes('CLAUDE_CONFIG_DIR'), false);
  assert.equal(flag(c.argv, '--settings'), undefined);
  assert.equal(flag(c.argv, '--model'), 'haiku');
  assert.equal(flag(c.argv, '--effort'), 'low');
  assert.equal(flag(c.argv, '--permission-mode'), 'plan');
});

test('T-P2: fork → --resume=<path> --fork-session --session-id; resume → --resume <id>', async () => {
  const src = E.spec();
  await E.engine.ensure(src, { why: 'send' });
  E.engine.send(src.chatId, { uuid: randomUUID(), text: 'ECHO:src' });
  await waitFor(() => frames(E.sink, src.chatId).some((f) => f['type'] === 'result'), 'result');
  await E.engine.sleep(src.chatId, 'user');
  const jsonl = path.join(E.dirs.cfg, 'projects', src.cwd.replace(/[^a-zA-Z0-9]/g, '-'), src.sessionId + '.jsonl');
  const fsid = randomUUID();
  const f = await capture({ sessionId: fsid, chatId: `t:${fsid}`, start: { kind: 'fork', fromJsonl: jsonl, title: 'Copie' } });
  assert.equal(flag(f.argv, '--resume'), jsonl);
  assert.ok(f.argv.includes('--fork-session'));
  assert.equal(flag(f.argv, '--session-id'), fsid);
  const r = await capture({ sessionId: src.sessionId, chatId: src.chatId, start: { kind: 'resume' } });
  assert.equal(flag(r.argv, '--resume'), src.sessionId);
  assert.equal(r.argv.includes('--fork-session'), false);
  assert.equal(flag(r.argv, '--session-id'), undefined);
});
