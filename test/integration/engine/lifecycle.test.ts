// test/integration/engine/lifecycle.test.ts — watchdogs, close algorithm, breaker, fork id, hooks (REAL SDK + fake-claude). 0 tokens.
// A scaled clock (every engine timer ÷ 20) keeps the 45 s / 8 s / 10 s watchdogs testable in real time.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Clock } from '../../../src/server/contracts.ts';
import { makeEngine } from '../../../src/server/engine/engine.ts';
import { createSpawner } from '../../../src/server/engine/spawner.ts';
import { memoryLogger } from '../../../src/server/util/log.ts';
import { isPidAlive } from '../../../src/server/util/winproc.ts';
import { recordingSink } from '../../unit/engine/engine-helpers.ts';
import type { Rec } from '../../unit/engine/engine-helpers.ts';
import { FAKE, tmpDirs, waitFor, frames, realEngine } from './real-helpers.ts';

const scaled = (k: number): Clock => ({ now: () => Date.now(), timer(ms, fn) { const t = setTimeout(fn, Math.ceil(ms / k)); return { cancel: () => clearTimeout(t) }; } });
const dirs = tmpDirs('life');
const sink = recordingSink();
const log = memoryLogger();
const engine = makeEngine({ query, clock: scaled(20), sink, log, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null,
  spawner: createSpawner({ jobrunPath: null, registryFile: path.join(dirs.root, 'children.json'), log }) });
engine.setPolicy({ maxLive: 8, reapMin: 60 });
after(async () => { await engine.shutdown(5_000); dirs.dispose(); });
const spec = (title?: string) => {
  const sid = randomUUID();
  return { chatId: `t:${sid}`, sessionId: sid, cwd: dirs.cwd, account: { id: 't', configDir: dirs.cfg, claudeMdExcludes: [] }, mode: 'default' as const,
    start: title ? { kind: 'new' as const, title } : { kind: 'new' as const }, allowBypass: false, aiTitles: false, exe: FAKE, isolation: 'plain' as const };
};
const exitOf = (c: string) => sink.log.find((r): r is Extract<Rec, { k: 'exited' }> => r.k === 'exited' && r.c === c);

test('init timeout: a CLI that never answers initialize is killed → exited init_timeout', async () => {
  const s = spec('HANGINIT');
  assert.equal((await engine.ensure(s, { why: 'prespawn' })).ok, true);
  await waitFor(() => !!exitOf(s.chatId), 'exit', 15_000);
  assert.equal(exitOf(s.chatId)!.info.reason, 'init_timeout');
});

test('close on a CLI that ignores EOF (HANG): q.close → own kill; gone ≤ 3 s after q.close()', async () => {
  const s = spec();
  await engine.ensure(s, { why: 'send' });
  await waitFor(() => engine.facts(s.chatId)?.phase === 'live', 'live');
  engine.send(s.chatId, { uuid: randomUUID(), text: 'HANG' });
  await waitFor(() => engine.facts(s.chatId)?.busy === true, 'busy');
  const pid = engine.facts(s.chatId)!.cliPid!;
  assert.ok(isPidAlive(pid));
  const info = await engine.sleep(s.chatId, 'user');             // steps 1–5 on the scaled clock
  assert.ok(info && (info.reason === 'killed' || info.reason === 'closed'), JSON.stringify(info));
  await waitFor(() => !isPidAlive(pid), 'pid gone', 3_000);
  const t0 = Date.now();
  const s2 = spec();
  await engine.ensure(s2, { why: 'send' });
  await waitFor(() => engine.facts(s2.chatId)?.phase === 'live', 'live 2');
  engine.send(s2.chatId, { uuid: randomUUID(), text: 'HANG' });
  await waitFor(() => engine.facts(s2.chatId)?.busy === true, 'busy 2');
  const pid2 = engine.facts(s2.chatId)!.cliPid!;
  const t1 = Date.now();
  await engine.sleep(s2.chatId, 'force');                        // force: straight to q.close() + own kill
  await waitFor(() => !isPidAlive(pid2), 'pid2 gone', 3_000);
  assert.ok(Date.now() - t1 <= 3_000, `force close took ${Date.now() - t1} ms`);
  void t0;
});

test('crash breaker with the real CLI path: 3 CRASH → breaker_open', async () => {
  const s = spec();
  for (let i = 0; i < 3; i++) {
    assert.equal((await engine.ensure(s, { why: 'send' })).ok, true, 'ensure ' + i);
    engine.send(s.chatId, { uuid: randomUUID(), text: 'CRASH:5' });
    await waitFor(() => sink.log.filter((r) => r.k === 'exited' && r.c === s.chatId).length === i + 1, 'crash ' + i);
  }
  const ex = sink.log.filter((r): r is Extract<Rec, { k: 'exited' }> => r.k === 'exited' && r.c === s.chatId);
  assert.ok(ex.every((e) => e.info.reason === 'crash' && e.info.code === 5), JSON.stringify(ex.map((e) => e.info)));
  assert.deepEqual(await engine.ensure(s, { why: 'send' }), { ok: false, err: { code: 'breaker_open' } });
});

