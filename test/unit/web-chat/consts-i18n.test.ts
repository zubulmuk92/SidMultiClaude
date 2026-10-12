// chat/consts.js mirrors src/shared/limits.ts (no .ts reaches the browser); every literal key the chat surface uses
// resolves, and placeholders are well formed (fr-chat.js was merged into fr.js at M2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as limits from '../../../src/shared/limits.ts';
import { ROOT, web } from './_load.ts';

const { LIMITS } = await web('components/chat/consts.js');
const { fr } = await web('i18n/fr.js');
const T = await web('components/chat/text.js');

test('every LIMITS value equals src/shared/limits.ts', () => {
  const L = limits as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(LIMITS)) assert.equal(v, L[k], k);
  assert.equal(LIMITS.MAX_IMAGES_TOTAL_BYTES, 12 * 1024 * 1024);          // lead decision L1
});

test('every literal i18n key used by the chat surface exists', () => {
  const dirs = ['chat', 'dock', 'composer', 'side'].map((d) => path.join(ROOT, 'src', 'web', 'components', d));
  const missing: string[] = [];
  let n = 0;
  for (const d of dirs) for (const f of fs.readdirSync(d)) {
    const src = fs.readFileSync(path.join(d, f), 'utf8');
    for (const m of src.matchAll(/\b(?:t|tp|talt)\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      const key = m[1] as string;
      if (key.endsWith('.')) continue;                 // dynamic prefix: t('mode.' + x)
      n++;
      if (!T.hasKey(key)) missing.push(`${f}: ${key}`);
    }
  }
  assert.ok(n > 200, `scanned ${n} uses`);
  assert.deepEqual(missing, []);
});

test('dynamic keys resolve for every value they can take', () => {
  for (const m of ['default', 'acceptEdits', 'plan', 'auto', 'bypass']) assert.ok(T.hasKey('mode.' + m), m);
  for (const s of ['busy', 'idle', 'waiting', 'blocked']) assert.ok(T.hasKey('state.external.' + s), s);
  for (const a of ['both', 'conv', 'code', 'fork']) assert.ok(T.hasKey('rewind.' + a), a);
  for (const d of ['user', 'rule', 'auto', 'autoNa', 'interrupted']) assert.ok(T.hasKey('tool.denied.' + d), d);
  for (const s of ['done', 'failed', 'stopped']) assert.ok(T.hasKey('agents.status.' + s), s);
  for (const k of ['read', 'search', 'command', 'edit', 'web', 'agent', 'mcp', 'todo', 'other', 'meta']) assert.ok(T.hasKey(`grp.${k}.n`), k);
});

test('placeholders are balanced, and t() fills them (unknown ones stay visible)', () => {
  for (const [k, v] of Object.entries(fr as Record<string, string>)) {
    assert.equal((v.match(/\{/g) ?? []).length, (v.match(/\}/g) ?? []).length, k);
  }
  assert.equal(T.t('perm.stack', { i: 1, n: 3 }), '1 sur 3');
  assert.equal(T.t('perm.stack', { i: 1 }), '1 sur {n}');
  assert.equal(T.t('no.such.key'), 'no.such.key');
  assert.equal(T.tp('common', 0), 'Annuler');
  assert.equal(T.talt('limit.banner', 1, { compte: 'P', heure: '15:45', 'durée': '2 h 10' }), 'Limite hebdomadaire atteinte sur P · réinitialisation à 15:45 (dans 2 h 10)');
  assert.equal(T.fmtTokens(1234), '1,2 k'); assert.equal(T.fmtTokens(84_000), '84 k'); assert.equal(T.fmtCost(0.84), '0,84 $');
});
