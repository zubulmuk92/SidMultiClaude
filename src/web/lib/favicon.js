// @ts-check
// src/web/lib/favicon.js — canvas favicon badge (ux §4.5): a neutral rounded « S » plus one badge, highest priority first:
// amber count (needs_*, « 9+ ») › red (error / limit) › green dot (unread) › blue arc (running). The caller throttles
// to ≤ 1/s (main.js); identical specs are not redrawn. Also mirrors the needs count on navigator.setAppBadge when present.
import { faviconSpec } from '../derived.js';

let last = '';
/** Reads a CSS custom property (theme-aware), with a fallback. @param {string} name @param {string} fb */
function cssVar(name, fb) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; } catch { return fb; }
}

/** @param {{ needs: number; errors: number; done: number; running?: number }} counts @returns {boolean} redrawn */
export function setFaviconBadge(counts) {
  const spec = faviconSpec({ running: 0, ...counts });
  const key = `${spec.kind}:${spec.text}`;
  if (key === last || typeof document === 'undefined') return false;
  last = key;
  try {
    const nav = /** @type {Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }} */ (navigator);
    if (counts.needs && nav.setAppBadge) void nav.setAppBadge(counts.needs).catch(() => {});
    else if (nav.clearAppBadge) void nav.clearAppBadge().catch(() => {});
  } catch { /* not supported */ }
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  if (!g) return false;
  g.fillStyle = cssVar('--fav-bg', '#3b3b45');
  g.beginPath(); g.roundRect(0, 0, 32, 32, 7); g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 22px "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('S', spec.kind === 'none' ? 16 : 13, 17);
  const colors = { needs: cssVar('--st-needs', '#d97706'), error: cssVar('--st-err', '#dc2626'), done: cssVar('--st-done', '#16a34a'), running: cssVar('--st-run', '#2563eb') };
  if (spec.kind === 'needs') {
    g.fillStyle = colors.needs;
    g.beginPath(); g.arc(23, 23, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#000000'; g.font = `bold ${spec.text.length > 1 ? 10 : 13}px "Segoe UI", system-ui, sans-serif`;
    g.fillText(spec.text, 23, 24);
  } else if (spec.kind === 'error' || spec.kind === 'done') {
    g.fillStyle = colors[spec.kind];
    g.beginPath(); g.arc(25, 25, 6, 0, Math.PI * 2); g.fill();
  } else if (spec.kind === 'running') {
    g.strokeStyle = colors.running; g.lineWidth = 3;
    g.beginPath(); g.arc(25, 25, 5, -Math.PI / 2, Math.PI); g.stroke();
  }
  let link = /** @type {HTMLLinkElement | null} */ (document.querySelector('link[rel="icon"]'));
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.type = 'image/png';
  link.href = c.toDataURL('image/png');
  return true;
}
