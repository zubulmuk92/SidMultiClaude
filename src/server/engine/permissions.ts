// src/server/engine/permissions.ts — ask registry, canUseTool/onElicitation bridge, UiAnswer→PermissionResult (SPEC §2.5).
// Callback shapes verified against the SDK. Callbacks never time out (CLI parity); first decision wins; on
// options.signal abort the callback returns null (the SDK then sends nothing) and the card is withdrawn.
import fs from 'node:fs';
import path from 'node:path';
import type { CanUseTool, ElicitationResult, OnElicitation, PermissionMode, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type * as P from '../../shared/protocol.ts';
import type { Clock, EngineSink, Logger } from '../contracts.ts';
import { ASK_INPUT_MAX_STRING_BYTES } from '../../shared/limits.ts';
import { canonicalPath, isInside } from '../util/paths.ts';

export const DENY_DEFAULT_MESSAGE = 'L\'utilisateur a refusé.';
export const SKIP_QUESTION_MESSAGE = 'L\'utilisateur a choisi de ne pas répondre.';
export const WITHDRAW_GRACE_MS = 150;            // signal abort → askEnd 'cancelled' unless the process died meanwhile ('crash')

/** What toPermissionResult needs beyond the (lite) card: the full input and the filtered suggestions. */
export type AnswerContext = { input?: Record<string, unknown>; suggestions?: PermissionUpdate[]; allowBypass?: boolean };

const RULE_UPDATES = new Set(['addRules', 'replaceRules', 'removeRules', 'addDirectories', 'removeDirectories']);

/** Suggestions without `userSettings` (it writes into the account profile); local/project only when the cwd passed S9. */
export function filterSuggestions(s: readonly PermissionUpdate[] | undefined, cwdSafe: boolean): PermissionUpdate[] {
  return (s ?? []).filter((u) => u.destination !== 'userSettings' && u.destination !== 'cliArg'
    && (cwdSafe || (u.destination !== 'localSettings' && u.destination !== 'projectSettings')));
}
/** Monospace rule text shown in the tooltip, e.g. Bash(npm ci). */
export function ruleTexts(s: readonly PermissionUpdate[]): string[] {
  const out: string[] = [];
  for (const u of s) if (u.type === 'addRules' || u.type === 'replaceRules') for (const r of u.rules) out.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
  return out;
}

/** UiAnswer → PermissionResult, per the table of SPEC §2.5 (userSettings never emitted). */
export function toPermissionResult(ask: P.PendingAsk, answer: P.UiAnswer, ctx: AnswerContext = {}): PermissionResult {
  const input = ctx.input ?? ask.input;
  switch (answer.kind) {
    case 'allow-once': return { behavior: 'allow', updatedInput: input };
    case 'allow-edited': return { behavior: 'allow', updatedInput: answer.input };
    case 'allow-always': {
      const scope = answer.scope;
      const updates = filterSuggestions(ctx.suggestions, true).map((u): PermissionUpdate =>
        u.type === 'setMode' ? { ...u, destination: 'session' } : RULE_UPDATES.has(u.type) ? { ...u, destination: scope } : u);
      return updates.length ? { behavior: 'allow', updatedInput: input, updatedPermissions: updates } : { behavior: 'allow', updatedInput: input };
    }
    case 'allow-and-auto':
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] };
    case 'deny': {
      const message = answer.message || DENY_DEFAULT_MESSAGE;
      return answer.stopTurn ? { behavior: 'deny', message, interrupt: true } : { behavior: 'deny', message };
    }
    case 'answers': {
      const updated: Record<string, unknown> = { ...input, answers: answer.answers };
      if (answer.notes && Object.keys(answer.notes).length) {
        updated['annotations'] = Object.fromEntries(Object.entries(answer.notes).map(([q, notes]) => [q, { notes }]));
      }
      if (answer.response !== undefined) updated['response'] = answer.response;
      return { behavior: 'allow', updatedInput: updated };
    }
    case 'skip-question': return { behavior: 'deny', message: SKIP_QUESTION_MESSAGE };
    case 'plan-approve': {
      const next: PermissionMode = answer.nextMode === 'bypassPermissions' && !ctx.allowBypass ? 'default' : answer.nextMode;
      return { behavior: 'allow', updatedInput: { ...input, plan: answer.editedPlan ?? input['plan'] },
        updatedPermissions: [{ type: 'setMode', mode: next, destination: 'session' }] };
    }
    case 'plan-reject': return { behavior: 'deny', message: answer.feedback || DENY_DEFAULT_MESSAGE };
    case 'elicit': return { behavior: 'deny', message: DENY_DEFAULT_MESSAGE };   // not a tool ask: see toElicitationResult
  }
}

