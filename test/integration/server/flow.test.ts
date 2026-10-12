// M2 end-to-end server flow: the real server process (SMC_TEST=1, temp app dir + temp profile, random port) with the REAL
// engine (Agent SDK) driving test/fakes/fake-claude.mjs (SMC_CLAUDE_EXE). One chat over WebSocket:
// create → send ECHO → stream → ASK allow → QUESTION answer → PLAN approve → interrupt → sleep → wake (resume) → fork → retry.
// 0 tokens: no real profile, no real claude.exe. Child-process run (harness): see real-engine.test.ts for why.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type * as P from '../../../src/shared/protocol.ts';
import { startServer } from '../../e2e/harness.ts';
import type { ServerHandle } from '../../e2e/harness.ts';
import { isPidAlive } from '../../../src/server/util/winproc.ts';
import { connectWs } from '../../helpers/ws-client.ts';
import type { WsClient } from '../../helpers/ws-client.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const tmp = createTmpRoot('int-flow');
let s: ServerHandle | null = null;
after(async () => { await s?.stop(); tmp.dispose(); });

let n = 0;
const uuid = (): string => `0b6f3a59-0a8e-4c55-8a51-${String(++n).padStart(12, '0')}`;
type Ev = Extract<P.S2C, { t: 'ev' }>;
const evsOf = (w: WsClient, chatId: string): P.ChatEvent[] => w.all('ev').filter((m) => m.c === chatId).map((m) => m.ev);
const textOf = (w: WsClient, chatId: string): string =>
  evsOf(w, chatId).flatMap((e) => (e.k === 'block' && e.block.k === 'text' ? [e.block.md] : [])).join('\n');
const turnEnds = (w: WsClient, chatId: string): Extract<P.ChatEvent, { k: 'turn.end' }>[] =>
  evsOf(w, chatId).filter((e): e is Extract<P.ChatEvent, { k: 'turn.end' }> => e.k === 'turn.end');
async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 25)); }
}
async function send(w: WsClient, chatId: string, text: string): Promise<void> {
  const r = await w.request({ t: 'chat.send', chatId, uuid: uuid(), text }, 30_000);
  assert.deepEqual(r, { ok: true, data: { accepted: 'new' } }, `${text}: ${JSON.stringify(r)}`);
}
async function turn(w: WsClient, chatId: string, text: string): Promise<Extract<P.ChatEvent, { k: 'turn.end' }>> {
  const before = turnEnds(w, chatId).length;
  await send(w, chatId, text);
  await until(() => turnEnds(w, chatId).length > before, `turn.end of ${text}`, 30_000);
  return turnEnds(w, chatId).at(-1)!;
}
async function answer(w: WsClient, chatId: string, kind: P.AskKind, a: P.UiAnswer): Promise<void> {
  const ask = await w.next<Extract<P.S2C, { t: 'ask' }>>((m) => m.t === 'ask' && m.ask.chatId === chatId && m.ask.kind === kind, 20_000);
  const r = await w.request({ t: 'chat.decide', chatId, requestId: ask.ask.requestId, answer: a });
  assert.deepEqual(r, { ok: true }, `${kind}: ${JSON.stringify(r)}`);
  await w.next((m) => m.t === 'askEnd' && m.requestId === ask.ask.requestId && m.reason === 'answered', 10_000);
}
const live = (w: WsClient): number => w.all('procs').at(-1)?.procs.live ?? 0;
const summaryOf = (w: WsClient, chatId: string): P.ChatSummary | undefined =>
  w.all('chats').flatMap((m) => m.upsert).filter((x) => x.chatId === chatId).at(-1);

