// src/server/util/ids.ts — chatId codec, UUID checks, account slugs, boot id, opaque cursor codec.
// chatId = "<accountId>:<sessionId>" (SPEC §2.1, C2). accountId is a slug /^[a-z][a-z0-9-]{0,23}$/ (never ':'),
// sessionId a lower-case UUID 8-4-4-4-12. Cursors are opaque base64url JSON (SPEC §5.5 TranscriptReader).
import { randomBytes, randomUUID } from 'node:crypto';
import type { AccountId, ChatId, SessionId, Uuid } from '../../shared/protocol.ts';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const UUID_ANY_CASE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]{0,23}$/;

/** Lower-case canonical UUID (Claude session ids, client crypto.randomUUID()). */
export function isUuid(s: unknown): s is Uuid { return typeof s === 'string' && UUID_RE.test(s); }
export function isAccountId(s: unknown): s is AccountId { return typeof s === 'string' && ACCOUNT_ID_RE.test(s); }
export function newUuid(): Uuid { return randomUUID(); }

export function makeChatId(accountId: AccountId, sessionId: SessionId): ChatId {
  if (!isAccountId(accountId)) throw new Error(`invalid accountId: ${String(accountId)}`);
  if (!isUuid(sessionId)) throw new Error(`invalid sessionId: ${String(sessionId)}`);
  return `${accountId}:${sessionId}`;
}
export function parseChatId(c: unknown): { accountId: AccountId; sessionId: SessionId } | null {
  if (typeof c !== 'string') return null;
  const i = c.indexOf(':');
  if (i <= 0) return null;
  const accountId = c.slice(0, i);
  const sessionId = c.slice(i + 1);
  return isAccountId(accountId) && isUuid(sessionId) ? { accountId, sessionId } : null;
}
export function isChatId(c: unknown): c is ChatId { return parseChatId(c) !== null; }
export function accountOf(c: ChatId): AccountId {
  const p = parseChatId(c);
  if (!p) throw new Error(`invalid chatId: ${c}`);
  return p.accountId;
}
export function sessionOf(c: ChatId): SessionId {
  const p = parseChatId(c);
  if (!p) throw new Error(`invalid chatId: ${c}`);
  return p.sessionId;
}

/**
 * Account slug from a display name, fixed at creation: « Perso » → perso, « ACME » → acme, a second « Perso » → perso-2.
 * Accents are stripped (NFD), anything else becomes '-', the result starts with a letter and has ≤ 24 chars.
 */
export function accountSlug(name: string, taken: Iterable<string> = []): AccountId {
  const used = new Set(taken);
  let base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = ('compte-' + base).replace(/-+$/g, '');
  base = base.slice(0, 24).replace(/-+$/g, '') || 'compte';
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const cand = base.slice(0, 24 - suffix.length).replace(/-+$/g, '') + suffix;
    if (!used.has(cand)) return cand;
  }
}

/** Server boot id (changes at every server start; S2C hello.boot). Not a secret. */
export function newBootId(): string { return `${Date.now().toString(36)}-${randomBytes(6).toString('base64url')}`; }

// ------------------------------------------------------------------ opaque cursors (base64url JSON)
export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
/** Returns null for anything that is not a base64url-encoded JSON object (or that `check` rejects). Never throws. */
export function decodeCursor<T extends Record<string, unknown>>(s: unknown, check?: (o: Record<string, unknown>) => o is T): T | null {
  if (typeof s !== 'string' || !s || s.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const o: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const rec = o as Record<string, unknown>;
    if (check && !check(rec)) return null;
    return rec as T;
  } catch {
    return null;
  }
}
/** The reader's cursor shape (SPEC §5.5): { off, leaf }. */
export type TxCursor = { off: number; leaf: string };
export const isTxCursor = (o: Record<string, unknown>): o is TxCursor =>
  typeof o['off'] === 'number' && Number.isSafeInteger(o['off']) && o['off'] >= 0 && typeof o['leaf'] === 'string';
