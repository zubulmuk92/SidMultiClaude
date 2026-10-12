// fs-guard: the only write API. Real-profile paths are only passed to the PURE check(); nothing is ever written there.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureFsGuard, createFsGuard, fsGuard, FsGuardError, resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { homeReal, realpathNative } from '../../../src/server/util/paths.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const tmp = createTmpRoot('fsguard');
after(() => tmp.dispose());
const ext = tmp.externalProfile('configured', { login: 'disconnected' });
tmp.defaultProfile();
tmp.profile('pro');
tmp.profile('perso', { login: 'disconnected' });
const guard = createFsGuard({ allowRoots: [tmp.appDir, tmp.root], home: tmp.home, profileDirs: () => [ext.configDir!] });

const snapshot = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(p); if (e.isDirectory()) walk(p); } };
  walk(dir);
  return out.sort();
};

test('refuses every write under <home>\\.claude, .claude-pro, .claude-perso, .claude.json and a configured dir', async () => {
  const before = snapshot(tmp.home).concat(snapshot(ext.configDir!));
  const targets = [
    path.join(tmp.home, '.claude', 'settings.json'),
    path.join(tmp.home, '.claude', 'projects', 'x', 'y.jsonl'),
    path.join(tmp.home, '.claude-pro', 'settings.json'),
    path.join(tmp.home, '.claude-pro'),
    path.join(tmp.home, '.claude-perso', 'CLAUDE.md'),
    path.join(tmp.home, '.claude-new', 'x.json'),                      // any .claude-* name, even one that does not exist yet
    path.join(tmp.home, '.claude.json'),
    path.join(tmp.home, '.claude.json.tmp.123.abc'),
    path.join(tmp.home, '.CLAUDE-PRO', 'SETTINGS.JSON'),                 // case-insensitive
    path.join(ext.configDir!, '.claude.json'),
    path.join(ext.configDir!, 'projects', 'k', 's.jsonl'),
    // Win32 spellings of the same folders (trailing dots / spaces are dropped by CreateFile without \\?\)
    path.join(tmp.home, '.claude.', 'settings.json'),
    path.join(tmp.home, '.claude ', 'settings.json'),
    path.join(tmp.home, '.claude-pro.', 'new.json'),
    path.join(tmp.home, '.claude.json.'),
    path.join(ext.configDir! + '.', 'x.json'),
    // alternate data streams on a profile folder or file
    path.join(tmp.home, '.claude:evil'),
    path.join(tmp.home, '.claude.json:evil'),
    path.join(tmp.home, '.claude', 'settings.json::$DATA'),
  ];
  for (const t of targets) {
    assert.throws(() => guard.check(t), FsGuardError, t);
    await assert.rejects(guard.writeFile(t, 'x'), FsGuardError, t);
    assert.throws(() => guard.writeFileSync(t, 'x'), FsGuardError, t);
    await assert.rejects(guard.writeFileAtomic(t, 'x'), FsGuardError, t);
    assert.throws(() => guard.appendFileSync(t, 'x'), FsGuardError, t);
    await assert.rejects(guard.mkdir(path.join(t, 'sub')), FsGuardError, t);
    await assert.rejects(guard.rm(t, { force: true }), FsGuardError, t);
  }
  assert.deepEqual(snapshot(tmp.home).concat(snapshot(ext.configDir!)), before, 'nothing was created or removed');
});

test('a junction inside the app dir that points into a profile is refused (canonical check)', () => {
  const link = path.join(tmp.appDir, 'link-to-profile');
  fs.symlinkSync(path.join(tmp.home, '.claude-pro'), link, 'junction');
  assert.throws(() => guard.check(path.join(link, 'settings.json')), FsGuardError);
  assert.throws(() => guard.writeFileSync(path.join(link, 'settings.json'), 'x'), FsGuardError);
  assert.equal(fs.existsSync(path.join(tmp.home, '.claude-pro', 'settings.json')), false);
});

test('writes outside the allow-list, UNC and device paths, alternate data streams are refused', async () => {
  const g = createFsGuard({ allowRoots: [tmp.appDir], home: tmp.home });
  assert.throws(() => g.check(path.join(tmp.root, 'work', 'x.txt')), FsGuardError);
  assert.throws(() => g.check('\\\\server\\share\\x.json'), FsGuardError);
  assert.throws(() => g.check('\\\\?\\C:\\x.json'), FsGuardError);
  assert.throws(() => g.check('\\\\.\\pipe\\x'), FsGuardError);
  assert.throws(() => g.check('a\0b'), FsGuardError);
  assert.throws(() => g.check(path.join(tmp.appDir, 'state', 'chats.json:hidden')), /alternate data stream/);
  await assert.rejects(g.writeFile(path.join(os.tmpdir(), 'smc-should-not-exist.txt'), 'x'), FsGuardError);
});

