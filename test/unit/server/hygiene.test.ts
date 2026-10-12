// WP-D acceptance 7 / S8, scoped to WP-D's own files so that the package's Verify enforces it (WP0's repo-wide version is
// test/unit/util/hygiene.test.ts): no interval timer, no shell spawn option, no shell executable launched by name, and
// every process launch in the server shell names an absolute .exe path held in a variable (never a bare literal).
// The searched tokens are assembled at run time, so this file never matches its own greps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OWNED = ['src/server/main.ts', 'src/server/http', 'src/server/ws', 'src/server/app', 'src/server/platform', 'launcher/SidMultiClaude.cs',
  'launcher/SidMultiClaude.vbs', 'scripts/install.ps1', 'scripts/vendor-audit.mjs', 'test/fakes/fake-engine.ts', 'test/unit/server',
  'test/integration/server', 'test/e2e/security.e2e.ts'];
function files(p: string): string[] {
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [abs];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => files(path.join(p, e.name)));
}
const all = OWNED.flatMap(files).map((f) => ({ f: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));
const INTERVAL = ['set', 'Interval'].join('');
const SHELL_OPTION = new RegExp(['\\bshell', '\\s*:'].join(''));
const SHELL_BY_NAME = new RegExp(['(?:spawn|spawnSync|execFile|execHidden|spawnHidden)\\(\\s*[\'"`]', '(?:cmd|bash|sh|powershell|pwsh|wsl)(?:\\.exe)?[\'"`]'].join(''), 'i');
const BARE_LITERAL = new RegExp(['(?:spawn|spawnSync|execFile|execHidden|spawnHidden)\\(\\s*[\'"`]', '[^\'"`\\\\/]+[\'"`]'].join(''));

test('WP-D files: no interval timer, no shell option, no shell launched by name, no bare executable literal', () => {
  assert.ok(all.length >= 30, `WP-D files scanned: ${all.length}`);
  assert.deepEqual(all.filter((s) => s.text.includes(INTERVAL)).map((s) => s.f), [], 'interval timer');
  assert.deepEqual(all.filter((s) => SHELL_OPTION.test(s.text)).map((s) => s.f), [], 'shell option');
  assert.deepEqual(all.filter((s) => SHELL_BY_NAME.test(s.text)).map((s) => s.f), [], 'shell by name');
  const server = all.filter((s) => s.f.startsWith(path.join('src', 'server')));
  assert.deepEqual(server.filter((s) => BARE_LITERAL.test(s.text)).map((s) => s.f), [], 'spawn targets are absolute paths');
  assert.ok(server.some((s) => s.text.includes('windowsHide')), 'windowsHide is set where the shell spawns');
});
