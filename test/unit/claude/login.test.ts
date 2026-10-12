// test/unit/claude/login.test.ts — LoginService against fakes/fake-login.mjs: url → waiting → done, errors, cancel, logout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createLoginService } from '../../../src/server/claude/login.ts';
import type { LoginService } from '../../../src/server/contracts.ts';
import type * as P from '../../../src/shared/protocol.ts';
import { isPidAlive } from '../../../src/server/util/winproc.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { makeStore, until } from './lib.ts';

const FAKE = path.join(import.meta.dirname, 'fakes', 'fake-login.mjs');
const root = createTmpRoot('wpc-login');
const { store, guard } = await makeStore(root);
after(async () => { store.close(); await root.disposeAsync(); });
// parent-session variables on purpose: accountEnv must strip them (the fake exits 3 on a leak)
const base = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_API_KEY: 'fake-api-key' };

const PIDFILE = path.join(root.root, 'fake-login.pid');
function service(mode: string, timeoutMs?: number): LoginService {
  return createLoginService({ accounts: store, exe: () => process.execPath, log: nullLogger, argsPrefix: () => [FAKE], guard,
    oauthWaitMs: 500,
    envBase: { ...base, FAKE_LOGIN_MODE: mode, FAKE_LOGIN_HOME: root.home, FAKE_LOGIN_PIDFILE: PIDFILE }, ...(timeoutMs ? { timeoutMs } : {}) });
}
const steps = (): { list: P.LoginStep[]; push: (s: P.LoginStep) => void } => { const list: P.LoginStep[] = []; return { list, push: (s) => list.push(s) }; };

test('new profile: folder created, url → waiting → code → done; logout', async () => {
  const dir = path.join(root.home, '.claude-neuf');
  const acc = await store.add({ configDir: dir, name: 'Neuf', color: 5, monogram: 'N' });
  assert.equal(fs.existsSync(dir), false);
  const ls = service('ok');
  const s = steps();
  ls.start(acc.id, 'moi@example.invalid', s.push);
  await until(() => s.list.some((x) => x.step === 'waiting'), 5000);
  assert.ok(fs.statSync(dir).isDirectory());
  assert.deepEqual(s.list.slice(0, 2), [{ step: 'url', url: 'https://claude.ai/oauth/authorize?code=true&client_id=fake&state=s1' }, { step: 'waiting' }]);
  ls.code(acc.id, 'abc123#s1');
  await until(() => s.list.some((x) => x.step === 'done' || x.step === 'error'), 8000);
  assert.deepEqual(s.list.at(-1), { step: 'done', email: 'moi@example.invalid', plan: 'Team' });
  await until(() => store.list().find((a) => a.id === acc.id)?.login === 'connected', 3000);
  await ls.logout(acc.id);
  assert.equal(store.list().find((a) => a.id === acc.id)?.login, 'disconnected');
});

test('error paths: Login failed, invalid code, exit 0 without an account, spawn failure', async () => {
  const acc = await store.add({ configDir: path.join(root.home, '.claude-err'), name: 'Err', color: 6, monogram: 'E' });
  for (const [mode, re] of [['fail', /Login failed: invalid_grant/], ['badcode', /Invalid code/], ['noaccount', /no oauthAccount/]] as const) {
    const ls = service(mode);
    const s = steps();
    ls.start(acc.id, undefined, s.push);
    await until(() => s.list.some((x) => x.step === 'waiting'), 5000);
    ls.code(acc.id, 'abc#def');
    await until(() => s.list.some((x) => x.step === 'error' || x.step === 'done'), 10_000);
    const last = s.list.at(-1)!;
    assert.equal(last.step, 'error', mode);
    assert.match((last as { message: string }).message, re);
    assert.equal((last as { key?: string }).key, 'login.err.failed', mode);   // i18n key, raw detail in message
  }
  const bad = createLoginService({ accounts: store, exe: () => 'node', log: nullLogger, guard });
  const s = steps();
  bad.start(acc.id, undefined, s.push);
  await until(() => s.list.length > 0, 2000);
  assert.equal(s.list[0]!.step, 'error');
  assert.match(String((s.list[0] as { key?: string }).key), /^login\.err\.(exit|spawn|failed)$/);
});

test('cancel kills the process; the 10 min timeout (shortened) kills and reports', async () => {
  const acc = await store.add({ configDir: path.join(root.home, '.claude-hang'), name: 'Hang', color: 7, monogram: 'H' });
  const ls = service('hang');
  const s = steps();
  ls.start(acc.id, undefined, s.push);
  await until(() => s.list.some((x) => x.step === 'waiting'), 5000);
  const pid = Number(fs.readFileSync(PIDFILE, 'utf8'));
  assert.ok(isPidAlive(pid));
  ls.cancel(acc.id);
  await until(() => !isPidAlive(pid), 5000);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!s.list.some((x) => x.step === 'error' || x.step === 'done'), 'no step after cancel');
  const t = service('hang', 700);
  const s2 = steps();
  t.start(acc.id, undefined, s2.push);
  await until(() => s2.list.some((x) => x.step === 'error'), 8000);
  await until(() => !isPidAlive(Number(fs.readFileSync(PIDFILE, 'utf8'))), 5000);
  assert.equal((s2.list.at(-1) as { key?: string }).key, 'login.err.timeout');
});
