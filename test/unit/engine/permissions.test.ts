// test/unit/engine/permissions.test.ts — UiAnswer → PermissionResult table, suggestion filter, ask registry (SPEC §2.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type * as P from '../../../src/shared/protocol.ts';
import {
  createAskRegistry, DENY_DEFAULT_MESSAGE, filterSuggestions, ruleTexts, SKIP_QUESTION_MESSAGE, toElicitationResult, toPermissionResult,
} from '../../../src/server/engine/permissions.ts';
import type { AskContext } from '../../../src/server/engine/permissions.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';

const ask = (o: Partial<P.PendingAsk> = {}): P.PendingAsk => ({ chatId: 'a:s', requestId: 'r1', toolUseId: 't1', kind: 'permission', toolName: 'Bash',
  input: { command: 'npm ci' }, offerAlways: true, alwaysRules: [], offerAuto: false, defaultToNo: false, since: 0, ...o });
const sugg: PermissionUpdate[] = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm ci' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm ci' }], behavior: 'allow', destination: 'userSettings' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
];

test('filterSuggestions drops userSettings always, local/project when the cwd failed S9', () => {
  assert.deepEqual(filterSuggestions(sugg, true).map((s) => s.destination), ['localSettings', 'session']);
  assert.deepEqual(filterSuggestions(sugg, false).map((s) => s.destination), ['session']);
  assert.deepEqual(ruleTexts(filterSuggestions(sugg, true)), ['Bash(npm ci)']);
});

