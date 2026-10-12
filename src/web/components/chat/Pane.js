// @ts-check
// src/web/components/chat/Pane.js — one chat pane (ux §3.5, §5–§7; contract.d.ts): header, banners, transcript, tasks
// strip, pending dock, composer and the agents drawer, with the chat keys of SPEC §9.3 (Ctrl+O view, Ctrl+F search,
// F2 rename, Ctrl+B background, Alt+M / Alt+P / Alt+T / Alt+G, Alt+↑/↓ messages, Ctrl+Fin, Échap interrupts).
// ChatOverlays() hosts the chat dialogs (mounted once by the shell) and the polite live region.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from './text.js';
import { accountOf, act, announce, announcement, chatUi, cycleView, requestComposerFocus, useChatVM } from './env.js';
import { CHAT, actionFor, inTextField } from '../../lib/keymap.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { PaneHeader } from './PaneHeader.js';
import { PaneBanners } from './PaneBanners.js';
import { Transcript, navigateMessage, scrollToBottom } from './Transcript.js';
import { TodoStrip } from '../side/TodoStrip.js';
import { AgentsDrawer } from '../side/AgentsDrawer.js';
import { PendingDock } from '../dock/PendingDock.js';
import { Composer, interruptChat, isBusy } from '../composer/Composer.js';
import { overlay } from '../side/overlays.js';
import { RewindDialog } from '../side/RewindDialog.js';
import { ContinueOnDialog } from '../side/ContinueOnDialog.js';
import { WakeDialog } from '../side/WakeDialog.js';
import { ModelSwitchConfirm } from '../side/ModelSwitchConfirm.js';
import { Lightbox } from '../side/Lightbox.js';
import { ConfirmModal, InfoPopover } from '../side/Popovers.js';

/** @typedef {import('../../../shared/protocol.ts').ChatId} ChatId */

/** Running Bash / PowerShell tool of the last turn (Ctrl+B). @param {import('../../contract.d.ts').ChatVM} vm */
function runningCommand(vm) {
  const last = vm.turns.value[vm.turns.value.length - 1]?.sig.value;
  const b = last?.blocks.filter((x) => x.k === 'tool' && x.status === 'running' && (x.name === 'Bash' || x.name === 'PowerShell')).pop();
  return b && b.k === 'tool' ? b.toolUseId : undefined;
}

