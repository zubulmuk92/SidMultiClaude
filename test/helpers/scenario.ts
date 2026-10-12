// test/helpers/scenario.ts — fixtures and scripted SDK frames for every package's tests.
// 1. Typed loaders for the sanitized recordings (test/fixtures/frames, pairs) and the golden protocol scripts.
// 2. Protocol-script templating ($req.<field> / $<name>.<field>) and request matching, for test/fakes/mock-server.mjs
//    (web shell) and the hub tests (server).
// 3. scenario(): a builder of SDK frames with the exact shapes recorded from CLI 2.1.294 (see test/fixtures/frames/*),
//    for test/fakes/fake-query.ts (engine) and the model tests.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SdkFrame } from '../../src/server/contracts.ts';
import type * as P from '../../src/shared/protocol.ts';

export const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');
export type FixtureName = 'dry' | 'fork' | 'main' | 'plan';
export type PairName = 'fork' | 'main' | 'plan';
export type FrameMsg = SdkFrame & Record<string, unknown>;
export type FrameRec = { t: number; label: string; m: FrameMsg };
export type WireRec =
  | { t: number; dir: 'cli>' | '>cli'; m: Record<string, unknown> }
  | { t: number; dir: 'spawn'; pid: number; command: string; args: string[]; cwd: string }
  | { t: number; dir: 'exit'; code: number | null; sig: string | null };
export type InputRec = { t: number; uuid: P.Uuid; text: string; priority?: 'later' | 'now'; images: number };
export type FixtureIndex = {
  generatedBy: string; source: string; totalFrames: number;
  fixtures: Record<FixtureName, {
    frames: number; wire: number; sessionIds: P.SessionId[];
    inputs: { label: string; uuid: P.Uuid; priority?: string; images: number }[];
    facts: { delivery: Record<P.Uuid, string>; modeTrail: string[]; title: string | null; assistantModels: string[] };
    pair?: { sessionId: P.SessionId; transcriptLines: number; cwd: string };
  }>;
};

const readJsonl = <T>(file: string): T[] =>
  fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

export function loadFrames(name: FixtureName): FrameRec[] { return readJsonl<FrameRec>(path.join(FIXTURES, 'frames', `${name}.jsonl`)); }
export function loadWire(name: FixtureName): WireRec[] { return readJsonl<WireRec>(path.join(FIXTURES, 'frames', 'wire', `${name}.jsonl`)); }
export function loadIndex(): FixtureIndex { return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'frames', 'index.json'), 'utf8')) as FixtureIndex; }
export function loadPair(name: PairName): { frames: FrameRec[]; transcript: Record<string, unknown>[]; inputs: InputRec[] } {
  const dir = path.join(FIXTURES, 'pairs', name);
  return {
    frames: readJsonl<FrameRec>(path.join(dir, 'frames.jsonl')),
    transcript: readJsonl<Record<string, unknown>>(path.join(dir, 'transcript.jsonl')),
    inputs: readJsonl<InputRec>(path.join(dir, 'inputs.jsonl')),
  };
}
/** uuid of a labelled user message, e.g. inputUuid('main', 'B') (labels: main T1 T2 T3 A B C D T6). */
export function inputUuid(name: FixtureName, label: string): P.Uuid {
  const i = loadIndex().fixtures[name].inputs.find((x) => x.label === label);
  if (!i) throw new Error(`no input ${label} in fixture ${name}`);
  return i.uuid;
}
/** The raw transcript as RawEntry[] (byte offsets of each line), what TranscriptReader hands to diskToTurns. */
export function transcriptRawEntries(name: PairName): { off: number; len: number; e: Record<string, unknown> }[] {
  const buf = fs.readFileSync(path.join(FIXTURES, 'pairs', name, 'transcript.jsonl'));
  const out: { off: number; len: number; e: Record<string, unknown> }[] = [];
  let off = 0;
  while (off < buf.length) {
    let end = buf.indexOf(0x0a, off);
    if (end < 0) end = buf.length;
    const line = buf.subarray(off, end).toString('utf8');
    if (line.trim()) out.push({ off, len: end - off, e: JSON.parse(line) as Record<string, unknown> });
    off = end + 1;
  }
  return out;
}

