// @ts-check
// src/web/components/dock/PendingDock.js — sticky dock above the composer (ux §6.1): server-held asks, oldest first,
// stacked « 1 sur n » (Alt+↓ / Alt+↑ move through the stack), never steals keystrokes (focus moves to a new card only
// when the pane is focused, the composer is empty and the user has not typed for 2 s; otherwise the card pulses and is
// announced). A card withdrawn by an interrupt or a crash collapses to « Demande annulée » for 3 s.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../chat/text.js';
import { announce, chatUi, getEnv, useChatVM } from '../chat/env.js';
import { UI } from '../chat/consts.js';
import { ErrorBoundary } from '../chat/ErrorBoundary.js';
import { PermissionCard } from './PermissionCard.js';
import { QuestionForm } from './QuestionForm.js';
import { PlanCard } from './PlanCard.js';
import { ElicitationCard } from './ElicitationCard.js';
import { answered } from './Card.js';

/** @typedef {import('../../../shared/protocol.ts').PendingAsk} PendingAsk */

/** Focus the top card of a chat (the shell binds it to Alt+A). @param {string} chatId @returns {boolean} */
export function focusDock(chatId) {
  if (typeof document === 'undefined') return false;
  const el = /** @type {HTMLElement | null} */ (document.querySelector(`.d-dock[data-chat="${CSS.escape(chatId)}"] [data-dock-card]`));
  el?.focus();
  return !!el;
}

/** @param {{ chatId: string; ask: PendingAsk; index: number; total: number; autoFocus?: boolean }} p */
function CardFor(p) {
  switch (p.ask.kind) {
    case 'question': return html`<${QuestionForm} ...${p} />`;
    case 'plan': return html`<${PlanCard} ...${p} />`;
    case 'elicitation': return html`<${ElicitationCard} ...${p} />`;
    default: return html`<${PermissionCard} ...${p} />`;
  }
}

/** @param {{ chatId: string; compact?: boolean; focused?: boolean }} p */
export function PendingDock({ chatId, compact, focused }) {
  const vm = useChatVM(chatId);
  const asks = vm.asks.value;
  const [sel, setSel] = useState(0);
  const [gone, setGone] = useState(/** @type {{ id: string; text: string }[]} */ ([]));
  const [pulse, setPulse] = useState(/** @type {string | null} */ (null));
  const [focusId, setFocusId] = useState(/** @type {string | null} */ (null));
  const prev = useRef(/** @type {PendingAsk[]} */ ([]));
  useEffect(() => {
    const before = prev.current;
    prev.current = asks;
    const now = new Set(asks.map((a) => a.requestId));
    for (const a of before) {
      if (now.has(a.requestId) || answered.has(a.requestId)) continue;
      setTimeout(() => {            // let the tool block / state settle, then decide whether this was a withdrawal
        const reason = vm.askEndReason(a.requestId);
        const blk = vm.blocks(`t:${a.toolUseId}`)?.value;
        const st = blk && blk.k === 'tool' ? blk.status : undefined;
        const crash = reason === 'crash' || vm.summary.value.state.phase === 'error';
        if (reason === 'answered' || (!reason && !crash && st !== 'withdrawn' && st !== 'interrupted')) return;
        const item = { id: a.requestId, text: crash ? t('perm.withdrawn.crash') : t('perm.cancelled') };
        setGone((g) => [...g, item]);
        setTimeout(() => setGone((g) => g.filter((x) => x !== item)), UI.CANCELLED_FADE_MS);
      }, 150);
    }
    const fresh = asks.filter((a) => !before.some((b) => b.requestId === a.requestId));
    if (fresh.length && !compact) {
      const u = chatUi(chatId);
      const idle = Date.now() - u.lastTypedAt > UI.CARD_AUTOFOCUS_IDLE_MS;
      const empty = !vm.draft.value.text.trim();
      const f = /** @type {PendingAsk} */ (fresh[0]);
      if (focused && idle && empty) setFocusId(f.requestId);
      else { setPulse(f.requestId); setTimeout(() => setPulse(null), 1200); }
      const title = vm.summary.value.title;
      announce(f.kind === 'question' ? t('a11y.ask', { titre: title }) : f.kind === 'plan' ? t('a11y.plan', { titre: title })
        : t('a11y.perm', { outil: f.displayName || f.toolName, titre: title }));
    }
    if (sel >= asks.length) setSel(Math.max(0, asks.length - 1));
  }, [asks]);
  if (!asks.length && !gone.length) return null;
  const top = Math.min(sel, Math.max(0, asks.length - 1));
  const shown = compact ? asks.slice(0, 1) : asks.slice(top, top + 1);
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || asks.length < 2) return;
    e.preventDefault(); e.stopPropagation();
    const n = (top + (e.key === 'ArrowDown' ? 1 : -1) + asks.length) % asks.length;
    setSel(n);
    setTimeout(() => focusDock(chatId), 0);
  };
  return html`<div class=${'d-dock' + (compact ? ' d-compact' : '')} data-chat=${chatId} role="region" aria-label=${t('dock.label')} onKeyDown=${onKey}>
    ${gone.map((g) => html`<div key=${g.id} class="d-gone" role="status">${g.text}</div>`)}
    ${shown.map((a) => html`<div key=${a.requestId} class=${pulse === a.requestId ? 'd-pulse' : ''}>
      <${ErrorBoundary} label=${'card ' + a.kind} chatId=${chatId}>
        <${CardFor} chatId=${chatId} ask=${a} index=${asks.indexOf(a)} total=${compact ? 1 : asks.length} autoFocus=${focusId === a.requestId} />
      <//></div>`)}
  </div>`;
}
