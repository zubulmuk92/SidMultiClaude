// @ts-check
// src/web/components/chat/text.js — French copy and fr-FR formatting for the chat surface.
// t() reads i18n/fr.js directly (the one table; same lookup as lib/i18n.js). Pure module: loads in Node for the unit tests.
import { fr } from '../../i18n/fr.js';

/** @type {Readonly<Record<string, string>>} */
const TABLE = fr;

/** Interpolate `{name}` placeholders. Unknown placeholders stay visible (never throws).
 * @param {string} s @param {Record<string, string | number | undefined>} [args] */
export function fill(s, args) {
  if (!args) return s;
  return s.replace(/\{([^{}|]+)\}/g, (m, k) => (args[k] === undefined ? m : String(args[k])));
}

/** True when the key exists in the merged table. @param {string} key */
export const hasKey = (key) => Object.prototype.hasOwnProperty.call(TABLE, key);

/** French string for `key`; the key itself when missing (visible in tests, never a crash).
 * @param {string} key @param {Record<string, string | number | undefined>} [args] */
export function t(key, args) {
  const s = TABLE[key];
  return s === undefined ? key : fill(s, args);
}

/** One option of an "A · B · C" value (e.g. tp('common', 0) = « Annuler »).
 * @param {string} key @param {number} i @param {Record<string, string | number | undefined>} [args] */
export function tp(key, i, args) {
  const parts = t(key).split(' · ');
  return fill(parts[Math.min(i, parts.length - 1)] ?? key, args);
}

/** The {a|b} alternative of a value such as « Conversation compactée ({auto|manuelle}) ».
 * @param {string} key @param {number} alt @param {Record<string, string | number | undefined>} [args] */
export function talt(key, alt, args) {
  const s = t(key).replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, opts) => String(opts).split('|')[alt] ?? '');
  return fill(s, args);
}

// ------------------------------------------------------------------ fr-FR formatting (Intl; ux §14)
const NF0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const NF2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Normalise the narrow no-break spaces Intl emits so text matching stays simple. @param {string} s */
const sp = (s) => s.replace(/[  ]/g, ' ');

/** « 840 », « 1,2 k », « 84 k », « 1,2 M ». @param {number | undefined} n */
export function fmtTokens(n) {
  if (n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a < 1000) return sp(NF0.format(n));
  if (a < 10_000) return sp(NF1.format(n / 1000)) + ' k';
  if (a < 1_000_000) return sp(NF0.format(n / 1000)) + ' k';
  return sp(NF1.format(n / 1_000_000)) + ' M';
}
/** « 0,84 $ ». @param {number | undefined} usd */
export const fmtCost = (usd) => (usd === undefined ? '—' : sp(NF2.format(usd)) + ' $');
/** « 14:02 ». @param {number} at */
export const fmtTime = (at) => sp(TIME.format(new Date(at)));
/** « 0:12 », « 1:05:09 » (running timers). @param {number} ms */
export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (/** @type {number} */ x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}
/** « 41 s », « 1 min 12 s », « 3 h 05 », « 2 j ». @param {number} ms */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} j`;
}
/** « 34 Ko », « 1,2 Mo ». @param {number} bytes */
export function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return sp(NF0.format(bytes / 1024)) + ' Ko';
  return sp(NF1.format(bytes / 1024 / 1024)) + ' Mo';
}
/** Percentage without decimals. @param {number} ratio 0..1 */
export const fmtPct = (ratio) => sp(NF0.format(Math.max(0, ratio) * 100));
