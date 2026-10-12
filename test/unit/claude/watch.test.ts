// test/unit/claude/watch.test.ts — 8.3 paths throw BEFORE fs.watch; debounce; a null filename makes the index rescan.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { watchDir } from '../../../src/server/claude/watch.ts';
import { createSessionIndex } from '../../../src/server/claude/session-index.ts';
import { ShortNameError } from '../../../src/server/util/paths.ts';
import { appPaths } from '../../../src/server/util/paths.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { makeStore, realishClock, until } from './lib.ts';

const root = createTmpRoot('wpc-watch');
after(() => root.dispose());

test('an 8.3 path throws before fs.watch is ever called', () => {
  const spy = mock.method(fs, 'watch');
  try {
    assert.throws(() => watchDir('C:\\Users\\JEANDU~1\\AppData\\Local\\Temp', { recursive: true }, () => undefined), ShortNameError);
    assert.throws(() => watchDir('C:\\PROGRA~1', { recursive: false }, () => undefined));
    assert.equal(spy.mock.callCount(), 0);
  } finally { spy.mock.restore(); }
});

test('real watcher: debounced per name, reacts < 500 ms, close() stops it', async () => {
  const dir = root.cwd('w');
  const seen: (string | null)[] = [];
  const w = watchDir(dir, { recursive: true, debounceMs: 50 }, (n) => seen.push(n));
  try {
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) fs.appendFileSync(path.join(dir, 'a.jsonl'), 'x\n');
    await until(() => seen.includes('a.jsonl'), 2000, 5);
    assert.ok(performance.now() - t0 < 500);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(seen.filter((n) => n === 'a.jsonl').length, 1);
  } finally { w.close(); }
  assert.equal(w.closed, true);
});

test('a null filename (overflow) triggers a full rescan of the projects folder', async () => {
  const pro = root.profile('pro');
  const { store, guard } = await makeStore(root);
  const acc = await store.add({ configDir: pro.configDir, name: 'W', color: 2, monogram: 'W' });
  const fakes: EventEmitter[] = [];
  const spy = mock.method(fs, 'watch', () => { const e = Object.assign(new EventEmitter(), { close() { /* fake */ } }); fakes.push(e); return e; });
  const index = createSessionIndex({ accounts: store, cacheDir: appPaths(root.appDir).cacheDir, log: nullLogger, clock: realishClock, guard });
  try {
    pro.addSession({ cwd: root.cwd('a'), turns: [{ user: 'un', assistant: 'ok' }] });
    await index.start();
    assert.equal(index.list(acc.id).length, 1);
    assert.equal(fakes.length, 1);
    const s2 = pro.addSession({ cwd: root.cwd('b'), turns: [{ user: 'deux', assistant: 'ok' }] });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(index.list(acc.id).length, 1);                        // no event: not seen yet
    fakes[0]!.emit('change', 'rename', null);
    await until(() => !!index.get(`${acc.id}:${s2.sessionId}`), 2000);
  } finally { spy.mock.restore(); await index.close(); store.close(); }
});

test('names below a session (subagents, tool-results, temp files) never rescan; a project folder does', async () => {
  const pro = root.profile('deep');
  const { store, guard } = await makeStore(root);
  const acc = await store.add({ configDir: pro.configDir, name: 'D', color: 3, monogram: 'D' });
  const fakes: EventEmitter[] = [];
  const spy = mock.method(fs, 'watch', () => { const e = Object.assign(new EventEmitter(), { close() { /* fake */ } }); fakes.push(e); return e; });
  const index = createSessionIndex({ accounts: store, cacheDir: appPaths(root.appDir).cacheDir, log: nullLogger, clock: realishClock, guard });
  let readdirs = 0;
  const orig = fs.promises.readdir;
  const rd = mock.method(fs.promises, 'readdir', function (this: unknown, ...a: unknown[]) { readdirs++; return (orig as (...x: unknown[]) => unknown).apply(this, a); });
  try {
    const s = pro.addSession({ cwd: root.cwd('deep'), turns: [{ user: 'un', assistant: 'ok' }] });
    await index.start();
    assert.equal(index.list(acc.id).length, 1);
    const key = path.basename(path.dirname(s.path));
    const before = readdirs;
    for (const n of [`${key}\\${s.sessionId}\\subagents\\agent-a1.jsonl`, `${key}\\${s.sessionId}\\tool-results\\toolu_1.txt`, `${key}\\${s.sessionId}.jsonl.compact.tmp.1`, `${key}\\${s.sessionId}`]) {
      fakes[0]!.emit('change', 'change', n);
    }
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(readdirs, before, 'a deep name made the index rescan the projects folder');
    fakes[0]!.emit('change', 'rename', 'C--nouveau-projet');
    await until(() => readdirs > before, 2000);
  } finally { rd.mock.restore(); spy.mock.restore(); await index.close(); store.close(); }
});
