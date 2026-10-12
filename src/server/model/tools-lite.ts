// src/server/model/tools-lite.ts — per-tool summaries and head/tail cuts (ux §5.4 table), structuredPatch hunks.
// Pure. The same functions serve the live reducer and the disk rebuild, so a tool block is identical live and on reload.
// Heavy fields (full output, originalFile, image base64, full input) never enter a ToolInputView / UiToolResult:
// they come back as HeavyPiece[] for the stash (live) or as HeavyLoc (disk).
import type * as P from '../../shared/protocol.ts';
import { TOOL_OUTPUT_HEAD_BYTES, TOOL_OUTPUT_TAIL_BYTES } from '../../shared/limits.ts';
import { arr, contentImages, contentText, cut, firstLine, imageRefId, imageRefs, num, rec, str, toolStatusOf, denialOf } from './blocks.ts';
import type { Rec } from './blocks.ts';

export const FIELD_MAX_CHARS = 2000;     // one input field shown in a ToolInputView (the rest via detail(id,'input'))
export const PATCH_MAX_LINES = 2000;     // structuredPatch lines kept in a UiToolResult
export const DATA_TEXT_MAX = 64 * 1024;  // a long string in UiToolResult.data (plan text)

export type HeavyPiece = { id: string; field: P.DetailField; payload: P.DetailPayload; bytes: number };
export type RawToolResult = { content: unknown; isError: boolean; toolUseResult: unknown; denialKind?: unknown; decisionSource?: unknown };

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Input keys never shown: ExitPlanMode's assistant-frame copy of the plan can be stale. */
const HIDDEN_INPUT: Record<string, readonly string[]> = { ExitPlanMode: ['plan'] };

/** The main datum of a tool call (command, path, pattern, url…). Data, not French copy: the UI builds the sentence. */
export function toolSummary(name: string, input: Rec): string {
  const s = (k: string): string => str(input[k]);
  if (name === 'Bash' || name === 'PowerShell') return firstLine(s('command'));
  if (FILE_TOOLS.has(name)) return s('file_path') || s('notebook_path') || s('path');
  if (name === 'Grep' || name === 'Glob') return s('pattern');
  if (name === 'WebFetch') return s('url');
  if (name === 'WebSearch') return s('query');
  if (name === 'Agent' || name === 'Task') return firstLine(s('description') || s('prompt'));
  if (name === 'Skill') return s('skill') || s('command');
  if (name === 'AskUserQuestion') return firstLine(str(rec(arr(input['questions'])[0])['question']));
  if (name === 'ExitPlanMode') return s('planFilePath');
  if (name === 'TodoWrite') return String(arr(input['todos']).length);
  if (name === 'ToolSearch') return s('query');
  for (const v of Object.values(input)) if (typeof v === 'string' && v.trim()) return firstLine(v);
  return Object.keys(input).join(', ');
}

/** ToolInputView: summary + scalar fields (long strings cut, objects as JSON, `truncated` lists the cut keys). */
export function toolInputView(name: string, input: Record<string, unknown>): P.ToolInputView {
  const hidden = HIDDEN_INPUT[name] ?? [];
  const fields: Record<string, string | number | boolean> = {};
  const truncated: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (hidden.includes(k) || v === undefined || v === null) continue;
    if (typeof v === 'number' || typeof v === 'boolean') { fields[k] = v; continue; }
    let text: string;
    try { text = typeof v === 'string' ? v : JSON.stringify(v); } catch { text = ''; }
    if (text.length > FIELD_MAX_CHARS) { truncated.push(k); text = text.slice(0, FIELD_MAX_CHARS); }
    fields[k] = text;
  }
  const view: P.ToolInputView = { summary: toolSummary(name, input), fields };
  if (truncated.length) view.truncated = truncated;
  return view;
}
/** True when the input view lost data (the full input then goes to the stash / a HeavyLoc 'input'). */
export const inputIsHeavy = (v: P.ToolInputView): boolean => (v.truncated?.length ?? 0) > 0;

