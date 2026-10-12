// M2 (pure parts of the chat surface): the account's model catalog with the alias fallback, Auto only when the chat's
// model supports it, the code-fence language label of lib/md.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { web } from './_load.ts';

const H = await web('components/chat/PaneHeader.js');
const { fenceLang } = await web('lib/md.js');

test('model menu: the account catalog (AccountView.models) or, absent / empty, the aliases opus / sonnet / haiku', () => {
  assert.deepEqual(H.modelChoices(undefined).map((m: { value: string }) => m.value), ['opus', 'sonnet', 'haiku']);
  assert.deepEqual(H.modelChoices({ models: [] }).map((m: { value: string }) => m.value), ['opus', 'sonnet', 'haiku']);
  const cat = [{ value: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high'] }, { value: 'sonnet', label: 'Sonnet', efforts: [] }];
  assert.deepEqual(H.modelChoices({ models: cat }), cat);
  assert.equal(H.currentModel(cat, 'claude-opus-5-5')?.label, 'Opus 5.5');
  assert.equal(H.currentModel(cat, 'claude-sonnet-5-5')?.value, 'sonnet', 'an alias contained in the id');
  assert.equal(H.currentModel(cat, null), undefined);
});

test('mode menu: Auto only when autoAvailable (the current mode always stays); bypass only when allowed', () => {
  assert.deepEqual(H.menuModes({ allowBypass: false, autoAvailable: false, current: 'default' }), ['default', 'acceptEdits', 'plan']);
  assert.deepEqual(H.menuModes({ allowBypass: false, autoAvailable: true, current: 'default' }), ['default', 'acceptEdits', 'plan', 'auto']);
  assert.deepEqual(H.menuModes({ allowBypass: true, autoAvailable: false, current: 'auto' }), ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
});

test('code fences: the language label is the first word of the info string, a short plain name only', () => {
  assert.equal(fenceLang('ts'), 'ts');
  assert.equal(fenceLang('python title="x.py"'), 'python');
  assert.equal(fenceLang('c++'), 'c++');
  assert.equal(fenceLang(undefined), '');
  assert.equal(fenceLang('"><img src=x>'), '');
  assert.equal(fenceLang('a<b'), '');
  assert.equal(fenceLang('x'.repeat(25)), '');
});