test('writeFileAtomic: shouldCommit() false drops the prepared version (the newer file stays, no temp file left)', async () => {
  const d = path.join(tmp.appDir, 'commit');
  await guard.mkdir(d);
  const f = path.join(d, 'c.json');
  guard.writeFileAtomicSync(f, 'v1');
  guard.writeFileAtomicSync(f, 'v2');
  // the .bak is the previous file itself (a hard link renamed into place), never a copy that a kill could cut half-way
  const ino = (p: string): bigint => fs.statSync(p, { bigint: true }).ino;
  // and the target is always REPLACED by a rename (new file id), never rewritten in place (which a kill could tear)
  const before = ino(f);
  guard.writeFileAtomicSync(f, 'v2b');
  assert.equal(ino(f + '.bak'), before, 'sync: .bak = the previous file (same file id)');
  assert.notEqual(ino(f), before, 'sync: the target is a new file renamed into place');
  const before2 = ino(f);
  await guard.writeFileAtomic(f, 'v2');
  assert.equal(ino(f + '.bak'), before2, 'async: .bak = the previous file (same file id)');
  assert.notEqual(ino(f), before2, 'async: the target is a new file renamed into place');
  assert.equal(fs.readFileSync(f + '.bak', 'utf8'), 'v2b');
  guard.writeFileAtomicSync(f + '.bak', 'v1', { backup: false });      // reset the .bak content for the checks below
  let asked = 0;
  await guard.writeFileAtomic(f, 'older', { shouldCommit: () => { asked++; return false; } });
  assert.equal(asked, 1);
  assert.equal(fs.readFileSync(f, 'utf8'), 'v2');
  assert.equal(fs.readFileSync(f + '.bak', 'utf8'), 'v1', '.bak untouched by a dropped write');
  await guard.writeFileAtomic(f, 'v3', { shouldCommit: () => true });
  assert.equal(fs.readFileSync(f, 'utf8'), 'v3');
  assert.equal(fs.readFileSync(f + '.bak', 'utf8'), 'v2');
  assert.deepEqual(fs.readdirSync(d).sort(), ['c.json', 'c.json.bak']);
});

test('the REAL ~\\.claude, ~\\.claude-pro, ~\\.claude-perso and ~\\.claude.json are refused (pure check, also via 8.3)', () => {
  const home = homeReal();
  const g = createFsGuard({ allowRoots: [tmp.appDir], home });
  const real = [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude-pro', 'settings.json'),
    path.join(home, '.claude-perso', 'CLAUDE.md'),
    path.join(home, '.claude.json'),
  ];
  for (const t of real) assert.throws(() => g.check(t), FsGuardError, t);
  // the same paths spelled through the 8.3 home (os.tmpdir() is 8.3 here: C:\Users\JEANDU~1\…)
  const shortHome = path.dirname(path.dirname(path.dirname(os.tmpdir())));
  if (/~\d/.test(shortHome) && realpathNative(shortHome).toLowerCase() === home.toLowerCase()) {
    assert.throws(() => g.check(path.join(shortHome, '.claude-pro', 'settings.json')), FsGuardError);
    assert.throws(() => g.check(path.join(shortHome, '.claude.json')), FsGuardError);
  }
});

test('allowed writes: plain, append, atomic with .bak, mkdir, rename, rm', async () => {
  const d = path.join(tmp.appDir, 'state');
  await guard.mkdir(d);
  const f = path.join(d, 'a.json');
  await guard.writeFileAtomic(f, '{"v":1}');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"v":1}');
  assert.equal(fs.existsSync(f + '.bak'), false, 'no .bak for the first version');
  await guard.writeFileAtomic(f, '{"v":2}');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"v":2}');
  assert.equal(fs.readFileSync(f + '.bak', 'utf8'), '{"v":1}');
  guard.writeFileAtomicSync(f, '{"v":3}');
  assert.equal(fs.readFileSync(f + '.bak', 'utf8'), '{"v":2}');
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes('.tmp-')), [], 'no temp file left behind');
  guard.appendFileSync(path.join(d, 'log.txt'), 'a');
  await guard.appendFile(path.join(d, 'log.txt'), 'b');
  assert.equal(fs.readFileSync(path.join(d, 'log.txt'), 'utf8'), 'ab');
  await guard.rename(path.join(d, 'log.txt'), path.join(d, 'log2.txt'));
  await guard.rm(path.join(d, 'log2.txt'));
  assert.equal(fs.existsSync(path.join(d, 'log2.txt')), false);
  const fd = guard.openAppendSync(path.join(d, 'fd.txt'));
  fs.writeSync(fd, 'z'); fs.closeSync(fd);
  assert.equal(fs.readFileSync(path.join(d, 'fd.txt'), 'utf8'), 'z');
});

test('createProfileDir: the single exemption (an empty <home>\\.claude-<slug>)', async () => {
  const dir = await guard.createProfileDir(path.join(tmp.home, '.claude-nouveau'));
  assert.deepEqual(fs.readdirSync(dir), []);
  await assert.rejects(guard.createProfileDir(path.join(tmp.home, '.claude-nouveau')), /already exists/);
  await assert.rejects(guard.createProfileDir(path.join(tmp.home, '.claude')), /\.claude-<slug>/);
  await assert.rejects(guard.createProfileDir(path.join(tmp.home, '.claude-trailing.')), /\.claude-<slug>/);
  await assert.rejects(guard.createProfileDir(path.join(tmp.home, '.claude-a:b')), /\.claude-<slug>/);
  await assert.rejects(guard.createProfileDir(path.join(tmp.root, 'work', '.claude-x')), /directly under home/);
  await assert.rejects(guard.createProfileDir(path.join(tmp.home, '.claude-a', '.claude-b')), /directly under home/);
  assert.throws(() => guard.check(path.join(dir, 'settings.json')), FsGuardError, 'nothing can be written inside it afterwards');
});

test('the app-wide guard throws until configured', () => {
  resetFsGuardForTests();
  assert.throws(() => fsGuard(), /not configured/);
  const g = configureFsGuard({ allowRoots: [tmp.appDir], home: tmp.home });
  assert.equal(fsGuard(), g);
  resetFsGuardForTests();
});
