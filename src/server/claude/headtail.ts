// src/server/claude/headtail.ts — SDK head/tail 64 KiB metadata algorithm + backwards fallback.
// The string scanners mirror @anthropic-ai/claude-agent-sdk 0.3.293 (`Ft`, `Ha`, `HS`, `Ef`, `Cf`, `ii`, `vI`, `Ya`) so the
// index agrees with SDK listSessions/getSessionInfo (checked by the unit tests). Only the 64 KiB head and tail are read; a giant
// last line that hides the metadata block triggers a backwards skip over whole lines (never a full parse).
import fs from 'node:fs';
import path from 'node:path';
import { HEADTAIL_BYTES, TAIL_STEP_BYTES, TAIL_MAX_BYTES, INDEX_TEXT_MAX_CHARS } from '../../shared/limits.ts';

const MiB = 1024 * 1024;
const FALLBACK_SCAN_MAX = 32 * MiB;     // giant lines are ≤ 12.5 MB on this machine; stop well beyond
const HAS_MESSAGES_SCAN_MAX = 16 * MiB; // SDK: "has messages" scan ≤ 16 MB

export type HeadTail = { head: string; tail: string; size: number; mtimeMs: number; birthtimeMs: number };

/** First and last 64 KiB of a file (SDK `li`). null when missing, empty or not a file. */
export async function readHeadTail(file: string): Promise<HeadTail | null> {
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(file, 'r'); } catch { return null; }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size === 0) return null;
    const buf = Buffer.allocUnsafe(HEADTAIL_BYTES);
    const h = await fh.read(buf, 0, HEADTAIL_BYTES, 0);
    const head = buf.toString('utf8', 0, h.bytesRead);
    let tail = head;
    const tailStart = Math.max(0, st.size - HEADTAIL_BYTES);
    if (tailStart > 0) {
      const t = await fh.read(buf, 0, HEADTAIL_BYTES, tailStart);
      tail = buf.toString('utf8', 0, t.bytesRead);
    }
    return { head, tail, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs };
  } catch { return null; } finally { await fh.close().catch(() => undefined); }
}

// ------------------------------------------------------------------ SDK string scanners
function unescapeJson(s: string): string {
  if (!s.includes('\\')) return s;
  try { return JSON.parse(`"${s}"`) as string; } catch { return s; }
}
/** SDK `Ft`: value of the LAST `"key":"…"` occurrence (string scan, no parse). */
export function lastStr(text: string, key: string): string | undefined {
  let out: string | undefined;
  let best = -1;
  for (const pat of [`"${key}":"`, `"${key}": "`]) {
    let from = 0;
    for (;;) {
      const a = text.indexOf(pat, from);
      if (a < 0) break;
      const start = a + pat.length;
      let c = start;
      while (c < text.length) {
        if (text[c] === '\\') { c += 2; continue; }
        if (text[c] === '"') { if (a > best) { out = unescapeJson(text.slice(start, c)); best = a; } break; }
        c++;
      }
      from = c + 1;
    }
  }
  return out;
}
/** SDK `Ha`: value of the FIRST `"key":"…"` occurrence. */
export function firstStr(text: string, key: string): string | undefined {
  for (const pat of [`"${key}":"`, `"${key}": "`]) {
    const a = text.indexOf(pat);
    if (a < 0) continue;
    const start = a + pat.length;
    let c = start;
    while (c < text.length) {
      if (text[c] === '\\') { c += 2; continue; }
      if (text[c] === '"') return unescapeJson(text.slice(start, c));
      c++;
    }
  }
  return undefined;
}
/** SDK `HS`: first line containing `"key":` that parses and has a string value for it. */
export function firstParsedStr(text: string, key: string): string | undefined {
  const needle = `"${key}":`;
  for (const line of text.split('\n')) {
    if (!line.includes(needle)) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (o && typeof o === 'object') { const v = (o as Record<string, unknown>)[key]; if (typeof v === 'string') return v; }
    } catch { /* partial line */ }
  }
  return undefined;
}
/** SDK `Ef`: last line of `type` whose `key` is a string. */
export function lastTypedStr(text: string, type: string, key: string): string | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.includes(`"${key}":`) || !l.includes(`"type":"${type}"`)) continue;
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      if (o && o['type'] === type && typeof o[key] === 'string') return o[key] as string;
    } catch { /* partial line */ }
  }
  return undefined;
}