test('server flow over WebSocket: real SDK + fake CLI, one chat end to end', { timeout: 180_000 }, async () => {
  const prof = tmp.profile('flow', { login: 'connected', account: { emailAddress: 'flow@example.invalid' } });
  s = await startServer({ root: tmp, env: { SMC_FAKE_EMAIL: 'fake@example.invalid' } });   // a CLI answering as someone else
  const w = await connectWs({ port: s.port, boot: s.boot });
  await w.next((m) => m.t === 'hello');
  const add = await w.request<P.AccountView>({ t: 'account.add', configDir: prof.configDir, name: 'Flow', color: 2, monogram: 'F' });
  assert.ok(add.ok, JSON.stringify(add));
  assert.ok(add.data!.models?.length, 'AccountView.models from the profile model catalog');
  const accountId = add.data!.id;

  // create → send ECHO → stream
  const c = await w.request<{ chatId: string }>({ t: 'chat.create', accountId, cwd: tmp.cwd('flow'), mode: 'default', trust: true });
  assert.ok(c.ok, JSON.stringify(c));
  const chatId = c.data!.chatId;
  assert.ok((await w.request({ t: 'view', full: [chatId], focused: chatId, windowFocused: true })).ok);
  const first = await turn(w, chatId, 'ECHO: bonjour le flux');
  const kinds = evsOf(w, chatId).map((e) => e.k);
  for (const k of ['turn.start', 'block', 'delta', 'turn.end'] as const) assert.ok(kinds.includes(k), `${k} in ${kinds.join(',')}`);
  assert.match(textOf(w, chatId), /bonjour le flux/);
  assert.ok(Math.abs((first.footer.costUsd ?? -1) - 0.0001) < 1e-9, `first turn cost ${first.footer.costUsd}`);
  // smc_engine initialized: the fake CLI answers as fake@example.invalid (SMC_FAKE_EMAIL), the profile is flow@example.invalid
  const mism = await w.next<Extract<P.S2C, { t: 'toast' }>>((m) => m.t === 'toast' && m.key === 'account.mismatch', 10_000);
  assert.deepEqual(mism.args, { account: 'Flow', expected: 'flow@example.invalid', actual: 'fake@example.invalid' });
  assert.ok(evsOf(w, chatId).some((e) => e.k === 'meta' && e.meta.autoAvailable === true), 'autoAvailable from the init models');

  // ASK allow → QUESTION answer → PLAN approve
  const askDone = turn(w, chatId, 'ASK: npm test');
  await answer(w, chatId, 'permission', { kind: 'allow-once' });
  await askDone;
  assert.match(textOf(w, chatId), /ALLOWED/);
  const qDone = turn(w, chatId, 'QUESTION: Quelle couleur ?');
  await answer(w, chatId, 'question', { kind: 'answers', answers: { 'Quelle couleur ?': 'Bleu' } });
  await qDone;
  assert.match(textOf(w, chatId), /ANSWERS:.*Bleu/);
  const pDone = turn(w, chatId, 'PLAN: # Plan\n1. Faire');
  await answer(w, chatId, 'plan', { kind: 'plan-approve', nextMode: 'acceptEdits' });
  await pDone;
  assert.match(textOf(w, chatId), /PLAN-OK:acceptEdits/);

  // interrupt a slow turn
  const before = turnEnds(w, chatId).length;
  await send(w, chatId, 'SLOW: 200');
  await w.next((m) => m.t === 'ev' && (m as Ev).c === chatId && (m as Ev).ev.k === 'delta', 10_000);
  const intr = await w.request<{ stillQueued: string[] }>({ t: 'chat.interrupt', chatId });
  assert.ok(intr.ok, JSON.stringify(intr));
  await until(() => turnEnds(w, chatId).length > before, 'interrupted turn.end');
  assert.equal(turnEnds(w, chatId).at(-1)!.footer.interrupted, true);

  // sleep: the process closes (the fake appends its cost-state); the index picks up the transcript
  const pids = (w.all('procs').at(-1)?.procs.items ?? []).map((i) => i.pid).filter((p): p is number => typeof p === 'number');
  assert.ok((await w.request({ t: 'chat.sleep', chatId }, 20_000)).ok);
  await until(() => live(w) === 0, 'cold after sleep');
  for (const pid of pids) await until(() => !isPidAlive(pid), `pid ${pid} gone`);
  await until(() => (summaryOf(w, chatId)?.size ?? 0) > 0, 'transcript indexed');

  // wake (resume): the first turn of the new process costs its own delta, not the session total (cost-state baseline)
  const woke = await turn(w, chatId, 'ECHO: réveil');
  assert.ok(Math.abs((woke.footer.costUsd ?? -1) - 0.0001) < 1e-9, `wake turn cost ${woke.footer.costUsd}`);
  assert.match(textOf(w, chatId), /réveil/);
  assert.ok((await w.request({ t: 'chat.sleep', chatId }, 20_000)).ok);
  await until(() => live(w) === 0, 'cold before fork');

  // fork: a new cold chat; its first turn spawns `fork` from the source transcript, again with the delta cost only
  const f = await w.request<{ chatId: string }>({ t: 'chat.fork', chatId });
  assert.ok(f.ok, JSON.stringify(f));
  const forkId = f.data!.chatId;
  assert.notEqual(forkId, chatId);
  assert.equal(summaryOf(w, forkId)?.links?.forkedFrom, chatId);
  assert.ok((await w.request({ t: 'view', full: [chatId, forkId], focused: forkId, windowFocused: true })).ok);
  const forked = await turn(w, forkId, 'ECHO: branche');
  assert.ok(Math.abs((forked.footer.costUsd ?? -1) - 0.0001) < 1e-9, `fork turn cost ${forked.footer.costUsd}`);

  // retry: a crash leaves error{crash}; chat.retry clears it and acks without spawning; the user re-sends
  await send(w, forkId, 'CRASH: 3');
  await until(() => summaryOf(w, forkId)?.state.error?.code === 'crash', 'crash error state');
  await until(() => live(w) === 0, 'cold after the crash');
  const retry = await w.request({ t: 'chat.retry', chatId: forkId });
  assert.deepEqual(retry, { ok: true });
  await until(() => summaryOf(w, forkId)?.state.error === undefined, 'error cleared');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(live(w), 0, 'chat.retry never spawns');
  await turn(w, forkId, 'ECHO: encore');
  assert.match(textOf(w, forkId), /encore/);

  // quit closes the process tree
  const procPids = (w.all('procs').at(-1)?.procs.items ?? []).map((i) => i.pid).filter((p): p is number => typeof p === 'number');
  const exit = new Promise<number | null>((r) => s!.proc.once('exit', r));
  assert.ok((await w.request({ t: 'app.quit', force: true })).ok);
  await w.next((m) => m.t === 'bye', 20_000);
  assert.equal(await exit, 0);
  for (const pid of procPids) assert.equal(isPidAlive(pid), false, `pid ${pid} gone`);
});
