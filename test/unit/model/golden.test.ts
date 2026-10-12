// test/unit/model/golden.test.ts — golden replays of the recorded fixtures (SPEC §11 acceptance 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputUuid, loadFrames, loadIndex, loadPair, loadWire } from '../../helpers/scenario.ts';
import { replay } from './replay.ts';
import { planModelBadge, planOfAsk } from '../../../src/server/model/derive.ts';
import { toolInputView } from '../../../src/server/model/tools-lite.ts';

test('main fixture: deliveries A completed, B folded, C completed, D cancelled', () => {
  const p = loadPair('main');
  const rp = replay(p.frames, p.inputs);
  const d = rp.r.deliveries();
  assert.equal(d[inputUuid('main', 'A')], 'completed');
  assert.equal(d[inputUuid('main', 'B')], 'folded');
  assert.equal(d[inputUuid('main', 'C')], 'completed');
  assert.equal(d[inputUuid('main', 'D')], 'cancelled');
  // every delivery recorded in the fixture index matches
  const facts = loadIndex().fixtures.main.facts.delivery as Record<string, string>;
  for (const [u, st] of Object.entries(facts)) assert.equal(d[u], st, `delivery of ${u}`);
});

test('main fixture: mode trail default › acceptEdits › default, title LIVE-TITLE', () => {
  const rp = replay(loadFrames('main'), loadPair('main').inputs);
  assert.deepEqual(rp.modeTrail, ['default', 'acceptEdits', 'default']);
  assert.equal(rp.r.meta().title, 'LIVE-TITLE');
  assert.equal(rp.titles[rp.titles.length - 1], 'LIVE-TITLE');
});

test('main fixture: B is a folded user block inside the turn of A; D never opens a turn', () => {
  const p = loadPair('main');
  const rp = replay(p.frames, p.inputs);
  const A = inputUuid('main', 'A'), B = inputUuid('main', 'B'), D = inputUuid('main', 'D');
  const tA = rp.turns.find((t) => t.id === `u:${A}`);
  assert.ok(tA, 'turn of A');
  const fb = tA.blocks.find((b) => b.id === `u:${B}`);
  assert.ok(fb && fb.k === 'user' && fb.msg.delivery === 'folded');
  assert.ok(!rp.turns.some((t) => t.id === `u:${D}`));
  // every turn that got a result has a footer; the plain turns report auxTokens 0
  const ended = rp.turns.filter((t) => t.footer);
  assert.ok(ended.length >= 4, 'turns with a result');
  for (const t of ended) assert.equal(t.footer!.auxTokens, 0, `aux of ${t.id}`);
});

test('plan fixture: plan text comes from the ask input, never from the stale assistant copy', () => {
  const wire = loadWire('plan');
  const asks = wire.flatMap((w) => {
    const m = (w as { m?: Record<string, unknown> }).m;
    const req = m?.['request'] as Record<string, unknown> | undefined;
    return req?.['subtype'] === 'can_use_tool' && req['tool_name'] === 'ExitPlanMode' ? [req['input'] as Record<string, unknown>] : [];
  });
  assert.equal(asks.length, 2);
  const frames = loadFrames('plan');
  const copies = frames.filter((f) => f.label === 'assistant[tool_use:ExitPlanMode]')
    .map((f) => ((f.m['message'] as { content: { input: Record<string, unknown> }[] }).content[0]!.input));
  assert.equal(copies.length, 2);
  const second = planOfAsk(asks[1]!);
  assert.equal(second.plan, asks[1]!['plan']);
  assert.notEqual(second.plan, copies[1]!['plan'], 'the fixture records a stale assistant copy');
  assert.equal(typeof second.planFilePath, 'string');
  // the tool block never carries the assistant copy of the plan
  const view = toolInputView('ExitPlanMode', copies[1]!);
  assert.ok(!('plan' in view.fields));
  const rp = replay(frames, loadPair('plan').inputs);
  const planBlocks = rp.turns.flatMap((t) => t.blocks).filter((b) => b.k === 'tool' && b.name === 'ExitPlanMode');
  assert.equal(planBlocks.length, 2);
  for (const b of planBlocks) if (b.k === 'tool') assert.ok(!('plan' in b.input.fields), 'no assistant copy of the plan in the block');
});

test('plan fixture: plan.modelBadge on the Sonnet blocks of a haiku chat', () => {
  const p = loadPair('plan');
  const rp = replay(p.frames, p.inputs);
  const chatModel = rp.r.meta().model;
  assert.ok(chatModel && /haiku/i.test(chatModel), `chat model ${chatModel}`);
  const blocks = rp.turns.flatMap((t) => t.blocks).filter((b) => (b.k === 'text' || b.k === 'tool') && b.model);
  const sonnet = blocks.filter((b) => (b.k === 'text' || b.k === 'tool') && /sonnet/.test(b.model ?? ''));
  const haiku = blocks.filter((b) => (b.k === 'text' || b.k === 'tool') && /haiku/.test(b.model ?? ''));
  assert.ok(sonnet.length > 0 && haiku.length > 0);
  for (const b of sonnet) if (b.k === 'text' || b.k === 'tool') assert.equal(planModelBadge(chatModel, b.model), 'Sonnet');
  for (const b of haiku) if (b.k === 'text' || b.k === 'tool') assert.equal(planModelBadge(chatModel, b.model), null);
  assert.deepEqual(rp.modeTrail, ['plan', 'default']);
});

test('fork fixture: the reducer reports the session-id change', () => {
  const main = loadIndex().fixtures.main.sessionIds[0]!;
  const forkSid = loadIndex().fixtures.fork.sessionIds[0]!;
  const p = loadPair('fork');
  const rp = replay(p.frames, p.inputs, { chatId: `acc:${main}`, resumed: true });
  assert.notEqual(main, forkSid);
  assert.equal(rp.r.sessionId(), forkSid);
  assert.equal(rp.r.deliveries()[inputUuid('fork', 'fork#1')], 'completed');
});
