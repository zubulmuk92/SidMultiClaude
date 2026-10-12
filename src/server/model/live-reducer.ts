// src/server/model/live-reducer.ts — SDK frames → ChatEvent[] + live turn + meta/metrics/tasks/todos + heavy stash (SPEC §5.5, model).
// Pure state machine: `at` comes from the caller, no timers, no I/O. Unknown frames are ignored; step() never throws.
// Block ids and contents match diskToTurns() exactly ("live = reload"). Rows that the transcript never records
// (modeChange, hook, notice, rateLimit, cacheMiss, crash: app rows) are emitted as `system` events but are NOT kept in
// liveTurn(), so a reload shows the same blocks.
import type { CreateLiveReducer, FrameSignals, LiveReducer, ReduceOut, SdkFrame } from '../contracts.ts';
import type * as P from '../../shared/protocol.ts';
import { CACHE_TTL_1H_MS, HEAVY_STASH_MAX_BYTES, PROGRESS_MIN_INTERVAL_MS, TOOL_OUTPUT_HEAD_BYTES } from '../../shared/limits.ts';
import { SYNTHETIC, arr, blockId, contentText, cut, imageRefId, isInterruptText, localCommandText, localRow, num, optStr, rec, str, userOrigin } from './blocks.ts';
import type { Rec } from './blocks.ts';
import { inputIsHeavy, liteToolResult, toolInputView } from './tools-lite.ts';
import type { HeavyPiece } from './tools-lite.ts';
import {
  auxTokens, autoCompactAt, cacheMissCause, cacheWarmUntil, contextOf, costDelta, isCacheMiss, modelUsageTotal, modelsUsed,
  ttlFromUsage, usageTokens,
} from './accounting.ts';
import type { CostBaseline } from './accounting.ts';
import { slashCommandViews } from './derive.ts';
import { todosFromTool } from './todos.ts';

/** Seed of a live reducer. `baseline` = the last cost-state of the transcript (resume / fork); `resumed` = not a new session. */
export type LiveSeed = { chatId: P.ChatId; meta: P.ChatMetaView; metrics: P.ChatMetrics; baseline?: CostBaseline | null; resumed?: boolean };
/** The reducer plus read-only extras used by the server shell and the tests. */
export type LiveReducerX = LiveReducer & {
  deliveries(): Record<P.Uuid, P.Delivery>;   // command_lifecycle state per uuid; `folded` from result.user_message_uuids
  sessionId(): P.SessionId;                   // latest session_id seen in frames (fork / clear re-key)
  faults(): number;                           // frames whose processing threw (swallowed: step() never throws); 0 expected
};

const PERSISTED_ROWS: ReadonlySet<P.UiSystemRow['kind']> = new Set(['interrupted', 'compact', 'retry', 'error', 'refusal', 'local', 'cleared']);
const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required']);
/** Result texts of a plan limit (CLI USAGE_LIMIT_ERROR_PREFIXES; matched case-insensitively on the start). */
export const USAGE_LIMIT_PREFIXES: readonly string[] = ['claude ai usage limit reached', "you've hit your", 'you have hit your', 'usage limit reached'];

type MsgState = { id: string; model: string; starts: number[]; done: number };

export const createLiveReducer: CreateLiveReducer = (seedIn) => createLiveReducerX(seedIn);

