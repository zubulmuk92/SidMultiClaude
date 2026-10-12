// test/unit/claude/accounts.test.ts — account store: login matrix, phantom config, plans, duplicates, excludes, trust.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { toSlash } from '../../../src/server/util/paths.ts';
import { planLabel } from '../../../src/server/claude/profiles.ts';
import { makeStore, until } from './lib.ts';
import { budget } from '../../helpers/perf.ts';

const root = createTmpRoot('wpc-acc');
after(() => root.dispose());

const def = root.defaultProfile({ claudeMd: '# perso' });
const pro = root.profile('pro', { account: { organizationType: 'claude_team', organizationRateLimitTier: 'default_raven', userRateLimitTier: null, seatTier: 'team_premium' } });
root.profile('perso', { login: 'disconnected', catalog: false });
root.profile('tok', { login: 'incoherent-token', catalog: false });
root.profile('acc', { login: 'incoherent-account', catalog: false });
root.profile('cm', { login: 'credman' });
root.profile('dup', { account: { accountUuid: pro.accountUuid! } });
root.writePhantomGlobalConfig();
fs.mkdirSync(path.join(root.home, '.claude', 'rules'), { recursive: true });
fs.writeFileSync(path.join(root.home, '.claude', 'rules', 'style.md'), '# r');

const { store } = await makeStore(root);
after(() => store.close());
const dirOf = (n: string): string => path.join(root.home, `.claude-${n}`);

test('candidates: default + every ~\\.claude-*, login state from stat + oauthAccount', async () => {
  const c = await store.candidates();
  const by = new Map(c.map((x) => [x.configDir === null ? 'default' : path.basename(x.configDir), x]));
  assert.equal(by.get('default')?.login, 'connected');                  // ~\.claude.json, NOT the phantom ~\.claude\.claude.json
  assert.equal(by.get('default')?.email, 'default@example.invalid');
  assert.equal(by.get('.claude-pro')?.login, 'connected');
  assert.equal(by.get('.claude-perso')?.login, 'disconnected');
  assert.equal(by.get('.claude-tok')?.login, 'incoherent');
  assert.equal(by.get('.claude-acc')?.login, 'incoherent');
  assert.equal(by.get('.claude-cm')?.login, 'connected');                // credman: the uuid alone is enough
  assert.ok(c.every((x) => x.added === false));
});

