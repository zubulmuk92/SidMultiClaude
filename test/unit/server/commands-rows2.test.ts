// WP-D acceptance 4 (rows of SPEC §6.3, continued): tx.search (abort), prompts.search, tx.detail size cap, accounts
// (update, login flow, logout, usage / baseline through the probe process), fs.mentions, fs.dirs, ui / draft, log.client.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../../../src/shared/protocol.ts';
import type { SessionMeta, SpawnSpec, EnsureOpts } from '../../../src/server/contracts.ts';
import { resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { MAX_DETAIL_BYTES, LOG_CLIENT_PER_MIN } from '../../../src/shared/limits.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createWorld, tick } from './_world.ts';

const tmp = createTmpRoot('commands-rows2');
after(() => { resetFsGuardForTests(); tmp.dispose(); });
const SID = '4adf4c63-b504-4be1-804b-92a88963e275';
const CHAT = `perso:${SID}`;
const UUID = (n: number): string => `0b6f3a59-0a8e-4c55-8a51-${String(n).padStart(12, '0')}`;
const code = (r: { ok: boolean; err?: P.WireError }): string => (r.ok ? 'ok' : r.err!.code);
type World = ReturnType<typeof createWorld>;
const ensures = (w: World): [SpawnSpec, EnsureOpts][] => w.engine.calls.filter((c) => c.m === 'ensure').map((c) => c.args as [SpawnSpec, EnsureOpts]);
function indexed(w: World, cwd: string): SessionMeta {
  const m: SessionMeta = { accountId: 'perso', sessionId: SID, chatId: CHAT, path: path.join(tmp.root, `${SID}.jsonl`), cwd, title: 'T', titleSource: 'lastPrompt',
    origin: 'cli', createdAt: 1, updatedAt: w.clock.now(), mtimeMs: 1, size: 100 };
  w.index.put(m);
  return m;
}

test('tx.search: hits carry turn ids, a new search aborts the previous one; prompts.search; tx.detail > 8 MB → too_large', async () => {
  const w = createWorld(tmp, 'search');
  const win = w.window();
  const sm = indexed(w, tmp.cwd('s-search'));
  w.chains.set(sm.path, [{ off: 0, len: 1, e: { type: 'user', uuid: UUID(1), parentUuid: null, message: { role: 'user', content: 'cherche' } } }]);
  let first = true;
  w.reader.search = (_f, q, _limit, signal) => {
    if (first) { first = false; return new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))); }
    return Promise.resolve([{ off: 0, len: 1, snippet: `…${q}…` }]);
  };
  const p1 = win.req<P.SearchHit[]>({ t: 'tx.search', chatId: CHAT, q: 'lent' });   // pending until the next search
  await tick();
  assert.equal(first, false, 'the first search is running');
  const hits = await win.req<P.SearchHit[]>({ t: 'tx.search', chatId: CHAT, q: 'cherche' });
  assert.deepEqual(hits, { ok: true, data: [{ turnId: `u:${UUID(1)}`, snippet: '…cherche…' }] });
  assert.deepEqual(await p1, { ok: true, data: [] }, 'a new search aborted the previous one (one ack, empty)');
  assert.deepEqual(await win.req({ t: 'prompts.search', q: 'git', chatId: CHAT }), { ok: true, data: [{ text: 'hit:git', at: 1, source: 'app', chatId: CHAT }] });
  w.orch.setHeavy(CHAT, [{ id: 't:big', field: 'output', off: 0, len: MAX_DETAIL_BYTES * 2 + 1 }], null);
  assert.equal(code(await win.req({ t: 'tx.detail', chatId: CHAT, blockId: 't:big', field: 'output' })), 'too_large');
});

