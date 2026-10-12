// @ts-check
// src/web/components/shell/common.js — small shared pieces of the shell (state glyph, account badge, modal frame with
// focus trap (ux §10.4: dialogs trap focus and restore it on close), popup menu with role="menu", arrows, type-ahead).
// Styles in styles/shell.css; positions are set through the CSSOM (CSP style-src 'self').
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { t } from '../../lib/i18n.js';
import { stateGlyph } from '../../derived.js';

/** @typedef {import('../../../shared/protocol.ts').ChatSummary} ChatSummary */
/** @typedef {import('../../../shared/protocol.ts').AccountView} AccountView */

/** @param {{ s: ChatSummary }} p */
export function Glyph({ s }) {
  const g = stateGlyph(s);
  return html`<span class=${`glyph st-${g.cls}`} role="img" aria-label=${g.label} title=${g.label}>${g.glyph}</span>`;
}
/** @param {{ a: AccountView | undefined; id?: string }} p */
export function AccBadge({ a, id }) {
  return html`<span class=${`acc-badge acc-${a?.color ?? 8}`} title=${a?.name ?? id ?? ''}>${a?.monogram ?? (id ?? '?').slice(0, 1).toUpperCase()}</span>`;
}

/**
 * Real focus trap: focus that lands outside the open dialog (an async focus() from a pane behind it, a click on the
 * backdrop) is pulled back inside. Menus and toasts are exempt. @param {HTMLElement | null} el @returns {() => void}
 */
export function trapFocus(el) {
  if (!el) return () => {};
  // focus goes back where it was inside the dialog (the switcher's input, a dialog field), not to the frame: keys typed
  // right after a stolen focus (Entrée in the switcher) still reach the field
  /** @type {HTMLElement | null} */
  let last = document.activeElement instanceof HTMLElement && el.contains(document.activeElement) ? document.activeElement : null;
  const onIn = (/** @type {FocusEvent} */ e) => {
    const t = /** @type {Node | null} */ (e.target);
    if (t && el.contains(t)) { if (t instanceof HTMLElement && t !== el) last = t; return; }
    if (!t || (t instanceof Element && t.closest('.menu, .toasts, .ov-backdrop'))) return;
    const back = last && last.isConnected && el.contains(last) ? last : /** @type {HTMLElement | null} */ (el.querySelector('[data-autofocus]'));
    (back ?? el).focus();
  };
  document.addEventListener('focusin', onIn, true);
  return () => document.removeEventListener('focusin', onIn, true);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/**
 * Modal frame. Escape and a backdrop click call onClose; Tab cycles inside; focus returns to the opener on unmount.
 * @param {{ title: string; onClose: () => void; children?: any; wide?: boolean; cls?: string; footer?: any; labelId?: string }} p
 */
export function Modal({ title, onClose, children, wide, cls, footer, labelId }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const id = labelId ?? `dlg-${title.length}-${Math.floor(Math.random() * 1e6)}`;
  useLayoutEffect(() => {                    // at commit: closing before the next paint still restores the focus
    const opener = /** @type {HTMLElement | null} */ (document.activeElement);
    const el = ref.current;
    const first = /** @type {HTMLElement | null} */ (el?.querySelector('[data-autofocus]') ?? el?.querySelector(FOCUSABLE) ?? null);
    (first ?? el)?.focus();
    const stop = trapFocus(el);
    // A focused control that becomes disabled (a busy « Se connecter ») drops the focus on <body> without any focus event:
    // the topmost dialog still takes Échap (closes) and Tab (focus back inside) instead of leaving them to the shell.
    const orphan = (/** @type {KeyboardEvent} */ e) => {
      const a = document.activeElement;
      if (e.defaultPrevented || (a && a !== document.body) || !el) return;
      const all = document.querySelectorAll('.dlg');
      if (all[all.length - 1] !== el) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
      else if (e.key === 'Tab') { e.preventDefault(); /** @type {HTMLElement | null} */ (el.querySelector(FOCUSABLE) ?? el)?.focus(); }
    };
    document.addEventListener('keydown', orphan);
    return () => { stop(); document.removeEventListener('keydown', orphan); if (opener && opener.isConnected) opener.focus(); };
  }, []);
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = /** @type {HTMLElement[]} */ ([...ref.current.querySelectorAll(FOCUSABLE)]).filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const next = e.shiftKey ? (i <= 0 ? items[items.length - 1] : items[i - 1]) : (i === items.length - 1 ? items[0] : items[i + 1]);
    e.preventDefault();
    next?.focus();
  };
  return html`<div class="ov-backdrop" onMouseDown=${(/** @type {MouseEvent} */ e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref=${ref} class=${`dlg ${wide ? 'dlg-wide' : ''} ${cls ?? ''}`} role="dialog" aria-modal="true" aria-labelledby=${id} tabindex="-1" onKeyDown=${onKey}>
      <header class="dlg-head"><h2 id=${id}>${title}</h2>
        <button type="button" class="icon-btn" aria-label=${t('shell.close')} title=${t('shell.closeEsc')} onClick=${onClose}>✕</button></header>
      <div class="dlg-body">${children}</div>
      ${footer ? html`<footer class="dlg-foot">${footer}</footer>` : null}
    </div></div>`;
}