export function toElicitationResult(answer: P.UiAnswer): ElicitationResult {
  if (answer.kind === 'elicit') return answer.content ? { action: answer.action, content: answer.content as ElicitationResult['content'] } : { action: answer.action };
  return { action: answer.kind === 'deny' ? 'decline' : 'cancel' };
}

/** PendingAsk.input "lite": strings > 256 KB cut (Edit/Write keep up to 256 KB for the preview). */
export function liteInput(v: Record<string, unknown>): Record<string, unknown> {
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return Buffer.byteLength(x) > ASK_INPUT_MAX_STRING_BYTES ? Buffer.from(x).subarray(0, ASK_INPUT_MAX_STRING_BYTES).toString('utf8') : x;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v) as Record<string, unknown>;
}

/** Secret files the server never opens (SPEC §10 S10: `.credentials.json` is stat-only, `*.key` is never read). */
export const SECRET_FILE_RE = /(^|[\\/])\.credentials\.json$|\.key$/i;

/** Write preview base: read by the server inside the cwd only (absent file = empty base); never a secret file (S10). */
export async function readDiffBase(cwd: string, filePath: unknown): Promise<P.PendingAsk['diffBase']> {
  if (typeof filePath !== 'string' || !filePath) return { unavailable: true };
  const abs = canonicalPath(path.resolve(cwd, filePath));
  if (!isInside(abs, canonicalPath(cwd))) return { unavailable: true };
  // Win32 drops trailing dots / spaces (`a.key.` opens a.key); a colon past the drive names a data stream (`a.key::$DATA`).
  if (SECRET_FILE_RE.test(abs.replace(/[. ]+$/, '')) || abs.indexOf(':', 2) >= 0) return { unavailable: true };
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile() || st.size > ASK_INPUT_MAX_STRING_BYTES) return { unavailable: true };
    return { path: abs, text: await fs.promises.readFile(abs, 'utf8') };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { path: abs, text: '' } : { unavailable: true };
  }
}

// ------------------------------------------------------------------ registry (key: chatId + requestId)
export type AskContext = {
  cwd: string;
  cwdSafe: boolean;                     // S9 passed: localSettings / projectSettings destinations allowed
  allowBypass: boolean;
  mode(): P.PermissionModeId;
  autoAvailable(): boolean;             // ModelInfo.supportsAutoMode of the current model
  exited(): boolean;                    // the CLI process is gone (a withdrawal then means 'crash')
};
type Entry = {
  ask: P.PendingAsk; input: Record<string, unknown>; suggestions: PermissionUpdate[]; ctx: AskContext;
  resolve(r: PermissionResult | ElicitationResult | null): void;
  state: 'open' | 'withdrawing'; timer?: { cancel(): void };
};
/** A chat id, or a getter for chats that can be re-keyed while live (/clear, CLI-chosen fork id): read at ask time. */
export type ChatRef = P.ChatId | (() => P.ChatId);
export interface AskRegistry {
  canUseTool(chat: ChatRef, ctx: AskContext): CanUseTool;
  onElicitation(chat: ChatRef, ctx: AskContext): OnElicitation;
  decide(chatId: P.ChatId, requestId: string, a: P.UiAnswer): 'ok' | 'not_pending';
  count(chatId: P.ChatId): number;
  list(chatId?: P.ChatId): P.PendingAsk[];
  /** Ends every ask of a chat (process exit): askEnd(reason) for each, callbacks resolved with null. */
  endAll(chatId: P.ChatId, reason: P.AskEndReason): void;
  /** A chat was re-keyed (/clear, CLI-chosen fork id): its open asks move with it. */
  rekey(from: P.ChatId, to: P.ChatId): void;
}
export type AskRegistryDeps = { sink: Pick<EngineSink, 'ask' | 'askEnd'>; clock: Clock; onChange(chatId: P.ChatId): void; log?: Logger; withdrawGraceMs?: number };

