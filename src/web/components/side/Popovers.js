// @ts-check
// src/web/components/side/Popovers.js — shared overlay primitives (Modal, Menu) and the zero-token popovers
// (Infos de session, Contexte; ux §3.5–3.6).
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, fmtTokens, fmtBytes, fmtPct } from '../chat/text.js';
import { act } from '../chat/env.js';
import { closeOverlay } from './overlays.js';
import { GlyphIcon, Icon } from '../../lib/icons.js';

/** Modal dialog: role=dialog, Échap closes, focus moves inside and stays there (Tab wraps).
 * @param {{ title: string; onClose: () => void; cls?: string; onKey?: (e: KeyboardEvent) => boolean | void; children?: import('preact').ComponentChildren; footer?: import('preact').ComponentChildren }} p */
export function Modal({ title, onClose, cls, onKey, children, footer }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector('[autofocus], input, textarea, select, button:not([data-close])');
    /** @type {HTMLElement | null} */ (first ?? el)?.focus();
  }, []);
  /** @param {KeyboardEvent} e */
  const key = (e) => {
    if (onKey && onKey(e) === true) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === 'Tab' && ref.current) {
      const f = [...ref.current.querySelectorAll('button, input, textarea, select, [tabindex="0"]')].filter((x) => !(/** @type {HTMLButtonElement} */ (x)).disabled);
      if (!f.length) return;
      const a = /** @type {HTMLElement} */ (f[0]), z = /** @type {HTMLElement} */ (f[f.length - 1]);
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    }
  };
  return html`<div class="c-backdrop" onMouseDown=${(/** @type {MouseEvent} */ e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref=${ref} class=${'c-modal ' + (cls ?? '')} role="dialog" aria-modal="true" aria-label=${title} tabindex="-1" onKeyDown=${key}>
      <header class="c-modal-head"><h2>${title}</h2>
        <button type="button" class="c-icon" data-close aria-label=${t('lightbox.close')} onClick=${onClose}><${Icon} n="x" /></button></header>
      <div class="c-modal-body">${children}</div>
      ${footer ? html`<footer class="c-modal-foot">${footer}</footer>` : null}
    </div>
  </div>`;
}

/** @typedef {{ id: string; label: string; glyph?: string; hint?: string; checked?: boolean; disabled?: boolean; danger?: boolean; sep?: boolean }} MenuItem */
/** Button + role=menu with arrow keys, type-ahead and digits 1–9 (Alt+M then 1–5).
 * @param {{ label: import('preact').ComponentChildren; title?: string; items: MenuItem[]; onPick: (id: string) => void; cls?: string; open?: boolean; onOpenChange?: (o: boolean) => void; radio?: boolean }} p */
export function Menu({ label, title, items, onPick, cls, open, onOpenChange, radio }) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const set = (/** @type {boolean} */ o) => { setOwn(o); onOpenChange?.(o); };
  const list = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => { if (isOpen) /** @type {HTMLElement | null} */ (list.current?.querySelector('[role^=menuitem]:not([disabled])'))?.focus(); }, [isOpen]);
  const pickable = items.filter((i) => !i.sep);
  /** @param {KeyboardEvent} e */
  const key = (e) => {
    const els = [...(list.current?.querySelectorAll('[role^=menuitem]') ?? [])];
    const i = els.indexOf(/** @type {Element} */ (document.activeElement));
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); set(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      /** @type {HTMLElement | undefined} */ (els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length])?.focus();
      return;
    }
    const d = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (d) { const it = pickable[Number(d[1]) - 1]; if (it && !it.disabled) { e.preventDefault(); set(false); onPick(it.id); } return; }
    if (e.key.length === 1 && /\S/.test(e.key)) {
      const j = els.findIndex((x, k) => k > i && (x.textContent ?? '').trim().toLowerCase().startsWith(e.key.toLowerCase()));
      /** @type {HTMLElement | undefined} */ (els[j])?.focus();
    }
  };
  return html`<span class=${'c-menu ' + (cls ?? '')}>
    <button type="button" class="c-menu-btn" aria-haspopup="menu" aria-expanded=${isOpen} title=${title ?? ''} onClick=${() => set(!isOpen)}>${label}</button>
    ${isOpen ? html`<div ref=${list} class="c-menu-list" role="menu" onKeyDown=${key} onFocusOut=${(/** @type {FocusEvent} */ e) => {
      if (!list.current?.contains(/** @type {Node | null} */ (e.relatedTarget))) set(false); }}>
      ${items.map((it) => it.sep ? html`<div class="c-menu-sep" role="separator"></div>` : html`
        <button type="button" role=${radio ? 'menuitemradio' : 'menuitem'} aria-checked=${radio ? !!it.checked : undefined}
          class=${'c-menu-item' + (it.danger ? ' c-danger' : '')} disabled=${it.disabled} tabindex="-1"
          onClick=${() => { set(false); onPick(it.id); }}>
          <span>${it.glyph ? html`<${GlyphIcon} g=${it.glyph} size=${14} /> ` : null}${it.label}</span>${it.hint ? html`<small>${it.hint}</small>` : null}</button>`)}
    </div>` : null}
  </span>`;
}

