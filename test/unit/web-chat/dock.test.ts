// dock/logic.js: card keys (defaultToNo, ←/→ scope, never in text fields), scopes (never userSettings, S7), card text,
// Edit/Write previews and « Modifier avant d'accepter », question answers (multi-select, Autre, notes), plan options
// and plan source (the ask, never the assistant frame), elicitation fields. Checked against the protocol fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protocolSteps, web } from './_load.ts';

const D = await web('components/dock/logic.js');
const { questionsOf } = await web('components/dock/QuestionForm.js');
const { modelName } = await web('components/dock/PlanCard.js');

const askOf = async (name: string) => (await protocolSteps(name)).flatMap((s) => (s.step === 'send' ? s.frame : [])).find((m: any) => m.t === 'ask').ask;
const k = (key: string, code = '', m: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
  ({ key, code, ctrlKey: !!m.ctrl, altKey: !!m.alt, shiftKey: !!m.shift });
const st = (o: Partial<{ inText: boolean; defaultToNo: boolean; offerAlways: boolean; isEdit: boolean }> = {}) =>
  ({ inText: false, defaultToNo: false, offerAlways: true, isEdit: false, ...o });

test('permission keys: digits on event.code (AZERTY-safe), letters on event.key', () => {
  assert.equal(D.permissionKey(k('&', 'Digit1'), st()), 'allow');
  assert.equal(D.permissionKey(k('o'), st()), 'allow');
  assert.equal(D.permissionKey(k('é', 'Digit2'), st()), 'always');
  assert.equal(D.permissionKey(k('T'), st()), 'always');
  assert.equal(D.permissionKey(k('"', 'Digit3'), st()), 'deny');
  assert.equal(D.permissionKey(k('n'), st()), 'deny');
  assert.equal(D.permissionKey(k('Escape'), st()), 'denyStop');
  assert.equal(D.permissionKey(k('Tab'), st()), 'comment');
  assert.equal(D.permissionKey(k('v'), st()), 'full');
  assert.equal(D.permissionKey(k('ArrowLeft'), st()), 'scopePrev');
  assert.equal(D.permissionKey(k('ArrowRight'), st()), 'scopeNext');
});

test('defaultToNo disables 1/O; no « always » without suggestions; E only for edits; nothing acts in a text field', () => {
  assert.equal(D.permissionKey(k('1', 'Digit1'), st({ defaultToNo: true })), null);
  assert.equal(D.permissionKey(k('o'), st({ defaultToNo: true })), null);
  assert.equal(D.permissionKey(k('2', 'Digit2'), st({ offerAlways: false })), null);
  assert.equal(D.permissionKey(k('2', 'Digit2'), st({ offerAlways: false, isEdit: true })), 'always');
  assert.equal(D.permissionKey(k('ArrowRight'), st({ offerAlways: false })), null);
  assert.equal(D.permissionKey(k('e'), st()), null);
  assert.equal(D.permissionKey(k('e'), st({ isEdit: true })), 'edit');
  // « Modifier avant d'accepter » edits one text: not offered for MultiEdit (its edits could not be applied)
  assert.equal(D.permissionKey(k('e'), { ...st({ isEdit: true }), canEdit: false }), null);
  const ask = (toolName: string) => ({ kind: 'permission', toolName, input: {} });
  assert.deepEqual(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash'].map((n) => D.canEditBefore(ask(n))), [true, true, true, false, false]);
  for (const e of [k('1', 'Digit1'), k('n'), k('Tab'), k('Escape')]) assert.equal(D.permissionKey(e, st({ inText: true })), null);
  assert.equal(D.permissionKey(k('1', 'Digit1', { ctrl: true }), st()), null);
});

test('scopes cycle session → local → project and never offer userSettings (S7)', () => {
  assert.deepEqual([...D.SCOPES], ['session', 'localSettings', 'projectSettings']);
  assert.equal(D.cycleScope('session', 1), 'localSettings');
  assert.equal(D.cycleScope('session', -1), 'projectSettings');
  assert.equal(D.cycleScope('projectSettings', 1), 'session');
  assert.ok(!Object.keys(D.SCOPE_KEYS).includes('userSettings'));
});

test('fixture permission ask: Bash subject, always offered with its rule, not an edit', async () => {
  const a = await askOf('permission');
  assert.deepEqual(D.askSubject(a), { kind: 'command', text: 'npm ci' });
  assert.equal(D.isEditAsk(a), false);
  assert.equal(a.offerAlways, true);
  assert.deepEqual(a.alwaysRules, ['Bash(npm ci)']);
});

test('Edit / Write previews and the edited input', () => {
  const edit = { kind: 'permission', toolName: 'Edit', input: { file_path: 'C:\\p\\a.ts', old_string: 'a\nb', new_string: 'a\nB' } };
  assert.equal(D.isEditAsk(edit), true);
  assert.deepEqual(D.editTexts(edit), { path: 'C:\\p\\a.ts', before: 'a\nb', after: 'a\nB', isNew: false, unavailable: false });
  assert.deepEqual(D.editedInput(edit, 'X'), { file_path: 'C:\\p\\a.ts', old_string: 'a\nb', new_string: 'X' });
  const s = D.previewStats('a\nb', 'a\nB');
  assert.deepEqual([s.added, s.removed, s.block], [1, 1, false]);
  const write = { kind: 'permission', toolName: 'Write', input: { file_path: 'n.txt', content: 'x\ny' } };
  assert.equal(D.editTexts(write).isNew, true);
  assert.equal(D.editTexts({ ...write, diffBase: { path: 'n.txt', text: 'x' } }).before, 'x');
  assert.equal(D.editTexts({ ...write, diffBase: { unavailable: true } }).unavailable, true);
  assert.deepEqual(D.editedInput(write, 'z'), { file_path: 'n.txt', content: 'z' });
});

test('fixture question: answers keyed by the exact question, multi-select joined with ", ", Autre and notes', async () => {
  const a = await askOf('question');
  const qs = questionsOf(a);
  assert.equal(qs.length, 2);
  let s = D.initQuestions(qs);
  assert.equal(D.buildAnswers(qs, s), null);                       // not every question answered
  s = [D.pickOption(qs[0], s[0], 1), D.pickOption(qs[1], D.pickOption(qs[1], s[1], 0), 2)];
  assert.deepEqual(D.buildAnswers(qs, s), { kind: 'answers', answers: { [qs[0].question]: 'Bleu', [qs[1].question]: 'Accueil, Aide' } });
  s[1] = D.pickOption(qs[1], s[1], 0);                              // toggling off
  s[1] = { ...D.pickOption(qs[1], s[1], qs[1].options.length), other: 'Profil' };
  s[0] = { ...s[0], note: 'plutôt foncé' };
  assert.deepEqual(D.buildAnswers(qs, s), { kind: 'answers', answers: { [qs[0].question]: 'Bleu', [qs[1].question]: 'Aide, Profil' },
    notes: { [qs[0].question]: 'plutôt foncé' } });
  const single = D.pickOption(qs[0], D.pickOption(qs[0], s[0], 0), qs[0].options.length);
  assert.deepEqual([single.selected, single.otherOn], [[], true]);  // single choice: Autre replaces the option
});

test('fixture plan: text from the ask; options Auto (or accept edits) then Manuel; bypass only when allowed', async () => {
  const a = await askOf('plan');
  assert.match(D.planText(a), /^- Écrire `plan.txt`/);
  assert.equal(D.planText({ ...a, plan: undefined }), a.input.plan);
  assert.deepEqual(D.planOptions({ autoAvailable: true, bypassAllowed: false }).map((o: any) => o.nextMode), ['auto', 'default']);
  assert.deepEqual(D.planOptions({ autoAvailable: false, bypassAllowed: false }).map((o: any) => o.key), ['plan.yesEdits', 'plan.yesManual']);
  assert.equal(D.planOptions({ autoAvailable: true, bypassAllowed: true })[0].nextMode, 'bypassPermissions');
  assert.equal(modelName('claude-sonnet-5-5'), 'Sonnet');
  assert.equal(modelName('claude-haiku-5-5'), 'Haiku');
});

test('elicitation: fields from the schema (text, number, boolean, enum) and typed content', () => {
  const f = D.elicitFields({ properties: { nom: { type: 'string', title: 'Nom' }, n: { type: 'integer' }, ok: { type: 'boolean' },
    env: { enum: ['dev', 'prod'] }, r: { type: 'number' } }, required: ['nom'] });
  assert.deepEqual(f.map((x: any) => [x.name, x.type, x.required]),
    [['nom', 'string', true], ['n', 'number', false], ['ok', 'boolean', false], ['env', 'enum', false], ['r', 'number', false]]);
  assert.equal(D.elicitContent(f, {}), null);
  assert.deepEqual(D.elicitContent(f, { nom: ' Ada ', n: '4', ok: true, env: 'prod', r: '4,5' }), { nom: 'Ada', n: 4, ok: true, env: 'prod', r: 4.5 });
  assert.equal(D.elicitContent(f, { nom: 'x', n: 'abc' }), null);
  assert.equal(D.elicitContent(f, { nom: 'x', n: '4,5' }), null);               // an integer field refuses a decimal
});

test('the CLI decision reason is shown in French when known, raw otherwise (description untouched)', async () => {
  const { t, hasKey } = await web('components/chat/text.js');
  assert.equal(D.permReasonKey('This command requires approval'), 'perm.why.approval');
  assert.equal(t(D.permReasonKey('This command requires approval')), 'Cette commande nécessite votre accord.');
  assert.equal(D.permReasonKey('This command requires approval.'), 'perm.why.approval');
  assert.equal(D.permReasonKey('Multiple directory changes in one command require approval for clarity'), 'perm.why.multiCd');
  assert.equal(D.permReasonKey('Some brand new CLI reason'), null);
  assert.equal(D.permReasonKey(undefined), null);
  assert.equal(D.permReasonKey(''), null);
  assert.equal(D.permReasonKey('toString'), null);                     // no prototype lookups
  for (const k of Object.values(D.PERM_REASON_KEYS) as string[]) assert.ok(hasKey(k), `fr.js has ${k}`);
  // the recorded shape (verify.md): Bash ask with decisionReason "This command requires approval"
  const ask = await askOf('permission');
  assert.equal(D.permReasonKey(ask.decisionReason), 'perm.why.approval');
});

test('M3 verifier: the everyday workingDir / Bash / PowerShell reasons of the CLI are in French too', async () => {
  const { t } = await web('components/chat/text.js');
  // workingDir: Read / Edit / Write outside the chat's folders (the most frequent reason after « requires approval »)
  assert.equal(t(D.permReasonKey('Path is outside allowed working directories')), 'Ce chemin est en dehors des dossiers de travail autorisés.');
  assert.equal(D.permReasonKey('This command uses shell operators that require approval for safety'), 'perm.why.operators');
  assert.equal(D.permReasonKey('Compound command contains cd with path operation — manual approval required to prevent path resolution bypass'), 'perm.why.cdCompound');
  assert.equal(D.permReasonKey('Command uses the background job operator (`&`) which spawns a child PowerShell process'), 'perm.why.psBackground');
  assert.equal(D.permReasonKey('  Write target is a symbolic link  '), 'perm.why.symlink');            // trimmed
  // every mapped reason has a French text that is not the English one
  for (const [raw, k] of Object.entries(D.PERM_REASON_KEYS) as [string, string][]) assert.notEqual(t(k), raw, k);
});