test('accounts: update broadcasts, the login flow (one at a time, code, cancel), logout sleeps the account\'s chats first', async () => {
  const w = createWorld(tmp, 'accounts');
  const a = w.window(), b = w.window();
  indexed(w, tmp.cwd('s-acc'));
  assert.equal(code(await a.req({ t: 'account.update', accountId: 'nope', patch: { name: 'X' } })), 'not_found');
  assert.equal(code(await a.req({ t: 'account.update', accountId: 'perso', patch: { name: 'Moi', color: 3 } })), 'ok');
  assert.deepEqual(w.accountUpdates, [['perso', { name: 'Moi', color: 3 }]]);
  assert.ok(b.ws.msgs().some((m) => m.t === 'accounts'), '`accounts` to every window');
  assert.equal(code(await a.req({ t: 'account.loginCode', accountId: 'pro', code: 'abc#st' })), 'not_pending');
  assert.equal(code(await a.req({ t: 'account.login', accountId: 'pro', email: 'w@example.com' })), 'ok');
  for (const win of [a, b]) assert.ok(win.ws.msgs().some((m) => m.t === 'login' && m.accountId === 'pro' && m.step.step === 'url'), 'login steps to every window');
  assert.equal(code(await a.req({ t: 'account.login', accountId: 'pro' })), 'busy', 'one login per account at a time');
  assert.equal(code(await a.req({ t: 'account.logout', accountId: 'pro' })), 'busy', 'no logout during a login');
  assert.equal(code(await a.req({ t: 'account.loginCode', accountId: 'pro', code: 'abc#st' })), 'ok');
  assert.equal(code(await a.req({ t: 'account.loginCancel', accountId: 'pro' })), 'ok');
  assert.deepEqual(w.loginCalls, [['start', 'pro', 'w@example.com'], ['code', 'pro', 'abc#st'], ['cancel', 'pro']]);
  assert.equal(code(await a.req({ t: 'account.login', accountId: 'pro' })), 'ok', 'free again after cancel');
  w.loginSteps.get('pro')!({ step: 'done', email: 'w@example.com', plan: 'team' });
  assert.equal(code(await a.req({ t: 'account.login', accountId: 'pro' })), 'ok', 'free again after done');
  await a.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(1), text: 'x' });
  assert.equal(w.engine.isLive(CHAT), true);
  w.loginSteps.get('pro')!({ step: 'error', message: 'x' });
  assert.equal(code(await a.req({ t: 'account.logout', accountId: 'perso' })), 'ok');
  assert.equal(w.engine.isLive(CHAT), false, 'logout first sleeps the account\'s chats');
  const order = w.engine.calls.filter((c) => c.m === 'sleep').map((c) => c.args[0]);
  assert.deepEqual(order, ['logout']);
  assert.deepEqual(w.loginCalls.at(-1), ['logout', 'perso']);
});

test('account.usage / baseline: a live chat of the account, else a transient probe in probe-cwd closed right after', async () => {
  const w = createWorld(tmp, 'usage');
  const win = w.window();
  assert.equal(code(await win.req({ t: 'account.usage', accountId: 'pro' })), 'not_logged_in');
  assert.deepEqual(await win.req({ t: 'account.usage', accountId: 'perso' }), { ok: true, data: null });
  const [spec, opts] = ensures(w).at(-1)!;
  assert.equal(opts.why, 'usage');
  assert.equal(spec.cwd, fs.realpathSync.native(path.join(w.appDir, 'probe-cwd')), 'the only S9 exemption');
  assert.deepEqual([spec.start, spec.mode, spec.allowBypass], [{ kind: 'new' }, 'default', false]);
  await tick();
  assert.equal(w.engine.isLive(spec.chatId), false, 'closed right after');
  const base = await win.req<P.ContextSummary>({ t: 'account.baseline', accountId: 'perso' });
  assert.ok(base.ok && base.data!.total === 18_000);
  assert.equal(ensures(w).length, 2);
  indexed(w, tmp.cwd('s-usage'));
  await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(2), text: 'x' });
  const before = ensures(w).length;
  w.clock.advance(10 * 60_000);                                              // F2: usage refresh at most once per 10 min
  assert.equal(code(await win.req({ t: 'account.usage', accountId: 'perso' })), 'ok');
  assert.equal(ensures(w).length, before, 'a live chat of the account answers: no probe');
  assert.deepEqual(w.engine.calls.filter((c) => c.m === 'usage').at(-1)?.chatId, CHAT);
});