export function createLiveReducerX(seed: LiveSeed): LiveReducerX {
  const meta: P.ChatMetaView = { ...seed.meta };
  const metrics: P.ChatMetrics = { ...seed.metrics };
  let session: P.SessionId = seed.chatId.slice(seed.chatId.indexOf(':') + 1);
  const tasks = new Map<string, P.TaskView>();
  let todos: P.TodoItem[] | null = null;
  const deliveries = new Map<P.Uuid, P.Delivery>();

  let turn: P.UiTurn | null = null;
  let ended = true;                                  // the current turn got its result (a new block opens a system turn)
  const index = new Map<string, number>();           // block id → position in turn.blocks
  let sysTurnId: string | null = null;               // `x:<uuid>` of the last system:init, for a turn with no user message
  const msgs = new Map<string, MsgState>();          // message.id → stream index order (current turn only)
  let cur: MsgState | null = null;                   // message of the latest message_start
  const streamIds = new Map<number, string>();       // content block index → block id (current message)
  let lastThinking: string | null = null;
  const thinkingBuf = new Map<string, string>();     // live thinking text (moved to the stash at the assistant frame)
  const lastProgress = new Map<string, number>();

  // accounting
  const baseline = seed.baseline ?? null;
  // cost / modelUsage baselines: 0 for a brand-new session, unknown (undefined) for a resumed process without its cost-state
  let lastCost: number | undefined = baseline?.costUsd ?? seed.metrics.costUsd ?? (seed.resumed ? undefined : 0);
  let lastMu: Record<string, unknown> | undefined = baseline?.modelUsage;
  let lastMuTotal: number | undefined = baseline?.tokens ?? (seed.resumed || seed.metrics.costUsd !== undefined ? undefined : 0);
  let ttl = seed.metrics.cacheTtlMs ?? CACHE_TTL_1H_MS;
  let turnsInProcess = 0;
  let lastTurnModel: string | undefined;
  let tf = { compacted: false, images: false, firstRequestAt: undefined as number | undefined, prevRequestAt: undefined as number | undefined, models: [] as string[] };
  let appRows = 0;
  let faults = 0;

  // heavy stash (LRU by key, ≤ 8 MB per chat)
  const stash = new Map<string, { p: P.DetailPayload; bytes: number }>();
  let stashBytes = 0;
  const stashPut = (id: string, field: P.DetailField, p: P.DetailPayload, bytes: number): void => {
    const key = `${id}|${field}`;
    const old = stash.get(key);
    if (old) { stashBytes -= old.bytes; stash.delete(key); }
    if (bytes > HEAVY_STASH_MAX_BYTES) return;
    stash.set(key, { p, bytes });
    stashBytes += bytes;
    for (const [k, v] of stash) {
      if (stashBytes <= HEAVY_STASH_MAX_BYTES) break;
      stash.delete(k); stashBytes -= v.bytes;
    }
  };
  const stashAll = (pieces: readonly HeavyPiece[]): void => { for (const h of pieces) stashPut(h.id, h.field, h.payload, h.bytes); };

  // ------------------------------------------------------------ turn helpers
  const freshTf = (): typeof tf => ({ compacted: false, images: false, firstRequestAt: undefined, prevRequestAt: metrics.lastRequestAt, models: [] });
  /** Events carry copies: the reducer keeps mutating its own blocks (deltas, progress) and the hub serializes later. */
  const headCopy = (h: P.UiTurnHead): P.UiTurnHead => ({ id: h.id, at: h.at, user: h.user ? { ...h.user } : null });
  /** `implicit` = opened by a frame (CLI-initiated turn): the message being streamed must survive the reset. */
  const newTurn = (head: P.UiTurnHead, ev: P.ChatEvent[], implicit = false): void => {
    turn = { ...headCopy(head), blocks: [] };
    ended = false;
    index.clear(); lastProgress.clear();
    if (!implicit) {
      msgs.clear(); streamIds.clear(); thinkingBuf.clear();
      cur = null; lastThinking = null;
      tf = freshTf();
    }
    ev.push({ k: 'turn.start', turn: headCopy(head) });
  };
  /** The open turn, or a new system turn (`x:<init uuid>` / `x:<frame uuid>`) when none is open. */
  const openTurn = (ev: P.ChatEvent[], fallbackId: string, at: number): P.UiTurn => {
    if (!turn || ended) { newTurn({ id: sysTurnId ?? fallbackId, at, user: null }, ev, true); sysTurnId = null; }
    return turn as unknown as P.UiTurn;
  };
  const findBlock = (id: string): P.UiBlock | undefined => {
    const i = index.get(id);
    return i === undefined || !turn ? undefined : turn.blocks[i];
  };
  const upsert = (t: P.UiTurn, b: P.UiBlock, ev: P.ChatEvent[] | null): void => {
    const i = index.get(b.id);
    if (i === undefined) { index.set(b.id, t.blocks.length); t.blocks.push(b); } else t.blocks[i] = b;
    if (ev) ev.push({ k: 'block', turnId: t.id, block: { ...b } });
  };
  const row = (ev: P.ChatEvent[], id: string, r: P.UiSystemRow, at: number): void => {
    if (PERSISTED_ROWS.has(r.kind)) {
      const t = openTurn(ev, id, at);
      upsert(t, { k: 'system', id, row: r }, null);
      ev.push({ k: 'system', turnId: t.id, id, row: r });
    } else ev.push(turn ? { k: 'system', turnId: turn.id, id, row: r } : { k: 'system', id, row: r });
  };
  const progressOk = (id: string, at: number): boolean => {
    const last = lastProgress.get(id);
    if (last !== undefined && at - last < PROGRESS_MIN_INTERVAL_MS) return false;
    lastProgress.set(id, at);
    return true;
  };

  // ------------------------------------------------------------ stream events (partial messages, main thread only)
  const onStream = (e: Rec, at: number, ev: P.ChatEvent[], sig: FrameSignals): void => {
    const type = str(e['type']);
    if (type === 'message_start') {
      const m = rec(e['message']);
      const id = str(m['id']);
      cur = { id, model: str(m['model']), starts: [], done: 0 };
      msgs.set(id, cur);
      streamIds.clear();
      if (m['usage'] !== undefined) { metrics.contextTokens = contextOf(m['usage']); ev.push({ k: 'metrics', metrics: { ...metrics } }); }
      return;
    }
    if (!cur) return;
    const idx = num(e['index']);
    if (type === 'content_block_start' && idx !== undefined) {
      const cb = rec(e['content_block']);
      const cbt = str(cb['type']);
      const t = openTurn(ev, `x:${cur.id}`, at);
      cur.starts.push(idx);
      let b: P.UiBlock | null = null;
      if (cbt === 'text') { b = { k: 'text', id: blockId('text', cur.id, idx), md: '', live: true }; sig.sub = 'writing'; }
      else if (cbt === 'thinking' || cbt === 'redacted_thinking') {
        b = { k: 'thinking', id: blockId('thinking', cur.id, idx), chars: 0, live: true, ...(cbt === 'redacted_thinking' ? { redacted: true } : {}) };
        lastThinking = b.id; sig.sub = 'thinking';
      } else if (cbt === 'tool_use' || cbt === 'server_tool_use' || cbt === 'mcp_tool_use') {
        const toolUseId = str(cb['id']);
        const name = str(cb['name']);
        b = { k: 'tool', id: blockId('tool', toolUseId), toolUseId, name, input: toolInputView(name, {}), status: 'running' };
        sig.sub = 'tool'; sig.subTool = name;
      }
      if (!b) return;
      if (cur.model && b.k !== 'thinking') b.model = cur.model;
      streamIds.set(idx, b.id);
      if (!index.has(b.id)) upsert(t, b, ev);
      return;
    }
    if (type === 'content_block_delta' && idx !== undefined) {
      const id = streamIds.get(idx);
      if (!id) return;
      const d = rec(e['delta']);
      const dt = d['type'];
      if (dt === 'text_delta') {
        const text = str(d['text']);
        const b = findBlock(id);
        if (!text || !b || b.k !== 'text' || !b.live) return;
        b.md += text;
        ev.push({ k: 'delta', parts: [[id, text]] });
      } else if (dt === 'thinking_delta') {
        const text = str(d['thinking']);
        const b = findBlock(id);
        if (!b || b.k !== 'thinking' || !b.live) return;
        b.chars += text.length;
        if (text) thinkingBuf.set(id, (thinkingBuf.get(id) ?? '') + text);
        if (progressOk(id, at)) ev.push({ k: 'progress', blockId: id, chars: b.chars });
      }
    }
  };

  // ------------------------------------------------------------ assistant frames (one completed content block each)
  const onAssistant = (f: Rec, at: number, ev: P.ChatEvent[], sig: FrameSignals): void => {
    const m = rec(f['message']);
    const mid = str(m['id']);
    const model = str(m['model']);
    const err = optStr(f['error']);
    if (err === 'rate_limit') sig.rateLimit = { status: 'rejected', info: {} };
    else if (err && AUTH_ERRORS.has(err)) sig.authError = true;
    else if (err === 'billing_error') sig.billingError = true;
    else if (err === 'model_not_found') sig.modelNotFound = true;
    else if (err === 'overloaded' || err === 'server_error') sig.overloaded = true;
    // Same rule as disk-turns.ts: an error row for CLI-made error messages; a real model message keeps its content.
    if (f['isApiErrorMessage'] === true || (err && (model === SYNTHETIC || !model))) {
      row(ev, blockId('system', str(f['uuid']) || mid), { kind: 'error', text: contentText(m['content']), ...(err ? { data: { error: err } } : {}) }, at);
      return;
    }
    if (model === SYNTHETIC) {   // local command answered by the CLI itself (/usage: usage_report), no model call
      row(ev, blockId('system', str(f['uuid']) || mid), localRow(m['content'], f['usage_report'] ?? m['usage_report']), at);
      return;
    }
    let ms = msgs.get(mid);
    if (!ms) { ms = { id: mid, model, starts: [], done: 0 }; msgs.set(mid, ms); }
    if (model && model !== '<synthetic>' && !tf.models.includes(model)) tf.models.push(model);
    for (const c of arr(m['content'])) {
      const cb = rec(c);
      const idx = ms.starts[ms.done] ?? ms.done;
      ms.done++;
      const t = openTurn(ev, `x:${mid}`, at);
      const type = str(cb['type']);
      let b: P.UiBlock | null = null;
      if (type === 'text') {
        b = { k: 'text', id: blockId('text', mid, idx), md: str(cb['text']) };
        if (f['aborted'] === true) b.aborted = true;     // the partial frame of an interrupted stream (SDK interrupt)
      }
      else if (type === 'thinking' || type === 'redacted_thinking') {
        const id = blockId('thinking', mid, idx);
        const prev = findBlock(id);
        const text = str(cb['thinking']) || thinkingBuf.get(id) || '';
        const tb: P.UiBlock = { k: 'thinking', id, chars: text.length };
        if (prev?.k === 'thinking' && prev.tokens !== undefined) tb.tokens = prev.tokens;
        if (type === 'redacted_thinking') tb.redacted = true;
        if (text) stashPut(id, 'thinking', { text }, text.length);
        thinkingBuf.delete(id);
        b = tb;
      } else if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') {
        const toolUseId = str(cb['id']);
        const name = str(cb['name']);
        const input = rec(cb['input']);
        const id = blockId('tool', toolUseId);
        const prev = findBlock(id);
        const view = toolInputView(name, input);
        if (inputIsHeavy(view)) { const j = JSON.stringify(input); stashPut(id, 'input', { text: j }, j.length); }
        const tb: P.UiBlock = { k: 'tool', id, toolUseId, name, input: view, status: 'running' };
        if (prev?.k === 'tool') { tb.status = prev.status; if (prev.result) tb.result = prev.result; if (prev.elapsedMs !== undefined) tb.elapsedMs = prev.elapsedMs; }
        b = tb;
        const next = todosFromTool(name, input, todos);
        if (next) { todos = next; ev.push({ k: 'todos', todos: [...next] }); }
      }
      if (!b) continue;
      if (model && b.k !== 'thinking') b.model = model;
      upsert(t, b, ev);
    }
  };

  // ------------------------------------------------------------ user frames: tool results and the interrupt marker
  const onUser = (f: Rec, at: number, ev: P.ChatEvent[]): void => {
    const m = rec(f['message']);
    const content = m['content'];
    const metaList = arr(f['tool_result_meta']).map(rec);
    let markerDone = false;
    for (const c of arr(content)) {
      const cb = rec(c);
      if (cb['type'] === 'tool_result') {
        const toolUseId = str(cb['tool_use_id']);
        const id = blockId('tool', toolUseId);
        const b = findBlock(id);
        if (!turn || !b || b.k !== 'tool') continue;
        const tm = metaList.find((x) => x['id'] === toolUseId) ?? {};
        const lite = liteToolResult(b.name, toolUseId, {
          content: cb['content'], isError: cb['is_error'] === true, toolUseResult: f['tool_use_result'],
          denialKind: tm['non_execution_kind'], decisionSource: rec(tm['permission_decision'])['source'],
        });
        stashAll(lite.heavy);
        const nb: P.UiBlock = { ...b, status: lite.status, result: lite.result };
        upsert(turn, nb, null);
        ev.push({ k: 'tool.result', turnId: turn.id, toolUseId, status: lite.status, result: lite.result });
      } else if (cb['type'] === 'text' && isInterruptText(str(cb['text'])) && !markerDone) {
        markerDone = true;
        row(ev, blockId('system', str(f['uuid'])), { kind: 'interrupted', text: str(cb['text']).trim() }, at);
      }
    }
    if (typeof content === 'string' && isInterruptText(content)) row(ev, blockId('system', str(f['uuid'])), { kind: 'interrupted', text: content.trim() }, at);
  };

  // ------------------------------------------------------------ tasks (drawer) — replace semantics on the wire
  const TASK_KIND: Record<string, P.TaskView['kind']> = { local_bash: 'bash', local_agent: 'agent', remote_agent: 'agent', workflow: 'workflow', local_workflow: 'workflow', monitor: 'monitor', local_monitor: 'monitor' };
  const taskKind = (t: string, subagent: string): P.TaskView['kind'] => TASK_KIND[t] ?? (subagent ? 'agent' : t.includes('bash') ? 'bash' : t.includes('agent') ? 'agent' : 'other');
  const onTask = (f: Rec, sub: string, at: number, ev: P.ChatEvent[]): void => {
    if (sub === 'background_tasks_changed') {
      const live = new Set<string>();
      for (const x of arr(f['tasks'])) {
        const r = rec(x);
        if (r['ambient'] === true) continue;
        const id = str(r['task_id']);
        live.add(id);
        const old = tasks.get(id);
        tasks.set(id, { ...(old ?? { id, startedAt: at, status: 'running' as const }), kind: taskKind(str(r['task_type']), str(r['subagent_type'])),
          title: str(r['description']) || old?.title || id, background: true, status: old?.status ?? 'running' });
      }
      for (const [id, t] of tasks) if (t.background && t.status === 'running' && !live.has(id)) tasks.set(id, { ...t, status: 'done' });
    } else {
      const id = str(f['task_id']);
      if (!id) return;
      const old = tasks.get(id);
      const t: P.TaskView = old ? { ...old } : { id, kind: taskKind(str(f['task_type']), str(f['subagent_type'])), title: str(f['description']) || id, status: 'running', startedAt: at, background: f['is_backgrounded'] === true };
      const tu = optStr(f['tool_use_id']); if (tu) t.toolUseId = tu;
      const usage = rec(f['usage']);
      if (num(usage['total_tokens']) !== undefined) t.tokens = num(usage['total_tokens']);
      if (num(usage['tool_uses']) !== undefined) t.tools = num(usage['tool_uses']);
      if (sub === 'task_started') { const d = num(f['spawn_depth']); if (d !== undefined) t.depth = d; }
      if (sub === 'task_progress') { const d = optStr(f['last_tool_name']) ?? optStr(f['summary']); if (d) t.detail = d; }
      if (sub === 'task_notification') {
        const st = str(f['status']);
        t.status = st === 'failed' ? 'failed' : st === 'stopped' ? 'stopped' : 'done';
        const s = optStr(f['summary']); if (s) t.detail = s;
      }
      if (sub === 'task_updated') {
        const p = rec(f['patch']);
        const st = str(p['status']);
        if (st === 'completed') t.status = 'done'; else if (st === 'failed') t.status = 'failed'; else if (st === 'killed') t.status = 'stopped'; else if (st === 'running') t.status = 'running';
        if (typeof p['is_backgrounded'] === 'boolean') t.background = p['is_backgrounded'];
        const d = optStr(p['description']); if (d) t.title = d;
        const er = optStr(p['error']); if (er) t.detail = er;
      }
      tasks.set(id, t);
    }
    while (tasks.size > 100) { const first = tasks.keys().next().value; if (first === undefined) break; tasks.delete(first); }
    ev.push({ k: 'tasks', tasks: [...tasks.values()] });
  };

  // ------------------------------------------------------------ system frames
  const metaEv = (ev: P.ChatEvent[], patch: Partial<P.ChatMetaView>): void => { Object.assign(meta, patch); ev.push({ k: 'meta', meta: patch }); };
  const onSystem = (f: Rec, at: number, ev: P.ChatEvent[], sig: FrameSignals): void => {
    const sub = str(f['subtype']);
    const uuid = str(f['uuid']);
    switch (sub) {
      case 'init': {
        const patch: Partial<P.ChatMetaView> = {};
        const model = optStr(f['model']); if (model) patch.model = model;
        const cwd = optStr(f['cwd']); if (cwd) patch.cwd = cwd;
        if (Array.isArray(f['tools'])) patch.tools = f['tools'].length;
        if (Array.isArray(f['mcp_servers'])) patch.mcp = f['mcp_servers'].map((x) => ({ name: str(rec(x)['name']), status: str(rec(x)['status']) }));
        const pm = optStr(f['permissionMode']); if (pm) patch.mode = pm as P.PermissionModeId;
        if (Array.isArray(f['slash_commands'])) patch.commands = slashCommandViews(f['slash_commands'], { skills: f['skills'], plugins: f['plugins'] });
        if (Array.isArray(f['capabilities'])) patch.capabilities = f['capabilities'].map(str);
        const v = optStr(f['claude_code_version']); if (v) patch.cliVersion = v;
        metaEv(ev, patch);
        if (uuid && (!turn || ended)) sysTurnId = blockId('system', uuid);
        return;
      }
      case 'status': {
        const st = f['status'];
        if (st === 'requesting') {
          sig.sub = 'requesting';
          if (tf.firstRequestAt === undefined) tf.firstRequestAt = at;
          metrics.lastRequestAt = at;
          const w = cacheWarmUntil(at, ttl); if (w !== undefined) metrics.cacheWarmUntil = w;
          ev.push({ k: 'metrics', metrics: { ...metrics } });
        } else if (st === 'compacting') sig.sub = 'compacting';
        const pm = optStr(f['permissionMode']);
        if (pm && pm !== meta.mode) {
          const from = meta.mode;
          metaEv(ev, { mode: pm as P.PermissionModeId });
          row(ev, blockId('system', uuid), { kind: 'modeChange', data: { from, to: pm } }, at);
        }
        if (f['compact_result'] === 'failed') row(ev, blockId('system', uuid), { kind: 'notice', text: str(f['compact_error']), data: { compactFailed: true } }, at);
        return;
      }
      case 'compact_boundary': {
        const cm = rec(f['compact_metadata']);
        const data: Record<string, string | number | boolean> = { trigger: str(cm['trigger']) || 'auto' };
        for (const [k, v] of [['preTokens', cm['pre_tokens']], ['postTokens', cm['post_tokens']], ['durationMs', cm['duration_ms']]] as const) { const n = num(v); if (n !== undefined) data[k] = n; }
        tf.compacted = true;
        row(ev, blockId('system', uuid), { kind: 'compact', data }, at);
        return;
      }
      case 'api_retry': {
        const retry = { attempt: num(f['attempt']) ?? 0, max: num(f['max_retries']) ?? 0, inMs: num(f['retry_delay_ms']) ?? 0, ...(num(f['error_status']) !== undefined ? { status: num(f['error_status']) as number } : {}) };
        sig.retry = retry;
        sig.sub = 'retry';
        row(ev, blockId('system', uuid), { kind: 'retry', data: { ...retry } }, at);
        return;
      }
      case 'session_title_changed': { const t = optStr(f['title']); if (t) metaEv(ev, { title: t }); return; }
      case 'conversation_reset': {
        const sid = optStr(f['new_conversation_id']) ?? optStr(f['session_id']);
        if (sid) session = sid;
        turn = null; ended = true; index.clear(); msgs.clear(); sysTurnId = null;
        ev.push({ k: 'reset', reason: 'clear' });
        return;
      }
      case 'thinking_tokens': {
        const id = lastThinking;
        const b = id ? findBlock(id) : undefined;
        const n = num(f['estimated_tokens']);
        if (!id || !b || b.k !== 'thinking' || n === undefined) return;
        b.tokens = n;
        if (progressOk(`${id}|tok`, at)) ev.push({ k: 'progress', blockId: id, tokens: n });
        return;
      }
      case 'task_started': case 'task_progress': case 'task_notification': case 'task_updated': case 'background_tasks_changed':
        onTask(f, sub, at, ev); return;
      case 'commands_changed': metaEv(ev, { commands: slashCommandViews(f['commands']) }); return;
      case 'hook_response':
        row(ev, blockId('system', uuid), { kind: 'hook', ...(optStr(f['stderr']) ? { text: cut(str(f['stderr']), TOOL_OUTPUT_HEAD_BYTES) } : {}), data: { name: str(f['hook_name']), event: str(f['hook_event']), outcome: str(f['outcome']) || String(f['exit_code'] ?? '') } }, at);
        return;
      case 'local_command_output': row(ev, blockId('system', uuid), { kind: 'local', text: localCommandText(str(f['content'])) }, at); return;
      case 'model_refusal_fallback': case 'model_refusal_no_fallback':
        row(ev, blockId('system', uuid), { kind: 'refusal', text: str(f['content']) || undefined, data: { from: str(f['original_model']), to: str(f['fallback_model']), fallback: sub === 'model_refusal_fallback' } }, at);
        return;
      case 'permission_denied':
        row(ev, blockId('system', uuid), { kind: 'notice', text: str(f['decision_reason']) || undefined, data: { tool: str(f['tool_name']), reason: str(f['decision_reason_type']), denied: true } }, at);
        return;
      case 'informational':
        row(ev, blockId('system', uuid), { kind: 'notice', text: str(f['content']), data: { level: str(f['level']) || 'info' } }, at);
        return;
      case 'notification':
        row(ev, blockId('system', uuid), { kind: 'notice', text: str(f['text']), data: { priority: str(f['priority']) || 'low', key: str(f['key']) } }, at);
        return;
      default: return;
    }
  };

  // ------------------------------------------------------------ result: footer, accounting, folded deliveries
  const setDelivery = (uuid: string, d: P.Delivery, ev: P.ChatEvent[] | null): void => {
    const prev = deliveries.get(uuid);
    if (prev === d || (prev === 'folded' && d !== 'cancelled')) return;   // folded is final (its lifecycle still says completed)
    deliveries.set(uuid, d);
    if (!turn) return;
    if (turn.user?.uuid === uuid) turn.user = { ...turn.user, delivery: d };   // copy: turn.start already carried the old object
    const b = findBlock(blockId('user', uuid));
    if (b?.k === 'user') { const nb: P.UiBlock = { ...b, msg: { ...b.msg, delivery: d } }; upsert(turn, nb, ev); }
  };
  const onResult = (f: Rec, at: number, ev: P.ChatEvent[], sig: FrameSignals): void => {
    const first = str(f['user_message_uuid']);
    for (const u of arr(f['user_message_uuids']).map(str)) if (u && u !== first) setDelivery(u, 'folded', ev);
    const usage = usageTokens(f['usage']);
    const mu = rec(f['modelUsage']);
    const muTotal = modelUsageTotal(mu);
    const total = num(f['total_cost_usd']);
    const terminal = str(f['terminal_reason']);
    const footer: P.TurnFooter = { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output,
      models: Object.keys(mu).length && lastMuTotal !== undefined ? modelsUsed(lastMu ?? {}, mu) : [...tf.models] };
    if (!footer.models.length) footer.models = [...tf.models];
    const dur = num(f['duration_ms']); if (dur !== undefined) footer.durationMs = dur;
    const cost = lastCost === undefined ? undefined : costDelta(lastCost, total); if (cost !== undefined) footer.costUsd = cost;
    const aux = Object.keys(mu).length ? auxTokens(lastMuTotal, muTotal, usage) : undefined; if (aux !== undefined) footer.auxTokens = aux;
    if (terminal.startsWith('aborted') || (f['subtype'] === 'error_during_execution' && terminal !== 'completed')) footer.interrupted = true;
    if (terminal) footer.terminal = terminal;
    if (total !== undefined) { lastCost = total; metrics.costUsd = total; }
    if (Object.keys(mu).length) { lastMu = mu; lastMuTotal = muTotal; }
    // context window of the model that answered last; TTL from this turn's cache writes
    const lastModel = tf.models[tf.models.length - 1] ?? meta.model;
    const win = num(rec(mu[lastModel ?? ''])['contextWindow']) ?? num(rec(Object.values(mu)[0])['contextWindow']);
    if (win !== undefined) { metrics.contextWindow = win; metrics.autoCompactAt = autoCompactAt(win); }
    ttl = ttlFromUsage(f['usage'], ttl);
    metrics.cacheTtlMs = ttl;
    const w = cacheWarmUntil(metrics.lastRequestAt, ttl); if (w !== undefined) metrics.cacheWarmUntil = w;
    metrics.lastTurn = footer;
    turnsInProcess++;
    // errors carried by the result
    const resultText = str(f['result']) || arr(f['errors']).map(str).join('\n');
    if (f['is_error'] === true) {
      const low = resultText.trim().toLowerCase();
      if (USAGE_LIMIT_PREFIXES.some((p) => low.startsWith(p))) sig.rateLimit = { status: 'rejected', info: {} };
      const status = num(f['api_error_status']);
      if (status === 401) sig.authError = true;
      else if (status === 402) sig.billingError = true;
    }
    sig.sub = null;
    sig.turnEnded = true;
    if (turn && !ended) {
      for (const b of turn.blocks) {
        if ((b.k === 'text' || b.k === 'thinking') && b.live) {
          const nb = { ...b };
          delete nb.live;
          if (nb.k === 'text' && footer.interrupted) nb.aborted = true;
          upsert(turn, nb, ev);
        }
      }
      turn.footer = footer;
      ended = true;
      ev.push({ k: 'turn.end', turnId: turn.id, footer });
    }
    ev.push({ k: 'metrics', metrics: { ...metrics } });
    // cache-miss row (not on the very first turn of a brand-new session: there is no cache to miss)
    const brandNew = !seed.resumed && seed.metrics.costUsd === undefined && !baseline && turnsInProcess === 1;
    if (isCacheMiss(usage) && !brandNew) {
      const idle = tf.firstRequestAt !== undefined && tf.prevRequestAt !== undefined ? tf.firstRequestAt - tf.prevRequestAt : undefined;
      const cause = cacheMissCause({ compacted: tf.compacted, modelChanged: lastTurnModel !== undefined && lastModel !== undefined && lastModel !== lastTurnModel,
        resumed: turnsInProcess === 1, ...(idle !== undefined ? { idleMs: idle } : {}), ttlMs: ttl, images: tf.images });
      row(ev, `x:app:${++appRows}`, { kind: 'cacheMiss', data: { tokens: usage.cacheWrite, cause } }, at);
    }
    if (lastModel) lastTurnModel = lastModel;
    tf = freshTf();   // local events of the next turn start now (a CLI-initiated turn opens only at its first block)
  };

  // ------------------------------------------------------------ dispatch
  const dispatch = (f: Rec, at: number, ev: P.ChatEvent[], sig: FrameSignals): void => {
    const type = str(f['type']);
    const sid = optStr(f['session_id']);
    if (sid) session = sid;
    const sub = f['parent_tool_use_id'];
    const mainThread = sub === null || sub === undefined;
    switch (type) {
      case 'stream_event': if (mainThread) onStream(rec(f['event']), at, ev, sig); return;
      case 'assistant': if (mainThread) onAssistant(f, at, ev, sig); return;
      case 'user': if (mainThread) onUser(f, at, ev); return;
      case 'system': onSystem(f, at, ev, sig); return;
      case 'result': onResult(f, at, ev, sig); return;
      case 'command_lifecycle': {
        const u = str(f['command_uuid']);
        const st = str(f['state']);
        if (u && (st === 'queued' || st === 'started' || st === 'completed' || st === 'cancelled' || st === 'refused')) setDelivery(u, st, ev);
        return;
      }
      case 'rate_limit_event': {
        const info = rec(f['rate_limit_info']);
        const status = str(info['status']);
        if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return;
        const r = num(info['resetsAt']);
        const rl: NonNullable<FrameSignals['rateLimit']> = { status, info };
        if (r !== undefined) rl.resetsAt = r < 1e12 ? r * 1000 : r;   // the CLI sends epoch seconds
        const kind = optStr(info['rateLimitType']); if (kind) rl.kind = kind;
        sig.rateLimit = rl;
        return;
      }
      case 'tool_progress': {
        if (!mainThread) return;
        const toolUseId = str(f['tool_use_id']);
        const id = blockId('tool', toolUseId);
        const b = findBlock(id);
        const secs = num(f['elapsed_time_seconds']);
        sig.sub = 'tool';
        const name = optStr(f['tool_name']); if (name) sig.subTool = name;
        if (!b || b.k !== 'tool' || secs === undefined) return;
        b.elapsedMs = Math.round(secs * 1000);
        if (progressOk(id, at)) ev.push({ k: 'progress', blockId: id, elapsedMs: b.elapsedMs });
        return;
      }
      default: return;
    }
  };

  const reducer: LiveReducerX = {
    step(f: SdkFrame, at: number): ReduceOut {
      const events: P.ChatEvent[] = [];
      const signals: FrameSignals = {};
      try { dispatch(rec(f), at, events, signals); } catch { faults++; /* malformed frame: ignored (never throws) */ }
      let urgent = false;
      for (const e of events) if (e.k !== 'delta' && e.k !== 'progress') { urgent = true; break; }
      return { events, urgent, signals };
    },
    userStarted(m): P.ChatEvent[] {
      const ev: P.ChatEvent[] = [];
      const delivery: P.Delivery = m.folded ? 'folded' : 'started';
      const prev = deliveries.get(m.uuid);
      if (prev !== 'completed' && prev !== 'folded') deliveries.set(m.uuid, delivery);
      const msg: P.UiUserMsg = { uuid: m.uuid, text: m.text, origin: userOrigin(undefined, m.text), delivery: deliveries.get(m.uuid) ?? delivery };
      const id = blockId('user', m.uuid);
      if (m.images > 0) {
        msg.images = Array.from({ length: m.images }, (_, i) => {
          const im: P.ImageRef = { ref: imageRefId(id, i), mediaType: m.imageTypes?.[i] ?? '' };
          const b = m.imageBytes?.[i];
          if (b !== undefined) im.bytes = b;
          return im;
        });
      }
      if (m.folded && turn && !ended) { upsert(turn, { k: 'user', id, msg }, ev); return ev; }
      if (turn?.id === id) return ev;                       // duplicate notification
      newTurn({ id, at: m.at, user: msg }, ev);
      tf.images = m.images > 0;
      return ev;
    },
    localRow(r: P.UiSystemRow, at: number): P.ChatEvent[] {
      const ev: P.ChatEvent[] = [];
      row(ev, `x:app:${++appRows}`, r, at);
      return ev;
    },
    processExited(asked?: ReadonlySet<string>): P.ChatEvent[] {
      // The process is gone without a result (crash, force stop): nothing of its turn is still running —
      // running tools become « interrupted » (as the disk rebuild shows them once a later turn exists), a tool waiting for
      // an answer « withdrawn » (« Demande annulée »), live text freezes
      // as cut, running tasks stop. Without this a crashed turn kept « Exécute : … » and its caret forever.
      const ev: P.ChatEvent[] = [];
      if (turn && !ended) {
        for (const b of [...turn.blocks]) {
          if (b.k === 'tool' && (b.status === 'running' || b.status === 'asking')) {
            upsert(turn, { ...b, status: b.status === 'asking' || asked?.has(b.toolUseId) ? 'withdrawn' : 'interrupted' }, ev);
          }
          else if ((b.k === 'text' || b.k === 'thinking') && b.live) {
            const nb = { ...b };
            delete nb.live;
            if (nb.k === 'text') nb.aborted = true;
            upsert(turn, nb, ev);
          }
        }
      }
      let stopped = false;
      for (const [id, t] of tasks) if (t.status === 'running') { tasks.set(id, { ...t, status: 'stopped' }); stopped = true; }
      if (stopped) ev.push({ k: 'tasks', tasks: [...tasks.values()] });
      return ev;
    },
    liveTurn(): P.UiTurn | null {
      if (!turn) return null;
      const t = turn as P.UiTurn;
      return { ...t, user: t.user ? { ...t.user } : null, blocks: t.blocks.map((b) => ({ ...b })) };
    },
    meta(): P.ChatMetaView { return { ...meta }; },
    metrics(): P.ChatMetrics { return { ...metrics }; },
    tasks(): P.TaskView[] { return [...tasks.values()]; },
    todos(): P.TodoItem[] | null { return todos ? [...todos] : null; },
    detail(id: string, field: P.DetailField): P.DetailPayload | null {
      const key = `${id}|${field}`;
      const hit = stash.get(key);
      if (hit) { stash.delete(key); stash.set(key, hit); return hit.p; }
      if (field === 'thinking') { const t = thinkingBuf.get(id); if (t !== undefined) return { text: t }; }
      return null;
    },
    deliveries(): Record<P.Uuid, P.Delivery> { return Object.fromEntries(deliveries); },
    sessionId(): P.SessionId { return session; },
    faults(): number { return faults; },
  };
  return reducer;
}
