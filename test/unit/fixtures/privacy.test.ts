// No fixture contains personal data: checked on DECODED JSON strings so that escaping hides nothing.
// Generic markers are always checked. A private deny-list (one string per line, matched case-insensitively) can be
// supplied through SMC_PRIVACY_DENYLIST=<file>: it is then checked against the fixtures AND every text file of the
// repository. The list itself stays outside the repository.
// (scripts/sanitize-frames.mjs runs the same kind of scan against its real inputs when it regenerates the fixtures.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from '../../helpers/scenario.ts';

const DENY_FILE = process.env['SMC_PRIVACY_DENYLIST'];
const SPOT_LIST = DENY_FILE ? fs.readFileSync(DENY_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
// Token-like markers are assembled from parts so that the source itself never matches a secret scanner.
const GENERIC = ['sessionstart hook', '.credentials.json', ['sk', 'ant', ''].join('-'), 'bear' + 'er '];
const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(jsonl|json)$/.test(e.name) ? [p] : [];
  });
}
function strings(v: unknown, out: string[]): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
}
const all = ['frames', 'pairs', 'protocol'].flatMap((d) => files(path.join(FIXTURES, d))).map((f) => {
  const text = fs.readFileSync(f, 'utf8');
  const decoded = (f.endsWith('.jsonl') ? text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as unknown) : [JSON.parse(text) as unknown]).flatMap((v) => strings(v, []));
  return { f: path.relative(FIXTURES, f), hay: decoded.join('\n').toLowerCase() + '\n' + text.toLowerCase(), decoded };
});

test('fixtures exist: 4 frame files, 4 wire files, 3 pairs, 8 protocol scripts', () => {
  assert.equal(all.filter((x) => /^frames[\\/][a-z]+\.jsonl$/.test(x.f)).length, 4);
  assert.equal(all.filter((x) => /^frames[\\/]wire[\\/]/.test(x.f)).length, 4);
  assert.equal(all.filter((x) => /^pairs[\\/]/.test(x.f)).length, 9);
  assert.equal(all.filter((x) => /^protocol[\\/]/.test(x.f)).length, 8);
});

test('no deny-list string or generic marker in any fixture (decoded strings and raw text)', () => {
  const hits: string[] = [];
  for (const { f, hay } of all) {
    SPOT_LIST.forEach((n, i) => { if (hay.includes(n)) hits.push(`${f}: deny-list entry #${i + 1}`); });
    for (const n of GENERIC) if (hay.includes(n)) hits.push(`${f}: ${n}`);
  }
  assert.deepEqual(hits, []);
});

test('no deny-list string in any text file of the repository', { skip: DENY_FILE ? false : 'SMC_PRIVACY_DENYLIST not set' }, () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.git') return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ico|png|jpe?g|gif|exe|dll|woff2?)$/i.test(e.name) ? [] : [p];
  });
  const hits: string[] = [];
  for (const f of walk(REPO)) {
    const text = fs.readFileSync(f, 'utf8').toLowerCase();
    SPOT_LIST.forEach((n, i) => { if (text.includes(n)) hits.push(`${path.relative(REPO, f)}: deny-list entry #${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});

test('only synthetic identities and paths remain', () => {
  const bad: string[] = [];
  for (const { f, decoded } of all) {
    for (const s of decoded) {
      for (const m of s.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) if (!/@example\.invalid$/i.test(m[0]) && !/@(synced|builtin)/.test(m[0]) && !/^[^@]+@[\d.]+$/.test(m[0])) bad.push(`${f}: email-like ${m[0]}`);
      for (const m of s.matchAll(/[A-Za-z]:[\\/]+Users[\\/]+([^\\/"]+)/gi)) if (!/^(smc-user|SMC-US~1)$/i.test(m[1]!)) bad.push(`${f}: user folder ${m[1]}`);
      for (const m of s.matchAll(/\b[A-Z0-9]{2,6}~\d\b/g)) if (m[0] !== 'SMC-US~1' && !/^US~1$/.test(m[0])) bad.push(`${f}: 8.3 name ${m[0]}`);
    }
  }
  assert.deepEqual([...new Set(bad)], []);
});

test('context attachments are placeholders (hook output, CLAUDE.md, prompt snapshot, environment)', () => {
  for (const name of ['main', 'fork', 'plan']) {
    const lines = fs.readFileSync(path.join(FIXTURES, 'pairs', name, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const e of lines) {
      const a = e['attachment'] as Record<string, unknown> | undefined;
      if (!a) continue;
      if (a['type'] === 'hook_success') for (const k of ['stdout', 'content']) if (a[k]) assert.match(String(a[k]), /^\[placeholder: /, `${name} ${k}`);
      if (a['type'] === 'prompt_snapshot') for (const s of a['systemPrompt'] as string[]) assert.match(s, /^\[placeholder: /);
      if (a['type'] === 'environment') { const snap = a['snapshot'] as Record<string, unknown>; assert.match(String(snap['osVersion']), /^\[placeholder: /); assert.match(String(snap['shell']), /^\[placeholder: /); }
    }
  }
  for (const name of ['dry', 'main', 'plan']) {
    const hooks = fs.readFileSync(path.join(FIXTURES, 'frames', `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { m: Record<string, unknown> }).m)
      .filter((m) => m['type'] === 'system' && m['subtype'] === 'hook_response');
    assert.ok(hooks.length > 0, name);
    for (const h of hooks) for (const k of ['output', 'stdout']) assert.ok(h[k] === '' || h[k] === '[placeholder: hook output]', `${name} hook ${k}`);
    assert.ok(hooks.some((h) => h['output'] === '[placeholder: hook output]'), `${name}: non-empty hook output became a placeholder`);
  }
});
