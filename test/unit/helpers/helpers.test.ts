// The shared test helpers work as documented (other packages build on them).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeClock } from '../../helpers/fake-clock.ts';
import { buildTranscript, createTmpRoot } from '../../helpers/tmp-profile.ts';
import { connectWs, tryConnect } from '../../helpers/ws-client.ts';
import { ackFor, bindTemplates, matchesRequest } from '../../helpers/scenario.ts';
import { createGuardedServer } from '../../../src/server/http/guard.ts';
import { projectKey } from '../../../src/server/util/paths.ts';

const tmp = createTmpRoot('helpers');
after(() => tmp.dispose());

test('fake clock: ordered firing, timers armed by callbacks, runAll, cancel, maxPending', () => {
  const c = createFakeClock(1_000);
  const log: string[] = [];
  c.timer(300, () => log.push(`b@${c.now()}`));
  c.timer(100, () => { log.push(`a@${c.now()}`); c.timer(50, () => log.push(`a2@${c.now()}`)); });
  const x = c.timer(200, () => log.push('never'));
  x.cancel();
  assert.equal(c.pending(), 2);
  c.advance(160);
  assert.deepEqual(log, ['a@1100', 'a2@1150']);
  assert.equal(c.now(), 1_160);
  assert.equal(c.runAll(), 1);
  assert.deepEqual(log, ['a@1100', 'a2@1150', 'b@1300']);
  assert.equal(c.maxPending, 3);
  assert.equal(c.runNext(), false);
});

test('tmp-profile: login states from files only (credentials stat + oauthAccount), never under a real profile', () => {
  const root = createTmpRoot('login');
  try {
    const connected = root.profile('a');
    const disconnected = root.profile('b', { login: 'disconnected' });
    const token = root.profile('c', { login: 'incoherent-token' });
    const account = root.profile('d', { login: 'incoherent-account' });
    const credman = root.profile('e', { login: 'credman' });
    const def = root.defaultProfile();
    const has = (p: typeof connected): [boolean, boolean] => [fs.existsSync(p.paths.credentials) && fs.statSync(p.paths.credentials).size > 0, !!p.readGlobalConfig()['oauthAccount']];
    assert.deepEqual(has(connected), [true, true]);
    assert.deepEqual(has(disconnected), [false, false]);
    assert.deepEqual(has(token), [true, false]);
    assert.deepEqual(has(account), [false, true]);
    assert.deepEqual(has(credman), [false, true]);
    assert.equal((credman.readGlobalConfig()['cachedGrowthBookFeatures'] as Record<string, unknown>)['tengu_windows_credman'], true);
    assert.equal(def.paths.globalConfig, path.join(root.home, '.claude.json'), 'default profile global config in home');
    assert.equal(def.configDir, null);
    assert.match(String((connected.readGlobalConfig()['oauthAccount'] as Record<string, unknown>)['emailAddress']), /@example\.invalid$/);
    assert.ok(fs.readdirSync(path.join(connected.paths.configHome, 'cache', 'model-catalog')).length === 1);
    connected.setLogin('disconnected');
    assert.deepEqual(has(connected), [false, false]);
    assert.ok(fs.existsSync(root.writePhantomGlobalConfig()));
  } finally { root.dispose(); }
});

