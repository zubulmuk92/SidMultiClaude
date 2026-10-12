// M2 review findings (regressions): F1 the model is an alias or a catalog id, never free text (billable model_validation);
// F2 usage refresh throttled per account, probe processes serialized / deduplicated; F3 disk image media types allow-listed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type * as P from '../../../src/shared/protocol.ts';
import type { SessionMeta, SpawnSpec, EnsureOpts } from '../../../src/server/contracts.ts';
import { resetFsGuardForTests } from '../../../src/server/util/fs-guard.ts';
import { contentImages } from '../../../src/server/model/blocks.ts';
import { createTmpRoot } from '../../helpers/tmp-profile.ts';
import { createWorld, tick } from './_world.ts';

const tmp = createTmpRoot('review-fixes');
after(() => { resetFsGuardForTests(); tmp.dispose(); });
const SID = '5bdf4c63-b504-4be1-804b-92a88963e275';
const CHAT = `perso:${SID}`;
const UUID = (n: number): string => `1b6f3a59-0a8e-4c55-8a51-${String(n).padStart(12, '0')}`;
const code = (r: { ok: boolean; err?: P.WireError }): string => (r.ok ? 'ok' : r.err!.code);
type World = ReturnType<typeof createWorld>;
const ensures = (w: World): [SpawnSpec, EnsureOpts][] => w.engine.calls.filter((c) => c.m === 'ensure').map((c) => c.args as [SpawnSpec, EnsureOpts]);
const callsOf = (w: World, m: string): unknown[][] => w.engine.calls.filter((c) => c.m === m).map((c) => c.args);
function indexed(w: World, cwd: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  const m: SessionMeta = { accountId: 'perso', sessionId: SID, chatId: CHAT, path: path.join(tmp.root, `${SID}.jsonl`), cwd, title: 'T', titleSource: 'lastPrompt',
    origin: 'cli', createdAt: 1, updatedAt: w.clock.now(), mtimeMs: 1, size: 100, ...extra };
  w.index.put(m);
  return m;
}
const OPUS_ID: P.ModelOption = { value: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high'] };

test('F1: chat.create / chat.setModel / account.update accept aliases and catalog ids only', async () => {
  const w = createWorld(tmp, 'f1');
  const win = w.window();
  const cwd = tmp.cwd('f1');
  const create = async (model: string): Promise<string> => code(await win.req({ t: 'chat.create', accountId: 'perso', cwd, mode: 'default', trust: true, model }));
  assert.equal(await create('claude-x'), 'invalid', 'free text never reaches the CLI');
  assert.equal(await create('claude-opus-5-5'), 'invalid', 'not in this account\'s catalog');
  assert.equal(await create('opus'), 'ok');
  assert.equal(await create('fable'), 'ok');
  w.accounts.catalog = [OPUS_ID];
  assert.equal(await create('claude-opus-5-5'), 'ok', 'catalog id');
  indexed(w, tmp.cwd('f1-chat'));
  assert.equal(code(await win.req({ t: 'chat.setModel', chatId: CHAT, model: 'claude-x', effort: null })), 'invalid');
  assert.equal(w.meta.chat(CHAT)?.model, undefined, 'nothing stored on a refusal');
  assert.equal(code(await win.req({ t: 'chat.setModel', chatId: CHAT, model: 'sonnet', effort: null })), 'ok');
  assert.equal(w.meta.chat(CHAT)?.model, 'sonnet');
  assert.equal(code(await win.req({ t: 'account.update', accountId: 'perso', patch: { defaults: { model: 'gpt-x' } } })), 'invalid');
  assert.equal(code(await win.req({ t: 'account.update', accountId: 'perso', patch: { defaults: { model: 'claude-opus-5-5' } } })), 'ok');
});

test('F1: an effort-only change echoes the reported model → the stored choice is kept; a stale catalog id is dropped at spawn', async () => {
  const w = createWorld(tmp, 'f1-echo');
  const win = w.window();
  indexed(w, tmp.cwd('f1-echo'), { model: 'claude-sonnet-9-9' });             // the model the CLI reported, not a user choice
  assert.equal(code(await win.req({ t: 'chat.setModel', chatId: CHAT, model: 'claude-sonnet-9-9', effort: 'high' })), 'ok');
  assert.deepEqual([w.meta.chat(CHAT)?.model, w.meta.chat(CHAT)?.effort], [undefined, 'high'], 'the reported id is not pinned');
  w.accounts.catalog = [OPUS_ID];
  assert.equal(code(await win.req({ t: 'chat.setModel', chatId: CHAT, model: 'claude-opus-5-5', effort: null })), 'ok');
  w.accounts.catalog = [];                                                     // the catalog moved on (CLI auto-update)
  await win.req({ t: 'chat.send', chatId: CHAT, uuid: UUID(1), text: 'go' });
  const spec = ensures(w).at(-1)![0];
  assert.equal(spec.model, undefined, 'unknown model → CLI default, never a validation probe');
  assert.equal(code(await win.req({ t: 'chat.setModel', chatId: CHAT, model: 'claude-opus-5-5', effort: 'max' })), 'ok', 'own stored choice echoed');
  assert.deepEqual(callsOf(w, 'setModel').at(-1), ['claude-opus-5-5', 'max']);
});

test('F2: usage refresh at most once per 10 min per account; concurrent probes share one process', async () => {
  const w = createWorld(tmp, 'f2');
  const win = w.window();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const usage = w.engine.usage.bind(w.engine);
  w.engine.usage = async (c: P.ChatId) => { await gate; return usage(c); };
  const reqs = [0, 1, 2, 3].map(() => win.req({ t: 'account.usage', accountId: 'perso' }));
  await tick(); await tick();
  assert.equal(ensures(w).length, 1, 'one probe for 4 concurrent requests');
  release();
  for (const r of await Promise.all(reqs)) assert.equal(code(r), 'ok');
  assert.equal(code(await win.req({ t: 'account.usage', accountId: 'perso' })), 'ok');
  assert.equal(ensures(w).length, 1, 'within 10 min: the cached usage, no probe');
  w.clock.advance(10 * 60_000);
  await tick();
  assert.equal(code(await win.req({ t: 'account.usage', accountId: 'perso' })), 'ok');
  assert.equal(ensures(w).length, 2, 'after 10 min: refreshed');
});

test('F2: baseline requests are deduplicated and never overlap a usage probe of the same account', async () => {
  const w = createWorld(tmp, 'f2-base');
  const win = w.window();
  const live = (): number => w.engine.stats().items.filter((i) => i.chatId.startsWith('perso:')).length;
  let peak = 0;
  const ensure = w.engine.ensure.bind(w.engine);
  w.engine.ensure = async (s: SpawnSpec, o: EnsureOpts) => { const r = await ensure(s, o); peak = Math.max(peak, live()); return r; };
  const all = await Promise.all([
    win.req({ t: 'account.baseline', accountId: 'perso' }), win.req({ t: 'account.baseline', accountId: 'perso' }),
    win.req({ t: 'account.usage', accountId: 'perso' }),
  ]);
  for (const r of all) assert.equal(code(r), 'ok');
  assert.equal(ensures(w).length, 2, 'one baseline probe + one usage probe');
  assert.equal(peak, 1, 'never two probe processes of one account at once');
  await tick();
  assert.equal(live(), 0, 'every probe closed');
});

test('F3: a disk image with a non-image media_type never reaches a data: URL as such', () => {
  const imgs = contentImages([
    { type: 'image', source: { type: 'base64', media_type: 'text/html', data: 'QUJD' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'QUJD' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'QUJD' } },
    { type: 'image', source: { type: 'base64', data: 'QUJD' } },
  ]);
  assert.deepEqual(imgs.map((i) => i.mediaType), ['image/png', 'image/png', 'image/webp', 'image/png']);
});
