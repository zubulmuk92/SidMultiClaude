// test/unit/claude/names.test.ts — default account names. A personal org ("<email>'s Organization",
// claude_max / claude_pro) is never suggested: « Perso », then « Perso 2 »…; a team / enterprise org gives its name. The
// monogram follows the name, colours 1 (default profile), 2 (.claude-pro), then the free ones.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { identityOf, monogramOf, suggestedColor, suggestedName, teamOrgName } from '../../../src/server/claude/profiles.ts';
import { makeStore } from './lib.ts';

test('teamOrgName: team / enterprise only, never "<email>\'s Organization"', () => {
  assert.equal(teamOrgName({ organizationName: 'ACME', organizationType: 'claude_team' }), 'ACME');
  assert.equal(teamOrgName({ organizationName: 'Acme', organizationType: 'claude_enterprise' }), 'Acme');
  assert.equal(teamOrgName({ organizationName: "prenom.nom@exemple.fr's Organization", organizationType: 'claude_team' }), null);
  assert.equal(teamOrgName({ organizationName: 'Jean’s Organization' }), null);
  assert.equal(teamOrgName({ organizationName: 'Org perso', organizationType: 'claude_max' }), null);
  assert.equal(teamOrgName({ organizationName: 'Org perso', organizationType: 'claude_pro' }), null);
  assert.equal(teamOrgName(null), null);
});

test('suggestedName: org name, « Perso », « Perso 2 »…; a profile without login is named after its folder', () => {
  const max = { accountUuid: 'u', organizationName: "a@b.invalid's Organization", organizationType: 'claude_max' };
  assert.equal(suggestedName(max, null, []), 'Perso');
  assert.equal(suggestedName(max, 'C:\\u\\.claude-x', ['perso']), 'Perso 2');
  assert.equal(suggestedName(max, 'C:\\u\\.claude-x', ['Perso', 'Perso 2']), 'Perso 3');
  assert.equal(suggestedName({ accountUuid: 'u', organizationName: 'ACME', organizationType: 'claude_team' }, 'C:\\u\\.claude-pro', ['Perso']), 'ACME');
  assert.equal(suggestedName(null, 'C:\\u\\.claude-travail', []), 'Travail');
  assert.equal(suggestedName(null, null, []), 'Perso');
});

test('monogramOf follows the name; suggestedColor prefers 1 / 2 then the free ones', () => {
  assert.equal(monogramOf('Perso'), 'P');
  assert.equal(monogramOf('Perso 2'), 'P2');
  assert.equal(monogramOf('acme'), 'A');
  assert.equal(suggestedColor(null, new Set()), 1);
  assert.equal(suggestedColor('C:\\u\\.claude-pro', new Set([1])), 2);
  assert.equal(suggestedColor('C:\\u\\.claude-x', new Set([1, 2])), 3);
  assert.equal(suggestedColor(null, new Set([1])), 2);
});

const root = createTmpRoot('m3-names');
after(() => root.dispose());
root.defaultProfile({ account: { organizationName: "default@example.invalid's Organization", organizationType: 'claude_max' } });
root.profile('pro', { account: { organizationName: 'ACME', organizationType: 'claude_team' } });
root.profile('max2', { account: { organizationName: "other@example.invalid's Organization", organizationType: 'claude_max' } });
root.profile('perso', { login: 'disconnected', catalog: false });

test('store.candidates(): suggestions unique across candidates; add() without a name uses them too', async () => {
  const { store } = await makeStore(root);
  after(() => store.close());
  const c = await store.candidates();
  const by = new Map(c.map((x) => [x.configDir === null ? 'default' : path.basename(x.configDir), x]));
  assert.deepEqual(by.get('default')?.suggested, { name: 'Perso', color: 1, monogram: 'P' });
  assert.deepEqual(by.get('.claude-pro')?.suggested, { name: 'ACME', color: 2, monogram: 'A' });
  assert.equal(by.get('.claude-pro')?.org, 'ACME');
  assert.equal(by.get('default')?.org, undefined);                    // never "<email>'s Organization"
  const names = c.map((x) => x.suggested?.name);
  assert.equal(new Set(names).size, names.length, `unique: ${names.join(', ')}`);
  assert.equal(by.get('.claude-max2')?.suggested?.name.startsWith('Perso '), true);
  assert.equal(by.get('.claude-max2')?.suggested?.monogram, `P${by.get('.claude-max2')!.suggested!.name.slice(-1)}`);
  const a = await store.add({ configDir: null, name: '', color: 0, monogram: '' });
  assert.equal(a.name, 'Perso');
  assert.equal(a.monogram, 'P');
  const again = await store.candidates();
  assert.equal(again.find((x) => x.configDir === null)?.suggested, undefined);
  assert.equal(again.find((x) => x.configDir !== null && path.basename(x.configDir) === '.claude-max2')?.suggested?.name, 'Perso 2');
});

test('identityOf (account card): the org is shown for a team / enterprise only, never "<email>’s Organization"', () => {
  const max = { accountUuid: 'u1', emailAddress: 'a@b.invalid', organizationName: "a@b.invalid's Organization", organizationType: 'claude_max', userRateLimitTier: 'default_claude_max_5x' };
  assert.equal(identityOf(max)?.org, undefined);
  assert.equal(identityOf(max)?.plan, 'Max 5x');
  assert.equal(identityOf({ ...max, organizationName: 'ACME', organizationType: 'claude_team' })?.org, 'ACME');
  assert.equal(identityOf({ ...max, organizationName: 'Big Corp', organizationType: 'claude_enterprise' })?.org, 'Big Corp');
});