// ------------------------------------------------------------------ golden protocol scripts
export const PROTOCOL_SCRIPTS = ['stream', 'permission', 'question', 'plan', 'queue', 'crash', 'reconnect', 'cap'] as const;
export type ProtocolScriptName = (typeof PROTOCOL_SCRIPTS)[number];
export type ProtocolAck = { ok: true; data?: unknown } | { ok: false; err: P.WireError };
/**
 * One line of test/fixtures/protocol/<name>.jsonl.
 * - meta: first line (format documentation).  - connect: wait for a (re)connection.  - drop: close the socket abruptly.
 * - send: push `frame` (one WebSocket frame = JSON array of S2C) after `delayMs`.
 * - expect: wait for a C2S whose fields include `match`; reply with ONE frame: the ack (built from `ack` + the request id),
 *   then `then`. `as` names the request for templates.
 * Templates: in any string, `$req.<field>` / `$<as>.<field>` are replaced by that field of the latest / named request.
 */
export type ProtocolStep =
  | { step: 'meta'; v: 1; name: string; description: string; format: string }
  | { step: 'connect' }
  | { step: 'send'; delayMs: number; frame: P.S2C[] }
  | { step: 'expect'; match: Record<string, unknown>; as?: string; ack: ProtocolAck; then: P.S2C[] }
  | { step: 'drop' };
export function loadProtocol(name: ProtocolScriptName): ProtocolStep[] { return readJsonl<ProtocolStep>(path.join(FIXTURES, 'protocol', `${name}.jsonl`)); }

