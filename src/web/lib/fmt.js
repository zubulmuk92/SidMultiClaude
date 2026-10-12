// @ts-check
// src/web/lib/fmt.js — Intl fr-FR formatting: numbers, money, times, relative times (ux §14).
// Pure functions; `now` is a parameter wherever time matters so the tests are deterministic.

const NF = new Intl.NumberFormat('fr-FR');
const NF1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const USD = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const HM = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' });
const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const RTF = new Intl.RelativeTimeFormat('fr-FR', { numeric: 'auto' });
const NBSP = ' ';

/** « 84 k », « 1,2 M », « 950 ». @param {number} n @returns {string} */
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${NF1.format(n / 1e6)} M`;
  if (a >= 1e4) return `${NF.format(Math.round(n / 1e3))} k`;
  if (a >= 1e3) return `${NF1.format(n / 1e3)} k`;
  return NF.format(Math.round(n));
}
/** « 1 234 ». @param {number} n */
export function fmtInt(n) { return NF.format(Math.round(n)); }
/** « 0,84 $ » (list price, never billed on a subscription). @param {number} usd */
export function fmtMoney(usd) { return `${USD.format(usd)}${NBSP}$`; }
/** « 42 % ». @param {number} pct */
export function fmtPct(pct) { return `${NF.format(Math.round(pct))}${NBSP}%`; }
/** « 15:45 ». @param {number} at */
export function fmtTime(at) { return HM.format(at); }
/** « 9 oct. ». @param {number} at */
export function fmtDate(at) { return DATE.format(at); }
/** « 1,2 Mo », « 340 Ko ». @param {number} bytes */
export function fmtBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${NF1.format(bytes / 1024 ** 3)} Go`;
  if (bytes >= 1024 ** 2) return `${NF1.format(bytes / 1024 ** 2)} Mo`;
  if (bytes >= 1024) return `${NF.format(Math.round(bytes / 1024))} Ko`;
  return `${NF.format(bytes)} o`;
}
/** RAM given in MB: « 0,7 Go », « 450 Mo ». @param {number} mb */
export function fmtRam(mb) { return mb >= 1000 ? `${NF1.format(mb / 1000)} Go` : `${NF.format(Math.round(mb))} Mo`; }
/** Timer « 0:42 », « 12:05 », « 1:02:03 ». @param {number} ms */
export function fmtTimer(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(r).padStart(2, '0')}`;
}
/** Duration « 2 h 10 », « 47 min », « 12 s ». @param {number} ms */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`;
  return `${Math.round(h / 24)} j`;
}
/** « il y a 3 min », « hier », « dans 2 h ». @param {number} at @param {number} now */
export function fmtRel(at, now) {
  const d = at - now;
  const a = Math.abs(d);
  if (a < 45_000) return d <= 0 ? 'à l’instant' : 'dans un instant';
  if (a < 3_600_000) return RTF.format(Math.round(d / 60_000), 'minute');
  if (a < 86_400_000) return RTF.format(Math.round(d / 3_600_000), 'hour');
  if (a < 7 * 86_400_000) return RTF.format(Math.round(d / 86_400_000), 'day');
  return DATE.format(at);
}
/** Short sidebar age: « 2 min », « 3 h », « hier », « lun. », « 12 sept. ». @param {number} at @param {number} now */
export function fmtAge(at, now) {
  const d = Math.max(0, now - at);
  if (d < 60_000) return 'maint.';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h`;
  if (d < 2 * 86_400_000) return 'hier';
  if (d < 7 * 86_400_000) return DAY.format(at);
  return DATE.format(at);
}
/** Basename of a Windows or POSIX path. @param {string} p */
export function baseName(p) {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i < 0 ? s : s.slice(i + 1) || s;
}
/** Parent folder name (used to disambiguate equal basenames). @param {string} p */
export function parentName(p) {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i <= 0 ? '' : baseName(s.slice(0, i));
}
