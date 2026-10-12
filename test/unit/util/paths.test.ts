import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertNo83, appPaths, canonicalPath, chatIdFromDraftFile, defaultAppRoot, draftFileName, has83, homeReal, isInside, pathKey,
  profileCandidates, profilePaths, projectKey, realpathNative, samePath, ShortNameError, toSlash,
} from '../../../src/server/util/paths.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const tmp = createTmpRoot('paths');
after(() => tmp.dispose());

test('8.3 guard: /~\\d/ throws before fs.watch, long names pass', () => {
  assert.equal(has83('C:\\Users\\JEANDU~1\\AppData'), true);
  assert.equal(has83('C:\\Users\\Jean Dupont\\AppData'), false);
  assert.throws(() => assertNo83('C:\\Users\\JEANDU~1\\.claude\\projects'), ShortNameError);
  assert.equal(assertNo83('C:\\Users\\Jean Dupont\\.claude\\projects'), 'C:\\Users\\Jean Dupont\\.claude\\projects');
});

test('realpathNative expands the 8.3 temp dir and fixes the case', () => {
  const t = realpathNative(os.tmpdir());                       // os.tmpdir() is 8.3 on this machine (JEANDU~1)
  assert.equal(has83(t), false, t);
  const dir = path.join(tmp.root, 'CaseTest');
  fs.mkdirSync(dir);
  assert.equal(realpathNative(path.join(tmp.root, 'casetest')), dir);
  assert.equal(realpathNative(dir.toUpperCase()).toLowerCase(), dir.toLowerCase());
  assert.equal(has83(homeReal()), false);
  assert.throws(() => realpathNative(path.join(tmp.root, 'missing-dir')), /ENOENT/);
});

test('canonicalPath tolerates a missing tail and still expands the existing prefix', () => {
  const short = path.join(os.tmpdir(), path.relative(realpathNative(os.tmpdir()), tmp.root), 'nope', 'file.json');
  const c = canonicalPath(short);
  assert.equal(c, path.join(tmp.root, 'nope', 'file.json'));
  assert.equal(has83(c), false);
});

test('path comparisons are case- and separator-insensitive', () => {
  assert.equal(samePath('C:\\Users\\X\\Proj', 'c:/users/x/proj/'), true);
  assert.equal(isInside('c:\\users\\x\\proj\\src', 'C:\\Users\\X\\Proj'), true);
  assert.equal(isInside('C:\\Users\\X\\Proj', 'C:\\Users\\X\\Proj'), true);
  assert.equal(isInside('C:\\Users\\X\\Proj', 'C:\\Users\\X\\Proj', false), false);
  assert.equal(isInside('C:\\Users\\X\\Project2', 'C:\\Users\\X\\Proj'), false, 'prefix of a sibling name is not inside');
  assert.equal(isInside('C:\\', 'C:\\'), true);
  assert.equal(pathKey('C:\\'), 'c:\\');
  assert.equal(toSlash('C:\\Users\\Jean Dupont\\.claude\\CLAUDE.md'), 'C:/Users/Jean Dupont/.claude/CLAUDE.md');
});

test('app paths: %LOCALAPPDATA%\\SidMultiClaude layout and draft file names', () => {
  const root = defaultAppRoot({ LOCALAPPDATA: path.join(tmp.root, 'LocalAppData') });
  assert.equal(root, path.join(tmp.root, 'LocalAppData', 'SidMultiClaude'));
  const p = appPaths(tmp.appDir);
  assert.equal(p.chats, path.join(tmp.appDir, 'state', 'chats.json'));
  assert.equal(p.crashMarker, path.join(tmp.appDir, 'run', 'crash.marker'));
  assert.equal(p.logsDir, path.join(tmp.appDir, 'logs'));
  const chatId = 'perso-2:4adf4c63-b504-4be1-804b-92a88963e275';
  const f = draftFileName(chatId);
  assert.equal(f, 'perso-2_4adf4c63-b504-4be1-804b-92a88963e275.json');
  assert.ok(!f.includes(':'), 'no ADS separator in a file name');
  assert.equal(chatIdFromDraftFile(f), chatId);
  assert.equal(chatIdFromDraftFile('desktop.ini'), null);
  assert.throws(() => draftFileName('no-colon'));
});

test('profile paths: default profile vs configured dir', () => {
  const h = 'C:\\Users\\Someone';
  const d = profilePaths(null, h);
  assert.equal(d.configHome, 'C:\\Users\\Someone\\.claude');
  assert.equal(d.globalConfig, 'C:\\Users\\Someone\\.claude.json', 'default profile global config lives in home');
  assert.equal(d.credentials, 'C:\\Users\\Someone\\.claude\\.credentials.json');
  const w = profilePaths('C:\\Users\\Someone\\.claude-pro', h);
  assert.equal(w.globalConfig, 'C:\\Users\\Someone\\.claude-pro\\.claude.json');
  assert.equal(w.sessionsDir, 'C:\\Users\\Someone\\.claude-pro\\sessions');
  assert.equal(w.projectsDir, 'C:\\Users\\Someone\\.claude-pro\\projects');
});

test('profile candidates: .claude then every .claude-* directory', () => {
  tmp.defaultProfile();
  tmp.profile('pro');
  tmp.profile('perso', { login: 'disconnected' });
  fs.writeFileSync(path.join(tmp.home, '.claude-not-a-dir.txt'), 'x');
  const c = profileCandidates(tmp.home);
  assert.deepEqual(c.map((x) => x.configDir === null ? null : path.basename(x.configDir)), [null, '.claude-perso', '.claude-pro']);
});

test('CLI project key', () => {
  assert.equal(projectKey('C:\\Users\\Jean Dupont'), 'C--Users-Jean-Dupont');
  assert.equal(projectKey('C:\\dev\\avancé'), 'C--dev-avanc-');
  assert.equal(projectKey('C:\\x\\.claude\\worktrees\\a'), 'C--x--claude-worktrees-a');
  const long = 'C:\\' + 'a'.repeat(250);
  const k = projectKey(long);
  assert.ok(k.length > 200 && k.startsWith('C--' + 'a'.repeat(197)), k);
  assert.match(k, /^.{200}-[0-9a-z]+$/);
});
