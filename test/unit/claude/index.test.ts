// test/unit/claude/index.test.ts — SessionIndex: fields, skips, speed (cold / cached), watchers, live chats, oracle (opt-in).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createSessionIndex } from '../../../src/server/claude/session-index.ts';
import type { SessionIndexExt } from '../../../src/server/claude/session-index.ts';
import type { SessionMeta } from '../../../src/server/contracts.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { appPaths, projectKey } from '../../../src/server/util/paths.ts';
import { makeStore, realishClock, until } from './lib.ts';
import type { E } from './lib.ts';
import { budget, timed, timedText, within } from '../../helpers/perf.ts';

const root = createTmpRoot('wpc-index');
const pro = root.profile('pro');
const { store, guard } = await makeStore(root);
const acc = await store.add({ configDir: pro.configDir, name: 'ACME', color: 2, monogram: 'A' });
const cacheDir = appPaths(root.appDir).cacheDir;
const open: SessionIndexExt[] = [];
const newIndex = (): SessionIndexExt => { const i = createSessionIndex({ accounts: store, cacheDir, log: nullLogger, clock: realishClock, guard }); open.push(i); return i; };
after(async () => { for (const i of open) await i.close(); store.close(); await root.disposeAsync(); });

const cwd = root.cwd('demo');
const lastTs = (entries: E[]): number => Date.parse(String(entries.filter((e) => e['type'] === 'user' || e['type'] === 'assistant').at(-1)!['timestamp']));

