// test/unit/model/derive.test.ts — deriveTitle / activityLine tables and derive helpers (acceptance 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityLine, deriveTitle, modelFamily, planModelBadge, slashCommandViews } from '../../../src/server/model/derive.ts';
import type * as P from '../../../src/shared/protocol.ts';

const long = 'Ajoute des tests unitaires pour le parseur de dates et vérifie les fuseaux horaires';

test('deriveTitle table', () => {
  const rows: [string, string][] = [
    ['Ajoute des tests', 'Ajoute des tests'],
    ['  \n\n  Corrige le bug\nsecond line', 'Corrige le bug'],
    ['/review Regarde le diff', 'Regarde le diff'],
    ['/plugin:cmd-x  fais ça', 'fais ça'],
    ['Lis @src/parser.ts et corrige', 'Lis parser.ts et corrige'],
    ['Compare @"C:\\Mes docs\\a b.txt" avec @lib/', 'Compare a b.txt avec lib'],
    ['email foo@bar.com ok', 'email foo@bar.com ok'],
    ['/clear', ''],
    ['', ''],
    ['\r\n  Multiple   spaces\there  ', 'Multiple spaces here'],
    [long, `${long.slice(0, 59).trimEnd()}…`],
    ['/home/jean/notes.txt est vide', '/home/jean/notes.txt est vide'],   // a path, not a /command
    ['/compact', ''],
  ];
  for (const [input, want] of rows) assert.equal(deriveTitle(input), want, JSON.stringify(input));
  const t = deriveTitle(long);
  assert.ok(t.length <= 60 && t.endsWith('…'));
  assert.equal(deriveTitle('x'.repeat(60)), 'x'.repeat(60));
  assert.equal(deriveTitle('x'.repeat(61)).length, 60);
  assert.equal(deriveTitle(undefined as unknown as string), '');
  // the cut never splits a surrogate pair (an emoji on the 60-char boundary)
  const emo = deriveTitle(`${'x'.repeat(58)}😀😀😀`);
  assert.ok(emo.length <= 60 && emo.endsWith('…') && !/[\uD800-\uDBFF]…$/.test(emo), emo);
});

const ask = (o: Partial<P.PendingAsk>): P.PendingAsk => ({
  chatId: 'a:s', requestId: 'r', toolUseId: 't', kind: 'permission', toolName: 'Bash', input: {}, offerAlways: false, alwaysRules: [],
  offerAuto: false, defaultToNo: false, since: 0, ...o,
});

test('activityLine table: ask › running tool › last reply › first prompt', () => {
  const rows: [Parameters<typeof activityLine>[0], string][] = [
    // data only, in the ux §3.3 form « Bash : npm test »: no French copy is built on the server
    [{ ask: ask({ input: { command: 'npm ci' } }) }, 'Bash : npm ci'],
    [{ ask: ask({ toolName: 'Edit', displayName: 'Modifier', input: { file_path: 'C:\\w\\a.ts' } }) }, 'Modifier : C:\\w\\a.ts'],
    [{ ask: ask({ toolName: 'WebFetch', input: { url: 'https://x.io/a' } }) }, 'WebFetch : https://x.io/a'],
    [{ ask: ask({ input: { command: 'git status\ngit diff' } }) }, 'Bash : git status'],
    [{ ask: ask({ kind: 'question', toolName: 'AskUserQuestion', questions: [{ question: 'Quelle lib ?', header: 'Lib', multiSelect: false, options: [] }] }) }, 'Quelle lib ?'],
    [{ ask: ask({ kind: 'plan', toolName: 'ExitPlanMode', plan: '# Plan : refonte\n1. a' }) }, 'Plan : refonte'],
    [{ ask: ask({ kind: 'plan', toolName: 'ExitPlanMode' }) }, 'ExitPlanMode'],
    [{ ask: ask({ kind: 'elicitation', toolName: 'x', elicitation: { mode: 'form', server: 'slack', message: 'Choisir un canal' } }) }, 'slack : Choisir un canal'],
    [{ ask: ask({ input: { command: 'a' } }), tool: { name: 'Read' }, lastText: 'z' }, 'Bash : a'],
    [{ tool: { name: 'Bash', description: 'Installer les dépendances' } }, 'Bash : Installer les dépendances'],
    [{ tool: { name: 'Read' } }, 'Read'],
    [{ tool: { name: 'mcp__slack__post_message' } }, 'slack › post_message'],
    [{ tool: { name: 'Frobnicate' } }, 'Frobnicate'],
    [{ lastText: '\n## Résumé\nTout est vert.' }, 'Résumé'],
    [{ lastText: '- point un' }, 'point un'],
    [{ firstPrompt: '\nFais le ménage\nensuite' }, 'Fais le ménage'],
    [{}, ''],
  ];
  for (const [input, want] of rows) assert.equal(activityLine(input), want, JSON.stringify(input));
  const cutLine = activityLine({ lastText: 'mot '.repeat(60) });
  assert.ok(cutLine.length <= 80 && cutLine.endsWith('…'));
});

test('slashCommandViews: groups, local badge, aliases, dedupe', () => {
  const v = slashCommandViews(['clear', '/compact', 'mcp__srv__do', 'my-skill', 'plug:cmd', 'clear', { name: 'review', description: 'Relit', argumentHint: '[pr]', aliases: ['rv'] }],
    { skills: ['my-skill'] });
  assert.deepEqual(v.map((c) => [c.name, c.group, c.local]), [
    ['clear', 'builtin', true], ['compact', 'builtin', false], ['mcp__srv__do', 'mcp', false], ['my-skill', 'skill', false], ['plug:cmd', 'plugin', false], ['review', 'builtin', false],
  ]);
  const rv = v.find((c) => c.name === 'review')!;
  assert.equal(rv.hint, '[pr]');
  assert.deepEqual(rv.aliases, ['rv']);
  assert.deepEqual(slashCommandViews(null), []);
});

test('model family and plan.modelBadge', () => {
  assert.equal(modelFamily('claude-sonnet-5-5'), 'Sonnet');
  assert.equal(modelFamily('haiku'), 'Haiku');
  assert.equal(modelFamily('custom-x'), 'custom-x');
  assert.equal(planModelBadge('haiku', 'claude-sonnet-5-5'), 'Sonnet');
  assert.equal(planModelBadge('claude-haiku-5-5', 'claude-haiku-5-5'), null);
  assert.equal(planModelBadge('haiku', '<synthetic>'), null);
  assert.equal(planModelBadge(undefined, 'claude-sonnet-5-5'), null);
});
