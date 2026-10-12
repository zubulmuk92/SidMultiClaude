// @ts-check
// src/web/lib/icons.js — the app's icon set: inline SVG on a 24-unit grid, 2-unit round stroke, `currentColor`.
// The interface shows no emoji and no pictographic font glyph: an icon looks the same on every Windows build, follows the
// text colour and the theme, and stays sharp at any scale. Text-only places (window title, notifications) keep characters.
import { html } from 'htm/preact';

const CIRCLE = 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z';
/** name → path data (one path, sub-paths joined). Names ending in `-fill` are filled instead of stroked. */
const PATHS = /** @type {Record<string, string>} */ ({
  'menu': 'M4 6h16M4 12h16M4 18h16',
  'plus': 'M12 5v14M5 12h14',
  'x': 'M18 6L6 18M6 6l12 12',
  'check': 'M20 6L9 17l-5-5',
  'chevron-down': 'M6 9l6 6l6-6',
  'chevron-right': 'M9 6l6 6l-6 6',
  'chevron-left': 'M15 6l-6 6l6 6',
  'more': 'M5 12h.01M12 12h.01M19 12h.01',
  'arrow-down': 'M12 5v14M19 12l-7 7l-7-7',
  'enter': 'M9 10l-5 5l5 5M20 4v7a4 4 0 0 1-4 4H4',
  'bell': 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  'bell-off': 'M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20',
  'settings': 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  'circle': 'M12 5a7 7 0 1 0 0 14a7 7 0 0 0 0-14z',
  'dot-fill': 'M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z',
  'loader': 'M21 12a9 9 0 1 1-6.22-8.56',
  'alert-circle': `${CIRCLE}M12 8v4M12 16h.01`,
  'help-circle': `${CIRCLE}M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01`,
  'x-circle': `${CIRCLE}M15 9l-6 6M9 9l6 6`,
  'ban': `${CIRCLE}M5.6 5.6l12.8 12.8`,
  'clock': `${CIRCLE}M12 7v5l3 2`,
  'alert-triangle': 'M21.73 18l-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3zM12 9v4M12 17h.01',
  'list': 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  'hourglass': 'M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2',
  'terminal': 'M4 17l6-6l-6-6M12 19h8',
  'swap': 'M8 3L4 7l4 4M4 7h16M16 21l4-4l-4-4M20 17H4',
  'branch': 'M6 3v12M18 9a3 3 0 1 0 0-6a3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6a3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  'star': 'M12 2l3.09 6.26L22 9.27l-5 4.87l1.18 6.88L12 17.77l-6.18 3.25L7 14.14L2 9.27l6.91-1.01L12 2z',
  'star-fill': 'M12 2l3.09 6.26L22 9.27l-5 4.87l1.18 6.88L12 17.77l-6.18 3.25L7 14.14L2 9.27l6.91-1.01L12 2z',
  'pencil': 'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5L2 22l1.5-5.5L17 3z',
  'square': 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  'check-square': 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8.5 12l2.5 2.5l4.5-5',
  'stop-fill': 'M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  'image': 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 7a2 2 0 1 0 0 4a2 2 0 0 0 0-4zM21 15l-3.09-3.09a2 2 0 0 0-2.82 0L6 21',
  'folder': 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
  'drive': 'M22 12H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11zM6 16h.01M10 16h.01',
  'rotate': 'M3 12a9 9 0 1 0 9-9a9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
  'pie': 'M21.21 15.89A10 10 0 1 1 8 2.83M22 12A10 10 0 0 0 12 2v10z',
  'pause': 'M9 5v14M15 5v14',
  'clipboard': 'M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1zM16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2M9 12h6M9 16h4',
  'forward': 'M13 19l9-7l-9-7v14zM2 19l9-7l-9-7v14z',
  'zap': 'M13 2L3 14h9l-1 8l10-12h-9l1-8z',
});

/**
 * The characters the pure model functions still return (derived.stateGlyph, chat/model.stateView, tool statuses: they also
 * feed the window title and the tests) → the icon drawn for them.
 */
const BY_GLYPH = /** @type {Record<string, string>} */ ({
  '○': 'circle', '◌': 'loader', '◐': 'loader', '!': 'alert-circle', '?': 'help-circle', '≡': 'list', '⧗': 'hourglass', '✕': 'x-circle',
  '✓': 'check', '⌨': 'terminal', '⚙': 'settings', '⊘': 'ban', '■': 'stop-fill', '⇄': 'swap', '☐': 'square', '☑': 'check-square',
  '‖': 'pause', '✎': 'pencil', '◇': 'clipboard', '✦': 'forward', '⚠': 'alert-triangle',
});

/**
 * Decorative by default (aria-hidden): the control or the text next to it carries the name. Pass `label` when the icon
 * stands alone. @param {{ n: string; size?: number; cls?: string; label?: string }} p
 */
export function Icon({ n, size = 16, cls, label }) {
  const d = PATHS[n];
  if (!d) return null;
  return html`<svg class=${`icon${n.endsWith('-fill') ? ' icon-fill' : ''}${cls ? ' ' + cls : ''}`} viewBox="0 0 24 24" width=${size} height=${size}
    role=${label ? 'img' : undefined} aria-label=${label} aria-hidden=${label ? undefined : 'true'}><path d=${d} /></svg>`;
}
/** The icon of a model glyph character; an unknown character is shown as it is. @param {{ g: string; size?: number }} p */
export function GlyphIcon({ g, size }) {
  const n = BY_GLYPH[g];
  return n ? html`<${Icon} n=${n} size=${size} />` : g;
}