// ------------------------------------------------------------------ prompts (SDK `ii`, `Cf`, `vI`)
const COMMAND_RE = /<command-name>(.*?)<\/command-name>/;
const SKIP_RE = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;
/** Cut to n UTF-16 units without splitting a surrogate pair. */
export function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? s.slice(0, n - 1) : s.slice(0, n);
}
/** SDK `PS`/`Y7`: each `<pasted_content id="abcd">\n…\n</pasted_content id="abcd">` block becomes its body. */
export function unwrapPasted(s: string): string {
  const OPEN = '<pasted_content id="';
  const parts: string[] = [];
  let last = 0;
  let from = 0;
  let blocks = 0;
  for (;;) {
    const o = s.indexOf(OPEN, from);
    if (o === -1) break;
    const at = o + OPEN.length;
    const id = s.slice(at, at + 4);
    if (!/^[0-9a-f]{4}$/.test(id) || !s.startsWith('">\n', at + 4)) { from = at; continue; }
    const body = at + 7;
    const close = `</pasted_content id="${id}">`;
    const d = s.indexOf(`\n${close}`, body - 1) + 1;
    if (d === 0) break;
    let p = o;
    for (let k = 0; k < 2 && p > last && s[p - 1] === '\n'; k++) p--;
    if (p > last) parts.push(s.slice(last, p));
    parts.push(s.slice(body, d - 1));
    blocks++;
    last = d + close.length;
    for (let k = 0; k < 2 && s[last] === '\n'; k++) last++;
    from = last;
  }
  if (!blocks) return s;
  if (last < s.length) parts.push(s.slice(last));
  return parts.join('');
}
/** Display text of a human prompt entry, or undefined (tool results, meta, wrappers). `fb` collects a /command fallback. */
export function promptText(e: Record<string, unknown>, fb: { command: string } = { command: '' }): string | undefined {
  if (e['type'] !== 'user' || e['isMeta'] === true || e['isCompactSummary'] === true) return undefined;
  const msg = e['message'] as Record<string, unknown> | undefined;
  if (!msg) return undefined;
  const content = msg['content'];
  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object') continue;
      if (b['type'] === 'tool_result') return undefined;
      if (b['type'] === 'text' && typeof b['text'] === 'string') texts.push(b['text']);
    }
  }
  for (const t of texts) {
    let s = unwrapPasted(t).replaceAll('\n', ' ').trim();
    if (!s) continue;
    const cmd = COMMAND_RE.exec(s);
    if (cmd) { if (!fb.command) fb.command = cmd[1] ?? ''; continue; }
    const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(s);
    if (bash) return `! ${(bash[1] ?? '').trim()}`;
    if (SKIP_RE.test(s)) continue;
    if (s.length > INDEX_TEXT_MAX_CHARS) s = cut(s, INDEX_TEXT_MAX_CHARS).trim() + '…';
    return s;
  }
  return undefined;
}
/** SDK `Cf`: first real prompt of the head. */
export function firstPrompt(head: string): string {
  const fb = { command: '' };
  for (const l of head.split('\n')) {
    if (!l.includes('"type":"user"') && !l.includes('"type": "user"')) continue;
    if (l.includes('"tool_result"')) continue;
    if (l.includes('"isMeta":true') || l.includes('"isMeta": true')) continue;
    if (l.includes('"isCompactSummary":true') || l.includes('"isCompactSummary": true')) continue;
    try { const t = promptText(JSON.parse(l) as Record<string, unknown>, fb); if (t !== undefined) return t; } catch { /* partial */ }
  }
  return fb.command;
}
/** SDK `vI`: « Image » / « Document » placeholder when the first prompt has no text. */
export function promptPlaceholder(head: string): string {
  for (const l of head.split('\n')) {
    if (!l.includes('"type":"user"') && !l.includes('"type": "user"')) continue;
    if (l.includes('"tool_result"') || l.includes('"isMeta":true') || l.includes('"isMeta": true')) continue;
    if (l.includes('"type":"image"') || l.includes('"type": "image"')) return 'Image';
    if (l.includes('"type":"document"') || l.includes('"type": "document"')) return 'Document';
  }
  return '';
}

