// test/unit/claude/headtail.test.ts — the SDK head/tail metadata algorithm: pasted prompts, the backwards
// fallback over a giant last line (with and without the metadata block after it), the "has messages" scan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstPrompt, hasMessages, readFileMeta, readHeadTail, unwrapPasted } from '../../../src/server/claude/headtail.ts';
import { canonicalPath } from '../../../src/server/util/paths.ts';
import { assistant, customTitle, iso, jsonl, lastPrompt, SID, toolResult, toolUse, u, user, writeJsonl } from './lib.ts';
import type { E } from './lib.ts';

let dir = '';
before(() => { dir = fs.mkdtempSync(path.join(canonicalPath(os.tmpdir()), 'smc-wpc-headtail-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('pasted blocks are unwrapped before the prompt filters (SDK PS): the first prompt is not lost', () => {
  const text = '<pasted_content id="ab12">\ncontenu collé\n</pasted_content id="ab12">\nQue fait ce code ?';
  assert.equal(unwrapPasted(text), 'contenu colléQue fait ce code ?');
  assert.equal(unwrapPasted('<pasted_content id="zz12">\nx'), '<pasted_content id="zz12">\nx');   // not a block id
  const head = jsonl([user(u(1), null, text, { i: 1 })]);
  assert.equal(firstPrompt(head), 'contenu colléQue fait ce code ?');
});

function giantSession(name: string, metadataAfter: boolean): string {
  const entries: E[] = [
    user(u(1), null, 'Bonjour', { i: 1 }), assistant(u(2), u(1), 'Salut', { i: 2 }),
    user(u(3), u(2), 'Lis le fichier', { i: 3 }), toolUse(u(4), u(3), 'toolu_1', { i: 4 }),
    toolResult(u(5), u(4), 'toolu_1', 'ok', { i: 5 }), assistant(u(6), u(5), 'Voilà', { i: 6, model: 'claude-sonnet-5' }),
    lastPrompt('Lis le fichier', u(6)), customTitle('Avant la ligne géante'),
    { type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: SID },
    user(u(7), u(6), 'Encore', { i: 7 }), toolUse(u(8), u(7), 'toolu_2', { i: 8 }),
  ];
  const huge = toolResult(u(9), u(8), 'toolu_2', 'ok', { i: 9 });
  huge['toolUseResult'] = { stdout: 'y'.repeat(1_500_000), stderr: '' };
  entries.push(huge);
  if (metadataAfter) entries.push(lastPrompt('Encore', u(9)), customTitle('Avant la ligne géante'));
  return writeJsonl(path.join(dir, `${name}.jsonl`), entries);
}

for (const metadataAfter of [false, true]) {
  test(`a giant last line: the backwards fallback finds the last messages (metadata block ${metadataAfter ? 'after it' : 'hidden'})`, async () => {
    const file = giantSession(`giant-${metadataAfter}`, metadataAfter);
    const ht = await readHeadTail(file);
    assert.ok(ht && !ht.tail.includes('"type":"assistant"'), 'the 64 KiB tail only sees the giant line');
    const m = await readFileMeta(file, SID);
    assert.ok(m);
    assert.equal(m.title, 'Avant la ligne géante');
    assert.equal(m.titleSource, 'custom');
    assert.equal(m.updatedAt, Date.parse(iso(8)), 'updatedAt from the last message before the giant line, not the mtime');
    assert.equal(m.lastRequestAt, Date.parse(iso(8)));
    assert.equal(m.lastContext, 10 + 1000 + 200);
    assert.equal(m.lastMode, 'acceptEdits');
    assert.equal(m.firstPrompt, 'Bonjour');
  });
}

test('"has messages": scanned between a metadata-only head and tail; a file without chain entries is skipped', async () => {
  const meta = (n: number): E => ({ type: 'custom-title', customTitle: `t${n}`, sessionId: SID, pad: 'm'.repeat(70_000) });
  const withChain = writeJsonl(path.join(dir, 'middle.jsonl'), [meta(1), user(u(1), null, 'Au milieu', { i: 1 }), meta(2)]);
  const ht = await readHeadTail(withChain);
  assert.ok(ht && !ht.head.includes('"parentUuid":') && !ht.tail.includes('"parentUuid":'));
  assert.equal(await hasMessages(withChain, ht), true);
  const none = writeJsonl(path.join(dir, 'none.jsonl'), [meta(1), meta(2), meta(3)]);
  assert.equal(await hasMessages(none, (await readHeadTail(none))!), false);
  assert.equal(await readFileMeta(none, SID), null);
});
