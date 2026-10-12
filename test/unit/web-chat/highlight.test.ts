// lib/highlight.js: every lazy language is one the server's static allow-list serves (HLJS_LANGS in
// src/server/http/static.ts, read as text: a language it does not serve would 404), each one ships in
// @highlightjs/cdn-assets, and aliases resolve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, web } from './_load.ts';

const H = await web('lib/highlight.js');

test('LANGS ⊆ the allow-list HLJS_LANGS, every file exists, aliases normalise', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'server', 'http', 'static.ts'), 'utf8');
  const m = /HLJS_LANGS[^=]*=\s*Object\.freeze\(\[([^\]]*)\]/.exec(src);
  assert.ok(m, 'HLJS_LANGS found in static.ts');
  const served = new Set([...(m?.[1] ?? '').matchAll(/'([\w-]+)'/g)].map((x) => x[1]));
  assert.deepEqual(H.LANGS.filter((l: string) => !served.has(l)), []);
  for (const l of H.LANGS) assert.ok(fs.existsSync(path.join(ROOT, 'node_modules', '@highlightjs', 'cdn-assets', 'es', 'languages', `${l}.min.js`)), l);
  assert.equal(H.normalizeLang('TS'), 'typescript');
  assert.equal(H.normalizeLang('c++'), 'cpp');
  assert.equal(H.normalizeLang('rs'), 'rust');
  assert.equal(H.normalizeLang('cobol'), null);
  assert.deepEqual(H.langsIn('```ts\nx\n```\n\n```text\ny\n```\n\n~~~golang\nz\n~~~'), ['typescript', 'go']);
});