// ------------------------------------------------------------------ backwards fallback over giant lines
async function readRange(fh: fs.promises.FileHandle, start: number, end: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(Math.max(0, end - start));
  let got = 0;
  while (got < buf.length) {
    const r = await fh.read(buf, got, buf.length - got, start + got);
    if (r.bytesRead === 0) break;
    got += r.bytesRead;
  }
  return buf.subarray(0, got);
}
/** Byte offset of the start of the line that ends at `end` (exclusive; a '\n' at end-1 is that line's terminator). */
export async function lineStartBefore(fh: fs.promises.FileHandle, end: number, maxScan: number): Promise<number | null> {
  let pos = end;
  let scanned = 0;
  let first = true;
  while (pos > 0) {
    const step = scanned < TAIL_MAX_BYTES ? TAIL_STEP_BYTES : MiB;
    const start = Math.max(0, pos - step);
    const buf = await readRange(fh, start, pos);
    let hay = buf;
    if (first && hay.length > 0 && hay[hay.length - 1] === 0x0a) hay = hay.subarray(0, hay.length - 1);
    first = false;
    const i = hay.lastIndexOf(0x0a);
    if (i >= 0) return start + i + 1;
    scanned += pos - start;
    pos = start;
    if (scanned > maxScan) return null;
  }
  return 0;
}
/**
 * Messages (and metadata) hidden by a giant last line: skips whole lines backwards (byte scan, no parse) and returns the
 * COMPLETE lines of the 64 KiB window that ends where the skipped lines start, once it holds a user/assistant line.
 * null if none within 32 MiB. A window without one is skipped as a whole (never line by line).
 */
export async function fallbackTail(file: string, size: number): Promise<string | null> {
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(file, 'r'); } catch { return null; }
  try {
    let end = size;
    let budget = FALLBACK_SCAN_MAX;
    while (end > 0 && budget > 0) {
      const ls = await lineStartBefore(fh, end, budget);
      if (ls === null || ls === 0) return null;
      budget -= end - ls;
      const winStart = Math.max(0, ls - HEADTAIL_BYTES);
      const buf = await readRange(fh, winStart, ls);
      const cut = winStart === 0 ? 0 : buf.indexOf(0x0a) + 1;   // the window's first line is partial (unless at 0)
      const win = winStart === 0 || cut > 0 ? buf.toString('utf8', cut) : '';
      if (/"type":"(?:user|assistant)"/.test(win)) return win;
      if (winStart === 0) return null;
      end = cut > 0 && cut < buf.length ? winStart + cut : ls;
      budget -= ls - end;
    }
    return null;
  } catch { return null; } finally { await fh.close().catch(() => undefined); }
}
/** SDK "has messages" (`FN`): `"parentUuid":` in head or tail, else a forward byte scan; past 16 MB it assumes yes. */
export async function hasMessages(file: string, ht: HeadTail): Promise<boolean> {
  if (ht.head.includes('"parentUuid":') || ht.tail.includes('"parentUuid":')) return true;
  if (ht.size <= HEADTAIL_BYTES) return false;
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(file, 'r'); } catch { return false; }
  try {
    const needle = Buffer.from('"parentUuid":');
    for (let pos = 0; pos < Math.min(ht.size, HAS_MESSAGES_SCAN_MAX); pos += MiB) {
      const b = await readRange(fh, Math.max(0, pos - needle.length), Math.min(ht.size, pos + MiB));
      if (b.includes(needle)) return true;
    }
    return ht.size > HAS_MESSAGES_SCAN_MAX;
  } finally { await fh.close().catch(() => undefined); }
}
/** `<dir>\<sessionId>\custom-title.json` → customTitle (SDK `Za`, sanitised). */
export async function sidecarTitle(file: string, sessionId: string): Promise<string | undefined> {
  try {
    const raw = await fs.promises.readFile(path.join(path.dirname(file), sessionId, 'custom-title.json'), 'utf8');
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o['customTitle'] !== 'string') return undefined;
    const t = [...o['customTitle'].trim().replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')].join('').trim();
    return t || undefined;
  } catch { return undefined; }
}

