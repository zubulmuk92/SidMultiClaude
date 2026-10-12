// test/unit/claude/history.test.ts — PromptHistory: app prompts.jsonl (rotated) + read-only terminal history.jsonl.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createPromptHistory } from '../../../src/server/claude/history.ts';
import { appPaths } from '../../../src/server/util/paths.ts';
import { PROMPTS_MAX_LINES } from '../../../src/shared/limits.ts';
import { makeStore } from './lib.ts';

const root = createTmpRoot('wpc-hist');
const pro = root.profile('pro');
const { store, guard } = await makeStore(root);
const acc = await store.add({ configDir: pro.configDir, name: 'W', color: 2, monogram: 'W' });
after(async () => { store.close(); await root.disposeAsync(); });

const X = root.cwd('ProjetX');
const Y = root.cwd('ProjetY');
const SA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SB = 'bbbbbbbb-0000-4000-8000-00000000000b';
const A = `${acc.id}:${SA}`;
const B = `${acc.id}:${SB}`;
const cwdOf = (c: string): string | undefined => (c === A ? X : c === B ? Y : undefined);

test('merge newest first, filter by normalised project path or session, dedupe on text', async () => {
  pro.addHistory([
    { display: 'terminal X ancien', project: X.toLowerCase().replaceAll('\\', '/'), sessionId: 'cccccccc-0000-4000-8000-00000000000c', timestamp: 1000 },
    { display: 'terminal Y', project: Y, sessionId: 'dddddddd-0000-4000-8000-00000000000d', timestamp: 2000 },
    { display: 'même texte', project: X, sessionId: SA, timestamp: 3000 },
    { display: 'terminal autre projet, même session', project: 'C:\\ailleurs', sessionId: SA, timestamp: 3500 },
  ]);
  const h = createPromptHistory({ accounts: store, appDir: root.appDir, guard, cwdOf });
  h.append(A, 'app A un', 4000);
  h.append(B, 'app B', 5000);
  h.append(A, 'même texte', 6000);
  h.append(A, '   ', 7000);                                            // blank: ignored
  await h.flush();
  const hits = await h.search('', A);
  assert.deepEqual(hits.map((x) => [x.text, x.source]), [
    ['même texte', 'app'], ['app A un', 'app'], ['terminal autre projet, même session', 'terminal'], ['terminal X ancien', 'terminal'],
  ]);
  assert.equal(hits[0]!.chatId, A);
  assert.deepEqual((await h.search('TERMINAL', A)).map((x) => x.text), ['terminal autre projet, même session', 'terminal X ancien']);
  assert.equal((await h.search('')).length, 6);                          // no chat: every source, deduplicated
  const h2 = createPromptHistory({ accounts: store, appDir: root.appDir, guard, cwdOf });
  assert.deepEqual((await h2.search('app', A)).map((x) => x.text), ['app A un']);   // reloaded from prompts.jsonl
});

test('prompts.jsonl is rotated to 5,000 lines', async () => {
  const h = createPromptHistory({ accounts: store, appDir: root.appDir, guard });
  for (let i = 0; i < PROMPTS_MAX_LINES + 600; i++) h.append(B, `p${i}`, 10_000 + i);
  await h.flush();
  const lines = fs.readFileSync(appPaths(root.appDir).prompts, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= PROMPTS_MAX_LINES + 500 && lines.length >= PROMPTS_MAX_LINES, String(lines.length));
  assert.match(lines.at(-1)!, /"p5599"/);
});
