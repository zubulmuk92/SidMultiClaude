import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, memoryLogger, redact, sanitizeFields } from '../../../src/server/util/log.ts';
import { createFsGuard } from '../../../src/server/util/fs-guard.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const tmp = createTmpRoot('log');
after(() => tmp.dispose());
// Fake secret prefixes, assembled from parts so that secret scanners do not flag these test vectors.
const SK = ['sk', 'ant', ''].join('-');
const BEARER = 'Bear' + 'er';
const AT = 'access' + 'Token';
const g = createFsGuard({ allowRoots: [tmp.appDir], home: tmp.home });
const readLines = (f: string): Record<string, unknown>[] => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

test('redact(): API keys, bearer tokens, access/refresh tokens, boot codes, WS auth protocols, registered secrets', () => {
  const device = 'Zx8yW_4-qTn0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';
  const s = redact([
    `key ${SK}api03-AbC_d-123`,
    `Authorization: ${BEARER} eyJhbGciOi.payload.sig`,
    `{"${AT}":"at-123","refreshToken":"rt-456"}`,
    'http://127.0.0.1:41731/#boot=QWERTY_123-abc',
    'protocols smc.boot.ABCdef123 smc.auth.ZZZ999',
    `device ${device}`,
    'login code#state abc123#xyz',
  ].join(' | '), [device]);
  for (const leak of ['AbC_d-123', 'eyJhbGciOi', 'at-123', 'rt-456', 'QWERTY_123', 'ABCdef123', 'ZZZ999', device, 'abc123#xyz']) assert.ok(!s.includes(leak), `${leak} leaked: ${s}`);
  assert.ok(s.includes(`${SK}***`), s);
  assert.ok(s.includes(`${BEARER} ***`), s);
});

test('fields: secrets replaced, message content replaced by its size, errors flattened, long strings cut', () => {
  const f = sanitizeFields({
    chatId: 'perso:4adf4c63-b504-4be1-804b-92a88963e275',
    text: 'mon prompt privé',
    nested: { content: [{ type: 'text', text: 'secret' }], ok: 3 },
    token: 'abc', deviceToken: 'def', exitCode: 75, code: 'ENOENT',
    err: Object.assign(new Error(`failed with ${SK}xyz`), { code: 'EPERM' }),
    long: 'x'.repeat(5000),
  });
  assert.equal(f['text'], '[16 chars]');
  assert.deepEqual(f['nested'], { content: '[content]', ok: 3 });
  assert.equal(f['token'], '***');
  assert.equal(f['deviceToken'], '***');
  assert.equal(f['exitCode'], 75);
  assert.equal(f['code'], 'ENOENT');
  const err = f['err'] as Record<string, unknown>;
  assert.equal(err['message'], `failed with ${SK}***`);
  assert.equal(err['code'], 'EPERM');
  assert.ok(String(f['long']).length < 2100);
  const dbg = sanitizeFields({ text: 'visible en debug' }, { debugContent: true });
  assert.equal(dbg['text'], 'visible en debug');
});

test('JSON lines with scope, level filter, child loggers and addSecret', () => {
  const clock = createFakeClock(Date.UTC(2026, 9, 8, 12, 0, 0));
  const log = createLogger({ dir: path.join(tmp.appDir, 'logs-a'), fs: g, clock, level: 'info' });
  log.debug('hidden');
  log.info('server listening', { port: 41731 });
  const eng = log.child('engine', { chatId: 'perso:4adf4c63-b504-4be1-804b-92a88963e275' });
  eng.warn('spawn slow', { ms: 2300 });
  log.addSecret('BOOTCODE-1234567890');
  log.error('opened #boot=BOOTCODE-1234567890 and BOOTCODE-1234567890');
  log.close();
  const file = log.file!;
  assert.equal(path.basename(file), 'server-20261008.log');
  const lines = readLines(file);
  assert.equal(lines.length, 3);
  assert.deepEqual(Object.keys(lines[0]!).slice(0, 3), ['t', 'lvl', 'msg']);
  assert.equal(lines[0]!['port'], 41731);
  assert.equal(lines[1]!['scope'], 'engine');
  assert.equal(lines[1]!['chatId'], 'perso:4adf4c63-b504-4be1-804b-92a88963e275');
  assert.ok(!JSON.stringify(lines[2]).includes('BOOTCODE-1234567890'));
});

test('rotation: 5 files × maxFileBytes, oldest deleted, new file per day', () => {
  const clock = createFakeClock(Date.UTC(2026, 9, 8, 12, 0, 0));
  const dir = path.join(tmp.appDir, 'logs-b');
  const log = createLogger({ dir, fs: g, clock, maxFileBytes: 2_000, maxFiles: 5 });
  for (let i = 0; i < 200; i++) log.info('ligne de journal assez longue pour remplir un fichier', { i, pad: 'p'.repeat(60) });
  let files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 5, files.join(','));
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 2_000 + 400, f);
  const last = readLines(path.join(dir, path.basename(log.file!)));
  assert.equal(last.at(-1)!['i'], 199, 'the newest line is in the current file');
  clock.advance(24 * 3600 * 1000);
  log.info('next day');
  assert.match(path.basename(log.file!), /^server-20261009\.log$/);
  files = fs.readdirSync(dir);
  assert.equal(files.length, 5);
  log.close();
});

test('a broken sink never throws from a log call', () => {
  const dir = path.join(tmp.appDir, 'logs-c');
  const g2 = createFsGuard({ allowRoots: [path.join(tmp.appDir, 'elsewhere')], home: tmp.home });   // dir NOT allowed
  const log = createLogger({ dir, fs: g2 });
  const orig = process.stderr.write.bind(process.stderr);
  let reported = '';
  process.stderr.write = ((s: string) => { reported += s; return true; }) as typeof process.stderr.write;
  try {
    assert.doesNotThrow(() => { log.info('a'); log.error('b'); });
  } finally { process.stderr.write = orig; }
  assert.match(reported, /file sink disabled/);
  assert.equal(fs.existsSync(dir), false);
});

test('memoryLogger records sanitised lines (for other packages\' tests)', () => {
  const m = memoryLogger();
  m.child('hub').info('sent', { text: 'contenu', n: 2 });
  assert.deepEqual(m.lines, [{ lvl: 'info', msg: 'sent', f: { scope: 'hub', text: '[7 chars]', n: 2 } }]);
  m.child('engine', { chatId: 'perso:x' }).child('pool', { n: 1 }).warn('evict', { n: 3 });   // base fields merge like createLogger's
  assert.deepEqual(m.lines[1], { lvl: 'warn', msg: 'evict', f: { scope: 'engine.pool', chatId: 'perso:x', n: 3 } });
});
