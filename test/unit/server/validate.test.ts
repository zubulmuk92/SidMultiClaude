// WP-D acceptance 3 (S6/S15, L1): validators reject unknown fields and oversize payloads; a 10⁴-message fuzz through the
// rpc never throws and gives exactly one ack per id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as P from '../../../src/shared/protocol.ts';
import { SCHEMAS, validateC2S } from '../../../src/server/ws/validate.ts';
import { createRpc, fail } from '../../../src/server/ws/rpc.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { MAX_DRAFT_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES_TOTAL_BYTES, MAX_TEXT_BYTES } from '../../../src/shared/limits.ts';

const CHAT = 'perso:4adf4c63-b504-4be1-804b-92a88963e275';
const UUID = '0b6f3a59-0a8e-4c55-8a51-1a2b3c4d5e6f';
const GOOD: Record<string, Record<string, unknown>> = {
  'view': { full: [CHAT], focused: CHAT, windowFocused: true },
  'chat.create': { accountId: 'perso', cwd: 'C:\\x', mode: 'default' },
  'chat.send': { chatId: CHAT, uuid: UUID, text: 'salut', images: [{ mediaType: 'image/png', base64: 'AAAA' }], priority: 'later' },
  'chat.decide': { chatId: CHAT, requestId: 'r1', answer: { kind: 'allow-always', scope: 'session' } },
  'chat.setMode': { chatId: CHAT, mode: 'bypassPermissions', typed: 'CONTOURNER' },
  'chat.setModel': { chatId: CHAT, model: null, effort: 'high' },
  'chat.delete': { chatId: CHAT, confirm: true },
  'ui.save': { ui: { layout: 2, tabs: [CHAT], closed: [], panes: [CHAT, null], focusedPane: 1,
    sidebar: { width: 280, collapsed: false, grouping: 'account', showArchived: false }, scroll: { [CHAT]: { turnId: 'u:x', offset: 3 } }, views: { [CHAT]: 'focus' } } },
  'draft.save': { chatId: CHAT, draft: { text: 'x', attachments: [], at: 1 } },
  'settings.set': { patch: { maxLive: 5, reapMin: null, theme: 'dark' } },
  'account.candidates': {},
  'app.quit': {},
  'chat.retry': { chatId: CHAT },                                       // M2 (lead)
  'tx.detail': { chatId: CHAT, blockId: 'b:x', field: 'input' },          // M2: blockId (was id, collided with the request id)
};

test('every C2S type has a schema, and valid samples pass', () => {
  for (const [t, body] of Object.entries(GOOD)) {
    const r = validateC2S({ id: 1, t, ...body });
    assert.equal(r.ok, true, `${t}: ${JSON.stringify(r)}`);
  }
  assert.equal(Object.keys(SCHEMAS).length, 42);                          // 41 + chat.retry
});

