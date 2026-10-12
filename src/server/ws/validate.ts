// src/server/ws/validate.ts — hand-written validators per C2S type (SPEC §10 S6/S15; image size caps in shared/limits.ts).
// Unknown fields are rejected, strings and arrays are capped, ids are format-checked (UUID / chatId / accountId).
// Existence checks (known chat, known account) belong to the handlers. Never throws.
import type * as P from '../../shared/protocol.ts';
import {
  MAX_DRAFT_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, MAX_IMAGES_TOTAL_BYTES, MAX_LIVE_MAX, MAX_LIVE_MIN, MAX_TEXT_BYTES,
  REAP_MIN_CHOICES, TX_PAGE_LIMIT_MAX,
} from '../../shared/limits.ts';
import { isAccountId, isChatId, isUuid } from '../util/ids.ts';

type Check = (v: unknown, at: string) => string | null;       // null = ok, else a reason
type Fields = Record<string, [required: boolean, check: Check]>;
class TooLarge extends Error {}

const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const MEDIA = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const VIEWS = ['normal', 'detailed', 'focus'] as const;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const utf8Len = (s: string): number => Buffer.byteLength(s, 'utf8');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (max: number, min = 0): Check => (v, at) => typeof v !== 'string' ? `${at}: string` : v.length < min || v.length > max ? `${at}: length` : null;
const bool: Check = (v, at) => (typeof v === 'boolean' ? null : `${at}: boolean`);
const lit = (x: unknown): Check => (v, at) => (v === x ? null : `${at}: must be ${String(x)}`);
const int = (min: number, max: number): Check => (v, at) => (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? null : `${at}: integer ${min}..${max}`);
const num = (min: number, max: number): Check => (v, at) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? null : `${at}: number`);
const oneOf = (xs: readonly unknown[]): Check => (v, at) => (xs.includes(v) ? null : `${at}: enum`);
const nullable = (c: Check): Check => (v, at) => (v === null ? null : c(v, at));
const chatId: Check = (v, at) => (isChatId(v) ? null : `${at}: chatId`);
const accountId: Check = (v, at) => (isAccountId(v) ? null : `${at}: accountId`);
const uuid: Check = (v, at) => (isUuid(v) ? null : `${at}: uuid`);
const arr = (c: Check, max: number): Check => (v, at) => {
  if (!Array.isArray(v)) return `${at}: array`;
  if (v.length > max) return `${at}: too many`;
  for (let i = 0; i < v.length; i++) { const r = c(v[i], `${at}[${i}]`); if (r) return r; }
  return null;
};
const obj = (fields: Fields): Check => (v, at) => checkFields(v, fields, at);
/** Plain JSON object (tool input, elicitation content): depth/size bounded by maxPayload, keys capped. */
const jsonObj = (maxKeys: number): Check => (v, at) => (isObj(v) && Object.keys(v).length <= maxKeys ? null : `${at}: object`);
const record = (key: Check, val: Check, max: number): Check => (v, at) => {
  if (!isObj(v)) return `${at}: object`;
  const ks = Object.keys(v);
  if (ks.length > max) return `${at}: too many`;
  for (const k of ks) { const r = key(k, `${at}.key`) ?? val(v[k], `${at}.${k}`); if (r) return r; }
  return null;
};

function checkFields(v: unknown, fields: Fields, at: string): string | null {
  if (!isObj(v)) return `${at}: object`;
  for (const k of Object.keys(v)) if (!Object.hasOwn(fields, k)) return `${at}.${k}: unknown field`;   // own keys only: 'constructor', 'toString'… are unknown too
  for (const [k, [req, c]] of Object.entries(fields)) {
    if (!Object.hasOwn(v, k) || v[k] === undefined) { if (req) return `${at}.${k}: required`; continue; }
    const r = c(v[k], `${at}.${k}`);
    if (r) return r;
  }
  return null;
}

