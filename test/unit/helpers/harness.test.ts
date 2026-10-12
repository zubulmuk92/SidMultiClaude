// test/e2e/harness.ts: boot-line contract, clean server env, start/stop/failure paths (with stand-in entry scripts, so the
// test does not depend on the state of src/server/main.ts), Edge launch (opt-in: SMC_E2E=1).
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { edgeInstalled, openBrowser, parseBootLine, serverEnv, startServer } from '../../e2e/harness.ts';
import { isPidAlive } from '../../../src/server/util/winproc.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const tmp = createTmpRoot('harness');
after(() => tmp.dispose());
const script = (name: string, body: string): string => {
  const f = path.join(tmp.root, name);
  fs.writeFileSync(f, body);
  return f;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await sleep(25); }
}

describe('e2e harness (independent cases run concurrently)', { concurrency: true }, () => {
  test('--print-boot line contract: SMC_BOOT {"port":n,"boot":"<code>"}', () => {
    assert.deepEqual(parseBootLine('SMC_BOOT {"port":41731,"boot":"AbCdEfGhIjKlMnOpQrStUvWx12"}'), { port: 41731, boot: 'AbCdEfGhIjKlMnOpQrStUvWx12' });
    for (const bad of ['SMC_BOOT', 'SMC_BOOT {}', 'SMC_BOOT {"port":"41731","boot":"AbCdEfGhIjKlMnOpQrStUvWx12"}', 'SMC_BOOT {"port":41731,"boot":"short"}',
      'boot {"port":41731,"boot":"AbCdEfGhIjKlMnOpQrStUvWx12"}', 'SMC_BOOT {"port":41731,"boot":"has space in it 1234567"}']) assert.equal(parseBootLine(bad), null, bad);
  });

  test('the server gets a clean env (no parent Claude session, no API key) plus the test switches', () => {
    const saved = { a: process.env['CLAUDECODE'], b: process.env['ANTHROPIC_API_KEY'], c: process.env['CLAUDE_CONFIG_DIR'] };
    process.env['CLAUDECODE'] = '1'; process.env['ANTHROPIC_API_KEY'] = 'sk-test'; process.env['CLAUDE_CONFIG_DIR'] = 'C:\\nope';
    try {
      const env = serverEnv({ EXTRA: 'x' });
      for (const k of Object.keys(env)) assert.ok(!/^(CLAUDECODE|CLAUDE_.*|ANTHROPIC_.*|NODE_OPTIONS)$/i.test(k), k);
      assert.equal(env['SMC_TEST'], '1');
      assert.match(env['SMC_CLAUDE_EXE']!, /fake-claude\.mjs$/);
      assert.equal(env['EXTRA'], 'x');
      assert.equal(Object.keys(env).filter((k) => k.toLowerCase() === 'path').length, 1, 'exactly one Path key');
    } finally {
      for (const [k, v] of [['CLAUDECODE', saved.a], ['ANTHROPIC_API_KEY', saved.b], ['CLAUDE_CONFIG_DIR', saved.c]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test('startServer: harness args in, boot line out, clean child env; stop() kills the whole tree', async () => {
    // Stand-in server: checks its argv/env, starts a grandchild (like a fake-claude chat), prints its boot line, then idles.
    const pidFile = path.join(tmp.root, 'gc.pid');
    const main = script('ok-server.mjs', [
      `import { spawn } from 'node:child_process';`,
      `import fs from 'node:fs';`,
      `const a = process.argv.slice(2);`,
      `const v = (n) => a[a.indexOf(n) + 1];`,
      `const leaked = Object.keys(process.env).filter((k) => /^(CLAUDECODE|CLAUDE_|ANTHROPIC_)/i.test(k));`,
      `console.log('ARGS ' + JSON.stringify({ dataDir: fs.existsSync(v('--data-dir')), home: fs.existsSync(v('--profiles-root')), printBoot: a.includes('--print-boot'), fake: a.includes('--fake-engine'), port: v('--port') }));`,
      `console.log('ENV ' + JSON.stringify({ leaked, test: process.env.SMC_TEST, exe: /fake-claude\\.mjs$/.test(process.env.SMC_CLAUDE_EXE ?? '') }));`,
      `const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
      `console.log('SMC_BOOT ' + JSON.stringify({ port: 41799, boot: 'AbCdEfGhIjKlMnOpQrStUvWx12' }));`,
      `setInterval(() => {}, 1e6);`,
    ].join('\n'));
    const s = await startServer({ main, root: tmp, port: 41799, fakeEngine: true });
    try {
      assert.equal(s.port, 41799);
      assert.equal(s.url, 'http://127.0.0.1:41799/#boot=AbCdEfGhIjKlMnOpQrStUvWx12');
      const out = s.stdout.join('');
      assert.match(out, /ARGS \{"dataDir":true,"home":true,"printBoot":true,"fake":true,"port":"41799"\}/);
      assert.match(out, /ENV \{"leaked":\[\],"test":"1","exe":true\}/);
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0);
      const gcPid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.equal(isPidAlive(gcPid), true);
      await s.stop();
      assert.equal(isPidAlive(s.proc.pid!), false, 'server gone');
      await waitFor(() => !isPidAlive(gcPid), 5_000);                     // its child too (taskkill /T /F)
    } finally { await s.stop(); }
  });

  test('startServer rejects cleanly when the server exits before its boot line, or never prints it', async () => {
    const early = script('early-exit.mjs', `process.stderr.write('boom: not ready\\n'); process.exit(3);`);
    await assert.rejects(startServer({ main: early, root: tmp }), /exited \(code 3\) before printing its boot line[\s\S]*boom: not ready/);
    const silent = script('silent.mjs', `console.log('listening… but no boot line'); setInterval(() => {}, 1e6);`);
    const t0 = Date.now();
    await assert.rejects(startServer({ main: silent, root: tmp, bootTimeoutMs: 400 }), /did not print SMC_BOOT within 400 ms/);
    assert.ok(Date.now() - t0 < 8_000, 'the hung server is killed, not awaited');
  });

  // A real browser launch is E2E territory (SPEC §12.6): 2 s usually, but up to ~17 s measured, which alone breaks the
  // unit budget (§12.1: < 10 s). Opt-in here (SMC_E2E=1); every E2E suite launches Edge through openBrowser() anyway.
  const edgeSkip = !edgeInstalled() ? 'Edge not installed' : process.env['SMC_E2E'] === '1' ? false : 'browser launch: set SMC_E2E=1 (E2E check)';
  test('the installed Edge launches headless through playwright-core (no download)', { skip: edgeSkip }, async () => {
    const { browser, context } = await openBrowser('http://127.0.0.1:41799');
    try {
      const page = await context.newPage();
      await page.setContent('<p id="x">bonjour</p>');
      assert.equal(await page.textContent('#x'), 'bonjour');
    } finally { await browser.close(); }
  });
});