test('toPermissionResult: every UiAnswer of the §2.5 table', () => {
  const a = ask();
  assert.deepEqual(toPermissionResult(a, { kind: 'allow-once' }), { behavior: 'allow', updatedInput: { command: 'npm ci' } });
  assert.deepEqual(toPermissionResult(a, { kind: 'allow-edited', input: { command: 'npm i' } }), { behavior: 'allow', updatedInput: { command: 'npm i' } });
  const always = toPermissionResult(a, { kind: 'allow-always', scope: 'projectSettings' }, { suggestions: sugg });
  assert.equal(always.behavior, 'allow');
  const ups = (always as { updatedPermissions: PermissionUpdate[] }).updatedPermissions;
  assert.deepEqual(ups.map((u) => u.destination), ['projectSettings', 'session']);   // rules take the scope; setMode stays session; never userSettings
  assert.deepEqual(toPermissionResult(a, { kind: 'allow-and-auto' }), { behavior: 'allow', updatedInput: { command: 'npm ci' }, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] });
  assert.deepEqual(toPermissionResult(a, { kind: 'deny', message: '' }), { behavior: 'deny', message: DENY_DEFAULT_MESSAGE });
  assert.deepEqual(toPermissionResult(a, { kind: 'deny', message: 'non', stopTurn: true }), { behavior: 'deny', message: 'non', interrupt: true });
  const q = ask({ kind: 'question', toolName: 'AskUserQuestion', input: { questions: [] } });
  assert.deepEqual(toPermissionResult(q, { kind: 'answers', answers: { 'Couleur ?': 'Bleu, Rouge' }, notes: { 'Couleur ?': 'n' }, response: 'r' }),
    { behavior: 'allow', updatedInput: { questions: [], answers: { 'Couleur ?': 'Bleu, Rouge' }, annotations: { 'Couleur ?': { notes: 'n' } }, response: 'r' } });
  assert.deepEqual(toPermissionResult(q, { kind: 'skip-question' }), { behavior: 'deny', message: SKIP_QUESTION_MESSAGE });
  const p = ask({ kind: 'plan', toolName: 'ExitPlanMode', input: { plan: 'P' } });
  assert.deepEqual(toPermissionResult(p, { kind: 'plan-approve', nextMode: 'acceptEdits', editedPlan: 'P2' }),
    { behavior: 'allow', updatedInput: { plan: 'P2' }, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  const bp = toPermissionResult(p, { kind: 'plan-approve', nextMode: 'bypassPermissions' }, { allowBypass: false }) as { updatedPermissions: { mode: string }[] };
  assert.equal(bp.updatedPermissions[0]!.mode, 'default');                          // bypass only when allowed for this chat
  assert.deepEqual(toPermissionResult(p, { kind: 'plan-reject', feedback: 'plus court' }), { behavior: 'deny', message: 'plus court' });
  assert.deepEqual(toElicitationResult({ kind: 'elicit', action: 'accept', content: { a: 1 } }), { action: 'accept', content: { a: 1 } });
});

function setup() {
  const clock = createFakeClock();
  const events: string[] = [];
  const reg = createAskRegistry({ clock, onChange: (c) => events.push(`change:${c}`),
    sink: { ask: (a) => events.push(`ask:${a.requestId}:${a.kind}`), askEnd: (c, r, why) => events.push(`end:${r}:${why}`) } });
  let exited = false;
  const ctx: AskContext = { cwd: process.cwd(), cwdSafe: true, allowBypass: false, mode: () => 'default', autoAvailable: () => true, exited: () => exited };
  return { clock, events, reg, ctx, die: () => { exited = true; } };
}
const opts = (requestId: string, ac: AbortController, extra: Record<string, unknown> = {}) =>
  ({ signal: ac.signal, requestId, toolUseID: 'tu-' + requestId, suggestions: sugg, ...extra }) as never;

test('registry: card fields, first decision wins, ask() before facts, askEnd answered', async () => {
  const { reg, ctx, events } = setup();
  const ac = new AbortController();
  const p = reg.canUseTool('a:s', ctx)('Bash', { command: 'npm ci' }, opts('r1', ac, { displayName: 'Bash', description: 'Installer' }));
  await new Promise((r) => setImmediate(r));
  const [card] = reg.list('a:s');
  assert.ok(card);
  assert.equal(card.offerAlways, true);
  assert.deepEqual(card.alwaysRules, ['Bash(npm ci)']);
  assert.equal(card.offerAuto, true);
  assert.equal(card.description, 'Installer');
  assert.equal(reg.count('a:s'), 1);
  assert.equal(events[0], 'ask:r1:permission');
  assert.equal(reg.decide('a:s', 'r1', { kind: 'allow-always', scope: 'localSettings' }), 'ok');
  assert.equal(reg.decide('a:s', 'r1', { kind: 'deny', message: 'x' }), 'not_pending');
  const r = await p as { behavior: string; updatedPermissions: PermissionUpdate[] };
  assert.equal(r.behavior, 'allow');
  assert.ok(r.updatedPermissions.every((u) => u.destination !== 'userSettings'));
  assert.ok(events.includes('end:r1:answered'));
  assert.equal(reg.count('a:s'), 0);
});

test('registry: question/plan kinds; abort withdraws (null + cancelled); exit → crash; rekey moves asks', async () => {
  const { reg, ctx, events, clock, die } = setup();
  const ac1 = new AbortController();
  const q = reg.canUseTool('a:s', ctx)('AskUserQuestion', { questions: [{ question: 'Q', header: 'h', multiSelect: false, options: [] }] }, opts('q1', ac1, { requiresUserInteraction: true }));
  const ac2 = new AbortController();
  const pl = reg.canUseTool('a:s', ctx)('ExitPlanMode', { plan: 'PLAN', planFilePath: 'p.md' }, opts('p1', ac2));
  await new Promise((r) => setImmediate(r));
  const kinds = Object.fromEntries(reg.list('a:s').map((a) => [a.requestId, a]));
  assert.equal(kinds['q1']!.kind, 'question');
  assert.equal(kinds['q1']!.offerAlways, false);
  assert.equal(kinds['p1']!.kind, 'plan');
  assert.equal(kinds['p1']!.plan, 'PLAN');
  ac1.abort();
  assert.equal(await q, null);                                     // the SDK then sends nothing
  clock.advance(1_000);
  assert.ok(events.includes('end:q1:cancelled'));
  reg.rekey('a:s', 'a:s2');
  assert.equal(reg.list('a:s2')[0]!.chatId, 'a:s2');
  die();
  ac2.abort();
  assert.equal(await pl, null);
  assert.ok(events.includes('end:p1:crash'));
  assert.equal(reg.decide('a:s2', 'p1', { kind: 'plan-reject', feedback: 'x' }), 'not_pending');
});

test('registry: allow-always with a non-S9 cwd degrades to session; endAll resolves null', async () => {
  const { reg, ctx, events } = setup();
  const ac = new AbortController();
  const p = reg.canUseTool('a:s', { ...ctx, cwdSafe: false })('Bash', { command: 'x' }, opts('r9', ac));
  await new Promise((r) => setImmediate(r));
  assert.equal(reg.list('a:s')[0]!.offerAlways, true);            // the session setMode suggestion survives the filter
  assert.deepEqual(reg.list('a:s')[0]!.alwaysRules, []);          // no localSettings rule offered outside an S9 cwd
  assert.equal(reg.decide('a:s', 'r9', { kind: 'allow-always', scope: 'localSettings' }), 'ok');
  const r = await p as { updatedPermissions?: PermissionUpdate[] };
  assert.ok((r.updatedPermissions ?? []).every((u) => u.destination === 'session'));
  const p2 = reg.canUseTool('a:s', ctx)('Bash', { command: 'y' }, opts('r10', new AbortController()));
  await new Promise((res) => setImmediate(res));
  reg.endAll('a:s', 'crash');
  assert.equal(await p2, null);
  assert.ok(events.includes('end:r10:crash'));
});

test('registry: a re-delivered requestId replaces the card; the replaced signal can no longer withdraw it; chat getter', async () => {
  const { reg, ctx, events, clock } = setup();
  let chat = 'a:s';
  const ac1 = new AbortController();
  const p1 = reg.canUseTool(() => chat, ctx)('Bash', { command: 'x' }, opts('rd', ac1));
  await new Promise((r) => setImmediate(r));
  chat = 'a:s3';                                                   // re-keyed meanwhile (as the engine does: getter + rekey)
  reg.rekey('a:s', 'a:s3');
  const ac2 = new AbortController();
  const p2 = reg.canUseTool(() => chat, ctx)('Bash', { command: 'x' }, opts('rd', ac2));
  await new Promise((r) => setImmediate(r));
  assert.equal(await p1, null);                                     // the replaced callback answers nothing
  ac1.abort();                                                      // late abort of the OLD signal
  clock.advance(1_000);
  assert.equal(events.includes('end:rd:cancelled'), false);
  assert.equal(reg.list('a:s3')[0]?.requestId, 'rd');
  assert.equal(reg.decide('a:s3', 'rd', { kind: 'allow-once' }), 'ok');
  assert.equal((await p2 as { behavior: string }).behavior, 'allow');
});
