// test/fakes/fake-query.ts — in-process QueryFn fake (scripted frames + every control method). SPEC §12.2(a).
// It pulls the prompt iterable like the SDK does, emits frames shaped like CLI 2.1.294 (see test/helpers/scenario.ts),
// calls options.canUseTool for scripted asks (with an AbortSignal that interrupt() aborts), and implements every Query
// control method, including the runtime-only ones (removable through `missing` for feature-detection tests).
// No process, no timers of its own beyond microtasks/setImmediate: safe with the fake Clock.
import { randomUUID } from 'node:crypto';
import type { Options, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn, SdkFrame } from '../../src/server/contracts.ts';

export type FakeTurnCtx = {
  msg: SDKUserMessage; text: string; uuid: string; h: FakeQueryHandle;
  emit(f: Record<string, unknown>): void;
  /** Standard successful turn body: status requesting, deltas, assistant, result (lifecycle is handled by the fake). */
  reply(text?: string, o?: { usage?: Record<string, unknown>; modelUsage?: Record<string, unknown>; costUsd?: number }): void;
  /** Calls options.canUseTool; resolves null when withdrawn (interrupt). */
  ask(toolName: string, input: Record<string, unknown>, extra?: Record<string, unknown>): Promise<PermissionResult | null>;
  aborted(): boolean;
};
export type FakeTurn = (c: FakeTurnCtx) => Promise<boolean | void> | boolean | void;   // false = cancelled turn
export type FakeQueryOptions = {
  init?: Record<string, unknown> | 'hang' | 'reject';
  sessionId?: string;                       // default: options.sessionId, else options.resume (non-.jsonl), else random
  startFrames?: readonly SdkFrame[];        // emitted right after query() (e.g. hook_started)
  turn?: FakeTurn;                          // per user message; default: echo the text
  frames?: readonly SdkFrame[];             // legacy: replayed verbatim for the FIRST user message instead of `turn`
  missing?: readonly string[];              // runtime-only methods removed (feature detection)
  controls?: Record<string, (...args: unknown[]) => unknown>;   // overrides of control methods
  ignoreEof?: boolean;                      // a CLI that does not exit on stdin EOF
};
export interface FakeQueryHandle {
  readonly options: Options;
  readonly sessionId: string;
  readonly calls: { name: string; args: unknown[] }[];
  readonly users: SDKUserMessage[];
  readonly frames: Record<string, unknown>[];
  emit(f: Record<string, unknown>): void;
  crash(code?: number): void;               // iterator throws `Claude Code process exited with code N`
  finish(): void;                           // iterator ends (clean exit)
  readonly done: boolean;
  readonly closed: boolean;
  pendingAsks(): number;
}
export type FakeQueryFn = QueryFn & { handles: FakeQueryHandle[]; last(): FakeQueryHandle };

const INIT_DEFAULT = {
  commands: [{ name: 'compact', description: 'Compact', argumentHint: '[instructions]' }], agents: [], output_style: 'default',
  available_output_styles: ['default'], models: [{ value: 'default', resolvedModel: 'fake-model', displayName: 'Fake', supportsAutoMode: true }],
  account: { email: 'fake@example.invalid' }, current_permission_mode: 'default', capabilities: ['interrupt_receipt_v1'],
};
const textOf = (m: SDKUserMessage): string => {
  const c = m.message.content;
  return typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
};

