// WP-D acceptance 5: MetaStore — a kill in the middle of writes leaves a valid file (or its .bak); settings are normalised;
// drafts round-trip; re-key flushes at once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createMetaStore, normaliseSettings, defaultSettings } from '../../../src/server/app/meta.ts';
import { configureFsGuard, resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { appPaths } from '../../../src/server/util/paths.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';

const tmp = createTmpRoot('meta');
after(() => { resetFsGuardForTests(); tmp.dispose(); });
const A = 'perso:4adf4c63-b504-4be1-804b-92a88963e275';
const B = 'perso:5bdf4c63-b504-4be1-804b-92a88963e275';
const guardFor = (dir: string): void => { fs.mkdirSync(dir, { recursive: true }); configureFsGuard({ allowRoots: [dir], home: tmp.home }); };

test('settings: hand-edited values fall back key by key', () => {
  const s = normaliseSettings({ maxLive: 99, reapMin: 7, theme: 'dark', port: 'x', dndUntil: 5, prespawn: false });
  assert.equal(s.maxLive, defaultSettings().maxLive);
  assert.equal(s.reapMin, 60);
  assert.equal(s.theme, 'dark');
  assert.equal(s.port, 41731);
  assert.equal(s.dndUntil, 5);
  assert.equal(s.prespawn, false);
  assert.equal(defaultSettings().maxLive, 4, 'lead decision Q2');
});

test('chats, drafts, trust and re-key round-trip through the files', async () => {
  const dir = path.join(tmp.root, 'app1');
  guardFor(dir);
  const clock = createFakeClock();
  const m = createMetaStore({ appDir: dir, log: nullLogger, clock });
  m.upsert({ chatId: A, accountId: 'perso', sessionId: A.slice(6), cwd: 'C:\\w', createdAt: 1, title: 'T', pendingStart: { kind: 'new' } });
  m.patch(A, { pinned: true, title: undefined });
  m.saveDraft(A, { text: 'brouillon', attachments: [], at: 5 });
  m.trust('perso', 'C:\\Work\\X');
  assert.equal(m.appTrusted('perso', 'c:\\work\\x'), true, 'case-insensitive');
  m.saveSettings({ maxLive: 6 });
  clock.advance(1_000);
  await m.flush();
  m.rekey(A, B);
  await m.flush();
  const m2 = createMetaStore({ appDir: dir, log: nullLogger, clock });
  assert.equal(m2.chat(A), undefined);
  assert.equal(m2.chat(B)?.pinned, true);
  assert.equal(m2.chat(B)?.title, undefined, 'undefined patch deletes the key');
  assert.equal(m2.chat(B)?.pendingStart, undefined, 're-key drops pendingStart');
  assert.equal(m2.drafts()[B]?.text, 'brouillon');
  assert.equal(m2.settings().maxLive, 6);
  assert.equal(m2.appTrusted('perso', 'C:\\Work\\X'), true);
});

test('kill mid-write: the next start reads a valid chats.json (or its .bak)', async () => {
  const dir = path.join(tmp.root, 'app2');
  guardFor(dir);
  const u = (f: string): string => pathToFileURL(path.resolve(import.meta.dirname, '..', '..', '..', f)).href;
  const code = `
    import { createMetaStore } from '${u('src/server/app/meta.ts')}';
    import { configureFsGuard } from '${u('src/server/util/fs-guard.ts')}';
    import { nullLogger } from '${u('src/server/util/log.ts')}';
    const dir = ${JSON.stringify(dir)};
    configureFsGuard({ allowRoots: [dir], home: ${JSON.stringify(tmp.home)} });
    const m = createMetaStore({ appDir: dir, log: nullLogger });
    let i = 0;
    process.stdout.write('ready\\n');
    for (;;) {
      const id = 'perso:' + (100000000 + (i % 5000)).toString(16).padStart(8, '0') + '-b504-4be1-804b-92a88963e275';
      m.upsert({ chatId: id, accountId: 'perso', sessionId: id.slice(6), cwd: 'C:\\\\w\\\\' + 'x'.repeat(i % 300), createdAt: i++ });
      m.flushSync();
    }`;
  for (let round = 0; round < 3; round++) {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    await new Promise<void>((r) => p.stdout!.once('data', () => r()));
    await new Promise((r) => setTimeout(r, 150 + round * 70));
    p.kill('SIGKILL');
    await new Promise((r) => p.once('exit', r));
    const m = createMetaStore({ appDir: dir, log: nullLogger });
    assert.ok(m.chats().length > 0, `round ${round}: chats survived`);
    for (const c of m.chats()) assert.equal(typeof c.cwd, 'string');
    const file = appPaths(dir).chats;
    const ok = [file, `${file}.bak`].some((f) => { try { JSON.parse(fs.readFileSync(f, 'utf8')); return true; } catch { return false; } });
    assert.ok(ok, 'a parsable file exists');
  }
});
