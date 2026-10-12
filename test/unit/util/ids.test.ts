import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountOf, accountSlug, decodeCursor, encodeCursor, isAccountId, isChatId, isTxCursor, isUuid, makeChatId, newBootId, newUuid,
  parseChatId, sessionOf,
} from '../../../src/server/util/ids.ts';

const SID = '4adf4c63-b504-4be1-804b-92a88963e275';

test('chatId codec: "<accountId>:<sessionId>" round trip', () => {
  const c = makeChatId('acme', SID);
  assert.equal(c, `acme:${SID}`);
  assert.deepEqual(parseChatId(c), { accountId: 'acme', sessionId: SID });
  assert.equal(accountOf(c), 'acme');
  assert.equal(sessionOf(c), SID);
  assert.equal(isChatId(c), true);
  assert.equal(isChatId(`perso-2:${SID}`), true);
});

test('chatId codec rejects malformed ids', () => {
  for (const bad of [`:${SID}`, `Perso:${SID}`, `2x:${SID}`, `a_b:${SID}`, `perso:${SID.toUpperCase()}`, `perso:${SID}x`, 'perso', `perso:${SID}:x`, 42, null,
    `${'a'.repeat(25)}:${SID}`]) {
    assert.equal(parseChatId(bad), null, String(bad));
  }
  assert.throws(() => makeChatId('Bad', SID));
  assert.throws(() => makeChatId('ok', 'not-a-uuid'));
  assert.throws(() => accountOf('nope'));
});

test('UUID and accountId checks', () => {
  assert.equal(isUuid(SID), true);
  assert.equal(isUuid(SID.toUpperCase()), false, 'lower-case canonical only');
  assert.equal(isUuid(newUuid()), true);
  assert.equal(isAccountId('perso'), true);
  assert.equal(isAccountId('a'.repeat(24)), true);
  assert.equal(isAccountId('a'.repeat(25)), false);
  assert.equal(isAccountId('perso:x'), false);
});

test('account slugs (perso, acme, perso-2…)', () => {
  assert.equal(accountSlug('Perso'), 'perso');
  assert.equal(accountSlug('ACME'), 'acme');
  assert.equal(accountSlug('Perso', ['perso']), 'perso-2');
  assert.equal(accountSlug('Perso', ['perso', 'perso-2']), 'perso-3');
  assert.equal(accountSlug('Équipe Rouge (été)'), 'equipe-rouge-ete');
  assert.equal(accountSlug('2e compte'), 'compte-2e-compte');
  assert.equal(accountSlug('   '), 'compte');
  const long = accountSlug('Un nom de compte vraiment beaucoup trop long');
  assert.ok(isAccountId(long) && long.length <= 24, long);
  const dup = accountSlug('Un nom de compte vraiment beaucoup trop long', [long]);
  assert.ok(isAccountId(dup) && dup.endsWith('-2') && dup.length <= 24, dup);
});

test('opaque cursors: base64url JSON, never throws on garbage', () => {
  const c = encodeCursor({ off: 123456, leaf: SID });
  assert.match(c, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(c, isTxCursor), { off: 123456, leaf: SID });
  for (const bad of ['', '!!!', 'e30', encodeCursor({ off: -1, leaf: 'x' }), encodeCursor({ off: 1.5, leaf: 'x' }), 'x'.repeat(5000), 7, null]) {
    assert.equal(decodeCursor(bad, isTxCursor), null, String(bad).slice(0, 20));
  }
  assert.deepEqual(decodeCursor('e30'), {}, 'without a check any object passes');
  assert.equal(decodeCursor(Buffer.from('[1,2]').toString('base64url')), null, 'arrays are not cursors');
});

test('boot ids are unique and not secret-looking UUIDs', () => {
  const a = newBootId();
  const b = newBootId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-z]+-[A-Za-z0-9_-]{8}$/);
});
