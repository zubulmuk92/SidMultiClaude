// test/unit/model/reducer-system.test.ts — SPEC §5.5 frame table: system frames, tasks, todos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveReducerX } from '../../../src/server/model/live-reducer.ts';
import type { SdkFrame } from '../../../src/server/contracts.ts';
import type * as P from '../../../src/shared/protocol.ts';
import * as B from './build.ts';

const mk = () => createLiveReducerX({ chatId: B.CHAT, meta: { title: '', cwd: '', mode: 'default' }, metrics: {} });
const sys = (subtype: string, o: Record<string, unknown> = {}): SdkFrame => ({ type: 'system', subtype, uuid: `x-${subtype}`, session_id: B.SID, ...o }) as SdkFrame;
const rows = (ev: P.ChatEvent[]): P.UiSystemRow[] => ev.flatMap((e) => (e.k === 'system' ? [e.row] : []));

test('system:init → meta; with no open turn, later rows go to a system turn x:<init uuid>', () => {
  const r = mk();
  const out = r.step(B.init('i1', { slash_commands: ['clear', 'review'], mcp_servers: [{ name: 'slack', status: 'connected' }], claude_code_version: '2.1.294', capabilities: ['interrupt'] }), 1);
  const meta = out.events.find((e) => e.k === 'meta');
  assert.ok(meta?.k === 'meta' && meta.meta.model === 'claude-opus-5-5' && meta.meta.tools === 1 && meta.meta.cliVersion === '2.1.294');
  assert.deepEqual(r.meta().mcp, [{ name: 'slack', status: 'connected' }]);
  assert.deepEqual(r.meta().commands?.map((c) => c.name), ['clear', 'review']);
  const ev = r.step(sys('local_command_output', { content: 'Total cost: $0' }), 2).events;
  assert.equal(ev[0]?.k, 'turn.start');
  assert.ok(ev[0]?.k === 'turn.start' && ev[0].turn.id === 'x:i1' && ev[0].turn.user === null);
  assert.deepEqual(rows(ev), [{ kind: 'local', text: 'Total cost: $0' }]);
});

test('system:status → sub signals; a mode change → meta.mode + modeChange row (not kept in the turn)', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  assert.equal(r.step(B.status('requesting'), 1).signals.sub, 'requesting');
  assert.equal(r.step(B.status('compacting'), 2).signals.sub, 'compacting');
  const out = r.step(B.status(null, { permissionMode: 'acceptEdits' }), 3);
  assert.equal(r.meta().mode, 'acceptEdits');
  assert.deepEqual(rows(out.events), [{ kind: 'modeChange', data: { from: 'default', to: 'acceptEdits' } }]);
  assert.equal(r.liveTurn()!.blocks.length, 0);
  assert.equal(r.step(B.status(null, { permissionMode: 'acceptEdits' }), 4).events.length, 0);
});

test('compact_boundary, api_retry, rate_limit_event', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  const c = r.step(sys('compact_boundary', { compact_metadata: { trigger: 'manual', pre_tokens: 182_000, post_tokens: 24_000, duration_ms: 41_000 } }), 1);
  assert.deepEqual(rows(c.events), [{ kind: 'compact', data: { trigger: 'manual', preTokens: 182_000, postTokens: 24_000, durationMs: 41_000 } }]);
  const a = r.step(sys('api_retry', { attempt: 2, max_retries: 10, retry_delay_ms: 8000, error_status: 529 }), 2);
  assert.deepEqual(a.signals.retry, { attempt: 2, max: 10, inMs: 8000, status: 529 });
  assert.equal(a.signals.sub, 'retry');
  assert.equal(rows(a.events)[0]?.kind, 'retry');
  const rl = r.step({ type: 'rate_limit_event', session_id: B.SID, rate_limit_info: { status: 'rejected', resetsAt: 1_760_000_000, rateLimitType: 'five_hour' } } as SdkFrame, 3);
  assert.deepEqual({ ...rl.signals.rateLimit, info: undefined }, { status: 'rejected', resetsAt: 1_760_000_000_000, kind: 'five_hour', info: undefined });
  assert.equal(r.step({ type: 'rate_limit_event', rate_limit_info: { status: 'weird' } } as SdkFrame, 4).signals.rateLimit, undefined);
});

