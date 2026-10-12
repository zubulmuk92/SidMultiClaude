// @ts-check
// src/web/components/shell/App.js — the shell (ux §3): top bar · sidebar · tab strip + pane grid · status bar, plus the
// global keymap (SPEC §9.3), the overlay host (one shell overlay at a time), the popup menu, toasts and the chat surface's
// ChatOverlays.
import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { actionFor, digitOf, GLOBAL, isGlobal } from '../../lib/keymap.js';
import { accounts, hydrated, orphans, overlay, ui } from '../../store.js';
import { attention } from '../../derived.js';
import { t } from '../../lib/i18n.js';
import { closeOverlay, closeTab, focusPane, nextAttention, openOverlay, reopenTab, setLayout, tabAt, tabStep, toggleSidebar } from '../../actions.js';
import { ChatOverlays } from '../chat/Pane.js';
import { TopBar } from './TopBar.js';
import { Sidebar } from './Sidebar.js';
import { TabStrip } from './TabStrip.js';
import { PaneGrid } from './PaneGrid.js';
import { StatusBar } from './StatusBar.js';
import { Toasts } from './Toasts.js';
import { Banners } from './Banners.js';
import { QuickSwitcher } from './QuickSwitcher.js';
import { Help } from './Help.js';
import { PeekHost } from './PeekHost.js';
import { MenuHost, Modal, menu } from './common.js';
import { Dashboard } from './Dashboard.js';
import { modalOpen } from '../../lib/modal.js';
import { NewChat } from '../dialogs/NewChat.js';
import { Resume } from '../dialogs/Resume.js';
import { Accounts } from '../dialogs/Accounts.js';
import { Login } from '../dialogs/Login.js';
import { Settings } from '../dialogs/Settings.js';
import { Confirm } from '../dialogs/Confirm.js';
import { Orphans } from '../dialogs/Orphans.js';

/** F6 / Maj+F6: top bar → sidebar → pane 1 → … (ux §10.4). @param {1 | -1} d */
export function cycleRegion(d) {
  const regions = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-region="topbar"], [data-region="sidebar"], .pane-cell')])
    .filter((el) => el.offsetParent !== null);
  if (!regions.length) return;
  const cur = regions.findIndex((r) => r.contains(document.activeElement));
  const next = regions[(cur + d + regions.length) % regions.length];
  if (!next) return;
  const pane = next.dataset['pane'];
  if (pane !== undefined) focusPane(Number(pane));          // focus follows F6 (a plain focusin never moves the focused pane)
  const target = /** @type {HTMLElement | null} */ (next.querySelector('textarea, [role="treeitem"][tabindex="0"], button, input, [tabindex="0"]'));
  (target ?? next).focus();
}

/** Global keydown (bubble phase: dialogs, cards and the composer stop what they handle). @param {KeyboardEvent} e */
export function onGlobalKey(e) {
  if (e.defaultPrevented) return;
  const id = actionFor(e);
  if (!isGlobal(id) || id === null) return;
  if (menu.value || modalOpen()) {            // a shell dialog, a chat overlay (ChatOverlays) or any aria-modal surface
    if (id === GLOBAL.switcher && overlay.value?.kind === 'switcher') { e.preventDefault(); overlay.value = null; }
    return;
  }
  e.preventDefault();
  if (id.startsWith('tab:')) { tabAt(digitOf(e) ?? Number(id.slice(4))); return; }
  switch (id) {
    case GLOBAL.switcher: openOverlay('switcher'); return;
    case GLOBAL.newChat: openOverlay('newChat'); return;
    case GLOBAL.resume: openOverlay('resume'); return;
    case GLOBAL.accounts: openOverlay('accounts'); return;
    case GLOBAL.nextAttention: nextAttention(); return;
    case GLOBAL.tabNext: tabStep(1); return;
    case GLOBAL.tabPrev: tabStep(-1); return;
    case GLOBAL.closeTab: closeTab(); return;
    case GLOBAL.reopenTab: reopenTab(); return;
    case GLOBAL.layout: setLayout(); return;
    case GLOBAL.sidebar: toggleSidebar(); return;
    case GLOBAL.regionNext: cycleRegion(1); return;
    case GLOBAL.regionPrev: cycleRegion(-1); return;
    case GLOBAL.help: openOverlay('help'); return;
    case GLOBAL.settings: openOverlay('settings'); return;
    default: return;
  }
}

/** Collapsed sidebar (Alt+B): a 48 px rail of account monograms with their attention counts (ux §3.2). */
function SidebarRail() {
  const att = attention.value;
  return html`<nav class="side-rail" aria-label=${t('shell.side.label')} data-region="sidebar">
    ${accounts.value.filter((a) => !a.hidden).map((a) => {
      const n = att.filter((s) => s.accountId === a.id).length;
      return html`<button type="button" key=${a.id} class=${`rail-acc acc-${a.color}`} title=${a.name} aria-label=${`${a.name}${n ? ` · ${t('shell.top.attention', { n })}` : ''}`}
        onClick=${toggleSidebar}><span class=${`acc-badge acc-${a.color}`}>${a.monogram}</span>${n ? html`<b class="rail-badge">${n}</b>` : null}</button>`;
    })}</nav>`;
}

function OverlayHost() {
  const o = overlay.value;
  if (!o) return orphans.value ? html`<${Orphans} />` : null;
  const p = o.props ?? {};
  switch (o.kind) {
    case 'switcher': return html`<${QuickSwitcher} />`;
    case 'help': return html`<${Help} />`;
    case 'dashboard': return html`<${Modal} title=${t('dash.title')} onClose=${closeOverlay} wide=${true} cls="dash-dlg"><${Dashboard} inDialog=${true} /><//>`;
    case 'peek': return html`<${PeekHost} chatId=${p['chatId']} />`;
    case 'newChat': return html`<${NewChat} ...${p} />`;
    case 'resume': return html`<${Resume} />`;
    case 'accounts': return html`<${Accounts} firstRun=${p['firstRun'] === true} />`;
    case 'login': return html`<${Login} accountId=${p['accountId']} />`;
    case 'settings': return html`<${Settings} />`;
    case 'confirm': return html`<${Confirm} ...${p} />`;
    case 'orphans': return html`<${Orphans} />`;
    default: return null;
  }
}

export function App() {
  useEffect(() => {
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, []);
  const u = ui.value;
  const rail = u.sidebar.collapsed;
  return html`<div class=${`shell ${rail ? 'side-collapsed' : ''} ${hydrated.value ? 'ready' : 'booting'}`}>
    <${TopBar} />
    <${Banners} />
    <div class="shell-body">
      ${rail ? html`<${SidebarRail} />` : html`<${Sidebar} />`}
      <div class="work"><${TabStrip} /><${PaneGrid} /></div>
    </div>
    <${StatusBar} />
  </div>
  <div class="layers">
    <${OverlayHost} />
    <${ChatOverlays} />
    <${MenuHost} />
    <${Toasts} />
  </div>`;
}
