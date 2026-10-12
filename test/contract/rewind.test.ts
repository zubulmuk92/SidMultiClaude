// test/contract/rewind.test.ts — the REAL claude.exe refuses a truncating resume whose --resume-drops-turn does not match, and the
// engine falls back to a plain resume of the same session (SPEC §2.1, rewind row). 0 tokens: a logged-out scratch profile, a
// crafted 4-entry transcript, and no prompt is ever sent (a rewind spawn is a pre-spawn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnSpec } from '../../src/server/contracts.ts';
import { makeEngine } from '../../src/server/engine/engine.ts';
import { createSpawner } from '../../src/server/engine/spawner.ts';
import { installedClaudeExe } from '../../src/server/engine/exe.ts';
import { realClock } from '../../src/server/util/clock.ts';
import { memoryLogger } from '../../src/server/util/log.ts';
import { recordingSink } from '../unit/engine/engine-helpers.ts';
import { REAL_SCRATCH, waitFor, frames } from '../integration/engine/real-helpers.ts';

const EXE = installedClaudeExe();

/** A scratch profile holding one 2-turn transcript (u1 → a1 → u2 → a2) for `cwd`. */
function transcript(root: string): { cfg: string; cwd: string; sid: string; u1: string; a1: string; u2: string } {
  const cfg = path.join(root, 'cfg'); const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cfg, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const cwdR = fs.realpathSync.native(cwd);
  const sid = randomUUID(); const [u1, a1, u2, a2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const base = { isSidechain: false, userType: 'external', cwd: cwdR, sessionId: sid, version: '2.1.294', gitBranch: 'HEAD', entrypoint: 'sdk-ts' };
  const at = (): string => new Date().toISOString();
  const user = (uuid: string, parentUuid: string | null, t: string) => ({ parentUuid, ...base, type: 'user', message: { role: 'user', content: t }, uuid, timestamp: at() });
  const asst = (uuid: string, parentUuid: string, t: string) => ({ parentUuid, ...base, type: 'assistant', uuid, timestamp: at(),
    message: { id: 'msg_' + uuid.slice(0, 8), type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: t }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  const proj = path.join(cfg, 'projects', cwdR.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, sid + '.jsonl'), [user(u1, null, 'one'), asst(a1, u1, 'r1'), user(u2, a1, 'two'), asst(a2, u2, 'r2')].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { cfg: fs.realpathSync.native(cfg), cwd: cwdR, sid, u1, a1, u2 };
}

test('rewind on the real CLI: a refused --resume-drops-turn falls back to a plain resume (rewind_fallback); a valid one goes live',
  { skip: EXE ? false : 'claude.exe not installed', timeout: 120_000 }, async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(REAL_SCRATCH, 'rw-')));
    const sink = recordingSink(); const log = memoryLogger();
    const engine = makeEngine({ query, clock: realClock, sink, log, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null,
      spawner: createSpawner({ jobrunPath: null, registryFile: path.join(root, 'children.json'), log }) });
    try {
      const t = transcript(root);
      const spec = (dropsTurn: string): SpawnSpec => ({ chatId: `k:${t.sid}`, sessionId: t.sid, cwd: t.cwd, account: { id: 'k', configDir: t.cfg, claudeMdExcludes: [] },
        mode: 'default', start: { kind: 'rewind', atUuid: t.a1, dropsTurn }, allowBypass: false, aiTitles: false, exe: EXE!, isolation: 'plain' });
      const c = `k:${t.sid}`;
      // refused: u1 is not the turn that follows a1
      assert.deepEqual(await engine.ensure(spec(t.u1), { why: 'rewind' }), { ok: true, data: undefined });
      await waitFor(() => frames(sink, c).some((f) => f['subtype'] === 'rewind_fallback') && engine.facts(c)?.phase === 'live', 'fallback live', 60_000);
      const refusal = frames(sink, c).find((f) => f['type'] === 'result');
      assert.match(String((refusal?.['errors'] as string[] | undefined)?.[0]), /^Resume rejected by --resume-drops-turn:/);
      assert.equal(sink.log.filter((r) => r.k === 'exited').length, 0);
      assert.equal((await engine.sleep(c, 'user'))?.reason, 'closed');
      sink.log.length = 0;
      // valid: u2 is the turn that follows a1
      assert.deepEqual(await engine.ensure(spec(t.u2), { why: 'rewind' }), { ok: true, data: undefined });
      await waitFor(() => engine.facts(c)?.phase === 'live' || !engine.isLive(c), 'valid rewind', 60_000);
      assert.equal(engine.facts(c)?.phase, 'live');
      assert.equal(frames(sink, c).some((f) => f['subtype'] === 'rewind_fallback'), false);
      await engine.sleep(c, 'user');
    } finally {
      await engine.shutdown(15_000);
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* busy files */ }
    }
  });