export type TemplateVars = Record<string, Record<string, unknown>>;   // { req: {...}, A: {...}, … }
const TEMPLATE_RE = /\$([A-Za-z]\w*)\.(\w+)/g;
/** Deep copy with `$name.field` tokens replaced (a string that is exactly one token keeps the field's type). */
export function bindTemplates<T>(value: T, vars: TemplateVars): T {
  const sub = (s: string): unknown => {
    const whole = /^\$([A-Za-z]\w*)\.(\w+)$/.exec(s);
    if (whole && vars[whole[1]!] && whole[2]! in vars[whole[1]!]!) return vars[whole[1]!]![whole[2]!];
    return s.replace(TEMPLATE_RE, (m, n: string, f: string) => (vars[n] && f in vars[n]! ? String(vars[n]![f]) : m));
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return sub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
/** True when every field of `match` (templates bound) equals the request's field (deep equality on JSON). */
export function matchesRequest(match: Record<string, unknown>, req: Record<string, unknown>, vars: TemplateVars): boolean {
  const m = bindTemplates(match, vars);
  return Object.entries(m).every(([k, v]) => JSON.stringify(req[k]) === JSON.stringify(v));
}
/** The ack frame element an expect step answers with. */
export function ackFor(id: number, ack: ProtocolAck): P.S2C {
  return ack.ok ? ('data' in ack && ack.data !== undefined ? { t: 'ack', id, ok: true, data: ack.data } : { t: 'ack', id, ok: true }) : { t: 'ack', id, ok: false, err: ack.err };
}

// ------------------------------------------------------------------ scripted SDK frames (shapes of CLI 2.1.294)
export type ScenarioOptions = { sessionId?: P.SessionId; model?: string; cwd?: string; mode?: P.PermissionModeId; t0?: number; stepMs?: number };
export interface Scenario {
  readonly sessionId: P.SessionId;
  /** system:init (sent by the CLI at each turn start). */
  init(o?: { capabilities?: string[]; slashCommands?: string[] }): Scenario;
  /** command_lifecycle `state` for a user message uuid. */
  lifecycle(uuid: P.Uuid, state: 'queued' | 'started' | 'completed' | 'cancelled'): Scenario;
  /** system:status requesting (one per API request). */
  requesting(uuids?: P.Uuid[]): Scenario;
  /** A streamed text block: message_start … text deltas … assistant … message_stop. Returns its message id. */
  text(text: string, o?: { parts?: number; model?: string; userUuid?: P.Uuid }): string;
  /** A streamed thinking block (empty text, as recorded) followed by its assistant frame. */
  thinking(o?: { model?: string }): string;
  /** A tool_use block (input_json deltas + assistant frame). Returns the tool_use id. */
  toolUse(name: string, input: Record<string, unknown>, o?: { id?: string; model?: string }): string;
  /** The user frame carrying a tool_result (+ tool_use_result metadata). */
  toolResult(toolUseId: string, content: string, o?: { isError?: boolean; toolUseResult?: unknown }): Scenario;
  /** A turn result. `uuids`[0] is the turn's own message; the others were folded into it. */
  result(o: { uuids: P.Uuid[]; text?: string; subtype?: 'success' | 'error_during_execution'; terminalReason?: string; queuedTurnCount?: number; costUsd?: number; ttl5m?: boolean }): Scenario;
  status(permissionMode: P.PermissionModeId): Scenario;
  title(title: string): Scenario;
  frame(f: Record<string, unknown>): Scenario;
  frames(): FrameMsg[];
  recs(): FrameRec[];
}
export function scenario(o: ScenarioOptions = {}): Scenario {
  const sessionId = o.sessionId ?? randomUUID();
  const model = o.model ?? 'claude-haiku-5-5';
  const out: FrameRec[] = [];
  let t = o.t0 ?? 0;
  let cost = 0;
  let msgN = 0;
  const step = o.stepMs ?? 5;
  const uuid = (): string => randomUUID();
  const push = (m: Record<string, unknown>): void => { t += step; out.push({ t, label: String(m['type']), m: m as FrameMsg }); };
  const usage = (ttl5m = false) => ({ input_tokens: 2, cache_creation_input_tokens: 81, cache_read_input_tokens: 37_152, output_tokens: 24,
    cache_creation: { ephemeral_5m_input_tokens: ttl5m ? 81 : 0, ephemeral_1h_input_tokens: ttl5m ? 0 : 81 }, service_tier: 'standard', inference_geo: 'not_available' });
  const ev = (event: Record<string, unknown>) => push({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null, uuid: uuid() });
  const assistant = (id: string, block: Record<string, unknown>, m = model) => push({ type: 'assistant',
    message: { model: m, id, type: 'message', role: 'assistant', content: [block], stop_reason: null, stop_sequence: null, usage: usage() },
    parent_tool_use_id: null, session_id: sessionId, uuid: uuid() });
  const msgId = (): string => `msg_scenario${String(++msgN).padStart(12, '0')}`;
  const s: Scenario = {
    sessionId,
    init(io = {}) {
      push({ type: 'system', subtype: 'init', cwd: o.cwd ?? 'C:\\Users\\smc-user\\Projects\\demo', session_id: sessionId, tools: ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Read', 'Write'],
        mcp_servers: [], model, permissionMode: o.mode ?? 'default', slash_commands: io.slashCommands ?? ['compact', 'context', 'usage'], terminal_slash_commands: ['doctor'],
        apiKeySource: 'none', claude_code_version: '2.1.294', output_style: 'default', agents: ['general-purpose'], skills: [], plugins: [],
        capabilities: io.capabilities ?? ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'], uuid: uuid() });
      return s;
    },
    lifecycle(u, state) { push({ type: 'command_lifecycle', command_uuid: u, state, uuid: uuid(), session_id: sessionId }); return s; },
    requesting(uuids) { push({ type: 'system', subtype: 'status', status: 'requesting', ...(uuids ? { user_message_uuids: uuids } : {}), uuid: uuid(), session_id: sessionId }); return s; },
    text(text, to = {}) {
      const id = msgId();
      ev({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: to.model ?? model, content: [], usage: usage() } });
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      const n = Math.max(1, to.parts ?? 3);
      const size = Math.max(1, Math.ceil(text.length / n));
      for (let i = 0; i < text.length; i += size) ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } });
      assistant(id, { type: 'text', text }, to.model ?? model);
      ev({ type: 'content_block_stop', index: 0 });
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 24 } });
      ev({ type: 'message_stop' });
      return id;
    },
    thinking(to = {}) {
      const id = msgId();
      ev({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: to.model ?? model, content: [], usage: usage() } });
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } });
      push({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 120, estimated_tokens_delta: 120, session_id: sessionId, uuid: uuid() });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'c2NlbmFyaW8tc2lnbmF0dXJl' } });
      assistant(id, { type: 'thinking', thinking: '', signature: 'c2NlbmFyaW8tc2lnbmF0dXJl' }, to.model ?? model);
      ev({ type: 'content_block_stop', index: 0 });
      return id;
    },
    toolUse(name, input, to = {}) {
      const id = to.id ?? `toolu_scenario${String(++msgN).padStart(12, '0')}`;
      const mid = msgId();
      ev({ type: 'message_start', message: { id: mid, type: 'message', role: 'assistant', model: to.model ?? model, content: [], usage: usage() } });
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {}, caller: { type: 'direct' } } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      assistant(mid, { type: 'tool_use', id, name, input, caller: { type: 'direct' } }, to.model ?? model);
      ev({ type: 'content_block_stop', index: 0 });
      ev({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 24 } });
      ev({ type: 'message_stop' });
      return id;
    },
    toolResult(id, content, to = {}) {
      push({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: to.isError ?? false }] },
        parent_tool_use_id: null, session_id: sessionId, uuid: uuid(), timestamp: new Date(t).toISOString(),
        tool_use_result: to.toolUseResult ?? { stdout: content, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } });
      return s;
    },
    result(r) {
      const ok = (r.subtype ?? 'success') === 'success';
      cost += 0.0021;
      const totalCost = r.costUsd ?? Number(cost.toFixed(6));
      push({ type: 'result', subtype: r.subtype ?? 'success', is_error: !ok, num_turns: 1, session_id: sessionId,
        ...(ok ? { result: r.text ?? '' } : { errors: ['scenario'] }), duration_ms: 1_200, duration_api_ms: 900, total_cost_usd: totalCost,
        usage: usage(r.ttl5m), modelUsage: { [model]: { inputTokens: 2, outputTokens: 24, cacheReadInputTokens: 37_152, cacheCreationInputTokens: 81, webSearchRequests: 0, costUSD: 0.0021, contextWindow: 1_000_000, maxOutputTokens: 128_000 } },
        permission_denials: [], terminal_reason: r.terminalReason ?? (ok ? 'completed' : 'aborted_streaming'), user_message_uuid: r.uuids[0], user_message_uuids: r.uuids,
        queued_turn_count: r.queuedTurnCount ?? 0, uuid: uuid(), stop_reason: ok ? 'end_turn' : null });
      return s;
    },
    status(permissionMode) { push({ type: 'system', subtype: 'status', status: null, permissionMode, uuid: uuid(), session_id: sessionId }); return s; },
    title(title) { push({ type: 'system', subtype: 'session_title_changed', title, uuid: uuid(), session_id: sessionId }); return s; },
    frame(f) { push({ session_id: sessionId, uuid: uuid(), ...f }); return s; },
    frames: () => out.map((r) => r.m),
    recs: () => out.map((r) => ({ ...r, label: r.m.type === 'system' ? `system:${String(r.m['subtype'])}` : r.label })),
  };
  return s;
}
