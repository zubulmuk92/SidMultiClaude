// Pure helpers of the side panels and dialogs: header cache clock, model-switch confirmation (warm cache only),
// continue targets, error banners, rewind actions (code options need tracked changes), Peek exchanges, tasks strip,
// drawer lines, mention highlighting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { web } from './_load.ts';

const { cacheClock, MODEL_ALIASES, MODES } = await web('components/chat/PaneHeader.js');
const { needsModelConfirm } = await web('components/side/ModelSwitchConfirm.js');
const { continueTargets } = await web('components/side/ContinueOnDialog.js');
const { errorBanner } = await web('components/chat/PaneBanners.js');
const { rewindActions } = await web('components/side/RewindDialog.js');
const { peekExchanges } = await web('components/chat/Peek.js');
const { todoSummary } = await web('components/side/TodoStrip.js');
const { taskLine } = await web('components/side/AgentsDrawer.js');

test('cache clock: warm, soon (< 5 min), cold; nothing for a sleeping chat', () => {
  const now = 1_000_000;
  assert.deepEqual(cacheClock({ cacheWarmUntil: now + 47 * 60_000 }, true, now), { tone: 'warm', min: 47 });
  assert.deepEqual(cacheClock({ cacheWarmUntil: now + 4 * 60_000 }, true, now), { tone: 'soon', min: 4 });
  assert.deepEqual(cacheClock({ cacheWarmUntil: now - 1 }, true, now), { tone: 'cold', min: 0 });
  assert.equal(cacheClock({ cacheWarmUntil: now + 1 }, false, now), null);
});

test('model menu offers aliases only, modes in CLI order; a model switch asks only while the cache is warm', () => {
  assert.deepEqual([...MODEL_ALIASES], ['opus', 'sonnet', 'haiku']);
  assert.deepEqual([...MODES], ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
  assert.equal(needsModelConfirm({ cacheWarmUntil: 2000 }, 1000, { modelChanges: true }), true);
  assert.equal(needsModelConfirm({ cacheWarmUntil: 500 }, 1000, { modelChanges: true }), false);
  assert.equal(needsModelConfirm({ cacheWarmUntil: 2000 }, 1000, { modelChanges: false }), false);   // effort only
});

test('continue targets: every visible account but its own, connected first', () => {
  const a = (id: string, login: string, hidden = false) => ({ id, login, hidden, name: id });
  assert.deepEqual(continueTargets([a('p', 'connected'), a('w', 'disconnected'), a('x', 'connected'), a('h', 'connected', true)], 'p').map((x: any) => x.id), ['x', 'w']);
});

test('error banners map the state error codes to their French copy', () => {
  const c = { compte: 'Perso', cwd: 'C:\\x' };
  assert.deepEqual(errorBanner({ code: 'auth' }, c), { key: 'err.auth', args: { compte: 'Perso' }, retry: false });
  assert.equal(errorBanner({ code: 'crash', exitCode: 3 }, c).args.code, 3);
  assert.equal(errorBanner({ code: 'cwd' }, c).key, 'resume.cwdMissing');
  assert.equal(errorBanner({ code: 'breaker' }, c).retry, true);
});

test('rewind: code options only when the dry run found tracked file changes', () => {
  assert.deepEqual(rewindActions({ files: [] }), ['conv', 'fork']);
  assert.deepEqual(rewindActions(null), ['conv', 'fork']);
  assert.deepEqual(rewindActions({ files: [{ path: 'a', added: 1, removed: 0 }] }), ['both', 'conv', 'code', 'fork']);
});

test('Peek shows the last exchanges: prompt and final reply', () => {
  const turn = (i: number) => ({ id: 'u:' + i, at: i, user: { uuid: String(i), text: 'q' + i, origin: 'human' },
    blocks: [{ k: 'text', id: 'a:' + i + ':0', md: 'brouillon' }, { k: 'text', id: 'a:' + i + ':1', md: 'r' + i }] });
  const ex = peekExchanges([1, 2, 3, 4].map(turn), 3);
  assert.deepEqual(ex.map((x: any) => [x.user, x.reply]), [['q2', 'r2'], ['q3', 'r3'], ['q4', 'r4']]);
});

test('tasks strip and drawer lines', () => {
  assert.deepEqual(todoSummary([{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress', activeForm: 'Écrit b' }, { text: 'c', status: 'pending' }]),
    { done: 1, total: 3, active: 'Écrit b' });
  assert.equal(taskLine({ status: 'running', startedAt: 0, tokens: 18_000, tools: 9, detail: 'Read' }, 72_000), '1:12 · 18 k · 9 outils · Read');
  assert.equal(taskLine({ status: 'done', startedAt: 0 }, 1), 'terminé');
});
