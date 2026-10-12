// src/server/engine/exe.ts — resolve the installed claude.exe / bundled binary; version probe from init (SPEC §1.3 C1).
// Installed native claude.exe by default (same binary as the user's terminal). The bundled one is opt-in and needs
// `npm run fetch-bundled-cli`. Every spawn logs claude_code_version and compares the initialize key set with a stored
// snapshot (0-cost drift detector, contract K2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as P from '../../shared/protocol.ts';

export const BUNDLED_PACKAGE = '@anthropic-ai/claude-agent-sdk-win32-x64';

function existingFile(p: string | undefined | null): string | null {
  if (!p) return null;
  try {
    if (!fs.statSync(p).isFile()) return null;
    return fs.realpathSync.native(p);                       // long form, exact case (8.3 names expanded)
  } catch { return null; }
}

/** The user's native install: %USERPROFILE%\.local\bin\claude.exe, else the first claude.exe on PATH. */
export function installedClaudeExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env['USERPROFILE'] ?? os.homedir();
  const direct = existingFile(path.join(home, '.local', 'bin', 'claude.exe'));
  if (direct) return direct;
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;             // never resolve against the cwd
    const hit = existingFile(path.join(dir, 'claude.exe'));
    if (hit) return hit;
  }
  return null;
}

/** The SDK-pinned binary (2.1.293), present only after `npm run fetch-bundled-cli`. */
export function bundledClaudeExe(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const sdkDir = path.dirname(req.resolve('@anthropic-ai/claude-agent-sdk'));
    const r2 = createRequire(path.join(sdkDir, 'package.json'));
    return existingFile(r2.resolve(`${BUNDLED_PACKAGE}/claude.exe`));
  } catch { return null; }
}

/**
 * Resolves the CLI binary. Under SMC_TEST=1 only, SMC_CLAUDE_EXE (e.g. test/fakes/fake-claude.mjs) overrides both
 * choices, so E2E runs never reach a real account.
 */
export function resolveClaudeExe(pref: 'installed' | 'bundled', env: NodeJS.ProcessEnv = process.env): P.Result<string, 'exe_missing'> {
  if (env['SMC_TEST'] === '1' && env['SMC_CLAUDE_EXE']) {
    const t = existingFile(path.resolve(env['SMC_CLAUDE_EXE']));
    return t ? { ok: true, data: t } : { ok: false, err: 'exe_missing' };
  }
  const p = pref === 'bundled' ? bundledClaudeExe() : installedClaudeExe(env);
  return p ? { ok: true, data: p } : { ok: false, err: 'exe_missing' };
}

/** `claude_code_version` of a system:init frame (sent at each turn start), if present. */
export function cliVersionOf(frame: unknown): string | undefined {
  const f = frame as { type?: unknown; subtype?: unknown; claude_code_version?: unknown } | null;
  return f && f.type === 'system' && f.subtype === 'init' && typeof f.claude_code_version === 'string' ? f.claude_code_version : undefined;
}

/** initializationResult() key set of the installed CLI, refreshed by `npm run test:contract` (K2). Drift → warning only. */
export const INIT_RESULT_KEYS: readonly string[] = Object.freeze([
  'account', 'agents', 'analytics_disabled', 'available_output_styles', 'capabilities', 'commands', 'current_permission_mode',
  'fast_mode_disabled_reason', 'fast_mode_state', 'feedback_mode', 'ide_rc_auto_enable_gate', 'models', 'output_style', 'pid',
  'remote_control_auto_connect_default', 'remote_control_auto_enable', 'remote_control_auto_on_by_default', 'remote_control_available',
  'session_state', 'user_output_styles_dir',
]);

export type KeyDrift = { added: string[]; removed: string[] };
/** Key-set drift between a live initialize answer (or system:init) and the stored snapshot. Empty arrays = no drift. */
export function keyDrift(actual: Record<string, unknown> | readonly string[], snapshot: readonly string[]): KeyDrift {
  const keys = new Set(Array.isArray(actual) ? actual : Object.keys(actual));
  const snap = new Set(snapshot);
  return { added: [...keys].filter((k) => !snap.has(k)).sort(), removed: [...snap].filter((k) => !keys.has(k)).sort() };
}
export const hasDrift = (d: KeyDrift): boolean => d.added.length > 0 || d.removed.length > 0;