test('add: identity, plan labels, duplicates, persisted in config.json', async () => {
  const d = await store.add({ configDir: null, name: 'Perso', color: 1, monogram: 'P' });
  const w = await store.add({ configDir: dirOf('pro'), name: 'ACME', color: 2, monogram: 'A' });
  const dup = await store.add({ configDir: dirOf('dup'), name: 'Doublon', color: 3, monogram: 'D' });
  await store.add({ configDir: dirOf('perso'), name: 'Perso 2', color: 4, monogram: 'P2' });
  assert.equal(d.isDefault, true);
  assert.equal(d.identity?.plan, 'Max 5x');
  assert.equal(w.identity?.plan, 'Team');
  assert.equal(w.identity?.org, 'Org pro');
  assert.equal(dup.diag.duplicateOf, w.id);
  assert.equal(store.list().find((a) => a.id === w.id)?.diag.duplicateOf, undefined);
  assert.equal(store.list().find((a) => a.name === 'Perso 2')?.login, 'disconnected');
  await assert.rejects(store.add({ configDir: dirOf('pro'), name: 'x', color: 1, monogram: 'x' }));
  await assert.rejects(store.add({ configDir: path.join(root.home, '.claude'), name: 'x', color: 1, monogram: 'x' }));
  assert.ok((await store.candidates()).find((x) => x.configDir === null)?.added);
  const cfg = JSON.parse(fs.readFileSync(path.join(root.appDir, 'config.json'), 'utf8')) as { v: number; data: { accounts: unknown[] } };
  assert.equal(cfg.v, 1);
  assert.equal(cfg.data.accounts.length, 4);
  assert.equal(planLabel({ organizationType: 'claude_max', userRateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(planLabel({ organizationType: 'claude_pro' }), 'Pro');
});

test('claudeMdExcludes: exact case and `/`, never on the default profile', async () => {
  const [d, w] = store.list();
  const h = toSlash(root.home);
  assert.deepEqual(store.claudeMdExcludes(w!.id), [`${h}/.claude/CLAUDE.md`, `${h}/.claude/rules/**`]);
  assert.deepEqual(store.claudeMdExcludes(d!.id), []);
  await store.update(d!.id, { excludeForeignClaudeMd: true });
  assert.equal(store.get(d!.id)!.excludeForeignClaudeMd, false);
  assert.deepEqual(store.claudeMdExcludes(d!.id), []);
  assert.ok(store.list()[1]!.diag.leakFiles.some((f) => /CLAUDE\.md$/.test(f)));
  assert.deepEqual(store.list()[0]!.diag.leakFiles, []);
  await store.update(w!.id, { excludeForeignClaudeMd: false });
  assert.deepEqual(store.claudeMdExcludes(w!.id), []);
  await store.update(w!.id, { excludeForeignClaudeMd: true });
});

test('trustedInCli: `\\` vs `/`, case-insensitive, trusted parent', () => {
  const [, w] = store.list();
  const cwd = root.cwd('Projet');
  const sub = path.join(cwd, 'sous');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(store.trustedInCli(w!.id, cwd), false);
  pro.trust(cwd.toLowerCase(), '/');
  store.refreshNow(w!.id);
  assert.equal(store.trustedInCli(w!.id, cwd), true);
  assert.equal(store.trustedInCli(w!.id, cwd.toUpperCase()), true);
  assert.equal(store.trustedInCli(w!.id, sub), true);
  assert.equal(store.trustedInCli(w!.id, root.cwd('Autre')), false);
});

test('usage, reauth, catalog, cleanupDays; global config changes are watched', async () => {
  const [, w] = store.list();
  pro.writeGlobalConfig({ cachedUsageUtilization: { fetchedAtMs: Date.now() - 2 * 3_600_000, accountUuid: pro.accountUuid,
    utilization: { limits: [{ kind: 'session', group: 'session', percent: 42, severity: 'normal', resets_at: '2026-10-08T15:00:00Z', scope: null, is_active: true }] } } });
  pro.writeSettings({ cleanupPeriodDays: 3650 });
  let fired = 0;
  const off = store.onChange((id) => { if (id === w!.id) fired++; });
  const ms = await until(() => store.list()[1]!.usage?.rows[0]?.pct === 42, 2000);
  assert.ok(ms < budget(500), `watch reacted in ${ms.toFixed(0)} ms`);
  assert.ok(fired > 0);
  const u1 = store.list()[1]!.usage!;
  assert.equal(u1.source, 'snapshot');
  assert.equal(u1.stale, true);
  store.noteUsage(w!.id, { kind: 'event', info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.8, resetsAt: 1_790_000_000 } });
  const u2 = store.list()[1]!.usage!;
  assert.equal(u2.source, 'event');
  assert.equal(u2.rows.find((r) => r.key === 'session')?.pct, 80);
  assert.equal(u2.stale, false);
  assert.equal(store.cleanupDays(w!.id), 3650);
  assert.ok(store.modelCatalog(w!.id).length > 0);
  store.noteAuthError(w!.id);
  assert.equal(store.list()[1]!.login, 'reauth');
  pro.setLogin('disconnected');
  await until(() => store.list()[1]!.login === 'disconnected', 2000);
  off();
});

test('config.json naming ~\\.claude explicitly is read back as the default profile (never CLAUDE_CONFIG_DIR=~\\.claude)', async () => {
  const r2 = createTmpRoot('wpc-acc-phantom');
  try {
    r2.defaultProfile();
    fs.writeFileSync(path.join(r2.appDir, 'config.json'), JSON.stringify({ v: 1, data: { accounts: [
      { id: 'perso', name: 'Perso', color: 1, monogram: 'P', configDir: path.join(r2.home, '.claude'), excludeForeignClaudeMd: true, defaults: {} },
    ] } }));
    const { store: s3 } = await makeStore(r2);
    const [a] = s3.list();
    assert.equal(a?.configDir, null);
    assert.equal(a?.isDefault, true);
    assert.equal(s3.get('perso')?.excludeForeignClaudeMd, false);
    assert.deepEqual(s3.claudeMdExcludes('perso'), []);
    assert.equal(s3.paths('perso').globalConfig, path.join(r2.home, '.claude.json'));
    s3.close();
  } finally { r2.dispose(); }
});

test('a second store reads config.json back', async () => {
  const { store: s2 } = await makeStore(root);
  assert.deepEqual(s2.list().map((a) => a.name), store.list().map((a) => a.name));
  assert.equal(s2.list()[0]!.configDir, null);
  s2.close();
  void def;
});