test('tmp-profile: sessions land in <cfg>\\projects\\<projectKey(cwd)>, registry entries come with a decoy *.key', () => {
  const p = tmp.profile('pro');
  const cwd = tmp.cwd('Mon Projet');
  const s = p.addSession({ cwd, title: 'Titre de test', turns: [{ user: 'Bonjour', assistant: 'Salut' }, { user: 'Lance les tests', tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok' }, assistant: 'Fait.' }], costUsd: 0.01, lastMode: 'acceptEdits' });
  assert.equal(path.dirname(s.path), path.join(p.paths.projectsDir, projectKey(cwd)));
  const lines = fs.readFileSync(s.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const chain = lines.filter((e) => typeof e['uuid'] === 'string');
  for (let i = 1; i < chain.length; i++) assert.equal(chain[i]!['parentUuid'], chain[i - 1]!['uuid'], 'one linear chain');
  assert.deepEqual(lines.filter((e) => e['type'] === 'custom-title').map((e) => e['customTitle']), ['Titre de test', 'Titre de test']);
  assert.equal(lines.find((e) => e['type'] === 'last-prompt')!['leafUuid'], chain.at(-1)!['uuid']);
  assert.ok(lines.some((e) => e['type'] === 'permission-mode' && e['permissionMode'] === 'acceptEdits'));
  const reg = p.addRegistry({ pid: 4242, sessionId: s.sessionId, cwd, status: 'busy' });
  assert.equal(JSON.parse(fs.readFileSync(reg, 'utf8')).sessionId, s.sessionId);
  assert.equal(fs.readdirSync(p.paths.sessionsDir).filter((f) => f.endsWith('.key')).length, 1);
  p.trust(cwd);
  assert.equal(((p.readGlobalConfig()['projects'] as Record<string, Record<string, unknown>>)[cwd.replace(/\\/g, '/')])!['hasTrustDialogAccepted'], true);
  const f = p.addFixtureSession('main', { cwd });
  assert.equal(path.basename(f.path), '4adf4c63-b504-4be1-804b-92a88963e275.jsonl');
  assert.ok(fs.readFileSync(f.path, 'utf8').split('\n').filter(Boolean).every((l) => { const e = JSON.parse(l) as Record<string, unknown>; return e['cwd'] === undefined || e['cwd'] === cwd; }));
  assert.ok(buildTranscript({ cwd, sessionId: s.sessionId }).length > 3);
});

test('ws-client + the verbatim guard: boot code → device token (bare object frame), token reconnect, refusals', async () => {
  let saved: string | null = null;
  const clients: unknown[] = [];
  let guard!: ReturnType<typeof createGuardedServer>;
  let port = 0;
  for (let p = 41790; p < 41800 && !port; p++) {
    guard = createGuardedServer({ port: p, indexHtml: '<!doctype html><script type="importmap">__IMPORTMAP__</script>', importMap: '{"imports":{}}',
      staticFiles: new Map(), deviceToken: null, saveDeviceToken: (t) => { saved = t; }, onClient: (ws) => { clients.push(ws); ws.send(JSON.stringify([{ t: 'bye', reason: 'quit' }])); } });
    try { await guard.listen(); port = p; } catch { /* port busy: next */ }
  }
  assert.ok(port, 'a free port in 41790–41799');
  try {
    const code = guard.newBootCode();
    const c = await connectWs({ port, boot: code });
    assert.equal(c.protocol, 'smc.v1', 'only smc.v1 is echoed');
    await c.next((m) => m.t === 'bye');
    assert.equal(c.deviceToken, saved, 'device-token received');
    assert.equal(c.frames[0]!.length, 1);
    await c.close();
    assert.deepEqual(await tryConnect({ port, boot: code }), { ok: false, status: 403 }, 'boot codes are single use');
    const again = await tryConnect({ port, token: saved! });
    assert.equal(again.ok, true);
    assert.deepEqual(await tryConnect({ port, token: saved!, origin: null }), { ok: false, status: 403 });
    assert.deepEqual(await tryConnect({ port, token: saved!, origin: `http://127.0.0.1:${port + 1}` }), { ok: false, status: 403 });
    assert.deepEqual(await tryConnect({ port, token: 'A'.repeat(43) }), { ok: false, status: 403 });
    assert.deepEqual(await tryConnect({ port }), { ok: false, status: 403 });
  } finally { guard.server.close(); }
});

test('scenario templates: $req / $name tokens, whole-token typing, request matching, ack frames', () => {
  const vars = { req: { uuid: 'u-1', id: 7 }, A: { uuid: 'u-a', text: 'salut' } };
  assert.deepEqual(bindTemplates({ id: 'u:$A.uuid', n: '$req.id', s: ['$A.text', 'x $req.uuid'] }, vars), { id: 'u:u-a', n: 7, s: ['salut', 'x u-1'] });
  assert.equal(matchesRequest({ t: 'chat.send', uuid: '$A.uuid' }, { t: 'chat.send', uuid: 'u-a', id: 3 }, vars), true);
  assert.equal(matchesRequest({ t: 'chat.send', uuid: '$A.uuid' }, { t: 'chat.send', uuid: 'other' }, vars), false);
  assert.deepEqual(ackFor(3, { ok: true }), { t: 'ack', id: 3, ok: true });
  assert.deepEqual(ackFor(4, { ok: false, err: { code: 'busy' } }), { t: 'ack', id: 4, ok: false, err: { code: 'busy' } });
});