const s1 = pro.addSession({ cwd, title: 'Titre perso', entrypoint: 'cli', lastMode: 'plan', costUsd: 0.42, ownerAccountUuid: '00000000-0000-4000-8000-0000000000ff', gitBranch: 'feat/x',
  turns: [{ user: 'Première question', assistant: 'ok' }, { user: 'Deuxième question', assistant: 'ok', usage: { input: 5, cacheRead: 1000, cacheWrite: 50 } }],
  extraEntries: [{ type: 'pr-link', prNumber: 1, prUrl: 'https://example.invalid/pr/1', prRepository: 'x/y', timestamp: '2030-01-01T00:00:00.000Z', sessionId: 'x' },
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2030-01-01T00:00:00.000Z' }] });
const s2 = pro.addSession({ cwd, aiTitle: 'Titre IA', entrypoint: 'sdk-ts', turns: [{ user: 'Bonjour', error: 'rate_limit', resetsAt: 1_790_000_000 }] });
const s3 = pro.addSession({ cwd, sidecarTitle: 'Titre sidecar', entrypoint: 'claude-desktop', turns: [{ user: 'Salut', assistant: 'ok' }] });
const s4 = pro.addSession({ cwd, entrypoint: 'sdk-py', turns: [{ user: 'Juste un prompt', assistant: 'ok' }] });
const projDir = path.join(pro.paths.projectsDir, projectKey(cwd));
fs.writeFileSync(path.join(projDir, '22222222-0000-4000-8000-000000000001.jsonl'), JSON.stringify({ parentUuid: null, isSidechain: true, type: 'user', uuid: 'a', message: { role: 'user', content: 'side' } }) + '\n');
fs.writeFileSync(path.join(projDir, '22222222-0000-4000-8000-000000000002.jsonl'), JSON.stringify({ type: 'custom-title', customTitle: 'vide' }) + '\n');
fs.writeFileSync(path.join(projDir, 'not-a-session.jsonl'), '{}\n');

let index: SessionIndexExt;
const get = (sid: string): SessionMeta => index.get(`${acc.id}:${sid}`)!;

test('fields: titles by priority, origin, mode, cost, owner, error, context; skips sidechain / empty files', async () => {
  index = newIndex();
  await index.start();
  assert.equal(index.list(acc.id).length, 4);
  const m1 = get(s1.sessionId);
  assert.equal(m1.title, 'Titre perso'); assert.equal(m1.titleSource, 'custom');
  assert.equal(m1.origin, 'cli'); assert.equal(m1.lastMode, 'plan'); assert.equal(m1.costUsd, 0.42);
  assert.equal(m1.ownerAccountUuid, '00000000-0000-4000-8000-0000000000ff');
  assert.equal(m1.firstPrompt, 'Première question'); assert.equal(m1.branch, 'feat/x');
  assert.equal(m1.cwd, cwd); assert.equal(m1.path, s1.path);
  assert.equal(m1.updatedAt, lastTs(s1.entries));                     // trailing metadata timestamps (2030) ignored
  assert.equal(m1.lastRequestAt, lastTs(s1.entries));
  assert.equal(m1.lastContext, 1055);
  const m2 = get(s2.sessionId);
  assert.equal(m2.title, 'Titre IA'); assert.equal(m2.titleSource, 'ai'); assert.equal(m2.origin, 'app');
  assert.deepEqual(m2.lastError, { kind: 'rate_limit', resetsAt: 1_790_000_000_000 });
  const m3 = get(s3.sessionId);
  assert.equal(m3.title, 'Titre sidecar'); assert.equal(m3.origin, 'desktop');
  const m4 = get(s4.sessionId);
  assert.equal(m4.titleSource, 'lastPrompt'); assert.equal(m4.title, 'Juste un prompt'); assert.equal(m4.origin, 'other');
});

test('watchers: append, sidecar title, new file and deletion react in < 500 ms', async () => {
  const events: { up: SessionMeta[]; rm: string[] }[] = [];
  index.onChange((up, rm) => events.push({ up, rm }));
  fs.appendFileSync(s4.path, JSON.stringify({ type: 'custom-title', customTitle: 'Renommé', sessionId: s4.sessionId }) + '\n');
  const ms = await until(() => get(s4.sessionId).title === 'Renommé', 2000);
  assert.ok(ms < budget(500), `append seen in ${ms.toFixed(0)} ms`);
  fs.mkdirSync(path.join(projDir, s3.sessionId), { recursive: true });
  fs.writeFileSync(path.join(projDir, s3.sessionId, 'custom-title.json'), JSON.stringify({ customTitle: 'Sidecar 2' }));
  await until(() => get(s3.sessionId).title === 'Sidecar 2', 2000);
  const s5 = pro.addSession({ cwd: root.cwd('autre'), turns: [{ user: 'Nouveau', assistant: 'ok' }] });
  await until(() => !!get(s5.sessionId), 2000);
  fs.rmSync(s5.path);
  await until(() => !get(s5.sessionId), 2000);
  assert.ok(events.some((e) => e.rm.includes(`${acc.id}:${s5.sessionId}`)));
});

test('live app chats: only mtimeMs / size refresh', async () => {
  const chatId = `${acc.id}:${s2.sessionId}`;
  index.setLive(new Set([chatId]));
  const before = get(s2.sessionId);
  fs.appendFileSync(s2.path, JSON.stringify({ type: 'custom-title', customTitle: 'Ne doit pas apparaître', sessionId: s2.sessionId }) + '\n');
  await until(() => get(s2.sessionId).size !== before.size, 2000);
  assert.equal(get(s2.sessionId).title, 'Titre IA');
  await index.reconcile(acc.id);
  assert.equal(get(s2.sessionId).title, 'Titre IA');                    // signature unchanged: reconcile is stat-only
  index.setLive(new Set());                                              // no longer live: re-read once
  await until(() => get(s2.sessionId).title === 'Ne doit pas apparaître', 2000);
});

test('speed: 110 files cold < 400 ms, < 60 ms from the cache', async () => {
  const many = root.profile('many');
  for (let i = 0; i < 110; i++) many.addSession({ cwd: root.cwd(`p${i % 12}`), title: `Chat ${i}`, turns: [{ user: `Q${i}`, assistant: 'R' }, { user: 'Encore', assistant: 'R', tool: { name: 'Bash', input: { command: 'dir' }, result: 'x'.repeat(30_000) } }] });
  const a2 = await store.add({ configDir: many.configDir, name: 'Many', color: 3, monogram: 'M' });
  await index.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const cold = newIndex();
  let coldT = await timed(() => cold.start());
  assert.equal(cold.list(a2.id).length, 110);
  await cold.close();
  // the cache: one slot per file path, keyed by (mtimeMs, size, birthtimeMs), with the meta (texts cut to 200 chars)
  const cache = JSON.parse(fs.readFileSync(path.join(cacheDir, `index-${a2.id}.json`), 'utf8')) as { v: number; data: { files: Record<string, { mtimeMs: number; size: number; birthtimeMs: number; meta?: SessionMeta }> } };
  const slots = Object.entries(cache.data.files);
  assert.equal(slots.length, 110);
  for (const [file, s] of slots) {
    const st = fs.statSync(file);
    assert.deepEqual([s.mtimeMs, s.size, s.birthtimeMs], [st.mtimeMs, st.size, st.birthtimeMs]);
    assert.equal(s.meta?.path, file);
    assert.ok(s.meta!.title.length <= 200);
  }
  let warm = newIndex();
  let warmT = await timed(() => warm.start());
  assert.equal(warm.list(a2.id).length, 110);
  assert.deepEqual(warm.list(a2.id).map((m) => m.title).sort(), cold.list(a2.id).map((m) => m.title).sort());
  // budgets (SPEC §9.5): best of up to 3 runs, measured as in test/helpers/perf.ts (the parallel unit suite's load does
  // not fail them; a real regression fails every run). The first runs above carry the correctness checks.
  for (let i = 0; i < 2 && !within(coldT, 400); i++) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const again = newIndex();
    const t = await timed(() => again.start());
    if (within(t, 400) || t.wall < coldT.wall) coldT = t;
    await again.close();
  }
  for (let i = 0; i < 2 && !within(warmT, 60); i++) {
    await warm.close();
    warm = newIndex();
    const t = await timed(() => warm.start());
    if (within(t, 60) || t.wall < warmT.wall) warmT = t;
  }
  console.log(`# index 110 files: cold ${timedText(coldT)} (both accounts), cached ${timedText(warmT)}`);
  assert.ok(within(coldT, 400), `cold ${timedText(coldT)}`);
  assert.ok(within(warmT, 60), `cached ${timedText(warmT)}`);
  index = warm;
});

test('oracle (opt-in SMC_ORACLE=1): equals SDK listSessions on the fixture profile', { skip: process.env['SMC_ORACLE'] !== '1' }, async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  for (const n of ['main', 'plan', 'fork']) pro.addFixtureSession(n, { cwd: root.cwd(`fx-${n}`) });
  await index.reconcile(acc.id);
  const prev = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = pro.configDir!;
  try {
    const list = await sdk.listSessions({ includeWorktrees: false });
    assert.ok(list.length >= 7);
    for (const s of list) {
      const m = get(s.sessionId);
      if (s.sessionId === '22222222-0000-4000-8000-000000000002') { assert.equal(m, undefined); continue; }   // no messages: skipped by design (SPEC §5.5)
      assert.ok(m, `missing ${s.sessionId}`);
      assert.equal(m.title, s.summary, 'summary');
      if (s.customTitle) assert.equal(m.title, s.customTitle);
      assert.equal(m.firstPrompt, s.firstPrompt);
      assert.equal(m.cwd, s.cwd);
      assert.equal(m.createdAt, s.createdAt);
      assert.equal(m.branch, s.gitBranch);
      const info = await sdk.getSessionInfo(s.sessionId);
      assert.equal(info?.summary, m.title);
    }
  } finally { if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR']; else process.env['CLAUDE_CONFIG_DIR'] = prev; }
});