test('unknown fields are rejected (including prototype names), required fields enforced', () => {
  for (const extra of ['x', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = validateC2S(JSON.parse(`{"id":2,"t":"chat.interrupt","chatId":"${CHAT}","${extra}":1}`));
    assert.deepEqual(r.ok ? 'ok' : [r.id, r.err.code], [2, 'invalid'], extra);
  }
  const nested = validateC2S({ id: 3, t: 'chat.decide', chatId: CHAT, requestId: 'r', answer: { kind: 'deny', message: 'n', evil: 1 } });
  assert.equal(nested.ok, false);
  assert.equal(validateC2S({ id: 4, t: 'chat.interrupt' }).ok, false);
  assert.equal(validateC2S({ id: 5, t: 'chat.decide', chatId: CHAT, requestId: 'r', answer: { kind: 'allow-always', scope: 'userSettings' } }).ok, false, 'userSettings never accepted');
  assert.equal(validateC2S({ id: 6, t: 'chat.delete', chatId: CHAT, confirm: false }).ok, false);
  assert.equal(validateC2S({ id: 7, t: 'chat.interrupt', chatId: 'Perso:not-a-uuid' }).ok, false, 'chatId format');
  assert.equal(validateC2S({ id: 8, t: 'nope' }).ok, false);
  assert.deepEqual(validateC2S({ t: 'app.quit' }), { ok: false, id: null, err: { code: 'invalid', message: 'id' } });
});

test('S15 / L1: size caps answer too_large', () => {
  const img = (n: number): P.ImageInput => ({ mediaType: 'image/png', base64: 'A'.repeat(n) });
  const send = (o: Record<string, unknown>): ReturnType<typeof validateC2S> => validateC2S({ id: 9, t: 'chat.send', chatId: CHAT, uuid: UUID, text: 'x', ...o });
  const code = (r: ReturnType<typeof validateC2S>): string => (r.ok ? 'ok' : r.err.code);
  assert.equal(code(send({ images: [img(MAX_IMAGE_BYTES + 4)] })), 'too_large', 'one image > 5 MB');
  const each = Math.floor(MAX_IMAGE_BYTES / 4) * 4;
  assert.equal(code(send({ images: [img(each), img(each)] })), 'ok', '2 × 5 MB fits 12 MiB');
  assert.equal(code(send({ images: [img(each), img(each), img(Math.ceil((MAX_IMAGES_TOTAL_BYTES - 2 * each + 8) / 4) * 4)] })), 'too_large', 'sum > 12 MiB');
  assert.equal(code(send({ images: Array.from({ length: 9 }, () => img(4)) })), 'invalid', '> 8 images');
  assert.equal(code(send({ text: 'é'.repeat(MAX_TEXT_BYTES / 2 + 1) })), 'too_large', 'text > 1 MB (utf-8 bytes)');
  assert.equal(code(send({ images: [{ mediaType: 'image/svg+xml', base64: 'AAAA' }] })), 'invalid', 'MIME allow-list');
  const draft = (text: string, attachments: unknown[] = []): ReturnType<typeof validateC2S> =>
    validateC2S({ id: 10, t: 'draft.save', chatId: CHAT, draft: { text, attachments, at: 1 } });
  assert.equal(code(draft('x'.repeat(MAX_DRAFT_BYTES))), 'ok', 'a 1 MB draft fits');
  assert.equal(code(draft('x'.repeat(MAX_DRAFT_BYTES + 1))), 'too_large', 'drafts ≤ 1 MB');
  assert.equal(code(draft('é'.repeat(MAX_DRAFT_BYTES / 2 + 1))), 'too_large', 'counted in UTF-8 bytes');
  assert.equal(code(draft('x', [{ name: 'a.png', mediaType: 'image/png', base64: 'A'.repeat(MAX_DRAFT_BYTES) }])), 'too_large', 'attachments count');
  assert.equal(code(validateC2S({ id: 11, t: 'tx.page', chatId: CHAT, limit: 51 })), 'invalid', 'tx.page limit ≤ 50');
});

function rnd(seed: number): () => number { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
test('fuzz: 10,000 random frames never throw and give exactly one ack per readable id', async () => {
  const r = rnd(42);
  const types = Object.keys(SCHEMAS);
  const values: unknown[] = [null, true, 0, -1, 1.5, 'x', '', CHAT, UUID, 'perso', [], [CHAT], {}, { kind: 'deny', message: 'x' }, 'A'.repeat(300), 2 ** 60];
  const acks = new Map<number, number>();
  let handled = 0;
  const rpc = createRpc<object>({
    log: nullLogger,
    handlers: Object.fromEntries(types.map((t) => [t, () => { handled++; if (r() < 0.2) fail('busy'); if (r() < 0.1) throw new Error('boom'); return r() < 0.5 ? undefined : Promise.resolve({ ok: true as const }); }])),
    sendAck: (_c, a) => { if (a.t === 'ack') acks.set(a.id, (acks.get(a.id) ?? 0) + 1); },
  });
  const conn = {};
  const owed = new Set<number>();
  let truncated = 0;
  for (let i = 0; i < 10_000; i++) {
    const msg: Record<string, unknown> = { id: i, t: types[Math.floor(r() * types.length)] };
    const sample = GOOD[msg['t'] as string];
    if (sample && r() < 0.3) Object.assign(msg, sample);
    const n = Math.floor(r() * 4);
    for (let k = 0; k < n; k++) msg[['chatId', 'text', 'uuid', 'cwd', 'answer', 'patch', 'x', 'full'][Math.floor(r() * 8)]!] = values[Math.floor(r() * values.length)];
    let text = JSON.stringify(msg);
    // a complete frame always owes its ack; a truncated one only when its id is complete (`{"id":<i>,` survived the cut)
    if (r() < 0.05) { text = text.slice(0, Math.floor(r() * text.length)); truncated++; if (text.length >= `{"id":${i},`.length) owed.add(i); }
    else owed.add(i);
    await rpc.handle(conn, text);
  }
  for (const [id, n] of acks) assert.equal(n, 1, `id ${id} acked ${n} times`);
  assert.deepEqual([...acks.keys()].filter((id) => !owed.has(id)), [], 'no ack for an unreadable id');
  assert.deepEqual([...owed].filter((id) => !acks.has(id)), [], 'every readable id got its ack');
  assert.ok(truncated > 300 && handled > 100, `${truncated} truncated, ${handled} handled (the rest is refused by the validators)`);
});

test('rpc: thrown errors map to wire codes; a duplicate in-flight id never gets a second ack', async () => {
  const out: P.S2C[] = [];
  let release!: () => void;
  const rpc = createRpc<object>({ log: nullLogger, sendAck: (_c, a) => out.push(a), handlers: {
    'chat.interrupt': () => new Promise((r) => { release = () => r({ ok: true, data: { stillQueued: [] } }); }),
    'app.quit': () => { throw Object.assign(new Error('x'), { code: 'not_live' }); },
    'account.candidates': () => { throw new Error('secret path C:\\x'); },
  } });
  const c = {};
  const p1 = rpc.handle(c, JSON.stringify({ id: 1, t: 'chat.interrupt', chatId: CHAT }));
  await rpc.handle(c, JSON.stringify({ id: 1, t: 'chat.interrupt', chatId: CHAT }));
  release();
  await p1;
  await rpc.handle(c, JSON.stringify({ id: 2, t: 'app.quit' }));
  await rpc.handle(c, JSON.stringify({ id: 3, t: 'account.candidates' }));
  await rpc.handle(c, JSON.stringify({ id: 4, t: 'account.usage', accountId: 'perso' }));
  assert.deepEqual(out.map((a) => (a.t === 'ack' ? [a.id, a.ok ? 'ok' : a.err.code] : null)),
    [[1, 'ok'], [2, 'not_live'], [3, 'internal'], [4, 'unsupported']], 'id 1: one ack, the real result');
  assert.ok(!JSON.stringify(out).includes('secret'), 'internal errors carry no detail');
});
