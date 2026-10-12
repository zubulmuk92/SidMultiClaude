// test/unit/claude/fakes/fake-login.mjs — a fake `claude auth login|logout` for the LoginService tests.
// Mimics claude.exe 2.1.294: prints the URL lines, waits for `code#state` on stdin, writes a FAKE
// oauthAccount + placeholder credentials into CLAUDE_CONFIG_DIR (or FAKE_LOGIN_HOME for the default profile; it refuses
// to write anywhere else), prints `Login successful.` and exits 0. FAKE_LOGIN_MODE: ok | fail | hang | noaccount | badcode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const [cmd, sub, ...rest] = process.argv.slice(2);
const mode = process.env.FAKE_LOGIN_MODE ?? 'ok';
const out = (s) => process.stdout.write(s);
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  if (process.env[k] !== undefined) { out(`Login failed: env leak ${k}\n`); process.exit(3); }
}
const cfgDir = process.env.CLAUDE_CONFIG_DIR;
const home = process.env.FAKE_LOGIN_HOME;
if (!cfgDir && !home) { out('Login failed: fake refuses to touch the real home\n'); process.exit(4); }
// Hard safety net: this fake writes files, so it only ever writes inside the OS temp dir (tmp profiles), never a real one.
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const tmpRoot = real(os.tmpdir()).toLowerCase() + path.sep;
if (!real(cfgDir ?? home).toLowerCase().startsWith(tmpRoot)) { out('Login failed: fake refuses to write outside the temp dir\n'); process.exit(4); }
const globalFile = cfgDir ? path.join(cfgDir, '.claude.json') : path.join(home, '.claude.json');
const credFile = path.join(cfgDir ?? path.join(home, '.claude'), '.credentials.json');
const readG = () => { try { return JSON.parse(fs.readFileSync(globalFile, 'utf8')); } catch { return {}; } };

if (cmd !== 'auth') { out(`unknown command ${cmd}\n`); process.exit(2); }
if (sub === 'logout') {
  const g = readG();
  delete g.oauthAccount;
  fs.writeFileSync(globalFile, JSON.stringify(g));
  fs.rmSync(credFile, { force: true });
  out('Successfully logged out from your Anthropic account.\n');
  process.exit(0);
}
if (process.env.FAKE_LOGIN_PIDFILE) fs.writeFileSync(process.env.FAKE_LOGIN_PIDFILE, String(process.pid));
if (sub !== 'login') { out(`unknown auth command ${sub}\n`); process.exit(2); }
const email = rest[0] === '--email' ? rest[1] : 'fake@example.invalid';
out('Opening browser to sign in…\n');
out("If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&client_id=fake&state=s1\n");
out('Paste code here if prompted > ');
if (mode === 'hang') setInterval(() => {}, 1 << 30);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const code = line.trim();
  if (mode === 'badcode' || !/^[\w-]+#[\w-]+$/.test(code)) { out('\nInvalid code. Please make sure the full code was copied.\n'); if (mode === 'badcode') process.exit(1); return; }
  if (mode === 'fail') { out('\nLogin failed: invalid_grant\n'); process.exit(1); }
  if (mode !== 'noaccount') {
    fs.mkdirSync(path.dirname(credFile), { recursive: true });
    fs.writeFileSync(credFile, JSON.stringify({ note: 'fake placeholder written by fake-login.mjs; never a token' }));
    fs.writeFileSync(globalFile, JSON.stringify({ ...readG(), oauthAccount: { accountUuid: '44444444-0000-4000-8000-000000000004', emailAddress: email,
      organizationUuid: '55555555-0000-4000-8000-000000000005', organizationName: 'Fake Org', organizationType: 'claude_team' } }));
  }
  out('\nLogin successful.\n');
  process.exit(0);
});