test('fs.mentions inside the chat folder (≤ 50, S9 first); fs.dirs: drives, sub-folders, home warning, errors', async () => {
  const w = createWorld(tmp, 'fs');
  const win = w.window();
  const cwd = tmp.cwd('s-fs');
  fs.mkdirSync(path.join(cwd, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'main.ts'), '');
  fs.writeFileSync(path.join(cwd, 'node_modules', 'x', 'main.js'), '');
  for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(cwd, 'src', 'deep', `f${i}.md`), '');
  indexed(w, cwd);
  const m = await win.req<P.FileHit[]>({ t: 'fs.mentions', chatId: CHAT, q: 'main' });
  assert.ok(m.ok && m.data![0]!.path === 'src/main.ts' && !m.data!.some((h) => h.path.includes('node_modules')), JSON.stringify(m));
  const all = await win.req<P.FileHit[]>({ t: 'fs.mentions', chatId: CHAT, q: '' });
  assert.ok(all.ok && all.data!.length === 50, 'capped at 50');
  indexed(w, tmp.home);
  assert.equal(code(await win.req({ t: 'fs.mentions', chatId: CHAT, q: 'x' })), 'cwd_refused');
  const drives = await win.req<P.DirListing>({ t: 'fs.dirs', path: null });
  assert.ok(drives.ok && drives.data!.drives!.some((d) => /^[A-Z]:\\$/.test(d)));
  const sub = await win.req<P.DirListing>({ t: 'fs.dirs', path: cwd });
  assert.ok(sub.ok && sub.data!.dirs.includes('src') && sub.data!.parent && sub.data!.warning === undefined, JSON.stringify(sub));
  const home = await win.req<P.DirListing>({ t: 'fs.dirs', path: tmp.home });
  assert.ok(home.ok && home.data!.warning === 'home');
  const up = await win.req<P.DirListing>({ t: 'fs.dirs', path: path.dirname(tmp.home) });
  assert.ok(up.ok && up.data!.warning === 'ancestor');
  assert.equal(code(await win.req({ t: 'fs.dirs', path: path.join(cwd, 'missing') })), 'not_found');
  assert.equal(code(await win.req({ t: 'fs.dirs', path: 'relative\\x' })), 'invalid');
});

test('ui.save and draft.save (last write wins by `at`, null deletes); log.client limited to 10 per minute', async () => {
  const w = createWorld(tmp, 'ui');
  const win = w.window();
  const ui: P.UiState = { layout: 2, tabs: [CHAT], closed: [], panes: [CHAT, null], focusedPane: 0,
    sidebar: { width: 300, collapsed: true, grouping: 'folder', showArchived: false }, scroll: {}, views: { [CHAT]: 'detailed' } };
  assert.equal(code(await win.req({ t: 'ui.save', ui })), 'ok');
  assert.deepEqual(w.meta.ui(), ui);
  const d = (text: string, at: number): P.Draft => ({ text, attachments: [], at });
  await win.req({ t: 'draft.save', chatId: CHAT, draft: d('v2', 20) });
  await win.req({ t: 'draft.save', chatId: CHAT, draft: d('v1', 10) });
  assert.equal(w.meta.drafts()[CHAT]?.text, 'v2', 'an older draft never overwrites a newer one');
  await win.req({ t: 'draft.save', chatId: CHAT, draft: null });
  assert.equal(w.meta.drafts()[CHAT], undefined);
  for (let i = 0; i < LOG_CLIENT_PER_MIN + 5; i++) assert.equal(code(await win.req({ t: 'log.client', level: 'error', msg: `boom ${i}` })), 'ok');
  assert.equal(w.logged.filter((l) => l.msg === 'client').length, LOG_CLIENT_PER_MIN);
  w.clock.advance(61_000);
  await win.req({ t: 'log.client', level: 'warn', msg: 'later' });
  assert.equal(w.logged.filter((l) => l.msg === 'client').length, LOG_CLIENT_PER_MIN + 1, 'the window slides');
});