test('tasks: task_* and background_tasks_changed (replace, ambient ignored)', () => {
  const r = mk();
  r.step(sys('task_started', { task_id: 'a1', task_type: 'local_agent', description: 'Explore', tool_use_id: 'tu1', spawn_depth: 1 }), 1);
  r.step(sys('task_progress', { task_id: 'a1', last_tool_name: 'Read', usage: { total_tokens: 1800, tool_uses: 9 } }), 2);
  let t = r.tasks()[0]!;
  assert.deepEqual([t.kind, t.title, t.status, t.detail, t.tokens, t.tools, t.depth, t.toolUseId], ['agent', 'Explore', 'running', 'Read', 1800, 9, 1, 'tu1']);
  const n = r.step(sys('task_notification', { task_id: 'a1', status: 'completed', summary: 'fini' }), 3);
  assert.ok(n.events.some((e) => e.k === 'tasks'));
  t = r.tasks()[0]!;
  assert.equal(t.status, 'done');
  r.step(sys('background_tasks_changed', { tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }, { task_id: 'amb', ambient: true }] }), 4);
  assert.deepEqual(r.tasks().map((x) => [x.id, x.kind, x.background, x.status]), [['a1', 'agent', false, 'done'], ['b1', 'bash', true, 'running']]);
  r.step(sys('background_tasks_changed', { tasks: [] }), 5);
  assert.equal(r.tasks().find((x) => x.id === 'b1')?.status, 'done');
});

test('tool_progress elapsed ≤ 1/s; thinking_tokens → progress tokens', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  r.step(B.msgStart('m1'), 0);
  r.step(B.blockStart(0, { type: 'thinking', thinking: '' }), 0);
  const tk = r.step(sys('thinking_tokens', { estimated_tokens: 1200 }), 1);
  assert.deepEqual(tk.events, [{ k: 'progress', blockId: 'a:m1:0', tokens: 1200 }]);
  r.step(B.assistant('m1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep' } }), 1);
  const tp = (s: number, at: number) => r.step({ type: 'tool_progress', tool_use_id: 'tu1', tool_name: 'Bash', elapsed_time_seconds: s, parent_tool_use_id: null } as SdkFrame, at);
  assert.deepEqual(tp(1, 1000).events, [{ k: 'progress', blockId: 't:tu1', elapsedMs: 1000 }]);
  assert.equal(tp(1.5, 1500).events.length, 0);
  assert.equal(tp(2, 2000).events.length, 1);
  assert.equal(tp(2, 2000).signals.subTool, 'Bash');
});

test('title, conversation_reset, hooks, refusal, permission_denied, informational, notification', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  r.step(sys('session_title_changed', { title: 'Mon titre' }), 1);
  assert.equal(r.meta().title, 'Mon titre');
  assert.equal(rows(r.step(sys('hook_response', { hook_name: 'SessionStart', hook_event: 'SessionStart', outcome: 'success' }), 2).events)[0]?.kind, 'hook');
  assert.equal(rows(r.step(sys('model_refusal_fallback', { original_model: 'a', fallback_model: 'b' }), 2).events)[0]?.kind, 'refusal');
  assert.deepEqual(rows(r.step(sys('permission_denied', { tool_name: 'Bash', decision_reason: 'règle', decision_reason_type: 'rule' }), 2).events)[0]?.data, { tool: 'Bash', reason: 'rule', denied: true });
  assert.deepEqual(rows(r.step(sys('informational', { content: 'note', level: 'warning' }), 2).events)[0], { kind: 'notice', text: 'note', data: { level: 'warning' } });
  assert.deepEqual(rows(r.step(sys('notification', { text: 'hé', priority: 'high', key: 'k' }), 2).events)[0], { kind: 'notice', text: 'hé', data: { priority: 'high', key: 'k' } });
  const reset = r.step(sys('conversation_reset', { new_conversation_id: 'new-sid' }), 3);
  assert.deepEqual(reset.events, [{ k: 'reset', reason: 'clear' }]);
  assert.equal(r.sessionId(), 'new-sid');
  assert.equal(r.liveTurn(), null);
});

test('todos: TodoWrite / TaskCreate / TaskUpdate → todos (replace)', () => {
  const r = mk();
  r.userStarted({ uuid: 'u1', text: 'x', images: 0, folded: false, at: 0 });
  const ev = r.step(B.assistant('m1', { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress', activeForm: 'Fait B' }] } }), 1).events;
  assert.deepEqual(ev.find((e) => e.k === 'todos'), { k: 'todos', todos: [{ text: 'A', status: 'completed' }, { text: 'B', status: 'in_progress', activeForm: 'Fait B' }] });
  r.step(B.assistant('m1', { type: 'tool_use', id: 't2', name: 'TaskCreate', input: { subject: 'C' } }), 2);
  r.step(B.assistant('m1', { type: 'tool_use', id: 't3', name: 'TaskUpdate', input: { taskId: '3', status: 'in_progress', addBlockedBy: ['1'] } }), 3);
  r.step(B.assistant('m1', { type: 'tool_use', id: 't4', name: 'TaskUpdate', input: { taskId: '1', status: 'deleted' } }), 4);
  assert.deepEqual(r.todos(), [{ text: 'B', status: 'in_progress', activeForm: 'Fait B' }, { text: 'C', status: 'blocked' }]);
});