// ------------------------------------------------------------------ composite payloads
const image: Check = (v, at) => {
  const r = checkFields(v, { mediaType: [true, oneOf(MEDIA)], base64: [true, (x, a) => (typeof x === 'string' && B64_RE.test(x) ? null : `${a}: base64`)] }, at);
  if (r) return r;
  if (((v as P.ImageInput).base64).length > MAX_IMAGE_BYTES) throw new TooLarge(`${at}: image too large`);
  return null;
};
const images: Check = (v, at) => {
  if (!Array.isArray(v)) return `${at}: array`;
  if (v.length > MAX_IMAGES_PER_MESSAGE) return `${at}: too many images`;
  for (let i = 0; i < v.length; i++) { const r = image(v[i], `${at}[${i}]`); if (r) return r; }
  const total = (v as P.ImageInput[]).reduce((n, x) => n + x.base64.length, 0);
  if (total > MAX_IMAGES_TOTAL_BYTES) throw new TooLarge(`${at}: images total too large`);
  return null;
};
const sendText: Check = (v, at) => {
  if (typeof v !== 'string') return `${at}: string`;
  if (utf8Len(v) > MAX_TEXT_BYTES) throw new TooLarge(`${at}: text too large`);
  return null;
};
const strRecord = (maxKeys: number, maxLen: number): Check => record(str(1_000, 0), str(maxLen), maxKeys);
const answer: Check = (v, at) => {
  if (!isObj(v)) return `${at}: object`;
  const kind = { kind: [true, str(32)] } as Fields;
  switch (v['kind']) {
    case 'allow-once': case 'allow-and-auto': case 'skip-question': return checkFields(v, kind, at);
    case 'allow-edited': return checkFields(v, { ...kind, input: [true, jsonObj(500)] }, at);
    case 'allow-always': return checkFields(v, { ...kind, scope: [true, oneOf(['session', 'localSettings', 'projectSettings'])] }, at); // never userSettings
    case 'deny': return checkFields(v, { ...kind, message: [true, str(100_000)], stopTurn: [false, bool] }, at);
    case 'answers': return checkFields(v, { ...kind, answers: [true, strRecord(64, 100_000)], notes: [false, strRecord(64, 100_000)], response: [false, str(100_000)] }, at);
    case 'plan-approve': return checkFields(v, { ...kind, nextMode: [true, oneOf(['default', 'acceptEdits', 'auto', 'bypassPermissions'])], editedPlan: [false, str(1_000_000)] }, at);
    case 'plan-reject': return checkFields(v, { ...kind, feedback: [true, str(100_000)] }, at);
    case 'elicit': return checkFields(v, { ...kind, action: [true, oneOf(['accept', 'decline', 'cancel'])], content: [false, jsonObj(200)] }, at);
    default: return `${at}.kind: enum`;
  }
};
const draft: Check = (v, at) => {
  const r = checkFields(v, {
    text: [true, (x, a) => (typeof x === 'string' ? null : `${a}: string`)], at: [true, num(0, 8.64e15)],   // size: too_large below
    attachments: [true, arr(obj({ name: [true, str(260)], mediaType: [true, oneOf(MEDIA)], base64: [true, (x, a) => (typeof x === 'string' && B64_RE.test(x) ? null : `${a}: base64`)] }), MAX_IMAGES_PER_MESSAGE)],
  }, at);
  if (r) return r;
  const d = v as P.Draft;
  if (utf8Len(d.text) + d.attachments.reduce((n, a) => n + a.base64.length + a.name.length, 0) > MAX_DRAFT_BYTES) throw new TooLarge(`${at}: draft too large`);
  return null;
};
const uiState: Check = obj({
  layout: [true, oneOf([1, 2, 3, 4])], tabs: [true, arr(chatId, 500)], closed: [true, arr(chatId, 500)],
  panes: [true, arr(nullable(chatId), 4)], focusedPane: [true, int(0, 3)],
  sidebar: [true, obj({ width: [true, int(0, 4000)], collapsed: [true, bool], grouping: [true, oneOf(['account', 'folder', 'state'])], showArchived: [true, bool] })],
  scroll: [true, record(chatId, obj({ turnId: [true, str(512)], offset: [true, num(-1e9, 1e9)] }), 2_000)],
  views: [true, record(chatId, oneOf(VIEWS), 2_000)],
});
const settingsPatch: Check = obj({
  port: [false, int(1024, 65535)], browser: [false, oneOf(['edge', 'chrome'])], exe: [false, oneOf(['installed', 'bundled'])],
  isolation: [false, oneOf(['job', 'plain'])], maxLive: [false, int(MAX_LIVE_MIN, MAX_LIVE_MAX)], reapMin: [false, oneOf(REAP_MIN_CHOICES)],
  prespawn: [false, bool], allowBypass: [false, bool], aiTitles: [false, bool], notifications: [false, bool], sound: [false, bool],
  volume: [false, num(0, 1)], onlyWhenAway: [false, bool], dndUntil: [false, nullable(num(0, 8.64e15))], reopenWindowOnAttention: [false, bool],
  ctrlEnterSends: [false, bool], shiftTabModes: [false, bool], showOtherOrigins: [false, bool], wakeNeverAsk: [false, bool],
  theme: [false, oneOf(['system', 'light', 'dark'])], density: [false, oneOf(['compact', 'comfortable'])], defaultView: [false, oneOf(VIEWS)],
});
const accountPatch: Check = obj({
  name: [false, str(64, 1)], color: [false, int(1, 8)], monogram: [false, str(3, 1)], hidden: [false, bool], excludeForeignClaudeMd: [false, bool],
  defaults: [false, obj({ model: [false, nullable(str(128, 1))], effort: [false, nullable(oneOf(EFFORTS))], mode: [false, nullable(oneOf(MODES))] })],
});

