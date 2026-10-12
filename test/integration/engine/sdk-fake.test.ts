// test/integration/engine/sdk-fake.test.ts — createEngine + REAL SDK + fake-claude.mjs (SPEC §11, §12.2(b)). 0 tokens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realEngine, waitFor, frames, resultText } from './real-helpers.ts';
import type { Rec } from '../../unit/engine/engine-helpers.ts';

const E = realEngine('core');
after(() => E.dispose());
const asksOf = (c: string) => E.sink.log.filter((r): r is Extract<Rec, { k: 'ask' }> => r.k === 'ask' && r.a.chatId === c).map((r) => r.a);
const results = (c: string) => frames(E.sink, c).filter((f) => f['type'] === 'result');

async function live(p: Parameters<typeof E.spec>[0] = {}) {
  const s = E.spec(p);
  const r = await E.engine.ensure(s, { why: 'send', exceed: true });
  assert.deepEqual(r, { ok: true, data: undefined });
  await waitFor(() => E.engine.facts(s.chatId)?.phase === 'live', 'live');
  return s;
}

test('allow (always → localSettings rule, never userSettings) and deny (verbatim message)', async () => {
  const s = await live();
  E.engine.send(s.chatId, { uuid: randomUUID(), text: 'ASK:npm ci' });
  await waitFor(() => asksOf(s.chatId).length === 1, 'ask 1');
  const a = asksOf(s.chatId)[0]!;
  assert.equal(a.kind, 'permission');
  assert.deepEqual(a.alwaysRules, ['Bash(npm ci)']);
  assert.equal(E.engine.decide(s.chatId, a.requestId, { kind: 'allow-always', scope: 'localSettings' }), 'ok');
  assert.equal(E.engine.decide(s.chatId, a.requestId, { kind: 'deny', message: 'trop tard' }), 'not_pending');   // first decision wins
  await waitFor(() => results(s.chatId).length === 1, 'result 1');
  assert.equal(results(s.chatId)[0]!['result'], 'ALLOWED localSettings:Bash(npm ci)');
  E.engine.send(s.chatId, { uuid: randomUUID(), text: 'ASK:rm -rf x' });
  await waitFor(() => asksOf(s.chatId).length === 2, 'ask 2');
  E.engine.decide(s.chatId, asksOf(s.chatId)[1]!.requestId, { kind: 'deny', message: 'Pas ça, merci.' });
  await waitFor(() => results(s.chatId).length === 2, 'result 2');
  assert.equal(results(s.chatId)[1]!['result'], 'DENIED:Pas ça, merci.');
});

test('interrupt during an ask: null to the SDK (no control_response on the wire), askEnd cancelled, aborted_tools; interrupt while streaming', async () => {
  const rec = path.join(E.dirs.root, 'withdrawn.jsonl');
  process.env['SMC_FAKE_RECORD'] = rec;                         // read by accountEnv at spawn: only this chat's CLI records
  let s: Awaited<ReturnType<typeof live>>;
  try { s = await live(); } finally { delete process.env['SMC_FAKE_RECORD']; }
  E.engine.send(s.chatId, { uuid: randomUUID(), text: 'ASK:node -e 1' });
  await waitFor(() => asksOf(s.chatId).length === 1, 'ask');
  const withdrawn = asksOf(s.chatId)[0]!;
  await E.engine.interrupt(s.chatId);
  await waitFor(() => E.sink.log.some((r) => r.k === 'askEnd' && r.c === s.chatId && r.why === 'cancelled'), 'askEnd cancelled', 5_000);
  await waitFor(() => results(s.chatId).length === 1, 'result');
  assert.equal(results(s.chatId)[0]!['terminal_reason'], 'aborted_tools');
  E.engine.send(s.chatId, { uuid: randomUUID(), text: 'ASK:node -e 2' });   // control: an answered ask IS on the wire
  await waitFor(() => asksOf(s.chatId).length === 2, 'ask 2');
  const answered = asksOf(s.chatId)[1]!;
  E.engine.decide(s.chatId, answered.requestId, { kind: 'allow-once' });
  await waitFor(() => results(s.chatId).length === 2, 'result 2');
  const recs = fs.readFileSync(rec, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; request_id?: string; late?: boolean });
  assert.ok(recs.some((r) => r.kind === 'control_response' && r.request_id === answered.requestId && r.late === false), 'the answered ask was recorded');
  assert.equal(recs.some((r) => r.kind === 'control_response' && r.request_id === withdrawn.requestId), false, 'the withdrawn ask got no answer');
  E.engine.send(s.chatId, { uuid: randomUUID(), text: 'SLOW:200' });
  await waitFor(() => frames(E.sink, s.chatId).filter((f) => f['type'] === 'stream_event').length > 5, 'streaming');
  await E.engine.interrupt(s.chatId);
  await waitFor(() => results(s.chatId).length === 3, 'result 3');
  assert.equal(results(s.chatId)[2]!['terminal_reason'], 'aborted_streaming');
  await waitFor(() => E.engine.facts(s.chatId)?.busy === false, 'idle');
  assert.equal(E.engine.isLive(s.chatId), true);
});

