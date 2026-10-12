// src/server/model/blocks.ts — shared block builders: ids, user messages, denials, tool statuses.
// Pure: no I/O, no timers, no clock. Used by live-reducer.ts and disk-turns.ts so both produce identical blocks.
import type * as P from '../../shared/protocol.ts';

export type Rec = Record<string, unknown>;
export const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Block ids (protocol.ts): user u:<uuid> · text/thinking a:<message.id>:<index> · tool t:<tool_use_id> · system x:<uuid>. */
export function blockId(kind: 'user' | 'text' | 'thinking' | 'tool' | 'system', ...parts: (string | number)[]): string {
  const p = parts.map(String);
  switch (kind) {
    case 'user': return `u:${p[0] ?? ''}`;
    case 'text':
    case 'thinking': return `a:${p[0] ?? ''}:${p[1] ?? '0'}`;
    case 'tool': return `t:${p[0] ?? ''}`;
    case 'system': return `x:${p.join(':')}`;
  }
}
/** Id of the n-th image of a block (user or tool): `${blockId}#${n}`; detail(id, 'image') serves it. */
export const imageRefId = (owner: string, n: number): string => `${owner}#${n}`;

/** CLI synthetic texts for an interrupt: `[Request interrupted by user]` / `[Request interrupted by user for tool use]`. */
export const INTERRUPT_PREFIX = '[Request interrupted by user';
export const isInterruptText = (t: string): boolean => t.trimStart().startsWith(INTERRUPT_PREFIX);

/** Plain text of a user/tool content (string or blocks); images are counted separately. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  const out: string[] = [];
  for (const b of arr(content)) {
    const r = rec(b);
    if (r['type'] === 'text') out.push(str(r['text']));
  }
  return out.join('\n');
}
export type ImagePiece = { mediaType: string; base64: string };
/** Image types allowed in a `data:` URL (same set as the outbound images, ws/validate.ts): the transcript is
 *  model / tool-authored, so any other media_type falls back to image/png instead of reaching the URL. */
const IMAGE_MEDIA: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const safeImageMedia = (t: string): string => (IMAGE_MEDIA.has(t) ? t : 'image/png');
/** Base64 images of a content array (user message or tool_result content). */
export function contentImages(content: unknown): ImagePiece[] {
  const out: ImagePiece[] = [];
  for (const b of arr(content)) {
    const r = rec(b);
    if (r['type'] !== 'image') continue;
    const src = rec(r['source']);
    out.push({ mediaType: safeImageMedia(str(src['media_type'])), base64: str(src['data']) });
  }
  return out;
}
/** ≈ decoded bytes of a base64 string. */
export const b64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
export function imageRefs(owner: string, imgs: readonly ImagePiece[]): P.ImageRef[] {
  return imgs.map((im, i) => ({ ref: imageRefId(owner, i), mediaType: im.mediaType, bytes: b64Bytes(im.base64) }));
}

/** SDK / transcript `origin.kind` → UiUserMsg origin. */
export function userOrigin(origin: unknown, text: string): P.UiUserMsg['origin'] {
  const k = str(rec(origin)['kind']);
  if (k === 'peer') return 'peer';
  if (k === 'task-notification' || k === 'task_notification') return 'task';
  if (k === 'auto-continuation' || k === 'auto') return 'auto';
  if (/^\s*<command-name>/.test(text)) return 'command';
  return 'human';
}

/** `toolDenialKind` (disk) / `tool_result_meta[].non_execution_kind` (live) → UiToolResult.denial. */
export function denialOf(kind: unknown, decisionSource?: unknown): P.UiToolResult['denial'] | undefined {
  switch (kind) {
    case 'user-rejected': return 'user';
    case 'permission-rule': return decisionSource === 'user_reject' ? 'user' : 'rule';
    case 'automode-blocked': return 'auto';
    case 'automode-unavailable': return 'autoNa';
    case 'interrupted': return 'interrupted';
    default: return undefined;
  }
}
/** Final status of a tool from its result. Identical rules live and on disk. */
export function toolStatusOf(isError: boolean, denial: P.UiToolResult['denial'] | undefined, toolUseResult: unknown): P.ToolStatus {
  if (denial === 'interrupted') return 'interrupted';
  if (denial === 'withdrawn') return 'withdrawn';
  if (denial) return 'denied';
  if (rec(toolUseResult)['interrupted'] === true) return 'interrupted';
  return isError ? 'error' : 'ok';
}

/** `message.model` of entries the CLI made itself (local errors, local command answers such as /usage). */
export const SYNTHETIC = '<synthetic>';
/** `local` system row of a synthetic (non-error) assistant message, identical live and on disk. */
export function localRow(content: unknown, usageReport: unknown): P.UiSystemRow {
  const row: P.UiSystemRow = { kind: 'local', text: contentText(content) };
  if (usageReport !== undefined && usageReport !== null) row.data = { usageReport: true };
  return row;
}

/** Local command output without the transcript's `<local-command-stdout|stderr>` wrappers: the same text live and on disk. */
export const localCommandText = (s: string): string => s.replace(/<\/?local-command-(?:stdout|stderr)>/g, '').trim();

/** First non-empty line, cut to `max` chars with a French ellipsis. */
export function firstLine(text: string, max = 200): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return cut(line, max);
}
export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max - 1);
  if (end > 0 && (s.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;   // never split a surrogate pair (emoji)
  return `${s.slice(0, end).trimEnd()}…`;
}
/** ISO timestamp → epoch ms (0 when absent or invalid). */
export function isoMs(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
}