export function createFakeQuery(script: readonly SdkFrame[] | FakeQueryOptions = {}): FakeQueryFn {
  const o: FakeQueryOptions = Array.isArray(script) ? { frames: script as readonly SdkFrame[] } : (script as FakeQueryOptions);
  const handles: FakeQueryHandle[] = [];
  const fn = ((args: { prompt: AsyncIterable<SDKUserMessage> | string; options?: Options }): Query => {
    const options = args.options ?? {};
    let sid = o.sessionId ?? options.sessionId ?? (typeof options.resume === 'string' && !/\.jsonl$/i.test(options.resume) ? options.resume : randomUUID());
    const buf: Record<string, unknown>[] = [];
    const waiters: { resolve(r: IteratorResult<SdkFrame>): void; reject(e: unknown): void }[] = [];
    let done = false; let failure: Error | null = null; let closed = false; let inputEnded = false; let busy = false;
    const asks = new Set<AbortController>();
    let current: { uuid: string; abort: boolean } | null = null;
    const queue: SDKUserMessage[] = [];
    const calls: { name: string; args: unknown[] }[] = [];
    const users: SDKUserMessage[] = [];
    const frames: Record<string, unknown>[] = [];
    const flush = (): void => {
      while (waiters.length && buf.length) waiters.shift()!.resolve({ value: buf.shift() as SdkFrame, done: false });
      if (!buf.length && (done || failure)) for (const w of waiters.splice(0)) failure ? w.reject(failure) : w.resolve({ value: undefined as never, done: true });
    };
    const emit = (f: Record<string, unknown>): void => {
      if (done || failure) return;
      const m = { uuid: randomUUID(), session_id: sid, ...f };
      frames.push(m); buf.push(m); flush();
      // Like the CLI (and fake-claude.mjs): after /clear every later frame carries the new session id.
      if (f['type'] === 'conversation_reset' && typeof f['new_conversation_id'] === 'string') sid = f['new_conversation_id'];
    };
    const finish = (): void => { if (done || failure) return; done = true; for (const a of asks) a.abort(); flush(); };
    const crash = (code = 1): void => { if (done || failure) return; for (const a of asks) a.abort(); failure = new Error(`Claude Code process exited with code ${code}`); flush(); };
    const lifecycle = (uuid: string, state: string): void => emit({ type: 'command_lifecycle', command_uuid: uuid, state });
    const result = (uuids: string[], ok: boolean, text: string, extra: Record<string, unknown> = {}): void => emit({
      type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, ...(ok ? { result: text } : {}), num_turns: 1,
      usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40, cache_creation: { ephemeral_1h_input_tokens: 40, ephemeral_5m_input_tokens: 0 } },
      modelUsage: {}, total_cost_usd: 0, permission_denials: [], user_message_uuid: uuids[0], user_message_uuids: uuids,
      queued_turn_count: queue.length, ...extra });
    async function runTurn(m: SDKUserMessage, first: boolean): Promise<void> {
      const uuid = m.uuid as string;
      current = { uuid, abort: false };
      lifecycle(uuid, 'started');
      emit({ type: 'system', subtype: 'init', model: 'fake-model', permissionMode: options.permissionMode ?? 'default', claude_code_version: '0.0.0-fakeq', capabilities: [] });
      let ok: boolean | void = true;
      if (first && o.frames) { for (const f of o.frames) emit(f as Record<string, unknown>); }
      else {
        const cur = current;
        const ctx: FakeTurnCtx = {
          msg: m, text: textOf(m), uuid, h: handle, emit, aborted: () => cur.abort,
          reply(text = textOf(m), ro = {}) {
            emit({ type: 'system', subtype: 'status', status: 'requesting', parent_tool_use_id: null, user_message_uuids: [uuid] });
            emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_q', usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40 } } } });
            emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
            emit({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_q', model: 'fake-model', role: 'assistant', content: [{ type: 'text', text }] } });
            result([uuid], true, text, { ...(ro.usage ? { usage: ro.usage } : {}), ...(ro.modelUsage ? { modelUsage: ro.modelUsage } : {}), ...(ro.costUsd !== undefined ? { total_cost_usd: ro.costUsd } : {}) });
          },
          async ask(toolName, input, extra = {}) {
            const ac = new AbortController(); asks.add(ac);
            try {
              const cut = options.canUseTool;
              if (!cut) return null;
              const r = await Promise.race([cut(toolName, input, { signal: ac.signal, toolUseID: 'toolu_' + randomUUID().slice(0, 8), requestId: randomUUID(), ...extra } as never),
                new Promise<null>((res) => ac.signal.addEventListener('abort', () => res(null), { once: true }))]);
              return r ?? null;
            } finally { asks.delete(ac); }
          },
        };
        ok = await (o.turn ?? ((c: FakeTurnCtx) => c.reply()))(ctx);
        if (cur.abort && ok !== false) { result([uuid], false, 'aborted', { terminal_reason: 'aborted_streaming' }); ok = false; }
      }
      lifecycle(uuid, ok === false ? 'cancelled' : 'completed');
      current = null;
    }
    async function pump(): Promise<void> {
      if (busy) return;
      busy = true;
      let first = users.length === queue.length;
      while (queue.length && !done && !failure) { const m = queue.shift()!; await runTurn(m, first); first = false; }
      busy = false;
      if (inputEnded && !o.ignoreEof) finish();
    }
    void (async () => {                                   // the SDK pulls the prompt iterable (streamInput)
      for (const f of o.startFrames ?? []) emit(f as Record<string, unknown>);
      if (typeof args.prompt === 'string') return;
      for await (const m of args.prompt) {
        if (done || failure) break;
        users.push(m); queue.push(m); lifecycle(m.uuid as string, 'queued'); void pump();
      }
      inputEnded = true;
      if (!busy && !o.ignoreEof) finish();
    })();
    const handle: FakeQueryHandle = {
      options, get sessionId() { return sid; }, calls, users, frames, emit, crash, finish,
      get done() { return done || failure !== null; }, get closed() { return closed; }, pendingAsks: () => asks.size,
    };
    handles.push(handle);
    const call = (name: string, args: unknown[], dflt: () => unknown): Promise<unknown> => {
      calls.push({ name, args });
      if (failure) return Promise.reject(new Error('Query closed: process exited'));
      const over = o.controls?.[name];
      try { return Promise.resolve(over ? over(...args) : dflt()); } catch (e) { return Promise.reject(e); }
    };
    let initP: Promise<unknown> | null = null;
    const q: Record<string, unknown> = {
      next: () => new Promise<IteratorResult<SdkFrame>>((resolve, reject) => { waiters.push({ resolve, reject }); flush(); }),
      return: () => { finish(); return Promise.resolve({ value: undefined, done: true }); },
      throw: (e: unknown) => Promise.reject(e),
      [Symbol.asyncIterator]() { return this; },
      initializationResult: () => {
        calls.push({ name: 'initializationResult', args: [] });
        initP ??= o.init === 'hang' ? new Promise(() => {}) : o.init === 'reject' ? Promise.reject(new Error('init failed'))
          : Promise.resolve({ ...INIT_DEFAULT, current_permission_mode: options.permissionMode ?? 'default', ...(o.init ?? {}) });
        return initP;
      },
      interrupt: () => call('interrupt', [], () => {
        if (current) current.abort = true;
        for (const a of asks) a.abort();
        return { still_queued: queue.map((m) => m.uuid) };
      }),
      setPermissionMode: (m: string) => call('setPermissionMode', [m], () => { emit({ type: 'system', subtype: 'status', status: null, permissionMode: m }); }),
      setModel: (m?: string) => call('setModel', [m], () => undefined),
      applyFlagSettings: (s: unknown) => call('applyFlagSettings', [s], () => undefined),
      supportedCommands: () => call('supportedCommands', [], () => INIT_DEFAULT.commands),
      supportedModels: () => call('supportedModels', [], () => INIT_DEFAULT.models),
      accountInfo: () => call('accountInfo', [], () => INIT_DEFAULT.account),
      getContextUsage: (a?: { detail?: string }) => call('getContextUsage', [a], () => {
        if (a?.detail !== 'summary') throw new Error('fake-query: getContextUsage must use detail summary');
        return { categories: [{ name: 'System prompt', tokens: 3117, kind: 'used' }, { name: 'Free', tokens: 1, kind: 'free' }], totalTokens: 37152, maxTokens: 200000, rawMaxTokens: 200000, memoryFiles: [{ path: 'CLAUDE.md' }] };
      }),
      stopTask: (id: string) => call('stopTask', [id], () => undefined),
      backgroundTasks: (id?: string) => call('backgroundTasks', [id], () => true),
      rewindFiles: (u: string, ro: unknown) => call('rewindFiles', [u, ro], () => ({ canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: 0 })),
      cancelAsyncMessage: (u: string) => call('cancelAsyncMessage', [u], () => {
        const i = queue.findIndex((m) => m.uuid === u);
        if (i < 0) return false;
        queue.splice(i, 1); lifecycle(u, 'cancelled'); return true;
      }),
      renameSession: (t: string, s?: string) => call('renameSession', [t, s], () => { emit({ type: 'system', subtype: 'session_title_changed', title: t }); }),
      listPermissionRules: () => call('listPermissionRules', [], () => ({ state: { rules: [{ behavior: 'allow', source: 'localSettings', rule: 'Bash(npm ci)', editability: 'persistent' }] } })),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (a: unknown) => call('usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET', [a], () => ({ five_hour: { utilization: 1 } })),
      streamInput: () => Promise.resolve(),
      close: () => { calls.push({ name: 'close', args: [] }); closed = true; finish(); },
    };
    for (const name of o.missing ?? []) delete q[name];
    return q as unknown as Query;
  }) as unknown as FakeQueryFn;
  fn.handles = handles;
  fn.last = () => { const h = handles[handles.length - 1]; if (!h) throw new Error('fake-query: no query started'); return h; };
  return fn;
}