/** Infos de session (zero tokens; chat.info{what:'session'}) or the context breakdown (chat.info{what:'context'}).
 * @param {{ chatId: string; what: 'session' | 'context' }} p */
export function InfoPopover({ chatId, what }) {
  const [data, setData] = useState(/** @type {any} */ (null));
  const [err, setErr] = useState(false);
  useEffect(() => { act().info(chatId, what).then(setData, () => setErr(true)); }, [chatId, what]);
  const title = what === 'session' ? t('info.title') : t('ctx.title');
  /** @type {import('preact').ComponentChildren} */ let body = err ? t('err.unsupported') : t('chat.loading');
  if (data && what === 'session') {
    /** @type {import('../../../shared/protocol.ts').SessionInfo} */ const s = data;
    body = html`<dl class="c-dl">
      <dt>${t('info.session')}</dt><dd><code>${s.sessionId}</code></dd>
      <dt>${t('info.cwd')}</dt><dd><code>${s.cwd}</code></dd>
      <dt>${t('info.transcript')}</dt><dd><code>${s.transcriptPath}</code> · ${fmtBytes(s.size)}</dd>
      ${s.cliVersion ? html`<dt>${t('info.version')}</dt><dd>${s.cliVersion}</dd>` : null}
      ${s.model ? html`<dt>${t('info.model')}</dt><dd>${s.model}</dd>` : null}
      ${s.tools !== undefined ? html`<dt>${t('info.tools')}</dt><dd>${s.tools}</dd>` : null}
      ${s.mcp?.length ? html`<dt>${t('info.mcp')}</dt><dd>${s.mcp.map((m) => `${m.name} (${m.status})`).join(', ')}</dd>` : null}
      <dt>${t('info.instructions')}</dt><dd><ul>${s.instructions.map((i) => html`<li class=${i.foreign ? 'c-warn' : ''}>
        ${i.foreign ? t('info.leak', { chemin: i.path }) : i.path}</li>`)}</ul></dd>
    </dl>`;
  } else if (data && what === 'context') {
    /** @type {import('../../../shared/protocol.ts').ContextSummary} */ const c = data;
    body = html`<p>${t('header.context', { pct: fmtPct(c.total / Math.max(1, c.window)), used: fmtTokens(c.total), max: fmtTokens(c.window) })}</p>
      <p>${t('header.context.auto', { pct: fmtPct(c.autoCompactAt / Math.max(1, c.window)) })}</p>
      <ul class="c-ctx">${c.categories.map((k) => html`<li><span>${k.name}</span><span>${fmtTokens(k.tokens)}</span></li>`)}</ul>`;
  }
  return html`<${Modal} title=${title} onClose=${closeOverlay} cls="c-info">${body}<//>`;
}

/** Confirmation dialog; with `typed`, the OK button stays disabled until that exact word is typed (bypass: CONTOURNER).
 * @param {{ title: string; body: string; ok: string; danger?: boolean; typed?: string; onOk: (typed?: string) => void }} p */
export function ConfirmModal({ title, body, ok, danger, typed, onOk }) {
  const [v, setV] = useState('');
  const can = !typed || v === typed;
  const go = () => { if (!can) return; closeOverlay(); onOk(typed ? v : undefined); };
  const footer = html`<button type="button" class="d-btn d-quiet" onClick=${closeOverlay}>${t('cap.cancel')}</button>
    <button type="button" class=${'d-btn ' + (danger ? 'd-danger' : 'd-primary')} disabled=${!can} onClick=${go}>${ok}</button>`;
  /** @param {KeyboardEvent} e */
  const onKey = (e) => { if (e.key === 'Enter' && typed && can) { go(); return true; } return false; };
  return html`<${Modal} title=${title} onClose=${closeOverlay} onKey=${onKey} cls="s-confirm-modal" footer=${footer}>
    <p>${body}</p>
    ${typed ? html`<input type="text" class="s-typed" autocomplete="off" spellcheck="false" aria-label=${typed} value=${v}
      onInput=${(/** @type {any} */ e) => setV(e.currentTarget.value)} />` : null}
  <//>`;
}
