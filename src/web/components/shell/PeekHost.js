// @ts-check
// src/web/components/shell/PeekHost.js — the Peek frame (SPEC §9.2.1): `Espace` on a sidebar or *À traiter* row opens a
// floating panel with the last 3 exchanges (the chat surface's <Peek>, fed by tx.page through peekTurns, cached) and the chat's top
// pending card (its keys 1 / 2 / 3). `Entrée` opens the chat, `Échap` always closes. Never spawns a process.
// The shell owns the frame (backdrop, focus trap, focus restore); the chat surface renders everything inside, header
// and hint included.
import { html } from 'htm/preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { chats } from '../../store.js';
import { closeOverlay, openChat } from '../../actions.js';
import { Peek } from '../chat/Peek.js';
import { trapFocus } from './common.js';

/** @param {{ chatId: string }} p */
export function PeekHost({ chatId }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  // the opener is read at the first render: <Peek>'s own effect moves the focus inside before this one runs
  const opener = useRef(/** @type {Element | null} */ (document.activeElement));
  const s = chats.value.get(chatId);
  useLayoutEffect(() => {                    // at commit: an Échap before the next paint still restores the focus
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus();
    const stop = trapFocus(el);
    return () => { stop(); const o = opener.current; if (o instanceof HTMLElement && o.isConnected) o.focus(); };
  }, [chatId]);
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeOverlay(); }
    else if (e.key === 'Enter' && (e.target === ref.current || !(e.target instanceof HTMLElement && e.target.closest('button, input, textarea, [role="group"], .d-card')))) {
      e.preventDefault(); closeOverlay(); openChat(chatId, e.ctrlKey ? 'newPane' : 'focused');
    }
  };
  return html`<div class="ov-backdrop peek-backdrop" onMouseDown=${(/** @type {MouseEvent} */ e) => { if (e.target === e.currentTarget) closeOverlay(); }}>
    <div ref=${ref} class="peek" role="dialog" aria-modal="true" aria-label=${t('peek.title', { titre: s?.title || t('state.new') })} tabindex="-1" onKeyDown=${onKey}>
      <${Peek} chatId=${chatId} onClose=${closeOverlay} />
    </div></div>`;
}
