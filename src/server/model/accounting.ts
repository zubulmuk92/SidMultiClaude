// src/server/model/accounting.ts — usage deltas, auxTokens, context, TTL, cache-miss rule, wake estimate (SPEC §2.12).
// Pure helpers; the live reducer and the disk rebuild use them, the server shell uses wakeEstimate / wakeDialog / baselineFromEntries.
import type { WakeEstimate } from '../contracts.ts';
import type * as P from '../../shared/protocol.ts';
import {
  AUTO_COMPACT_MARGIN_TOKENS, CACHE_MISS_MIN_RATIO, CACHE_MISS_MIN_TOKENS, CACHE_TTL_1H_MS, CACHE_TTL_5M_MS,
  WAKE_DIALOG_IDLE_MS, WAKE_DIALOG_MIN_CONTEXT, WAKE_SHARED_ACCOUNT_TOKENS, WAKE_SHARED_SAME_CWD_TOKENS,
} from '../../shared/limits.ts';
import { num, rec } from './blocks.ts';

/** max(0, ctx − 19 000) same account + cwd within the hour · − 16 800 same account only · else ctx. */
export const wakeEstimate: WakeEstimate = (lastContext, shared) => {
  const ctx = Math.max(0, Number.isFinite(lastContext) ? lastContext : 0);
  const sharedTokens = shared === 'sameCwd' ? WAKE_SHARED_SAME_CWD_TOKENS : shared === 'account' ? WAKE_SHARED_ACCOUNT_TOKENS : 0;
  return Math.max(0, ctx - sharedTokens);
};
/** The wake dialog shows when the chat was idle > 1 h and its context is > 100 k (and the user did not opt out). */
export const wakeDialog = (lastContext: number, idleMs: number, neverAsk: boolean): boolean =>
  !neverAsk && idleMs > WAKE_DIALOG_IDLE_MS && lastContext > WAKE_DIALOG_MIN_CONTEXT;

export type UsageTokens = { input: number; cacheRead: number; cacheWrite: number; output: number };
/** An API `usage` object (snake case) → token counts (0 for missing fields). */
export function usageTokens(u: unknown): UsageTokens {
  const r = rec(u);
  return { input: num(r['input_tokens']) ?? 0, cacheRead: num(r['cache_read_input_tokens']) ?? 0,
    cacheWrite: num(r['cache_creation_input_tokens']) ?? 0, output: num(r['output_tokens']) ?? 0 };
}
export const usageTotal = (t: UsageTokens): number => t.input + t.cacheRead + t.cacheWrite + t.output;
/** contextTokens = input + cache_read + cache_creation (of the latest message_start, or the last assistant usage on disk). */
export const contextOf = (u: unknown): number => { const t = usageTokens(u); return t.input + t.cacheRead + t.cacheWrite; };
export const autoCompactAt = (contextWindow: number): number => Math.max(0, contextWindow - AUTO_COMPACT_MARGIN_TOKENS);