// ------------------------------------------------------------------ one session's metadata (SDK `Ya` + cheap extras)
export type TitleSource = 'custom' | 'ai' | 'lastPrompt' | 'firstPrompt' | 'none';
export type ModeId = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
const MODES = new Set<string>(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
export type FileMeta = {
  size: number; mtimeMs: number; birthtimeMs: number;
  title: string; titleSource: TitleSource; customTitle?: string; firstPrompt?: string;
  createdAt?: number; updatedAt?: number; gitBranch?: string; cwd?: string; entrypoint?: string; tag?: string;
  model?: string; lastContext?: number; lastRequestAt?: number; lastMode?: ModeId; costUsd?: number; ownerAccountUuid?: string;
  lastError?: { kind: 'rate_limit' | 'auth' | 'other'; resetsAt?: number };
};
const ts = (v: unknown): number | undefined => { if (typeof v !== 'string') return undefined; const n = Date.parse(v); return Number.isNaN(n) ? undefined : n; };
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Complete lines of a tail window (the first one is partial unless the window starts the file). */
function tailEntries(tail: string, startsFile: boolean): Record<string, unknown>[] {
  const lines = tail.split('\n');
  if (!startsFile) lines.shift();
  const out: Record<string, unknown>[] = [];
  for (const l of lines) {
    if (!l) continue;
    try { const o = JSON.parse(l) as unknown; if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as Record<string, unknown>); } catch { /* truncated */ }
  }
  return out;
}
/** Parsed complete lines of the last 64 KiB of a transcript (cost baseline of a resumed / forked chat); [] when unreadable.
 *  A giant last line hides the window: the 32 MiB fallback scan then gives the lines before it. */
export async function readTailEntries(file: string): Promise<Record<string, unknown>[]> {
  const ht = await readHeadTail(file);
  if (!ht) return [];
  const startsFile = ht.size <= HEADTAIL_BYTES;
  const out = tailEntries(ht.tail, startsFile);
  if (out.length || startsFile) return out;
  const fb = await fallbackTail(file, ht.size);
  return fb ? tailEntries(fb, true) : [];
}
/** Extras the SDK does not compute: last request, context, mode, cost, owner, error, updatedAt (user/assistant only). */
function tailExtras(entries: Record<string, unknown>[], m: FileMeta): boolean {
  let sawChain = false;
  let sawAssistant = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const type = e['type'];
    if (type === 'permission-mode' && m.lastMode === undefined && typeof e['permissionMode'] === 'string' && MODES.has(e['permissionMode'])) m.lastMode = e['permissionMode'] as ModeId;
    else if (type === 'cost-state' && m.costUsd === undefined && typeof e['totalCostUSD'] === 'number') m.costUsd = e['totalCostUSD'];
    else if (type === 'bridge-session' && m.ownerAccountUuid === undefined && typeof e['ownerAccountUuid'] === 'string') m.ownerAccountUuid = e['ownerAccountUuid'];
    if (e['isSidechain'] === true || (type !== 'user' && type !== 'assistant')) continue;
    sawChain = true;
    const at = ts(e['timestamp']);
    if (m.updatedAt === undefined && at !== undefined) m.updatedAt = at;
    if (type !== 'assistant' || m.lastRequestAt !== undefined) continue;
    const msg = (e['message'] ?? {}) as Record<string, unknown>;
    const isError = e['isApiErrorMessage'] === true || msg['model'] === '<synthetic>';
    if (isError) {
      // only the LATEST assistant entry decides whether the chat is currently in error
      if (!sawAssistant) {
        const err = e['error'];
        const q = e['quotaLimits'] as Record<string, unknown> | undefined;
        if (err === 'rate_limit') m.lastError = { kind: 'rate_limit', ...(typeof q?.['resetsAt'] === 'number' ? { resetsAt: q['resetsAt'] * 1000 } : {}) };
        else if (err === 'authentication_failed') m.lastError = { kind: 'auth' };
        else m.lastError = { kind: 'other' };
      }
      sawAssistant = true;
      continue;
    }
    sawAssistant = true;
    if (at !== undefined) m.lastRequestAt = at;
    if (typeof msg['model'] === 'string') m.model = msg['model'];
    const u = msg['usage'] as Record<string, unknown> | undefined;
    if (u) m.lastContext = num(u['input_tokens']) + num(u['cache_read_input_tokens']) + num(u['cache_creation_input_tokens']);
  }
  return sawChain;
}

