// lib/diff.js: client-side LCS preview of Edit/Write asks (ux §6.3), structuredPatch rendering of results (ux §5.4),
// unified hunks with 3 lines of context, word-level highlight on paired lines, block fallback above 1e6 cells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { web } from './_load.ts';

const D = await web('lib/diff.js');
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

test('splitLines: a final newline does not create an empty line', () => {
  assert.deepEqual(D.splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(D.splitLines('a\r\nb'), ['a', 'b']);
  assert.deepEqual(D.splitLines(''), []);
});

test('line LCS: minimal +/- ops, unchanged prefix and suffix kept as context', () => {
  const ops = D.diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(ops.map((o: any) => o.op + o.text), [' a', '-b', '+B', ' c', ' d', '+e']);
  assert.deepEqual(D.countChanges(ops), { added: 2, removed: 1 });
  assert.deepEqual(D.diffLines('', 'x\ny').map((o: any) => o.op), ['+', '+']);    // new file: every line added
});

test('above 1e6 cells the preview becomes a block « n lignes remplacées par m »', () => {
  const a = lines(1100, (i) => `a${i}`), b = lines(1000, (i) => `b${i}`);
  const r = D.diffLinesDetailed(a, b);
  assert.equal(r.block, true);
  assert.deepEqual(D.countChanges(r.ops), { added: 1000, removed: 1100 });
  assert.equal(D.diffLinesDetailed(lines(900, (i) => `a${i}`), lines(900, (i) => `b${i}`)).block, false);
});

test('toHunks: 3 lines of context, close changes merged, line numbers and counts', () => {
  const a = lines(30, (i) => `l${i + 1}`);
  const b = a.replace('l5\n', 'L5\n').replace('l8\n', 'L8\n').replace('l25\n', 'L25\n');
  const hunks = D.toHunks(D.numberRows(D.diffLines(a, b)), 3);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].oldStart, 2); assert.equal(hunks[0].newStart, 2);
  assert.equal(hunks[0].oldLines, 10);                  // l2..l11
  assert.equal(hunks[1].oldStart, 22);
  const del = hunks[0].rows.find((r: any) => r.op === '-');
  assert.equal(del.oldNo, 5); assert.equal(del.newNo, undefined);
});

test('patchToHunks: structuredPatch lines (prefix kept out, « \\ No newline » dropped) with numbering from the hunk', () => {
  const [h] = D.patchToHunks([{ oldStart: 118, oldLines: 2, newStart: 118, newLines: 2,
    lines: ['  const token = x;', '-  if (!token) return null;', '+  if (!token) throw new Error();', '\\ No newline at end of file'] }]);
  assert.deepEqual(h.rows.map((r: any) => [r.op, r.oldNo ?? null, r.newNo ?? null]), [[' ', 118, 118], ['-', 119, null], ['+', null, 119]]);
  assert.equal(h.rows[1].text, '  if (!token) return null;');
});

test('wordDiff marks only the changed words (accents are word letters), and gives up at 500 chars', () => {
  const w = D.wordDiff('const é = vieux;', 'const é = nouveau;');
  assert.deepEqual(w.a, [{ text: 'const é = ', changed: false }, { text: 'vieux', changed: true }, { text: ';', changed: false }]);
  assert.deepEqual(w.b.filter((s: any) => s.changed).map((s: any) => s.text), ['nouveau']);
  assert.equal(D.wordDiff('x'.repeat(500), 'y'), null);
});

test('pairRows pairs each - run with the + run that follows', () => {
  const rows = [{ op: ' ' }, { op: '-' }, { op: '-' }, { op: '+' }, { op: ' ' }, { op: '-' }];
  assert.deepEqual([...D.pairRows(rows)], [[1, 3]]);
});
