// lib/stream-md.js: the settled / tail split of streaming markdown (ux §12.2). Settled text ends at a blank line outside
// a code fence; the fence state is incremental, so pushing a text in pieces gives exactly the one-shot split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { web } from './_load.ts';

const S = await web('lib/stream-md.js');

test('settled ends after the last blank line outside a fence', () => {
  assert.deepEqual(S.splitSettled('a\n\nb'), { settled: 'a\n\n', tail: 'b' });
  assert.deepEqual(S.splitSettled('no blank line yet'), { settled: '', tail: 'no blank line yet' });
  // a blank line inside an open fence never settles
  assert.deepEqual(S.splitSettled('x\n\n```ts\nconst a = 1;\n\nconst b = 2;'), { settled: 'x\n\n', tail: '```ts\nconst a = 1;\n\nconst b = 2;' });
  // once the fence closes, the next blank line settles everything
  const md = 'x\n\n```ts\nconst a = 1;\n\n```\n\nfin';
  assert.deepEqual(S.splitSettled(md), { settled: md.slice(0, md.length - 3), tail: 'fin' });
});

test('fences: ~~~ and longer runs close only with the same char and at least the same length', () => {
  const st = S.newFenceState();
  S.fenceStep(st, '````md');
  assert.equal(st.inFence, true); assert.equal(st.fenceLang, 'md');
  S.fenceStep(st, '```'); assert.equal(st.inFence, true);
  S.fenceStep(st, '~~~~'); assert.equal(st.inFence, true);
  S.fenceStep(st, '`````'); assert.equal(st.inFence, false);
  const st2 = S.newFenceState();
  S.fenceStep(st2, '``` a`b');                                  // backticks in the info string: not a fence
  assert.equal(st2.inFence, false);
});

test('incremental pushes (any chunking) give the one-shot split, and chunks concatenate to the settled text', () => {
  const md = 'Le test échoue.\n\n```ts\nparseDate("2026");\n\nx();\n```\n\nJe corrige.\n\n- a\n- b\n\nFin';
  for (const step of [1, 3, 7, 50]) {
    const sp = S.createSplitter();
    let acc = '', settled = '', r: any = null;
    for (let i = 0; i < md.length; i += step) {
      acc = md.slice(0, i + step);
      r = sp.push(acc);
      assert.equal(r.reset, false);
      settled += r.chunk;
      assert.equal(settled + r.tail, acc, `step ${step} at ${i}`);
    }
    assert.deepEqual({ settled, tail: r.tail }, S.splitSettled(md));
  }
});

test('the tail knows it is inside an open fence (shown as text in a <pre>)', () => {
  const sp = S.createSplitter();
  let r = sp.push('Voici :\n\n```py\nprint(1)');
  assert.equal(r.inFence, true); assert.equal(r.fenceLang, 'py');
  assert.deepEqual(S.splitOpenFence(r.tail), { before: '', code: 'print(1)', lang: 'py' });
  r = sp.push('Voici :\n\n```py\nprint(1)\n```\n');
  assert.equal(r.inFence, false);
  assert.deepEqual(S.splitOpenFence('texte\n```js\nlet a'), { before: 'texte', code: 'let a', lang: 'js' });
  assert.deepEqual(S.splitOpenFence('pas de fence'), { before: 'pas de fence', code: '', lang: '' });
  // an opening fence still being typed on the last line counts
  assert.equal(S.createSplitter().push('a\n\n```').inFence, true);
});

test('a replaced (non-append) text restarts the splitter', () => {
  const sp = S.createSplitter();
  sp.push('un\n\ndeux');
  const r = sp.push('autre\n\nchose');
  assert.equal(r.reset, true);
  assert.equal(r.chunk, 'autre\n\n');
  assert.equal(r.tail, 'chose');
});

test('CRLF text is split like LF text', () => {
  assert.deepEqual(S.splitSettled('a\r\n\r\nb'), { settled: 'a\r\n\r\n', tail: 'b' });
});
