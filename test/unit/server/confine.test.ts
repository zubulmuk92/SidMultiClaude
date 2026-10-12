// Ready test for WP-D (seeded by WP0): platform\scripts\confine-test.mjs, the 15 cases of out2\confine.json.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { confine, confineOrThrow, ConfineError } from '../../../src/server/platform/confine.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const tmp = createTmpRoot('confine');
after(() => tmp.dispose());
const work = path.join(tmp.root, 'work');
const root = path.join(work, 'Mon Projet');
const outside = path.join(work, 'outside');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
fs.symlinkSync(outside, path.join(root, 'link-out'), 'junction');   // junction escaping the root
const rootReal = fs.realpathSync.native(root);

// [case, expected]: 'OK <path relative to work>' or 'REJECT: <reason>' (verbatim from out2\confine.json)
const CASES: [string, string][] = [
  ['src/a.ts', 'OK Mon Projet\\src\\a.ts'],
  ['src\\a.ts', 'OK Mon Projet\\src\\a.ts'],
  ['../outside/secret.txt', 'REJECT: lexical escape'],
  ['src/../../outside/secret.txt', 'REJECT: lexical escape'],
  ['link-out/secret.txt', 'REJECT: escapes root after realpath (junction/symlink)'],
  ['C:/Windows/win.ini', 'REJECT: absolute/drive-relative path'],
  ['c:win.ini', 'REJECT: absolute/drive-relative path'],
  ['\\\\attacker\\share\\x', 'REJECT: UNC/device path'],
  ['\\\\?\\C:\\Windows\\win.ini', 'REJECT: UNC/device path'],
  ['//./pipe/x', 'REJECT: UNC/device path'],
  ['src/a.ts:secret', 'REJECT: ADS / colon'],
  ['CON', 'REJECT: reserved device name'],
  ['src/nul.txt', 'REJECT: reserved device name'],
  ['aux ', 'REJECT: reserved device name'],
  ['SRC/A.TS', 'OK Mon Projet\\src\\a.ts'],
];

test('confine: the 15 platform cases', () => {
  assert.equal(CASES.length, 15);
  for (const [c, expected] of CASES) {
    let got: string;
    try { got = 'OK ' + path.relative(fs.realpathSync.native(work), confineOrThrow(rootReal, c)); } catch (e) {
      assert.ok(e instanceof ConfineError, c);
      got = 'REJECT: ' + e.reason;
    }
    assert.equal(got, expected, c);
  }
});

test('confine (contract shape): real path or null; missing targets pass the lexical checks', () => {
  assert.equal(confine(root, 'src/a.ts'), path.join(rootReal, 'src', 'a.ts'));
  assert.equal(confine(root, 'link-out/secret.txt'), null);
  assert.equal(confine(root, 'new/file.md'), path.join(rootReal, 'new', 'file.md'));
  assert.equal(confine(path.join(work, 'missing-root'), 'x'), null);
  assert.equal(confine(root, 'a'.repeat(1025)), null);
  assert.equal(confine(root, 'COM1.txt'), null);
  assert.equal(confine(root, 'lpt¹'), null);
  assert.equal(confine(root, 'nul.'), null);
});

test('confine: a missing target behind a junction is refused; names starting with ".." stay inside', () => {
  assert.equal(confine(root, 'link-out/new.txt'), null, 'the junction leads out even if the file does not exist yet');
  assert.equal(confine(root, 'link-out/deeper/new.txt'), null);
  assert.equal(confine(root, 'src/new/deeper.txt'), path.join(rootReal, 'src', 'new', 'deeper.txt'));
  fs.writeFileSync(path.join(root, '..env.example'), 'x');
  assert.equal(confine(root, '..env.example'), path.join(rootReal, '..env.example'), '"..x" is a legal name, not an escape');
  assert.equal(confine(root, '..'), null);
  assert.equal(confine(root, 'src/../..'), null);
});