/**
 * Metadata of `<projects>\<key>\<sessionId>.jsonl` from its head and tail, or null when the SDK would skip it
 * (sidechain head, no messages, nothing to show).
 */
export async function readFileMeta(file: string, sessionId: string, projectPath?: string): Promise<FileMeta | null> {
  const ht = await readHeadTail(file);
  if (!ht) return null;
  const nl = ht.head.indexOf('\n');
  const firstLine = nl >= 0 ? ht.head.slice(0, nl) : ht.head;   // SDK `Ya`: an empty first line is not a sidechain head
  if (firstLine.includes('"isSidechain":true') || firstLine.includes('"isSidechain": true')) return null;
  if (!(await hasMessages(file, ht))) return null;
  const startsFile = ht.size <= HEADTAIL_BYTES;
  let tail = ht.tail;
  const m: FileMeta = { size: ht.size, mtimeMs: ht.mtimeMs, birthtimeMs: ht.birthtimeMs, title: '', titleSource: 'none' };
  if (!tailExtras(tailEntries(tail, startsFile), m) && !startsFile) {
    // a giant last line hides the last messages (updatedAt, context, model…) and maybe the metadata block too
    const fb = await fallbackTail(file, ht.size);
    if (fb) {
      tailExtras(tailEntries(fb, true), m);                    // complete lines only
      if (!/"type":"last-prompt"/.test(tail)) tail = fb + '\n' + tail;   // titles from just before the giant line
    }
  }
  const head = ht.head;
  const tailTitle = lastStr(tail, 'customTitle');
  const side = tailTitle === undefined ? await sidecarTitle(file, sessionId) : undefined;
  const custom = tailTitle || side || lastStr(head, 'customTitle') || undefined;
  const ai = custom ? undefined : (lastStr(tail, 'aiTitle') || lastStr(head, 'aiTitle') || undefined);
  const fp = firstPrompt(head) || undefined;
  const lp = lastStr(tail, 'lastPrompt') || lastStr(tail, 'summary') || undefined;
  if (custom) { m.title = custom; m.titleSource = 'custom'; m.customTitle = custom; }
  else if (ai) { m.title = ai; m.titleSource = 'ai'; m.customTitle = ai; }
  else if (lp) { m.title = lp; m.titleSource = 'lastPrompt'; }
  else if (fp) { m.title = fp; m.titleSource = 'firstPrompt'; }
  else { const ph = promptPlaceholder(head); if (!ph) return null; m.title = ph; m.titleSource = 'none'; }
  if (fp) m.firstPrompt = fp;
  const created = ts(firstStr(head, 'timestamp'));
  if (created !== undefined) m.createdAt = created;
  const br = lastStr(tail, 'gitBranch') || firstStr(head, 'gitBranch');
  if (br) m.gitBranch = br;
  const cwd = lastTypedStr(tail, 'relocated', 'relocatedCwd') || firstParsedStr(head, 'cwd') || projectPath;
  if (cwd) m.cwd = cwd;
  const ep = firstStr(head, 'entrypoint') ?? lastStr(tail, 'entrypoint');
  if (ep) m.entrypoint = ep;
  const tagLine = tail.split('\n').findLast((l) => l.includes('"type":"tag"') && l.includes('"tag":"'));
  const tag = tagLine ? lastStr(tagLine, 'tag') : undefined;
  if (tag) m.tag = tag;
  return m;
}
