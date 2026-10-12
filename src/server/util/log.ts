// src/server/util/log.ts — redacting, rotating JSON-lines logger.
// SPEC §7.1 / §10 S10: logs\server-YYYYMMDD.log, at most 5 files × 5 MB, NO message content by default, and redaction of
// `sk-ant-…`, `Bearer …`, accessToken / refreshToken, boot codes and device tokens (registered with addSecret).
// Line format: {"t":"<ISO>","lvl":"info","msg":"…","scope":"engine",…fields}. Writes are synchronous appends on an fd
// opened through fs-guard (a few µs per line; nothing is lost on a crash).
import fs from 'node:fs';
import path from 'node:path';
import type { Clock, Logger } from '../contracts.ts';
import { fsGuard } from './fs-guard.ts';
import type { FsGuard } from './fs-guard.ts';
import { realClock } from './clock.ts';
import { LOG_FIELD_MAX_CHARS, LOG_MAX_FILE_BYTES, LOG_MAX_FILES } from '../../shared/limits.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface AppLogger extends Logger {
  debug(msg: string, f?: Record<string, unknown>): void;
  /** Same sink, with `scope` (and base fields) added to every line. */
  child(scope: string, base?: Record<string, unknown>): AppLogger;
  /** Registers an exact secret (device token, boot code) that must never appear in a line. */
  addSecret(s: string): void;
  close(): void;
  readonly file: string | null;
}

export type LoggerOptions = {
  dir: string | null;                 // null: no file (console only, if enabled)
  name?: string;                      // file prefix, default 'server' → server-YYYYMMDD.log
  level?: LogLevel;                   // default 'info'
  console?: boolean;                  // also write to stderr (dev); default false
  debugContent?: boolean;             // keep message-content fields (debug mode only); default false
  maxFileBytes?: number;              // default 5 MB
  maxFiles?: number;                  // default 5 (oldest deleted)
  clock?: Clock;
  fs?: FsGuard;
};

// ------------------------------------------------------------------ redaction
const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[\w-]+/g, 'sk-ant-***'],
  [/Bearer\s+\S+/gi, 'Bearer ***'],
  [/("?(?:accessToken|refreshToken|access_token|refresh_token|apiKey|api_key|deviceToken|token)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1***'],
  [/(#boot=)[\w-]+/g, '$1***'],
  [/(smc\.(?:boot|auth)\.)[\w-]+/g, '$1***'],
  [/(code#state\s*)\S+/gi, '$1***'],
];
/** Keys whose value is a secret: always replaced. */
const SECRET_KEY_RE = /^(?:accessToken|refreshToken|access_token|refresh_token|token|deviceToken|bootCode|loginCode|authorization|apiKey|api_key|password|secret|cookie)$/i;
/** Keys that carry message content: replaced by a size unless debugContent (S10 "no message content in logs by default"). */
const CONTENT_KEY_RE = /^(?:text|content|prompt|md|input|output|stdout|stderr|plan|answers|thinking|draft|lastPrompt|firstPrompt|body|data|base64|result|summary|feedback|title)$/i;

export function redact(s: string, secrets: Iterable<string> = []): string {
  let out = s;
  for (const sec of secrets) if (sec && sec.length >= 8) out = out.split(sec).join('***');
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

function cut(s: string): string {
  return s.length > LOG_FIELD_MAX_CHARS ? `${s.slice(0, LOG_FIELD_MAX_CHARS)}…(+${s.length - LOG_FIELD_MAX_CHARS})` : s;
}

/** Deep-copies fields with secrets redacted, content replaced by a size marker, long strings cut and errors flattened. */
export function sanitizeFields(f: Record<string, unknown>, o: { secrets?: Iterable<string>; debugContent?: boolean } = {}): Record<string, unknown> {
  const secrets = [...(o.secrets ?? [])];
  const seen = new WeakSet<object>();
  const walk = (v: unknown, key: string, depth: number): unknown => {
    if (SECRET_KEY_RE.test(key) && v !== undefined && v !== null && v !== '') return '***';
    if (!o.debugContent && CONTENT_KEY_RE.test(key) && v !== undefined && v !== null) {
      if (typeof v === 'string') return `[${v.length} chars]`;
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      return '[content]';
    }
    if (typeof v === 'string') return cut(redact(v, secrets));
    if (typeof v === 'bigint') return v.toString();
    if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' ? String(v) : v;
    if (v instanceof Error) {
      const e = v as Error & { code?: unknown };
      return { name: e.name, message: cut(redact(e.message, secrets)), code: e.code, stack: e.stack ? cut(redact(e.stack, secrets)) : undefined };
    }
    if (seen.has(v)) return '[circular]';
    if (depth > 6) return '[depth]';
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, key, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k, depth + 1);
    return out;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) out[k] = walk(v, k, 0);
  return out;
}

// ------------------------------------------------------------------ file sink with rotation
const pad = (n: number): string => String(n).padStart(2, '0');
const dayOf = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };

type Sink = { write(line: string, now: number): void; close(): void; file(): string | null };

function fileSink(dir: string, name: string, maxBytes: number, maxFiles: number, g: FsGuard): Sink {
  let fd: number | null = null;
  let current: string | null = null;
  let day = '';
  let size = 0;
  const fileRe = new RegExp(`^${name}-(\\d{8})(?:-(\\d+))?\\.log$`);
  /** Keeps the `maxFiles` newest files; age comes from the name (day, then rotation index), never from mtimes. */
  function prune(): void {
    let files: { f: string; k: number }[] = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = fileRe.exec(f);
        if (m) files.push({ f, k: Number(m[1]) * 1e6 + Number(m[2] ?? 0) });
      }
    } catch { return; }
    files.sort((a, b) => b.k - a.k);
    for (const { f } of files.slice(maxFiles)) { try { g.rmSync(path.join(dir, f), { force: true }); } catch { /* best effort */ } }
  }
  function open(now: number): void {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = null; }
    g.mkdirSync(dir, { recursive: true });
    day = dayOf(now);
    // Continue the highest rotation index of the day (never refill a pruned gap: it would sort as the oldest file).
    let top = -1;
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = fileRe.exec(f);
        if (m && m[1] === day) top = Math.max(top, Number(m[2] ?? 0));
      }
    } catch { /* empty dir */ }
    const fileOf = (i: number): string => path.join(dir, i === 0 ? `${name}-${day}.log` : `${name}-${day}-${i}.log`);
    let i = Math.max(top, 0);
    let sz = 0;
    try { sz = fs.statSync(fileOf(i)).size; } catch { sz = 0; }
    if (sz >= maxBytes) { i++; sz = 0; }
    current = fileOf(i);
    size = sz;
    fd = g.openAppendSync(current);
    prune();
  }
  return {
    write(line, now) {
      if (fd === null || dayOf(now) !== day || size >= maxBytes) open(now);
      const buf = Buffer.from(line + '\n', 'utf8');
      fs.writeSync(fd!, buf);
      size += buf.length;
    },
    close() { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = null; } },
    file: () => current,
  };
}

