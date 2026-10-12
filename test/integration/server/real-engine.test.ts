// SPEC §12.2(b)+(c) for WP-D: the real server process with the REAL engine (SDK loaded lazily at the first spawn) driving
// test/fakes/fake-claude.mjs on a tmp profile — create → send → streamed turn → quit. 0 tokens, no real profile.
// Run as a child process (harness): the SDK's `node:process` namespace import instantiates process.stdin, and an
// inherited open stdin pipe would then block the exit of an in-process test runner on Windows.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type * as P from '../../../src/shared/protocol.ts';
import { startServer } from '../../e2e/harness.ts';
import type { ServerHandle } from '../../e2e/harness.ts';
import { isPidAlive } from '../../../src/server/util/winproc.ts';
import { connectWs } from '../../helpers/ws-client.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const tmp = createTmpRoot('int-real');
let s: ServerHandle | null = null;
after(async () => { await s?.stop(); tmp.dispose(); });

test('real engine + fake CLI: a streamed turn reaches the window, quit closes the process tree', { timeout: 60_000 }, async () => {
  tmp.defaultProfile({ login: 'connected' });
  s = await startServer({ root: tmp });
  const w = await connectWs({ port: s.port, boot: s.boot });
  await w.next((m) => m.t === 'hello');
  const add = await w.request<P.AccountView>({ t: 'account.add', configDir: null, name: 'Perso', color: 1, monogram: 'P' });
  assert.ok(add.ok, JSON.stringify(add));
  const c = await w.request<{ chatId: string }>({ t: 'chat.create', accountId: add.data!.id, cwd: tmp.cwd('proj'), mode: 'default', trust: true });
  assert.ok(c.ok, JSON.stringify(c));
  const chatId = c.data!.chatId;
  await w.request({ t: 'view', full: [chatId], focused: chatId, windowFocused: true });
  const sent = await w.request({ t: 'chat.send', chatId, uuid: '0b6f3a59-0a8e-4c55-8a51-000000000001', text: 'ECHO: salut' }, 30_000);
  assert.deepEqual(sent, { ok: true, data: { accepted: 'new' } });
  await w.next((m) => m.t === 'ev' && m.c === chatId && m.ev.k === 'turn.end', 30_000);
  const kinds = w.all('ev').filter((m) => m.c === chatId).map((m) => m.ev.k);
  for (const k of ['turn.start', 'block', 'delta', 'turn.end'] as const) assert.ok(kinds.includes(k), `${k} in ${kinds.join(',')}`);
  const procs = w.all('procs').at(-1)!.procs;
  assert.equal(procs.live, 1);
  const pids = procs.items.map((i) => i.pid).filter((p): p is number => typeof p === 'number');
  const exit = new Promise<number | null>((r) => s!.proc.once('exit', r));
  assert.ok((await w.request({ t: 'app.quit', force: true })).ok);
  await w.next((m) => m.t === 'bye', 20_000);
  assert.equal(await exit, 0);
  for (const pid of pids) assert.equal(isPidAlive(pid), false, `pid ${pid} gone`);
});
