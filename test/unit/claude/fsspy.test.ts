// test/unit/claude/fsspy.test.ts — SPEC §10 S10/S11: during a full run of the profile-reading services, no app write lands under any
// profile dir, and `.credentials.json` / `*.key` are never opened (stat only).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createSessionIndex } from '../../../src/server/claude/session-index.ts';
import { createLiveRegistry } from '../../../src/server/claude/registry.ts';
import { createPromptHistory } from '../../../src/server/claude/history.ts';
import { createTranscriptReader } from '../../../src/server/claude/reader.ts';
import { appPaths, isInside } from '../../../src/server/util/paths.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { makeStore, realishClock } from './lib.ts';

const root = createTmpRoot('wpc-spy');
after(() => root.dispose());

test('no write under a profile, no content read of .credentials.json or *.key', async () => {
  const def = root.defaultProfile();
  const pro = root.profile('pro', { usage: { fetchedAtMs: Date.now(), utilization: { five_hour: { utilization: 10, resets_at: null } } } });
  const ext = root.externalProfile('ailleurs');
  const cwd = root.cwd('p');
  for (const p of [def, pro, ext]) {
    const s = p.addSession({ cwd, title: 'x', turns: [{ user: 'a', assistant: 'b' }] });
    p.addRegistry({ pid: process.pid, sessionId: s.sessionId, updatedAt: Date.now() });
    p.addHistory([{ display: 'h', project: cwd, sessionId: s.sessionId }]);
  }
  const writes: string[] = [];
  const reads: string[] = [];
  const spies: { mock: { restore(): void } }[] = [];
  const spy = (obj: object, name: string, sink: string[], isWrite?: (args: unknown[]) => boolean): void => {
    const o = obj as Record<string, (...a: unknown[]) => unknown>;
    const orig = o[name]!;
    spies.push(mock.method(o, name, function (this: unknown, ...a: unknown[]) {
      if (typeof a[0] === 'string' || a[0] instanceof URL) { if (!isWrite || isWrite(a)) sink.push(String(a[0])); }
      return orig.apply(this, a);
    }));
  };
  const writeFlag = (a: unknown[]): boolean => typeof a[1] === 'string' && /[wa+]/.test(a[1]);
  for (const n of ['writeFile', 'appendFile', 'mkdir', 'rename', 'rm', 'unlink', 'copyFile', 'utimes', 'rmdir']) { spy(fs.promises, n, writes); spy(fs, `${n}Sync`, writes); }
  spy(fs, 'createWriteStream', writes);
  spy(fs.promises, 'open', writes, writeFlag); spy(fs, 'openSync', writes, writeFlag);
  for (const n of ['readFile', 'open']) spy(fs.promises, n, reads);
  for (const n of ['readFileSync', 'openSync', 'createReadStream']) spy(fs, n, reads);
  try {
    const { store, guard } = await makeStore(root);
    for (const [p, name] of [[def, 'Perso'], [pro, 'ACME'], [ext, 'Ext']] as const) await store.add({ configDir: p.configDir, name, color: 1, monogram: name[0]! });
    const index = createSessionIndex({ accounts: store, cacheDir: appPaths(root.appDir).cacheDir, log: nullLogger, clock: realishClock, guard });
    await index.start();
    await index.reconcile();
    const reg = createLiveRegistry({ accounts: store, log: nullLogger });
    reg.start();
    const hist = createPromptHistory({ accounts: store, appDir: root.appDir, guard });
    const metas = index.list();
    assert.equal(metas.length, 3);
    hist.append(metas[0]!.chatId, 'bonjour', Date.now());
    await hist.flush();
    assert.ok((await hist.search('')).length >= 2);
    const reader = createTranscriptReader({ log: nullLogger });
    for (const m of metas) { await reader.tail(m.path, 5); await reader.search(m.path, 'a', 5, new AbortController().signal); }
    for (const a of store.list()) { store.modelCatalog(a.id); store.trustedInCli(a.id, cwd); await store.update(a.id, { name: `${a.name}!` }); }
    await new Promise((r) => setTimeout(r, 400));
    await index.close();
    reg.close();
    store.close();
  } finally { for (const s of spies) s.mock.restore(); }
  const profiles = [path.join(root.home, '.claude'), path.join(root.home, '.claude.json'), pro.configDir!, ext.configDir!];
  const bad = writes.filter((w) => profiles.some((p) => isInside(w, p)) || /\.claude(-[^\\/]*)?([\\/]|$)/i.test(path.relative(root.home, w)));
  assert.deepEqual(bad, [], 'app writes under a profile');
  assert.ok(writes.some((w) => isInside(w, root.appDir)), 'the app did write its own files');
  assert.deepEqual(reads.filter((r) => /\.credentials\.json$/i.test(r) || /\.key$/i.test(r)), []);
  assert.ok(reads.some((r) => /\.claude\.json$/i.test(r)), 'global configs were read');
});
