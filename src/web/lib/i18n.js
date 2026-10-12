// @ts-check
// src/web/lib/i18n.js — French copy lookup.
// One table: i18n/fr.js (fr-shell.js and fr-chat.js were merged into it). Placeholders are `{name}` (accents allowed: {modèle}). Option strings (« A · B · C ») are read
// with tPart(key, i). A missing key renders as the key itself (never throws) and is reported once on the console.
import { fr } from '../i18n/fr.js';

/** @type {Record<string, string>} */
const TABLE = Object.assign(Object.create(null), fr);
/** @type {Set<string>} */
const missing = new Set();
const PH = /\{([^{}|]+)\}/g;

/** @param {string} key @returns {boolean} */
export function has(key) { return key in TABLE; }

/** @param {string} key @param {Record<string, string | number>} [args] @returns {string} */
export function t(key, args) {
  const raw = TABLE[key];
  if (raw === undefined) {
    if (!missing.has(key)) { missing.add(key); try { console.warn('i18n: missing key', key); } catch { /* no console */ } }
    return key;
  }
  return args ? fill(raw, args) : raw;
}

/** Replaces `{name}` by args[name]; unknown placeholders stay as they are. @param {string} s @param {Record<string, string | number>} args */
export function fill(s, args) {
  return s.replace(PH, (m, name) => (Object.prototype.hasOwnProperty.call(args, name) ? String(args[name]) : m));
}

/** The i-th option of a « A · B · C » string (falls back to the whole string). @param {string} key @param {number} i @param {Record<string, string | number>} [args] */
export function tPart(key, i, args) {
  const parts = t(key, args).split(' · ');
  return parts[i] ?? parts[parts.length - 1] ?? key;
}

/** All options of a « A · B · C » string. @param {string} key @returns {string[]} */
export function tParts(key) { return t(key).split(' · '); }

/** Splits « titre — corps » strings (notifications). @param {string} key @param {Record<string, string | number>} [args] @returns {{ title: string; body: string }} */
export function tTitleBody(key, args) {
  const s = t(key, args);
  const i = s.indexOf(' — ');
  return i < 0 ? { title: s, body: '' } : { title: s.slice(0, i), body: s.slice(i + 3) };
}

/** Keys reported missing so far (tests). @returns {string[]} */
export function missingKeys() { return [...missing]; }
