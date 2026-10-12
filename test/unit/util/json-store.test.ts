import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createFsGuard } from '../../../src/server/util/fs-guard.ts';
import { encodeEnvelope, loadVersioned, openJsonStore, writeVersioned } from '../../../src/server/util/json-store.ts';
import { createFakeClock } from '../../helpers/fake-clock.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';

const tmp = createTmpRoot('jsonstore');
after(() => tmp.dispose());
const g = createFsGuard({ allowRoots: [tmp.appDir], home: tmp.home });
const file = (name: string): string => path.join(tmp.appDir, name);
type Doc = { n: number; tags: string[] };
const defaults = (): Doc => ({ n: 0, tags: [] });
const accept = (d: unknown): Doc | undefined => (d && typeof d === 'object' && typeof (d as Doc).n === 'number' && Array.isArray((d as Doc).tags) ? (d as Doc) : undefined);

test('missing file → defaults; set + flush writes a {v,data} envelope; reopen reads it back', async () => {
  const f = file('a.json');
  const s = openJsonStore<Doc>({ file: f, version: 1, defaults, accept, fs: g, clock: createFakeClock() });
  assert.equal(s.loadedFrom, 'defaults');
  assert.deepEqual(s.get(), { n: 0, tags: [] });
  s.set({ n: 1, tags: ['x'] });
  assert.equal(s.dirty(), true);
  await s.flush();
  assert.equal(s.dirty(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { v: 1, data: { n: 1, tags: ['x'] } });
  const again = openJsonStore<Doc>({ file: f, version: 1, defaults, accept, fs: g });
  assert.equal(again.loadedFrom, 'file');
  assert.deepEqual(again.get(), { n: 1, tags: ['x'] });
});

test('every write keeps the previous version in .bak; a corrupt file falls back to .bak, then to defaults', async () => {
  const f = file('b.json');
  await writeVersioned(f, 1, { n: 1, tags: [] }, g);
  await writeVersioned(f, 1, { n: 2, tags: [] }, g);
  assert.equal(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')).data.n, 1);
  fs.writeFileSync(f, '{"v":1,"data":{"n":3,');                      // torn file
  const r = loadVersioned<Doc>({ file: f, version: 1, defaults, accept });
  assert.equal(r.source, 'bak');
  assert.equal(r.data.n, 1);
  assert.equal(r.problems.length, 1);
  fs.writeFileSync(f + '.bak', 'garbage');
  const r2 = loadVersioned<Doc>({ file: f, version: 1, defaults, accept });
  assert.equal(r2.source, 'defaults');
  assert.equal(r2.problems.length, 2);
});

test('versions: older → migrate, newer → rejected, accept() can reject', () => {
  const f = file('c.json');
  fs.writeFileSync(f, JSON.stringify({ v: 0, data: { count: 7 } }));
  const r = loadVersioned<Doc>({ file: f, version: 1, defaults, accept, migrate: (d, from) => (from === 0 ? { n: (d as { count: number }).count, tags: [] } : undefined) });
  assert.deepEqual(r, { data: { n: 7, tags: [] }, source: 'file', problems: [] });
  fs.writeFileSync(f, JSON.stringify({ v: 2, data: { n: 9, tags: [] } }));
  assert.equal(loadVersioned<Doc>({ file: f, version: 1, defaults, accept }).source, 'defaults');
  fs.writeFileSync(f, JSON.stringify({ v: 1, data: { n: 'nope' } }));
  assert.equal(loadVersioned<Doc>({ file: f, version: 1, defaults, accept }).source, 'defaults');
  fs.writeFileSync(f, JSON.stringify({ n: 1 }));                       // no envelope
  assert.equal(loadVersioned<Doc>({ file: f, version: 1, defaults, accept }).source, 'defaults');
});

test('debounced writer: one write after debounceMs from the first change, flush() writes at once', async () => {
  const f = file('d.json');
  const clock = createFakeClock();
  const s = openJsonStore<Doc>({ file: f, version: 1, defaults, accept, fs: g, clock, debounceMs: 1000 });
  s.set({ n: 1, tags: [] });
  clock.advance(400);
  s.update((d) => { d.n = 2; });
  assert.equal(clock.pending(), 1, 'a single timer');
  assert.equal(fs.existsSync(f), false);
  clock.advance(600);                                                // 1 s after the FIRST change
  assert.equal(clock.pending(), 0, 'the debounce timer fired');
  // the timer started the write on its own: wait for it (polling the real disk, no fixed sleep: robust under load)
  for (const end = Date.now() + 10_000; !(fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).data.n === 2);) {
    assert.ok(Date.now() < end, 'the debounced write landed');
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(s.dirty(), false);
  s.set({ n: 3, tags: [] });
  await s.flush();
  assert.equal(clock.pending(), 0, 'flush cancels the timer');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).data.n, 3);
  s.set({ n: 4, tags: [] });
  s.flushSync();
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).data.n, 4);
  await s.close();
});