test('SessionStart hook frames at spawn → resume_stable false note; none → true after 3 s', async () => {
  const s = spec('HOOKS');
  await engine.ensure(s, { why: 'prespawn' });
  await waitFor(() => frames(sink, s.chatId).some((f) => f['subtype'] === 'resume_stable'), 'stable note');
  assert.equal(frames(sink, s.chatId).find((f) => f['subtype'] === 'resume_stable')!['stable'], false);
  const s2 = spec();
  await engine.ensure(s2, { why: 'prespawn' });
  await waitFor(() => frames(sink, s2.chatId).some((f) => f['subtype'] === 'resume_stable'), 'stable note 2');
  assert.equal(frames(sink, s2.chatId).find((f) => f['subtype'] === 'resume_stable')!['stable'], true);
});

test('fork: --resume=<jsonl> --fork-session --session-id; a CLI that picks its own id → sessionChanged', async () => {
  const E = realEngine('fork');
  try {
    E.engine.setPolicy({ maxLive: 8, reapMin: 60 });
    const src = E.spec();
    await E.engine.ensure(src, { why: 'send' });
    E.engine.send(src.chatId, { uuid: randomUUID(), text: 'ECHO:source' });
    await waitFor(() => frames(E.sink, src.chatId).some((f) => f['type'] === 'result'), 'src result');
    await E.engine.sleep(src.chatId, 'user');
    const jsonl = path.join(src.account.configDir!, 'projects', src.cwd.replace(/[^a-zA-Z0-9]/g, '-'), src.sessionId + '.jsonl');
    assert.ok(fs.existsSync(jsonl));
    const f1 = E.spec({ start: { kind: 'fork', fromJsonl: jsonl, title: 'Copie' } });
    await E.engine.ensure(f1, { why: 'send' });
    E.engine.send(f1.chatId, { uuid: randomUUID(), text: 'ECHO:fork' });
    await waitFor(() => frames(E.sink, f1.chatId).some((f) => f['type'] === 'result'), 'fork result');
    assert.equal(E.sink.log.some((r) => r.k === 'session' && r.c === f1.chatId), false);   // the CLI honoured our id
    process.env['SMC_FAKE_IGNORE_FORK_ID'] = '1';
    const f2 = E.spec({ start: { kind: 'fork', fromJsonl: jsonl, title: 'Copie 2' } });
    try {
      await E.engine.ensure(f2, { why: 'send' });
      await waitFor(() => E.sink.log.some((r) => r.k === 'session' && r.c === f2.chatId), 'rekey');
    } finally { delete process.env['SMC_FAKE_IGNORE_FORK_ID']; }
    const ev = E.sink.log.find((r): r is Extract<Rec, { k: 'session' }> => r.k === 'session' && r.c === f2.chatId)!;
    assert.notEqual(ev.sid, f2.sessionId);
    assert.equal(E.engine.isLive(`t:${ev.sid}`), true);
  } finally { await E.dispose(); }
});

test('external holder: blocks a resume unless force; a forced open survives the race guard; one that appears during the spawn sends the chat back to sleep', async () => {
  const d = tmpDirs('holder');
  const hs = recordingSink();
  const lg = memoryLogger();
  type H = { pid: number; kind: string; entrypoint: string; status: 'idle' };
  let holder: H | null = { pid: 999_999, kind: 'interactive', entrypoint: 'cli', status: 'idle' };
  const eng = makeEngine({ query, clock: scaled(20), sink: hs, log: lg, freeMemBytes: () => 8 * 1024 ** 3, holder: () => holder,
    spawner: createSpawner({ jobrunPath: null, registryFile: path.join(d.root, 'children.json'), log: lg }) });
  const mk = () => { const sid = randomUUID(); return { chatId: `t:${sid}`, sessionId: sid, cwd: d.cwd, account: { id: 't', configDir: d.cfg, claudeMdExcludes: [] },
    mode: 'default' as const, start: { kind: 'resume' as const }, allowBypass: false, aiTitles: false, exe: FAKE, isolation: 'plain' as const }; };
  try {
    const s = mk();
    assert.deepEqual(await eng.ensure(s, { why: 'wake' }), { ok: false, err: { code: 'external', holder } });
    assert.deepEqual(await eng.ensure(s, { why: 'wake', force: true }), { ok: true, data: undefined });
    await waitFor(() => eng.facts(s.chatId)?.phase === 'live', 'live (forced)');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(eng.isLive(s.chatId), true);                    // the holder the user overrode does not trip the race guard
    assert.equal(frames(hs, s.chatId).some((f) => f['subtype'] === 'external_holder'), false);
    holder = null;
    const s2 = mk();
    assert.deepEqual(await eng.ensure(s2, { why: 'wake' }), { ok: true, data: undefined });
    holder = { pid: 999_998, kind: 'interactive', entrypoint: 'cli', status: 'idle' };   // appears while s2 initializes
    await waitFor(() => frames(hs, s2.chatId).some((f) => f['subtype'] === 'external_holder'), 'external_holder note');
    await waitFor(() => hs.log.some((r) => r.k === 'exited' && r.c === s2.chatId), 'back to sleep');
    assert.equal(eng.isLive(s.chatId), true);
  } finally { await eng.shutdown(5_000); d.dispose(); }
});