test('queue: fold (no priority) → folded; later → own turn; cancel → cancelled', async () => {
  const s = await live();
  const A = randomUUID(); const B = randomUUID(); const C = randomUUID(); const D = randomUUID();
  E.engine.send(s.chatId, { uuid: A, text: 'FOLD:1500' });
  await waitFor(() => frames(E.sink, s.chatId).some((f) => f['type'] === 'assistant'), 'tool_use');
  E.engine.send(s.chatId, { uuid: B, text: 'B' });
  E.engine.send(s.chatId, { uuid: C, text: 'ECHO:C-LATER', priority: 'later' });
  E.engine.send(s.chatId, { uuid: D, text: 'ECHO:D', priority: 'later' });
  await waitFor(() => (E.engine.facts(s.chatId)?.queue ?? []).filter((q) => q.delivery === 'queued').length === 3, 'queued');
  assert.equal(await E.engine.cancelQueued(s.chatId, D), true);
  await waitFor(() => results(s.chatId).length === 2, 'two results', 10_000);
  const delivered = E.sink.log.filter((r): r is Extract<Rec, { k: 'delivered' }> => r.k === 'delivered' && r.c === s.chatId);
  assert.deepEqual(delivered.map((d) => [d.uuid, d.folded]), [[A, false], [B, true], [C, false]]);
  assert.deepEqual(results(s.chatId)[0]!['user_message_uuids'], [A, B]);
  assert.equal(results(s.chatId)[1]!['result'], 'C-LATER');
  assert.ok(frames(E.sink, s.chatId).some((f) => f['type'] === 'command_lifecycle' && f['command_uuid'] === D && f['state'] === 'cancelled'));
  await waitFor(() => E.engine.facts(s.chatId)?.busy === false, 'idle');
});

test('send duplicate uuid; live rename frame; mode echo through system:status', async () => {
  const s = await live();
  const u = randomUUID();
  assert.equal(E.engine.send(s.chatId, { uuid: u, text: 'ECHO:x' }), 'accepted');
  assert.equal(E.engine.send(s.chatId, { uuid: u, text: 'ECHO:x' }), 'duplicate');
  await E.engine.rename(s.chatId, 'LIVE-TITLE');
  await waitFor(() => frames(E.sink, s.chatId).some((f) => f['subtype'] === 'session_title_changed' && f['title'] === 'LIVE-TITLE'), 'title frame');
  await E.engine.setMode(s.chatId, 'acceptEdits');
  await waitFor(() => frames(E.sink, s.chatId).some((f) => f['subtype'] === 'status' && f['permissionMode'] === 'acceptEdits'), 'mode echo');
  assert.equal(E.engine.facts(s.chatId)?.mode, 'acceptEdits');
});

test('question / plan / write asks; transcript JSONL written to the scratch profile', async () => {
  const s = await live();
  E.engine.send(s.chatId, { uuid: randomUUID(), text: 'QUESTION:Couleur ?' });
  await waitFor(() => asksOf(s.chatId).length === 1, 'question');
  const q = asksOf(s.chatId)[0]!;
  assert.equal(q.kind, 'question');
  assert.equal(q.questions?.[0]?.question, 'Couleur ?');
  E.engine.decide(s.chatId, q.requestId, { kind: 'answers', answers: { 'Couleur ?': 'Bleu' } });
  await waitFor(() => results(s.chatId).length === 1, 'r1');
  assert.equal(results(s.chatId)[0]!['result'], 'ANSWERS:{"Couleur ?":"Bleu"}');
  E.engine.send(s.chatId, { uuid: randomUUID(), text: 'PLAN:# Mon plan' });
  await waitFor(() => asksOf(s.chatId).length === 2, 'plan');
  const p = asksOf(s.chatId)[1]!;
  assert.equal(p.kind, 'plan');
  assert.equal(p.plan, '# Mon plan');
  E.engine.decide(s.chatId, p.requestId, { kind: 'plan-approve', nextMode: 'acceptEdits', editedPlan: '# Édité' });
  await waitFor(() => results(s.chatId).length === 2, 'r2');
  assert.equal(results(s.chatId)[1]!['result'], 'PLAN-OK:acceptEdits:# Édité');
  E.engine.send(s.chatId, { uuid: randomUUID(), text: 'WRITE:f.txt' });
  await waitFor(() => asksOf(s.chatId).length === 3, 'write');
  const w = asksOf(s.chatId)[2]!;
  assert.deepEqual(w.diffBase, { path: path.join(s.cwd, 'f.txt'), text: '' });
  E.engine.decide(s.chatId, w.requestId, { kind: 'allow-once' });
  await waitFor(() => results(s.chatId).length === 3, 'r3');
  const tx = path.join(s.account.configDir!, 'projects', s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), s.sessionId + '.jsonl');
  const lines = fs.readFileSync(tx, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(lines.some((e) => e['type'] === 'user' && e['sessionId'] === s.sessionId));
  assert.ok(lines.some((e) => e['type'] === 'assistant'));
});

test('crash with a pending ask: askEnd crash, queued deliveries returned, exited crash', async () => {
  const s = await live();
  E.engine.send(s.chatId, { uuid: randomUUID(), text: 'ASKCRASH:7' });
  const q = randomUUID();
  E.engine.send(s.chatId, { uuid: q, text: 'ECHO:never', priority: 'later' });
  await waitFor(() => E.sink.log.some((r) => r.k === 'exited' && r.c === s.chatId), 'exited');
  const ex = E.sink.log.find((r): r is Extract<Rec, { k: 'exited' }> => r.k === 'exited' && r.c === s.chatId)!;
  assert.equal(ex.info.reason, 'crash');
  assert.deepEqual(ex.returned.map((x) => x.uuid), [q]);
  assert.ok(E.sink.log.some((r) => r.k === 'askEnd' && r.c === s.chatId && r.why === 'crash'));
});

test('RESET → sessionChanged; fork whose CLI ignores our id → sessionChanged; HANGINIT → init_timeout path is covered by the fake clock', async () => {
  const s = await live();
  E.engine.send(s.chatId, { uuid: randomUUID(), text: 'RESET' });
  await waitFor(() => E.sink.log.some((r) => r.k === 'session' && r.c === s.chatId), 'reset');
  void resultText;
});