test('a flushSync() that lands during an in-flight flush() is never overwritten by the older snapshot', async () => {
  for (let i = 0; i < 5; i++) {
    const f = file(`race-${i}.json`);
    const s = openJsonStore<Doc>({ file: f, version: 1, defaults, accept, fs: g, clock: createFakeClock() });
    s.set({ n: 1, tags: ['x'.repeat(200_000)] });             // large enough for the async write to still be in flight
    const inFlight = s.flush();
    await new Promise((r) => setImmediate(r));
    s.set({ n: 2, tags: [] });
    s.flushSync();                                              // the newer version, committed synchronously
    await inFlight;
    assert.equal(s.dirty(), false);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).data.n, 2, `run ${i}: newer value on disk`);
    s.set({ n: 3, tags: [] });
    await s.close();
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).data.n, 3);
    assert.deepEqual(fs.readdirSync(tmp.appDir).filter((n) => n.startsWith(`race-${i}.json.tmp-`)), [], 'the dropped temp file is removed');
  }
});

test('kill mid-write: the file and its .bak always parse (8 hard kills of writer processes, 4 files × 2 kills each)', async () => {
  const dir = path.join(tmp.appDir, 'kill');
  fs.mkdirSync(dir, { recursive: true });
  const writer = path.join(dir, 'writer.mts');
  const src = (p: string): string => pathToFileURL(path.resolve(import.meta.dirname, '../../../src/server/util', p)).href;
  fs.writeFileSync(writer, [
    `import { createFsGuard } from '${src('fs-guard.ts')}';`,
    `import { openJsonStore } from '${src('json-store.ts')}';`,
    `const [dir, home, file] = process.argv.slice(2);`,
    `const g = createFsGuard({ allowRoots: [dir], home });`,
    `const s = openJsonStore({ file, version: 1, defaults: () => ({ n: 0, blob: '' }), fs: g, debounceMs: 1 });`,
    `let n = s.get().n;`,
    `for (;;) {`,
    `  n++;`,
    `  const blob = String(n % 10).repeat(200_000 + (n % 7) * 50_000);`,
    `  s.set({ n, blob, len: blob.length });`,
    `  if (n % 2) s.flushSync(); else await s.flush();          // both commit paths (sync, and async = the debounced one)`,
    `  if (n % 3 === 0) process.stdout.write('w');`,
    `}`,
  ].join('\n'));
  const valid = (text: string): boolean => {
    const e = JSON.parse(text) as { v: number; data: { n: number; blob: string; len: number } };
    return e.v === 1 && typeof e.data.n === 'number' && e.data.blob.length === e.data.len && e.data.blob === String(e.data.n % 10).repeat(e.data.len);
  };
  // 4 files in parallel (wall time), 2 successive kills on each (the second writer starts from what the first one left)
  const lane = async (k: number): Promise<void> => {
    const target = path.join(dir, `chats-${k}.json`);
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, [writer, dir, tmp.home, target], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let err = '';
      child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('exit', (c) => reject(new Error(`writer exited early (${c}): ${err}`)));
      });
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 40)));
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();                                                  // TerminateProcess: no cleanup, no finally
      await exited;
      assert.ok(valid(fs.readFileSync(target, 'utf8')), `file ${k} valid after kill #${i + 1}`);
      assert.ok(valid(fs.readFileSync(target + '.bak', 'utf8')), `.bak ${k} valid after kill #${i + 1}`);
      const r = loadVersioned<{ n: number }>({ file: target, version: 1, defaults: () => ({ n: -1 }) });
      assert.equal(r.source, 'file');
    }
  };
  await Promise.all([0, 1, 2, 3].map(lane));
  // leftovers of interrupted writes are only *.tmp-* siblings of a target or of its .bak (never the target itself)
  for (const n of fs.readdirSync(dir)) assert.match(n, /^(writer\.mts|chats-\d\.json|chats-\d\.json\.bak|chats-\d\.json(?:\.bak)?\.tmp-\d+-[0-9a-f]{8})$/);
});

test('encodeEnvelope is stable JSON with a trailing newline', () => {
  assert.equal(encodeEnvelope(1, { a: 1 }), '{\n "v": 1,\n "data": {\n  "a": 1\n }\n}\n');
});