/** @typedef {{ label: string; run?: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; sep?: boolean; hint?: string }} MenuItem */
/** The open popup menu (one at a time). */
export const menu = signal(/** @type {{ x: number; y: number; items: MenuItem[]; label: string } | null} */ (null));
/** @param {{ x: number; y: number }} at @param {MenuItem[]} items @param {string} label */
export function openMenu(at, items, label) { menu.value = { x: at.x, y: at.y, items, label }; }
/** Opens a menu under an element. @param {Element} el @param {MenuItem[]} items @param {string} label */
export function openMenuAt(el, items, label) { const r = el.getBoundingClientRect(); openMenu({ x: r.left, y: r.bottom + 2 }, items, label); }

export function MenuHost() {
  const m = menu.value;
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => {
    if (!m || !ref.current) return;
    const el = ref.current;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(m.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(m.y, window.innerHeight - r.height - 4))}px`;
    /** @type {HTMLElement | null} */ (el.querySelector('[role^="menuitem"]:not([disabled])'))?.focus();
    const away = (/** @type {MouseEvent} */ e) => { if (!el.contains(/** @type {Node} */ (e.target))) menu.value = null; };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [m]);
  if (!m) return null;
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    const items = /** @type {HTMLElement[]} */ ([...(ref.current?.querySelectorAll('[role^="menuitem"]:not([disabled])') ?? [])]);
    const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); menu.value = null; return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const hit = items.find((x, j) => j > i && (x.textContent ?? '').trim().toLowerCase().startsWith(k)) ?? items.find((x) => (x.textContent ?? '').trim().toLowerCase().startsWith(k));
      hit?.focus();
    }
  };
  return html`<div ref=${ref} class="menu" role="menu" aria-label=${m.label} onKeyDown=${onKey}>
    ${m.items.map((it) => (it.sep ? html`<div class="menu-sep" role="separator"></div>`
      : html`<button type="button" class=${`menu-item ${it.danger ? 'danger' : ''}`} role=${it.checked !== undefined ? 'menuitemradio' : 'menuitem'}
          aria-checked=${it.checked !== undefined ? String(it.checked) : undefined} disabled=${it.disabled}
          onClick=${() => { menu.value = null; it.run?.(); }}>
          <span class="menu-check" aria-hidden="true">${it.checked ? '✓' : ''}</span><span class="menu-label">${it.label}</span>${it.hint ? html`<kbd>${it.hint}</kbd>` : null}</button>`))}
  </div>`;
}
