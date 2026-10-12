// chat/model.js and the pure helpers of the transcript (ux §5): tool kinds, grouping per view mode, the opening user
// message shown once, group summary, 150-turn mount window, stick-to-bottom, footer (with the aux line), prompts for
// rewind / history, state labels, Markdown export, tool one-liners, denial rows, system rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { web } from './_load.ts';

const M = await web('components/chat/model.js');
const R = await web('components/chat/ToolRenderers.js');
const { systemText, detailedOnly } = await web('components/chat/SystemRow.js');

const tool = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ k: 'tool', id: 't:' + id, toolUseId: id, name, input: { summary: name, fields: {} }, status: 'ok', ...extra });
const text = (id: string, md: string) => ({ k: 'text', id, md });
const user = (uuid: string, t = 'q') => ({ k: 'user', id: 'u:' + uuid, msg: { uuid, text: t, origin: 'human' } });

test('tool kinds', () => {
  assert.deepEqual(['Read', 'Grep', 'Bash', 'PowerShell', 'Edit', 'Write', 'WebFetch', 'Agent', 'TodoWrite', 'AskUserQuestion', 'ToolSearch', 'mcp__slack__post', 'Zzz'].map(M.toolKind),
    ['read', 'search', 'command', 'command', 'edit', 'edit', 'web', 'agent', 'todo', 'ask', 'meta', 'mcp', 'other']);
  assert.deepEqual(M.mcpParts('mcp__claude_ai_Docs__read'), { server: 'claude_ai_Docs', tool: 'read' });
});

test('Normal groups ≥ 2 contiguous tools (asks, subagent tools and ToolSearch excluded); Détaillé shows all; Focus folds', () => {
  const blocks = [tool('1', 'Read'), tool('2', 'Grep'), text('a:1', 'x'), tool('3', 'Bash'), tool('4', 'Read', { parentToolUseId: '9' }),
    tool('5', 'ToolSearch'), tool('6', 'AskUserQuestion'), text('a:2', 'fin')];
  const n = M.layoutBlocks(blocks, 'normal');
  assert.deepEqual(n.map((i: any) => i.kind === 'group' ? `g${i.tools.length}` : i.block.id), ['g2', 'a:1', 't:3', 't:6', 'a:2']);
  assert.equal(M.layoutBlocks(blocks, 'detailed').length, blocks.length);
  const f = M.layoutBlocks([user('b'), ...blocks], 'focus');
  assert.deepEqual(f.map((i: any) => i.kind === 'folded' ? `+${i.count}` : i.block.id), ['u:b', '+7', 'a:2']);
  // the opening user message is the turn head: never rendered twice
  assert.deepEqual(M.layoutBlocks([user('h'), text('a:3', 'r'), user('f')], 'normal', 'h').map((i: any) => i.block.id), ['a:3', 'u:f']);
});

test('group summary and open rule', () => {
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }];
  const tools = [tool('1', 'Read'), tool('2', 'Read'), tool('3', 'Bash'), tool('4', 'Edit', { result: { isError: false, summary: '', patch } })];
  assert.match(M.groupSummary(tools), /2 lectures, 1 commande, 1 modification \(\+2 −1\)/);
  assert.equal(M.groupMustOpen(tools), false);
  assert.equal(M.groupMustOpen([...tools, tool('5', 'Bash', { status: 'running' })]), true);
  assert.equal(M.groupMustOpen([tool('6', 'Bash', { status: 'error' })]), true);
});

test('mount window keeps at most 150 turns, anchored when the user scrolled up; stick within 48 px', () => {
  assert.deepEqual(M.mountWindow(100, 150, null), { start: 0, end: 100 });
  assert.deepEqual(M.mountWindow(400, 150, null), { start: 250, end: 400 });
  assert.deepEqual(M.mountWindow(400, 150, 10), { start: 0, end: 150 });
  assert.deepEqual(M.mountWindow(400, 150, 200), { start: 150, end: 300 });
  assert.equal(M.nearBottom({ scrollTop: 452, scrollHeight: 1000, clientHeight: 500 }, 48), true);
  assert.equal(M.nearBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 500 }, 48), false);
});

test('turn footer: duration · input (cache %) · output · cost, plus the aux line only when > 0 (SPEC §9.2 item 10)', () => {
  const f = { durationMs: 72_000, input: 2, cacheRead: 37_152, cacheWrite: 81, output: 1200, costUsd: 0.05, models: [] };
  assert.equal(M.footerText(f), '1 min 12 s · 37 k entrée (100 % cache) · 1,2 k sortie · ≈ 0,05 $');
  assert.match(M.footerText({ ...f, auxTokens: 3400 }), / · dont ≈ 3,4 k tokens hors boucle principale/);
  assert.doesNotMatch(M.footerText({ ...f, auxTokens: 0 }), /dont/);
});

test('user prompts newest first (rewind points, ↑ history), human only', () => {
  const turns = [{ id: 'u:1', at: 1, user: { uuid: '1', text: 'un', origin: 'human' }, blocks: [user('2', 'deux')] },
    { id: 'u:3', at: 3, user: { uuid: '3', text: 'trois', origin: 'task' }, blocks: [] },
    { id: 'u:4', at: 4, user: { uuid: '4', text: 'quatre', origin: 'human' }, blocks: [] }];
  assert.deepEqual(M.userPrompts(turns).map((p: any) => p.text), ['quatre', 'un', 'deux']);
});