/** structuredPatch → PatchHunk[] (capped at PATCH_MAX_LINES lines). */
export function patchOf(sp: unknown): { patch: P.PatchHunk[]; cut: boolean } {
  const patch: P.PatchHunk[] = [];
  let lines = 0;
  for (const h of arr(sp)) {
    const r = rec(h);
    const ls = arr(r['lines']).map(str);
    if (lines + ls.length > PATCH_MAX_LINES) return { patch, cut: true };
    lines += ls.length;
    patch.push({ oldStart: num(r['oldStart']) ?? 0, oldLines: num(r['oldLines']) ?? 0, newStart: num(r['newStart']) ?? 0, newLines: num(r['newLines']) ?? 0, lines: ls });
  }
  return { patch, cut: false };
}
/** +added −removed of a patch. */
export function patchCounts(patch: readonly P.PatchHunk[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const h of patch) for (const l of h.lines) { if (l.startsWith('+')) added++; else if (l.startsWith('-')) removed++; }
  return { added, removed };
}
const lineCount = (t: string): number => (t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0);

/** UTF-8 size of the UTF-16 code unit at `i` of `s`, and how many code units it spans (a surrogate pair is 4 bytes). */
function u8(s: string, i: number, back: boolean): [bytes: number, units: number] {
  const c = s.charCodeAt(i);
  if (c < 0x80) return [1, 1];
  if (c < 0x800) return [2, 1];
  const pair = back
    ? (c & 0xfc00) === 0xdc00 && i > 0 && (s.charCodeAt(i - 1) & 0xfc00) === 0xd800
    : (c & 0xfc00) === 0xd800 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
  return pair ? [4, 2] : [3, 1];
}
/** Longest prefix of `s` whose UTF-8 encoding fits in `max` bytes (never splits a surrogate pair). */
export function utf8Head(s: string, max: number): string {
  let bytes = 0, i = 0;
  while (i < s.length) { const [n, w] = u8(s, i, false); if (bytes + n > max) break; bytes += n; i += w; }
  return s.slice(0, i);
}
/** Longest suffix of `s` whose UTF-8 encoding fits in `max` bytes (never splits a surrogate pair). */
export function utf8Tail(s: string, max: number): string {
  let bytes = 0, i = s.length;
  while (i > 0) { const [n, w] = u8(s, i - 1, true); if (bytes + n > max) break; bytes += n; i -= w; }
  return s.slice(i);
}

type Data = Record<string, string | number | boolean>;
const HEAVY_KEY = /original_?file|base64/i;
function put(d: Data, k: string, v: unknown, max = 512): void {
  if (typeof v === 'number' && Number.isFinite(v)) d[k] = v;
  else if (typeof v === 'boolean') d[k] = v;
  else if (typeof v === 'string' && v) d[k] = v.length > max ? v.slice(0, max) : v;
}
/** Small per-tool facts the UI renders (ux §5.4 "Statuses / extras"). Scalars only. */
export function toolData(name: string, tur: unknown): Data {
  const d: Data = {};
  if (typeof tur !== 'object' || tur === null || Array.isArray(tur)) return d;
  const r = tur as Rec;
  const pick = (...keys: string[]): void => { for (const k of keys) put(d, k, r[k]); };
  switch (name) {
    case 'Bash': case 'PowerShell':
      pick('interrupted', 'backgroundTaskId', 'timedOutAfterMs', 'returnCodeInterpretation', 'persistedOutputSize', 'noOutputExpected', 'assistantAutoBackgrounded');
      if (typeof r['stderr'] === 'string' && r['stderr']) d['stderr'] = utf8Head(r['stderr'], TOOL_OUTPUT_HEAD_BYTES);
      if (r['gitOperation'] !== undefined) put(d, 'gitOperation', JSON.stringify(r['gitOperation']));
      break;
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      pick('type', 'filePath', 'userModified', 'replaceAll', 'staged');
      if (typeof r['content'] === 'string') d['lines'] = lineCount(r['content']);
      if (typeof r['originalFile'] === 'string') d['hasOriginal'] = true;
      break;
    case 'Read': {
      const f = rec(r['file']);
      pick('type'); put(d, 'filePath', f['filePath']); put(d, 'numLines', f['numLines']); put(d, 'startLine', f['startLine']); put(d, 'totalLines', f['totalLines']);
      break;
    }
    case 'Grep': pick('mode', 'numFiles', 'numLines', 'numMatches', 'appliedLimit', 'totalLines'); break;
    case 'Glob': pick('numFiles', 'truncated', 'totalMatches', 'durationMs'); break;
    case 'WebFetch': pick('code', 'codeText', 'bytes', 'url', 'durationMs'); break;
    case 'WebSearch': pick('query', 'durationSeconds'); d['results'] = arr(r['results']).length; break;
    case 'Agent': case 'Task': pick('status', 'agentType', 'agentId', 'resolvedModel', 'totalTokens', 'totalToolUseCount', 'totalDurationMs', 'isAsync'); break;
    case 'AskUserQuestion': {
      const answers = rec(r['answers']);
      let i = 0;
      for (const [q, a] of Object.entries(answers)) { put(d, `q${i}`, q); put(d, `a${i}`, a); i++; }
      d['answered'] = i;
      break;
    }
    case 'ExitPlanMode': put(d, 'plan', r['plan'], DATA_TEXT_MAX); pick('filePath', 'planWasEdited', 'isAgent'); break;
    case 'ToolSearch': d['matches'] = arr(r['matches']).length; pick('query', 'total_deferred_tools'); break;
    case 'TodoWrite': {
      const todos = arr(r['newTodos']);
      d['total'] = todos.length;
      d['done'] = todos.filter((t) => rec(t)['status'] === 'completed').length;
      break;
    }
    default:   // unknown / MCP tools: small scalars only, never a file copy or an inline payload
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'object' || HEAVY_KEY.test(k) || (typeof v === 'string' && v.startsWith('data:'))) continue;
        put(d, k, v, 256);
      }
  }
  return d;
}

