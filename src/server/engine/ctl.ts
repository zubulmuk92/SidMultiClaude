// src/server/engine/ctl.ts — control-call wrapper: 10 s timeout, feature detection, typed errors (SPEC §2.3).
// Every control call of the engine goes through ctl(): it never hangs (robust P1) and every failure is an EngineError.
import type { Clock } from '../contracts.ts';
import type * as P from '../../shared/protocol.ts';
import { CONTROL_CALL_TIMEOUT_MS } from '../../shared/limits.ts';

/** Typed engine failure. `code` is a wire ErrorCode, so the server shell maps it to `ack.err` as is. */
export class EngineError extends Error {
  readonly code: P.ErrorCode;
  constructor(code: P.ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'EngineError';
    this.code = code;
  }
}
export const isEngineError = (e: unknown): e is EngineError => e instanceof EngineError;

/** Runtime-only Query methods (absent from the .d.ts on some versions): always feature-detected before use. */
export const RUNTIME_ONLY = new Set(['cancelAsyncMessage', 'renameSession', 'listPermissionRules', 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']);

export function hasMethod(q: unknown, name: string): boolean {
  return !!q && typeof (q as Record<string, unknown>)[name] === 'function';
}

const realTimer: Clock['timer'] = (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; };

/** Runs one control call with a timeout; never hangs. Runtime-only methods are feature-detected (typeof q[name] === 'function'). */
export function ctl<T>(name: string, fn: () => Promise<T>, timeoutMs: number = CONTROL_CALL_TIMEOUT_MS, clock?: Pick<Clock, 'timer'>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = (clock?.timer ?? realTimer)(timeoutMs, () => {
      if (settled) return;
      settled = true;
      reject(new EngineError('timeout', `control call ${name} timed out after ${timeoutMs} ms`));
    });
    let p: Promise<T>;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    p.then(
      (v) => { if (settled) return; settled = true; timer.cancel(); resolve(v); },
      (e: unknown) => {
        if (settled) return;
        settled = true;
        timer.cancel();
        reject(isEngineError(e) ? e : new EngineError('internal', `control call ${name} failed: ${e instanceof Error ? e.message : String(e)}`));
      },
    );
  });
}

/** Calls `q[name](...args)` through ctl(), or rejects with `unsupported` when the method is missing. */
export function ctlMethod<T>(q: unknown, name: string, args: readonly unknown[], timeoutMs?: number, clock?: Pick<Clock, 'timer'>): Promise<T> {
  if (!hasMethod(q, name)) return Promise.reject(new EngineError('unsupported', `${name} is not supported by this Claude Code version`));
  const f = (q as Record<string, (...a: unknown[]) => Promise<T>>)[name]!;
  return ctl<T>(name, () => f.apply(q, [...args]), timeoutMs, clock);
}