/** Σ over models of result.modelUsage tokens (camel case; cumulative per session, restored from cost-state on resume). */
export function modelUsageTotal(mu: unknown): number {
  let total = 0;
  for (const v of Object.values(rec(mu))) {
    const r = rec(v);
    total += (num(r['inputTokens']) ?? 0) + (num(r['outputTokens']) ?? 0) + (num(r['cacheReadInputTokens']) ?? 0) + (num(r['cacheCreationInputTokens']) ?? 0);
  }
  return total;
}
/** Models whose cumulative usage grew between two modelUsage snapshots (the models of one turn). */
export function modelsUsed(prev: unknown, cur: unknown): string[] {
  const p = rec(prev);
  const out: string[] = [];
  for (const [m, v] of Object.entries(rec(cur))) {
    if (modelUsageTotal({ m: v }) > modelUsageTotal({ m: p[m] })) out.push(m);
  }
  return out;
}
/** auxTokens = Δ Σ modelUsage − the turn's main usage (≥ 0; non-zero only for subagents, classifier, compaction, hidden calls). */
export function auxTokens(prevModelTotal: number | undefined, curModelTotal: number, turnUsage: UsageTokens): number | undefined {
  if (prevModelTotal === undefined) return undefined;
  return Math.max(0, curModelTotal - prevModelTotal - usageTotal(turnUsage));
}
/** Cost of a turn: Δ of the cumulative total_cost_usd (rounded to 1e-8 to drop float noise). */
export function costDelta(prevTotal: number | undefined, curTotal: number | undefined): number | undefined {
  if (curTotal === undefined) return undefined;
  const d = curTotal - (prevTotal ?? 0);
  return Math.max(0, Math.round(d * 1e8) / 1e8);
}
/** Cache TTL from a usage's cache_creation split: 5 min when only ephemeral_5m was written, 1 h otherwise; `prev` when nothing was written. */
export function ttlFromUsage(u: unknown, prev: number = CACHE_TTL_1H_MS): number {
  const cc = rec(rec(u)['cache_creation']);
  const m5 = num(cc['ephemeral_5m_input_tokens']) ?? 0;
  const h1 = num(cc['ephemeral_1h_input_tokens']) ?? 0;
  if (m5 > 0 && h1 === 0) return CACHE_TTL_5M_MS;
  if (h1 > 0) return CACHE_TTL_1H_MS;
  return prev;
}
/** Cache-miss rule: cache_creation > 30 % of (input + cache_read + cache_creation) and > 10 k. */
export function isCacheMiss(t: UsageTokens): boolean {
  const all = t.input + t.cacheRead + t.cacheWrite;
  return t.cacheWrite > CACHE_MISS_MIN_TOKENS && all > 0 && t.cacheWrite > CACHE_MISS_MIN_RATIO * all;
}
export type CacheMissCause = 'model' | 'effort' | 'resume' | 'compaction' | 'expired' | 'images' | 'unknown';
/** Most likely cause, from local events of the turn (first match wins). */
export function cacheMissCause(e: { modelChanged?: boolean; effortChanged?: boolean; resumed?: boolean; compacted?: boolean; idleMs?: number; ttlMs?: number; images?: boolean }): CacheMissCause {
  if (e.compacted) return 'compaction';
  if (e.modelChanged) return 'model';
  if (e.effortChanged) return 'effort';
  if (e.resumed) return 'resume';
  if (e.idleMs !== undefined && e.ttlMs !== undefined && e.idleMs > e.ttlMs) return 'expired';
  if (e.images) return 'images';
  return 'unknown';
}
export const cacheWarmUntil = (lastRequestAt: number | undefined, ttlMs: number): number | undefined =>
  lastRequestAt === undefined ? undefined : lastRequestAt + ttlMs;

export type { CostBaseline } from '../contracts.ts';
import type { CostBaseline } from '../contracts.ts';
/** Baseline of a resumed / forked process: the LAST `cost-state` entry of the transcript tail (SPEC §2.12). */
export function baselineFromEntries(entries: readonly unknown[]): CostBaseline | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const x = rec(entries[i]);
    const e = 'off' in x && 'e' in x ? rec(x['e']) : x;   // a RawEntry or a parsed line
    if (e['type'] !== 'cost-state') continue;
    const modelUsage = rec(e['modelUsage']);
    return { costUsd: num(e['totalCostUSD']), modelUsage, tokens: modelUsageTotal(modelUsage) };
  }
  return null;
}
/** Disk footer: Σ message.usage per DISTINCT message.id (one API message spans several entries). */
export function footerFromUsages(byMessage: ReadonlyMap<string, unknown>, models: readonly string[]): P.TurnFooter {
  const f: P.TurnFooter = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, models: [...models] };
  for (const u of byMessage.values()) {
    const t = usageTokens(u);
    f.input += t.input; f.cacheRead += t.cacheRead; f.cacheWrite += t.cacheWrite; f.output += t.output;
  }
  return f;
}