/** @param {{ chatId: ChatId; pane: number; focused: boolean }} props */
export function Pane({ chatId, pane, focused }) {
  const vm = useChatVM(chatId);
  const u = chatUi(chatId);
  const sum = vm.summary.value;
  const root = useRef(/** @type {HTMLElement | null} */ (null));
  const [narrow, setNarrow] = useState(false);
  const prevPhase = useRef(sum.state.phase);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (focused && root.current && !root.current.contains(document.activeElement)) requestComposerFocus(chatId); }, [focused, chatId]);
  useEffect(() => {                         // « Claude a terminé de répondre dans {titre} », once per turn, never while streaming
    const was = prevPhase.current, now = sum.state.phase;
    prevPhase.current = now;
    if (was === 'running' && now === 'idle') announce(t('a11y.done', { titre: sum.title }));
    if (now === 'running' && sum.state.sub === 'compacting') announce(t('a11y.compacting'));
  }, [sum.state.phase, sum.state.sub]);
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.defaultPrevented) return;
    const id = actionFor(e) ?? (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'b' ? CHAT.background : null);
    const run = (/** @type {() => void} */ f) => { e.preventDefault(); e.stopPropagation(); f(); };
    switch (id) {
      case CHAT.view: return run(() => cycleView(chatId));
      case CHAT.search: return run(() => { u.search.value = true; });
      case CHAT.rename: return run(() => { u.renaming.value = true; });
      case CHAT.background: return run(() => { const ref = runningCommand(vm); if (ref) void act().task(chatId, 'background', ref).catch(() => {}); });
      case CHAT.mode: return run(() => { u.menu.value = 'mode'; });
      case CHAT.model: return run(() => { u.menu.value = 'model'; });
      case CHAT.tasks: return run(() => { u.todosOpen.value = !u.todosOpen.value; });
      case CHAT.agents: return run(() => { u.drawer.value = !u.drawer.value; });
      case CHAT.prevMsg: return run(() => navigateMessage(chatId, -1));
      case CHAT.nextMsg: return run(() => navigateMessage(chatId, 1));
      case CHAT.bottom: return run(() => scrollToBottom(chatId));
      default: break;
    }
    if (e.key === 'Escape' && !inTextField(e.target) && isBusy(sum.state.phase)) run(() => interruptChat(chatId));
  };
  const acc = accountOf(sum.accountId);
  return html`<section ref=${root} class=${'c-pane' + (acc ? ' acc-' + acc.color : '') + (focused ? ' c-focused' : '')} data-chat=${chatId} data-pane=${pane}
      role="region" aria-label=${t('chat.region', { titre: sum.title, compte: sum.accountId })} onKeyDown=${onKey}>
    <${ErrorBoundary} label="header" chatId=${chatId}><${PaneHeader} chatId=${chatId} narrow=${narrow} /><//>
    <${ErrorBoundary} label="banners" chatId=${chatId}><${PaneBanners} chatId=${chatId} /><//>
    <div class="c-body">
      <div class="c-main">
        <${Transcript} chatId=${chatId} />
        <${ErrorBoundary} label="todos" chatId=${chatId}><${TodoStrip} chatId=${chatId} /><//>
        <${PendingDock} chatId=${chatId} focused=${focused} />
        <${ErrorBoundary} label="composer" chatId=${chatId}><${Composer} chatId=${chatId} focused=${focused} /><//>
      </div>
      ${u.drawer.value ? html`<${ErrorBoundary} label="drawer" chatId=${chatId}><${AgentsDrawer} chatId=${chatId} /><//>` : null}
    </div>
  </section>`;
}

/** Chat dialogs (one at a time) and the surface's polite live region; mounted once by the shell (contract.d.ts). */
export function ChatOverlays() {
  useEffect(() => {                        // markdown links (md.js marks them data-ext) open in the user's browser, never in the app
    /** @param {MouseEvent} e */
    const onClick = (e) => {
      if (e.defaultPrevented || (e.type === 'click' && e.button !== 0) || (e.type === 'auxclick' && e.button !== 1)) return;
      const a = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest('.md a[href]') : null);
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') ?? '';
      if (/^https?:\/\//i.test(href)) act().openExternal(href);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('auxclick', onClick);
    return () => { document.removeEventListener('click', onClick); document.removeEventListener('auxclick', onClick); };
  }, []);
  const o = overlay.value;
  /** @type {import('preact').ComponentChildren} */ let body = null;
  if (o) {
    switch (o.kind) {
      case 'rewind': body = html`<${RewindDialog} chatId=${o.chatId} uuid=${o.uuid} />`; break;
      case 'continue': body = html`<${ContinueOnDialog} chatId=${o.chatId} target=${o.target} />`; break;
      case 'wake': body = html`<${WakeDialog} chatId=${o.chatId} text=${o.text} images=${o.images} />`; break;
      case 'model': body = html`<${ModelSwitchConfirm} chatId=${o.chatId} model=${o.model} effort=${o.effort} />`; break;
      case 'lightbox': body = html`<${Lightbox} chatId=${o.chatId} imageRef=${o.ref} dataUrl=${o.dataUrl} />`; break;
      case 'info': body = html`<${InfoPopover} chatId=${o.chatId} what=${o.what} />`; break;
      case 'confirm': body = html`<${ConfirmModal} ...${o} />`; break;
      default: body = null;            // 'cap' and 'agents' render inline in their pane
    }
  }
  return html`<div class="c-overlays">
    ${body ? html`<${ErrorBoundary} label=${'overlay ' + (o?.kind ?? '')}>${body}<//>` : null}
    <div class="sr-only" aria-live="polite" role="status">${announcement.value}</div>
  </div>`;
}