/** tool_result (+ tool_use_result metadata) → status, lite UiToolResult and the heavy pieces for the stash. */
export function liteToolResult(name: string, toolUseId: string, raw: RawToolResult): { status: P.ToolStatus; result: P.UiToolResult; heavy: HeavyPiece[] } {
  const id = `t:${toolUseId}`;
  const tur = raw.toolUseResult;
  const t = rec(tur);
  const denial = denialOf(raw.denialKind, raw.decisionSource);
  const status = toolStatusOf(raw.isError, denial, tur);
  const heavy: HeavyPiece[] = [];
  const isShell = (name === 'Bash' || name === 'PowerShell') && typeof t['stdout'] === 'string';
  const text = isShell ? str(t['stdout']) : contentText(raw.content);
  const result: P.UiToolResult = { isError: raw.isError || status === 'denied', summary: firstLine(text) };
  if (denial) result.denial = denial;
  if (text) {
    result.totalLines = lineCount(text);
    // 4 KiB of UTF-8 each (limits.ts), not 4 Ki UTF-16 units: a CJK or emoji output must not triple the payload
    if (text.length <= TOOL_OUTPUT_HEAD_BYTES + TOOL_OUTPUT_TAIL_BYTES && Buffer.byteLength(text, 'utf8') <= TOOL_OUTPUT_HEAD_BYTES + TOOL_OUTPUT_TAIL_BYTES) result.head = text;
    else {
      result.head = utf8Head(text, TOOL_OUTPUT_HEAD_BYTES);
      result.tail = utf8Tail(text, TOOL_OUTPUT_TAIL_BYTES);
      result.truncated = true;
      heavy.push({ id, field: 'output', payload: { text }, bytes: text.length });
    }
  }
  const sp = t['structuredPatch'];
  if (Array.isArray(sp) && sp.length) {
    const p = patchOf(sp);
    result.patch = p.patch;
    if (p.cut) result.truncated = true;
  }
  const imgs = contentImages(raw.content);
  if (imgs.length) {
    result.images = imageRefs(id, imgs);
    imgs.forEach((im, i) => heavy.push({ id: imageRefId(id, i), field: 'image', payload: { dataUrl: `data:${im.mediaType};base64,${im.base64}`, mediaType: im.mediaType }, bytes: im.base64.length }));
  }
  if (typeof t['originalFile'] === 'string') heavy.push({ id, field: 'originalFile', payload: { text: t['originalFile'] }, bytes: t['originalFile'].length });
  const data = toolData(name, tur);
  if (result.patch) { const c = patchCounts(result.patch); data['added'] = c.added; data['removed'] = c.removed; }
  if (Object.keys(data).length) result.data = data;
  if (!result.summary && typeof tur === 'string') result.summary = cut(tur, 200);
  return { status, result, heavy };
}
