// Grep tests of SPEC §2.8 (`grep -r setInterval src/server` is empty) and §10 S8
// (no shell spawn option anywhere, no shell at all). They mirror the literal greps: comments count too, so the greps
// stay empty, and they cover every file of src/.
// The searched tokens are assembled at run time, so this file never matches its own greps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SOURCE_RE = /\.(ts|mts|cts|js|mjs|cjs|cs|ps1|vbs|html)$/;
function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'fixtures' ? [] : files(p);
    return SOURCE_RE.test(e.name) ? [p] : [];
  });
}
const read = (dirs: string[]) => dirs.flatMap((d) => files(path.join(ROOT, d))).map((f) => ({ f: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));
const INTERVAL = ['set', 'Interval'].join('');
const SHELL_OPTION = new RegExp(['\\bshell', '\\s*:'].join(''));

test('no interval timer anywhere in src/server, comments included (single-timer policy)', () => {
  const server = read(['src/server']);
  assert.ok(server.length > 30, 'the whole tree is scanned');
  assert.deepEqual(server.filter((s) => s.text.includes(INTERVAL)).map((s) => s.f), []);
});

test('no shell spawn option anywhere in the repo, and no shell executable launched by name in src/server', () => {
  const all = read(['src', 'scripts', 'test', 'launcher']);
  assert.ok(all.length > 150, `the whole repo is scanned (${all.length} files)`);
  assert.deepEqual(all.filter((s) => SHELL_OPTION.test(s.text)).map((s) => s.f), []);
  const server = all.filter((s) => s.f.startsWith(path.join('src', 'server')));
  const cmd = server.filter((s) => /spawn(?:Sync)?\(\s*['"](?:cmd|cmd\.exe|bash|sh|powershell|pwsh)(?:\.exe)?['"]/i.test(s.text)).map((s) => s.f);
  assert.deepEqual(cmd, []);
});