// ------------------------------------------------------------------ per C2S type (every field of protocol.ts, nothing else)
const C = (f: Fields): Fields => f;
const chat = { chatId: [true, chatId] } as Fields;
export const SCHEMAS: Readonly<Record<P.C2SType, Fields>> = Object.freeze({
  'view': C({ full: [true, arr(chatId, 16)], focused: [true, nullable(chatId)], windowFocused: [true, bool] }),
  'chat.create': C({ accountId: [true, accountId], cwd: [true, str(1_024, 1)], title: [false, str(200)], mode: [true, oneOf(MODES)],
    model: [false, str(128, 1)], effort: [false, oneOf(EFFORTS)], trust: [false, bool] }),
  'chat.prespawn': C({ ...chat }),
  'chat.send': C({ ...chat, uuid: [true, uuid], text: [true, sendText], images: [false, images], priority: [false, oneOf(['later', 'now'])],
    wake: [false, oneOf(['asIs', 'summary'])], evict: [false, chatId], exceed: [false, bool], force: [false, bool] }),
  'chat.interrupt': C({ ...chat }),
  'chat.cancelQueued': C({ ...chat, uuid: [true, uuid] }),
  'chat.decide': C({ ...chat, requestId: [true, str(128, 1)], answer: [true, answer] }),
  'chat.setMode': C({ ...chat, mode: [true, oneOf(MODES)], typed: [false, str(64)] }),
  'chat.setModel': C({ ...chat, model: [true, nullable(str(128, 1))], effort: [true, nullable(oneOf(EFFORTS))] }),
  'chat.rename': C({ ...chat, title: [true, str(200, 1)] }),
  'chat.flags': C({ ...chat, pinned: [false, bool], archived: [false, bool], keepAlive: [false, bool], muted: [false, bool] }),
  'chat.setCwd': C({ ...chat, cwd: [true, str(1_024, 1)] }),
  'chat.sleep': C({ ...chat, stopTasks: [false, bool], force: [false, bool] }),
  'chat.retry': C({ ...chat }),                                // resets the crash breaker; handler in app/commands.ts
  'chat.delete': C({ ...chat, confirm: [true, lit(true)] }),
  'chat.fork': C({ ...chat, upToUuid: [false, uuid], accountId: [false, accountId] }),
  'chat.rewind': C({ ...chat, userUuid: [true, uuid], action: [true, oneOf(['both', 'conv', 'code'])], dryRun: [true, bool] }),
  'chat.task': C({ ...chat, op: [true, oneOf(['stop', 'background', 'stopAll'])], ref: [false, str(256, 1)] }),
  'chat.info': C({ ...chat, what: [true, oneOf(['context', 'rules', 'session', 'commands'])] }),
  'chat.terminal': C({ ...chat, copyOnly: [true, bool] }),
  'tx.page': C({ ...chat, before: [false, str(1_024, 1)], limit: [true, int(1, TX_PAGE_LIMIT_MAX)] }),
  'tx.detail': C({ ...chat, blockId: [true, str(512, 1)],   // block id (not `id`, which would collide with the request id)
    field: [true, oneOf(['output', 'input', 'thinking', 'image', 'originalFile', 'raw'])] }),
  'tx.search': C({ ...chat, q: [true, str(500, 1)] }),
  'prompts.search': C({ q: [true, str(500)], chatId: [false, chatId] }),
  'account.candidates': C({}),
  'account.add': C({ configDir: [true, nullable(str(1_024, 1))], name: [true, str(64, 1)], color: [true, int(1, 8)], monogram: [true, str(3, 1)] }),
  'account.update': C({ accountId: [true, accountId], patch: [true, accountPatch] }),
  'account.login': C({ accountId: [true, accountId], email: [false, str(320, 3)] }),
  'account.loginCode': C({ accountId: [true, accountId], code: [true, str(4_096, 1)] }),
  'account.loginCancel': C({ accountId: [true, accountId] }),
  'account.logout': C({ accountId: [true, accountId] }),
  'account.usage': C({ accountId: [true, accountId] }),
  'account.baseline': C({ accountId: [true, accountId] }),
  'fs.mentions': C({ ...chat, q: [true, str(500)] }),
  'fs.dirs': C({ path: [true, nullable(str(1_024, 1))] }),
  'open': C({ what: [true, oneOf(['url', 'explorer', 'vscode'])], target: [true, str(8_192, 1)], chatId: [false, chatId] }),
  'ui.save': C({ ui: [true, uiState] }),
  'draft.save': C({ ...chat, draft: [true, nullable(draft)] }),
  'settings.set': C({ patch: [true, settingsPatch] }),
  'orphans.kill': C({ pids: [true, arr(int(1, 2 ** 32), 500)] }),
  'app.quit': C({ force: [false, bool] }),
  'log.client': C({ level: [true, oneOf(['warn', 'error'])], msg: [true, str(4_000)], chatId: [false, chatId] }),
});