// ------------------------------------------------------------------ logger
export function createLogger(o: LoggerOptions): AppLogger {
  const clock = o.clock ?? realClock;
  const min = LEVELS[o.level ?? 'info'];
  const secrets = new Set<string>();
  let sink: Sink | null = null;
  if (o.dir) sink = fileSink(o.dir, o.name ?? 'server', o.maxFileBytes ?? LOG_MAX_FILE_BYTES, o.maxFiles ?? LOG_MAX_FILES, o.fs ?? fsGuard());
  let broken = false;

  function emit(lvl: LogLevel, msg: string, scope: string | undefined, base: Record<string, unknown> | undefined, f: Record<string, unknown> | undefined): void {
    if (LEVELS[lvl] < min) return;
    const now = clock.now();
    const fields = sanitizeFields({ ...(base ?? {}), ...(f ?? {}) }, { secrets, debugContent: o.debugContent ?? false });
    const rec: Record<string, unknown> = { t: new Date(now).toISOString(), lvl, msg: cut(redact(msg, secrets)) };
    if (scope) rec['scope'] = scope;
    for (const [k, v] of Object.entries(fields)) if (!(k in rec)) rec[k] = v;
    let line: string;
    try { line = JSON.stringify(rec); } catch { line = JSON.stringify({ t: rec['t'], lvl, msg: rec['msg'], note: 'unserialisable fields' }); }
    if (o.console) process.stderr.write(line + '\n');
    if (sink && !broken) {
      try { sink.write(line, now); } catch (e) {
        broken = true;                                   // never throw from a log call; report once on stderr
        process.stderr.write(`[log] file sink disabled: ${String(e)}\n`);
      }
    }
  }
  function make(scope: string | undefined, base: Record<string, unknown> | undefined): AppLogger {
    return {
      debug: (m, f) => emit('debug', m, scope, base, f),
      info: (m, f) => emit('info', m, scope, base, f),
      warn: (m, f) => emit('warn', m, scope, base, f),
      error: (m, f) => emit('error', m, scope, base, f),
      child: (s, b) => make(scope ? `${scope}.${s}` : s, { ...(base ?? {}), ...(b ?? {}) }),
      addSecret: (s) => { if (s) secrets.add(s); },
      close: () => sink?.close(),
      get file() { return sink?.file() ?? null; },
    };
  }
  return make(undefined, undefined);
}

/** Discards everything (tests, modules without a logger). */
export const nullLogger: AppLogger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return nullLogger; },
  addSecret() {}, close() {},
  file: null,
};

/** In-memory logger for tests: records sanitised lines. */
export function memoryLogger(): AppLogger & { lines: { lvl: LogLevel; msg: string; f: Record<string, unknown> }[] } {
  const lines: { lvl: LogLevel; msg: string; f: Record<string, unknown> }[] = [];
  const secrets = new Set<string>();
  const make = (scope: string | undefined, base: Record<string, unknown> | undefined): AppLogger => {
    const push = (lvl: LogLevel) => (msg: string, f?: Record<string, unknown>): void => {
      lines.push({ lvl, msg: redact(msg, secrets), f: sanitizeFields({ ...(scope ? { scope } : {}), ...(base ?? {}), ...(f ?? {}) }, { secrets }) });
    };
    return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error'),
      child: (s, b) => make(scope ? `${scope}.${s}` : s, { ...(base ?? {}), ...(b ?? {}) }),
      addSecret: (s) => { if (s) secrets.add(s); }, close() {}, file: null };
  };
  return Object.assign(make(undefined, undefined), { lines });
}