test('state labels on the header (glyph + text, never colour alone)', () => {
  const s = (phase: string, extra: Record<string, unknown> = {}) => ({ phase, since: 0, flags: { live: true, unread: false, bgTasks: 0, queued: 0,
    external: null, stuck: false, notStarted: false }, pending: { count: 0 }, ...extra });
  assert.deepEqual(M.stateView(s('cold'), 0), { glyph: '○', label: 'En veille', tone: 'cold' });
  assert.equal(M.stateView(s('running', { sub: 'thinking' }), 0).label, 'Réflexion…');
  assert.equal(M.stateView(s('running', { sub: 'tool', subTool: 'Bash' }), 12_000).label, 'Exécute Bash… (12 s)');
  assert.equal(M.stateView(s('needs_plan'), 0).glyph, '≡');
  assert.equal(M.stateView({ ...s('idle'), flags: { ...s('idle').flags, external: { pid: 1, kind: 'cli', entrypoint: 'cli', status: 'waiting' } } }, 0).label, 'Terminal · attend une réponse');
});

test('tool one-liners, denials and system rows come from the French table', () => {
  assert.equal(R.toolSummary(tool('1', 'Bash', { input: { summary: '', fields: { command: 'npm ci', description: 'Installer' } } })), 'A exécuté : Installer');
  assert.equal(R.toolSummary(tool('2', 'Read', { input: { summary: '', fields: { file_path: 'C:\\p\\src\\a.ts', offset: 1, limit: 120 } } })), 'A lu a.ts (L1–120)');
  assert.equal(R.toolSummary(tool('3', 'mcp__slack__post')), 'slack › post');
  // M2: the CLI's own English tool_result text never shows (answers from result.data, plan state from the status)
  const en = 'User has answered your questions: "Couleur ?"="Bleu". You can now continue';
  assert.equal(R.toolSummary(tool('6', 'AskUserQuestion', { input: { summary: 'Couleur ?', fields: {} },
    result: { isError: false, summary: en, data: { q0: 'Couleur ?', a0: 'Bleu', q1: 'Taille ?', a1: 'M', answered: 2 } } })), 'Réponses · Bleu · M');
  assert.equal(R.toolSummary(tool('7', 'AskUserQuestion', { input: { summary: 'Couleur ?', fields: {} }, status: 'denied',
    result: { isError: true, summary: 'x', denial: 'user' } })), 'Couleur ?');
  assert.equal(R.toolSummary(tool('8', 'ExitPlanMode', { result: { isError: false, summary: 'User has approved your plan. You can now start coding.' } })), 'Plan approuvé');
  assert.equal(R.toolSummary(tool('9', 'ExitPlanMode', { status: 'denied', result: { isError: true, summary: 'Ajoute des tests', denial: 'user' } })), 'Plan proposé · Ajoute des tests');
  assert.equal(R.toolSummary(tool('10', 'ExitPlanMode', { status: 'asking' })), 'Plan proposé');
  assert.equal(R.denialText(tool('4', 'Bash', { result: { isError: true, summary: '', denial: 'user' } })), 'Refusé par vous');
  assert.equal(R.denialText(tool('5', 'Bash', { result: { isError: true, summary: '', denial: 'withdrawn' } })), 'Demande annulée');
  assert.equal(systemText({ kind: 'cleared' }), 'Conversation effacée — nouvelle session');
  assert.match(systemText({ kind: 'compact', data: { trigger: 'auto', preTokens: 182_000, postTokens: 24_000, durationMs: 41_000 } }), /^Conversation compactée \(auto\) · 182 k → 24 k tokens · 41 s$/);
  assert.equal(detailedOnly({ kind: 'hook' }), true);
  assert.equal(detailedOnly({ kind: 'crash' }), false);
});

test('Markdown export: headings per speaker, tool one-liners, folded messages quoted', () => {
  const turns = [{ id: 'u:1', at: 1, user: { uuid: '1', text: 'Salut', origin: 'human' }, blocks: [tool('1', 'Read'), text('a:1', 'Bonjour'), user('2', 'précision')] }];
  const md = M.exportMarkdown(turns, 'Titre', () => 'A lu x');
  assert.equal(md, '# Titre\n\n## Vous\n\nSalut\n\n## Claude\n\n- A lu x\n\nBonjour\n\n> précision\n');
});

test('a refused or withdrawn command never reads « A exécuté »; a tool without result shows its status', () => {
  const bash = (status: string, result?: unknown) => tool('b', 'Bash', { status, input: { summary: '', fields: { command: 'rm -rf build', description: 'Supprimer build' } }, ...(result ? { result } : {}) });
  assert.equal(R.toolSummary(bash('denied', { isError: true, summary: '', denial: 'user' })), 'Commande non exécutée : Supprimer build');
  assert.equal(R.toolSummary(bash('withdrawn')), 'Commande non exécutée : Supprimer build');
  assert.equal(R.toolSummary(bash('ok', { isError: false, summary: '' })), 'A exécuté : Supprimer build');
  assert.equal(R.denialText(bash('interrupted')), 'Interrompu');
  assert.equal(R.denialText(bash('withdrawn')), 'Demande annulée');
  assert.equal(R.denialText(bash('ok', { isError: false, summary: '' })), null);
});