export function createAskRegistry(d: AskRegistryDeps): AskRegistry {
  const byChat = new Map<P.ChatId, Map<string, Entry>>();
  const chatOf = new Map<string, P.ChatId>();                  // requestId → current chatId (rekey-safe)
  const grace = d.withdrawGraceMs ?? WITHDRAW_GRACE_MS;
  const table = (c: P.ChatId): Map<string, Entry> => { let t = byChat.get(c); if (!t) { t = new Map(); byChat.set(c, t); } return t; };
  /** Sink calls never throw into the engine: a failing sink must not leave an ask, an exit or a decision half done. */
  const emit = (what: string, fn: () => void): void => { try { fn(); } catch (err) { d.log?.error(`permissions: sink.${what} threw`, { err: String(err) }); } };

  function finalize(requestId: string, reason: P.AskEndReason): void {
    const chatId = chatOf.get(requestId);
    const e = chatId ? byChat.get(chatId)?.get(requestId) : undefined;
    if (!chatId || !e) return;
    e.timer?.cancel();
    byChat.get(chatId)!.delete(requestId);
    chatOf.delete(requestId);
    e.resolve(null);
    emit('askEnd', () => d.sink.askEnd(chatId, requestId, reason));
    emit('onChange', () => d.onChange(chatId));
  }
  function register(chatId: P.ChatId, ask: P.PendingAsk, input: Record<string, unknown>, suggestions: PermissionUpdate[], ctx: AskContext,
    signal: AbortSignal): Promise<PermissionResult | ElicitationResult | null> {
    return new Promise((resolve) => {
      const prev = table(chatId).get(ask.requestId);
      // Re-delivery of the same requestId: updates the card. The replaced entry is inert, so a later abort of ITS signal
      // can no longer withdraw the new card (finalize() works by requestId).
      if (prev) { prev.state = 'withdrawing'; prev.timer?.cancel(); prev.resolve(null); }
      const e: Entry = { ask, input, suggestions, ctx, resolve, state: 'open' };
      table(chatId).set(ask.requestId, e);
      chatOf.set(ask.requestId, chatId);
      const onAbort = (): void => {
        if (e.state !== 'open' || chatOf.get(ask.requestId) === undefined) return;
        e.state = 'withdrawing';
        e.resolve(null);                                        // the SDK then sends nothing
        if (e.ctx.exited()) { finalize(ask.requestId, 'crash'); return; }
        e.timer = d.clock.timer(grace, () => finalize(ask.requestId, e.ctx.exited() ? 'crash' : 'cancelled'));
      };
      emit('ask', () => d.sink.ask(ask));                      // ask() before the facts that count it
      emit('onChange', () => d.onChange(chatId));
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  return {
    canUseTool(chat, ctx) {
      return async (toolName, input, o) => {
        const chatId = typeof chat === 'function' ? chat() : chat;   // the CURRENT id (the chat may have been re-keyed)
        const extra = o as typeof o & { requiresUserInteraction?: boolean };
        const kind: P.AskKind = toolName === 'ExitPlanMode' ? 'plan'
          : extra.requiresUserInteraction === true || toolName === 'AskUserQuestion' ? 'question' : 'permission';
        const suggestions = filterSuggestions(o.suggestions, ctx.cwdSafe);
        const matched = o.matchedAskRule ? `${o.matchedAskRule.toolName}${o.matchedAskRule.ruleContent ? `(${o.matchedAskRule.ruleContent})` : ''}` : undefined;
        const mode = ctx.mode();
        const ask: P.PendingAsk = {
          chatId, requestId: o.requestId, toolUseId: o.toolUseID, kind, toolName, input: liteInput(input),
          offerAlways: kind === 'permission' && !o.suppressAlwaysAllowRule && suggestions.length > 0,
          alwaysRules: ruleTexts(suggestions),
          offerAuto: kind === 'permission' && (toolName === 'Bash' || toolName === 'PowerShell') && (mode === 'default' || mode === 'acceptEdits')
            && ctx.autoAvailable() && !matched,
          defaultToNo: o.defaultToNo === true, since: d.clock.now(),
        };
        if (o.displayName) ask.displayName = o.displayName;
        if (o.description) ask.description = o.description;
        if (o.decisionReason) ask.decisionReason = o.decisionReason;
        if (o.blockedPath) ask.blockedPath = o.blockedPath;
        if (o.agentID) ask.agentId = o.agentID;
        if (o.mcpServer) ask.mcpServer = { name: o.mcpServer.name, source: o.mcpServer.source };
        if (matched) ask.matchedAskRule = matched;
        if (kind === 'plan') {
          if (typeof input['plan'] === 'string') ask.plan = input['plan'];
          if (typeof input['planFilePath'] === 'string') ask.planFilePath = input['planFilePath'];
        }
        if (kind === 'question' && Array.isArray(input['questions'])) ask.questions = input['questions'] as P.AskQuestion[];
        if (toolName === 'Write') {
          ask.diffBase = await readDiffBase(ctx.cwd, input['file_path']);
          if (typeof chat === 'function') ask.chatId = chat();           // re-read: a re-key may have happened meanwhile
        }
        const r = await register(ask.chatId, ask, input, suggestions, ctx, o.signal);
        return r as PermissionResult | null;
      };
    },
    onElicitation(chat, ctx) {
      return async (req, o) => {
        const chatId = typeof chat === 'function' ? chat() : chat;
        const ask: P.PendingAsk = {
          chatId, requestId: o.requestId, toolUseId: req.elicitationId ?? '', kind: 'elicitation', toolName: 'Elicitation', input: {},
          offerAlways: false, alwaysRules: [], offerAuto: false, defaultToNo: false, since: d.clock.now(),
          elicitation: { mode: req.mode ?? 'form', server: req.serverName, message: req.message,
            ...(req.requestedSchema ? { schema: req.requestedSchema } : {}), ...(req.url ? { url: req.url } : {}) },
        };
        if (req.displayName) ask.displayName = req.displayName;
        if (req.description) ask.description = req.description;
        const r = await register(chatId, ask, {}, [], ctx, o.signal);
        return r as ElicitationResult | null;
      };
    },
    decide(chatId, requestId, a) {
      const e = byChat.get(chatId)?.get(requestId);
      if (!e || e.state !== 'open') return 'not_pending';
      let answer = a;
      if (answer.kind === 'allow-always' && answer.scope !== 'session' && !e.ctx.cwdSafe) answer = { kind: 'allow-always', scope: 'session' };
      let r: PermissionResult | ElicitationResult;
      try {
        r = e.ask.kind === 'elicitation' ? toElicitationResult(answer)
          : toPermissionResult(e.ask, answer, { input: e.input, suggestions: e.suggestions, allowBypass: e.ctx.allowBypass });
      } catch (err) {
        d.log?.error('permissions: answer mapping failed', { err: String(err) });
        return 'not_pending';
      }
      byChat.get(chatId)!.delete(requestId);
      chatOf.delete(requestId);
      e.resolve(r);                                             // first decision wins
      emit('askEnd', () => d.sink.askEnd(chatId, requestId, 'answered'));   // askEnd() before the facts that uncount it
      emit('onChange', () => d.onChange(chatId));
      return 'ok';
    },
    count: (chatId) => byChat.get(chatId)?.size ?? 0,
    list: (chatId) => (chatId ? [...(byChat.get(chatId)?.values() ?? [])] : [...byChat.values()].flatMap((t) => [...t.values()]))
      .filter((e) => e.state === 'open').map((e) => e.ask),
    endAll(chatId, reason) { for (const id of [...(byChat.get(chatId)?.keys() ?? [])]) finalize(id, reason); },
    rekey(from, to) {
      const t = byChat.get(from);
      if (!t) return;
      byChat.delete(from);
      for (const [id, e] of t) { e.ask = { ...e.ask, chatId: to }; table(to).set(id, e); chatOf.set(id, to); }
    },
  };
}
