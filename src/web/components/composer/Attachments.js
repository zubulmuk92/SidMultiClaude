// @ts-check
// src/web/components/composer/Attachments.js — image attachments of the composer (ux §7.6, SPEC §2.4):
// MIME allow-list, ≤ 8 per message, each ≤ MAX_IMAGE_BYTES and all together ≤ MAX_IMAGES_TOTAL_BYTES (base64 length).
// Images are sent as pasted; only those over their budget are re-encoded as JPEG (quality 0.9), then downscaled on
// the longer side until they fit, with a notice. Chips show a thumbnail (data: URL) and ≈ tokens.
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { t, fmtTokens, fmtBytes } from '../chat/text.js';
import { LIMITS } from '../chat/consts.js';
import { imageTargets, imageTokens } from './logic.js';
import { openOverlay } from '../side/overlays.js';

/** @typedef {import('../../../shared/protocol.ts').ImageMediaType} ImageMediaType */
/** @typedef {{ name: string; mediaType: ImageMediaType; base64: string }} Att */

export const ALLOWED = /** @type {readonly ImageMediaType[]} */ (Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']));
/** @param {string} m @returns {m is ImageMediaType} */
export const isAllowed = (m) => /** @type {readonly string[]} */ (ALLOWED).includes(m);

/** Attachments of each chat's composer (the draft mirrors them only while they fit MAX_DRAFT_BYTES). */
const held = new Map();
/** @param {string} chatId @returns {import('@preact/signals').Signal<Att[]>} */
export function attachmentsOf(chatId) {
  let s = held.get(chatId);
  if (!s) { s = signal(/** @type {Att[]} */ ([])); held.set(chatId, s); }
  return s;
}

/** @param {Blob} blob @returns {Promise<string>} base64 without the data: prefix */
function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
/** @param {File | Blob} f @param {string} [name] @returns {Promise<Att | null>} */
export async function readImage(f, name) {
  if (!isAllowed(f.type)) return null;
  return { name: name ?? (/** @type {File} */ (f)).name ?? 'image', mediaType: f.type, base64: await toBase64(f) };
}
/** @param {Att} a */
const dataUrl = (a) => `data:${a.mediaType};base64,${a.base64}`;

/** Re-encode as JPEG q 0.9, then downscale the longer side until the base64 fits `target`. @param {Att} a @param {number} target @returns {Promise<Att | null>} */
async function shrink(a, target) {
  const bin = atob(a.base64);                                       // no fetch(data:): connect-src is 'self' only
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([u8], { type: a.mediaType }));
  let scale = 1;
  for (let k = 0; k < 8; k++) {
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);               // JPEG has no alpha
    g.drawImage(bmp, 0, 0, w, h);
    const b64 = await toBase64(await c.convertToBlob({ type: 'image/jpeg', quality: LIMITS.IMAGE_REENCODE_JPEG_QUALITY }));
    if (b64.length <= target) return { name: a.name.replace(/\.\w+$/, '') + '.jpg', mediaType: 'image/jpeg', base64: b64 };
    scale *= Math.min(0.9, Math.sqrt(target / b64.length) * 0.95);
  }
  return null;
}

/**
 * Make one message's images fit. Returns the images to send (dropping those that cannot fit) and what changed.
 * @param {Att[]} atts @returns {Promise<{ atts: Att[]; reencoded: number; dropped: number }>}
 */
export async function fitImages(atts) {
  const targets = imageTargets(atts.map((a) => a.base64.length), { perImage: LIMITS.MAX_IMAGE_BYTES, total: LIMITS.MAX_IMAGES_TOTAL_BYTES });
  /** @type {Att[]} */ const out = [];
  let reencoded = 0, dropped = 0;
  for (let k = 0; k < atts.length; k++) {
    const a = /** @type {Att} */ (atts[k]), target = targets[k] ?? 0;
    if (a.base64.length <= target) { out.push(a); continue; }
    const s = await shrink(a, target).catch(() => null);
    if (s) { out.push(s); reencoded++; } else dropped++;
  }
  return { atts: out, reencoded, dropped };
}

/** @param {{ chatId: string; items: Att[]; onRemove: (k: number) => void }} p */
export function Attachments({ chatId, items, onRemove }) {
  if (!items.length) return null;
  return html`<div class="a-list">${items.map((a, k) => html`<span class="c-chip a-chip" key=${k}>
    <button type="button" class="a-thumb" title=${`${a.name} · ${fmtBytes(Math.round(a.base64.length * 0.75))}`}
      onClick=${() => openOverlay({ kind: 'lightbox', chatId, dataUrl: dataUrl(a) })}>
      <img src=${dataUrl(a)} alt="" decoding="async" onLoad=${(/** @type {any} */ e) => {
        const im = /** @type {HTMLImageElement} */ (e.currentTarget);
        const lab = im.parentElement?.nextElementSibling;
        if (lab) lab.textContent = t('composer.image', { n: fmtTokens(imageTokens(im.naturalWidth, im.naturalHeight)) });
      }} /></button>
    <span class="a-tok">${a.name}</span>
    <button type="button" class="c-icon" aria-label=${t('composer.remove')} onClick=${() => onRemove(k)}>✕</button>
  </span>`)}</div>`;
}
