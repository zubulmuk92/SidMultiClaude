// Every literal i18n key used anywhere in src/web exists in the ONE table, src/web/i18n/fr.js (M2: fr-shell.js and
// fr-chat.js were merged into it), and both lookups (lib/i18n.js for the shell, components/chat/text.js for the chat
// surface) read that same table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error browser module without declarations (checked by tsconfig.web.json)
import * as frM from '../../../src/web/i18n/fr.js';
// @ts-expect-error browser module
import * as i18nM from '../../../src/web/lib/i18n.js';
// @ts-expect-error browser module
import * as chatTextM from '../../../src/web/components/chat/text.js';

const i18n: any = i18nM, chatText: any = chatTextM;

const WEB = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'web');
const table = (frM as { fr: Readonly<Record<string, string>> }).fr;

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'i18n' && e.name !== 'vendor') out.push(...jsFiles(p)); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('i18n: every literal t(\'...\') key in src/web exists in fr.js', () => {
  // t / tp / talt / tPart / tParts / tTitleBody / toast / flash calls, and `key: '...'` (toasts, error keys) with a dotted key
  const re = /\b(?:t|tp|talt|tPart|tParts|tTitleBody|toast|flash)\(\s*'([a-z][\w.]*)'|\bkey: '([a-z][a-zA-Z]*\.[\w.]+)'/g;
  const missing: string[] = [];
  let n = 0;
  for (const f of jsFiles(WEB)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      const k = m[1] ?? m[2];
      if (!k || k.endsWith('.')) continue;                 // dynamic prefix: t('mode.' + x)
      n++;
      if (!Object.prototype.hasOwnProperty.call(table, k)) missing.push(`${path.relative(WEB, f)}: ${k}`);
    }
  }
  assert.ok(n > 600, `scanned ${n} uses`);
  assert.deepEqual(missing, []);
});

test('i18n: every key the server emits (toasts, notices, LoginStep keys) has its French copy in fr.js', () => {
  const SERVER = path.resolve(WEB, '..', 'server');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  const re = /\btoast\(\s*'([a-z][\w.]*)'|\bkey: '([a-z][a-zA-Z]*\.[\w.]+)'|\bloginError\('([a-z]+)'/g;
  const missing: string[] = [];
  let n = 0;
  for (const f of files(SERVER)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) {
      const k = m[1] ?? m[2] ?? `login.err.${m[3]}`;
      n++;
      if (!Object.prototype.hasOwnProperty.call(table, k)) missing.push(`${path.relative(SERVER, f)}: ${k}`);
    }
  }
  assert.ok(n >= 8, `scanned ${n} server keys`);
  assert.deepEqual(missing, []);
});

test('i18n: one table only (the split M1 tables are gone) and both lookups read it', () => {
  assert.equal(fs.existsSync(path.join(WEB, 'i18n', 'fr-shell.js')), false);
  assert.equal(fs.existsSync(path.join(WEB, 'i18n', 'fr-chat.js')), false);
  assert.deepEqual(fs.readdirSync(path.join(WEB, 'i18n')), ['fr.js']);
  for (const k of ['nav.newChat', 'shell.retry', 'grp.read', 'login.err.timeout']) {
    assert.equal(i18n.t(k), table[k], k);
    assert.equal(chatText.t(k), table[k], k);
  }
});

test('i18n: the login error keys of the lead list, with their placeholders', () => {
  assert.equal(i18n.t('login.err.timeout'), 'Délai de connexion dépassé (10 min).');
  assert.equal(i18n.t('login.err.failed', { detail: 'x' }), 'Connexion échouée : x');
  assert.equal(i18n.t('login.err.exit', { code: 3 }), 'Le processus de connexion s\'est arrêté (code 3).');
  for (const k of ['spawn', 'managed', 'cancelled']) assert.ok(i18n.has(`login.err.${k}`), k);
});

test('i18n: placeholders are balanced in every value', () => {
  for (const [k, v] of Object.entries(table)) assert.equal((v.match(/\{/g) ?? []).length, (v.match(/\}/g) ?? []).length, k);
});
