// test/unit/web-shell/tokens-contrast.test.ts — src/web/styles/tokens.css (ux §13): the two dark blocks are identical, and
// every text token keeps a WCAG contrast of at least 4.5:1 on the surfaces it is drawn on, in both themes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'web', 'styles', 'tokens.css'), 'utf8');
const tokens = (block: string): Map<string, string> => new Map([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
// rule starts only ("\n…"): the header comment names the same selectors
const root = css.indexOf('\n:root {'), media = css.indexOf('\n@media (prefers-color-scheme: dark)'), attr = css.indexOf('\n:root[data-theme="dark"]'), body = css.indexOf('\nbody');
const light = tokens(css.slice(root, media)), darkMedia = tokens(css.slice(media, attr)), dark = tokens(css.slice(attr, body));

function luminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i, hex);
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string): number => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

const TEXT = ['fg', 'fg-muted', 'fg-subtle', 'st-run', 'st-needs', 'st-done', 'st-err', 'st-limit', 'accent'];
const SURFACES = ['bg', 'bg-app', 'bg-elev', 'bg-sunken', 'bg-hover'];

test('tokens: the two dark blocks hold the same values', () => {
  assert.deepEqual([...darkMedia], [...dark]);
});

for (const [name, t] of [['light', light], ['dark', dark]] as const) {
  test(`tokens (${name}): text ≥ 4.5:1 on every surface, on the account colours and on the tinted cards`, () => {
    const get = (k: string): string => t.get(k) ?? assert.fail(`missing --${k}`);
    for (const fg of TEXT) for (const bg of SURFACES) assert.ok(contrast(get(fg), get(bg)) >= 4.5, `--${fg} on --${bg}: ${contrast(get(fg), get(bg)).toFixed(2)}`);
    for (let n = 1; n <= 8; n++) assert.ok(contrast(get('on-accent'), get(`acc-${n}`)) >= 4.5, `--on-accent on --acc-${n}: ${contrast(get('on-accent'), get(`acc-${n}`)).toFixed(2)}`);
    assert.ok(contrast(get('on-accent'), get('accent')) >= 4.5, '--on-accent on --accent');
    assert.ok(contrast(get('st-needs'), get('st-needs-bg')) >= 4.5, '--st-needs on its card');
    assert.ok(contrast(get('st-err'), get('st-err-bg')) >= 4.5, '--st-err on its card');
  });
}