export type Validated = { ok: true; msg: P.C2S } | { ok: false; id: number | null; err: P.WireError };
const readId = (raw: unknown): number | null => {
  if (!isObj(raw)) return null;
  const id = raw['id'];
  return Number.isSafeInteger(id) && (id as number) >= 0 ? (id as number) : null;
};

/** Never throws: a bad frame gives an 'invalid' (or 'too_large') WireError, with the request id when it could be read. */
export function validateC2S(raw: unknown): Validated {
  const id = readId(raw);
  try {
    if (!isObj(raw)) return { ok: false, id: null, err: { code: 'invalid', message: 'frame: object' } };
    if (id === null) return { ok: false, id: null, err: { code: 'invalid', message: 'id' } };
    const t = raw['t'];
    if (typeof t !== 'string' || !Object.prototype.hasOwnProperty.call(SCHEMAS, t)) return { ok: false, id, err: { code: 'invalid', message: 't' } };
    const fields: Fields = { id: [true, () => null], t: [true, () => null], ...SCHEMAS[t as P.C2SType] };
    const r = checkFields(raw, fields, t);
    if (r) return { ok: false, id, err: { code: 'invalid', message: r.slice(0, 200) } };
    return { ok: true, msg: raw as P.C2S };
  } catch (e) {
    if (e instanceof TooLarge) return { ok: false, id, err: { code: 'too_large', message: e.message.slice(0, 200) } };
    return { ok: false, id, err: { code: 'invalid', message: 'unreadable' } };
  }
}
