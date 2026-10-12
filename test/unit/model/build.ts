// test/unit/model/build.ts — tiny builders of synthetic SDK frames (live) and transcript entries (disk).
import type { RawEntry, SdkFrame } from '../../../src/server/contracts.ts';

export const SID = '11111111-2222-4333-8444-555555555555';
export const CHAT = `acc:${SID}`;
type R = Record<string, unknown>;
const f = (o: R): SdkFrame => ({ session_id: SID, ...o }) as SdkFrame;

export const lifecycle = (uuid: string, state: string): SdkFrame => f({ type: 'command_lifecycle', command_uuid: uuid, state });
export const init = (uuid: string, o: R = {}): SdkFrame => f({ type: 'system', subtype: 'init', uuid, model: 'claude-opus-5-5', cwd: 'C:\\w', tools: ['Bash'], permissionMode: 'default', ...o });
let stN = 0;
export const status = (st: string | null, o: R = {}): SdkFrame => f({ type: 'system', subtype: 'status', status: st, uuid: `st-${++stN}`, ...o });
export const stream = (event: R): SdkFrame => f({ type: 'stream_event', event, parent_tool_use_id: null });
export const msgStart = (id: string, usage: R = { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 }, model = 'claude-opus-5-5'): SdkFrame =>
  stream({ type: 'message_start', message: { id, model, usage } });
export const blockStart = (index: number, content_block: R): SdkFrame => stream({ type: 'content_block_start', index, content_block });
export const textDelta = (index: number, text: string): SdkFrame => stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
export const thinkingDelta = (index: number, thinking: string): SdkFrame => stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
export const assistant = (id: string, block: R, o: R = {}, model = 'claude-opus-5-5'): SdkFrame =>
  f({ type: 'assistant', uuid: `as-${id}-${String(block['type'])}`, parent_tool_use_id: null, message: { id, model, role: 'assistant', content: [block] }, ...o });
export const toolResult = (toolUseId: string, content: unknown, o: R = {}, isError = false): SdkFrame =>
  f({ type: 'user', uuid: `tr-${toolUseId}`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] }, ...o });
export const result = (o: R = {}): SdkFrame => f({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, terminal_reason: 'completed',
  usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 20 },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 5, outputTokens: 20, cacheReadInputTokens: 1000, cacheCreationInputTokens: 10, contextWindow: 200000 } },
  total_cost_usd: 0.01, queued_turn_count: 0, ...o,
});

/** Transcript entries → RawEntry[] with fake offsets. */
export function raw(entries: R[]): RawEntry[] {
  let off = 0;
  return entries.map((e) => { const len = JSON.stringify(e).length; const r = { off, len, e }; off += len + 1; return r; });
}
let n = 0;
const ts = (): string => new Date(Date.UTC(2026, 9, 8, 12, 0, n++)).toISOString();
export const dUser = (uuid: string, content: unknown, o: R = {}): R => ({ type: 'user', uuid, timestamp: ts(), message: { role: 'user', content }, ...o });
export const dAssistant = (uuid: string, id: string, block: R, o: R = {}, model = 'claude-opus-5-5'): R =>
  ({ type: 'assistant', uuid, timestamp: ts(), message: { id, model, role: 'assistant', content: [block], usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 20 } }, ...o });
export const dResult = (uuid: string, toolUseId: string, content: unknown, o: R = {}, isError = false): R =>
  dUser(uuid, [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }], o);
