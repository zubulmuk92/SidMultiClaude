// test/unit/claude/sdk-helpers.test.ts — SdkHelpers: one mutex, CLAUDE_CONFIG_DIR set/deleted then restored (real SDK on
// tmp profiles only: renameSession / forkSession / deleteSession are local file operations, 0 tokens).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createSdkHelpers } from '../../../src/server/claude/sdk-helpers.ts';
import type { SessionSdk } from '../../../src/server/claude/sdk-helpers.ts';
import type { Account } from '../../../src/server/contracts.ts';
import { nullLogger } from '../../../src/server/util/log.ts';

const root = createTmpRoot('wpc-sdk');
after(() => root.dispose());
const ENV0 = process.env['CLAUDE_CONFIG_DIR'];
const accOf = (id: string, configDir: string | null): Account => ({ id, name: id, color: 1, monogram: id[0]!.toUpperCase(), configDir, hidden: false, excludeForeignClaudeMd: !!configDir, resumeStable: null, defaults: {} });
const lastTitle = (file: string): string | undefined => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"custom-title"')).map((l) => (JSON.parse(l) as { customTitle: string }).customTitle).at(-1);

test('20 interleaved cross-account renames: 0 mix-ups, env restored (real SDK)', async () => {
  const pa = root.profile('a');
  const pb = root.profile('b');
  const A = accOf('a', pa.configDir);
  const B = accOf('b', pb.configDir);
  const sa = Array.from({ length: 10 }, (_, i) => pa.addSession({ cwd: root.cwd(`a${i % 3}`), title: `orig a${i}` }));
  const sb = Array.from({ length: 10 }, (_, i) => pb.addSession({ cwd: root.cwd(`b${i % 3}`), title: `orig b${i}` }));
  const h = createSdkHelpers({ log: nullLogger });
  const ops: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) { ops.push(h.rename(A, sa[i]!.sessionId, `Compte A n°${i}`)); ops.push(h.rename(B, sb[i]!.sessionId, `Compte B n°${i}`)); }
  await Promise.all(ops);
  for (let i = 0; i < 10; i++) {
    assert.equal(lastTitle(sa[i]!.path), `Compte A n°${i}`);
    assert.equal(lastTitle(sb[i]!.path), `Compte B n°${i}`);
  }
  assert.equal(process.env['CLAUDE_CONFIG_DIR'], ENV0);
  // fork up to the first prompt, then delete the fork
  const firstUser = sa[0]!.entries.find((e) => e['type'] === 'user')!['uuid'] as string;
  const forkId = await h.forkUpTo(A, sa[0]!.sessionId, firstUser, 'Branche');
  assert.match(forkId, /^[0-9a-f-]{36}$/);
  const forkFile = path.join(path.dirname(sa[0]!.path), `${forkId}.jsonl`);
  assert.ok(fs.existsSync(forkFile));
  assert.equal(lastTitle(forkFile), 'Branche');
  await h.remove(A, forkId);
  assert.equal(fs.existsSync(forkFile), false);
  await assert.rejects(h.rename(B, sa[1]!.sessionId, 'mauvais compte'));    // A's session is not visible from B
  assert.equal(process.env['CLAUDE_CONFIG_DIR'], ENV0);
});

test('default profile: the variable is DELETED during the call; restored after errors', async () => {
  const seen: (string | undefined)[] = [];
  const fake: SessionSdk = {
    async renameSession() { seen.push(process.env['CLAUDE_CONFIG_DIR']); await new Promise((r) => setTimeout(r, 5)); seen.push(process.env['CLAUDE_CONFIG_DIR']); },
    async deleteSession() { seen.push(process.env['CLAUDE_CONFIG_DIR']); throw new Error('boom'); },
    async forkSession() { return { sessionId: '33333333-0000-4000-8000-000000000003' }; },
  };
  const h = createSdkHelpers({ log: nullLogger, load: async () => fake });
  const D = accOf('perso', null);
  const W = accOf('w', 'X:\\profil-w');
  process.env['CLAUDE_CONFIG_DIR'] = 'Y:\\parent';
  try {
    await Promise.all([h.rename(D, 's', 't'), h.rename(W, 's', 't'), h.remove(D, 's').catch(() => undefined), h.rename(D, 's', 't')]);
    assert.deepEqual(seen, [undefined, undefined, 'X:\\profil-w', 'X:\\profil-w', undefined, undefined, undefined]);
    assert.equal(process.env['CLAUDE_CONFIG_DIR'], 'Y:\\parent');
    delete process.env['CLAUDE_CONFIG_DIR'];
    await h.rename(W, 's', 't');
    assert.equal('CLAUDE_CONFIG_DIR' in process.env, false);
    assert.equal(await h.forkUpTo(W, 's', 'u', 't'), '33333333-0000-4000-8000-000000000003');
  } finally { if (ENV0 === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = ENV0; }
});
