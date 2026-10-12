// @ts-check
// src/web/components/shell/PaneGrid.js — 1 to 4 panes (ux §3.4): 1 · 2 side by side · 3 (one large left, two stacked
// right) · 4 (2×2). Minimum pane width 420 px: when the grid is narrower, it falls back to fewer columns. The focused
// pane has a ring in its account's colour; a tab dropped on a pane shows there. Each cell mounts the chat surface's <Pane>.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { LIMITS, ui } from '../../store.js';
import { focusPane, openOverlay, showInPane } from '../../actions.js';
import { Pane } from '../chat/Pane.js';
import { Dashboard } from './Dashboard.js';
import { TAB_MIME } from './TabStrip.js';
import { Icon } from '../../lib/icons.js';

const COLS = { 1: 1, 2: 2, 3: 2, 4: 2 };

export function PaneGrid() {
  const u = ui.value;
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = width < COLS[u.layout] * LIMITS.PANE_MIN_WIDTH_PX;
  return html`<main ref=${ref} class=${`panegrid layout-${u.layout} ${narrow ? 'narrow' : ''}`} data-region="panes">
    ${u.panes.map((c, i) => html`<div key=${i} class=${`pane-cell cell-${i} ${i === u.focusedPane && u.layout > 1 ? 'focused' : ''}`}
        data-pane=${i} data-chat=${c ?? ''} data-region=${`pane-${i}`}
        onMouseDownCapture=${() => focusPane(i)}
        onDragOver=${(/** @type {DragEvent} */ e) => { if (e.dataTransfer?.types.includes(TAB_MIME)) { e.preventDefault(); /** @type {HTMLElement} */ (e.currentTarget).classList.add('drop'); } }}
        onDragLeave=${(/** @type {DragEvent} */ e) => /** @type {HTMLElement} */ (e.currentTarget).classList.remove('drop')}
        onDrop=${(/** @type {DragEvent} */ e) => { const d = e.dataTransfer?.getData(TAB_MIME); /** @type {HTMLElement} */ (e.currentTarget).classList.remove('drop'); if (d) { e.preventDefault(); showInPane(JSON.parse(d).c, i); } }}>
      ${c ? html`<${Pane} key=${c} chatId=${c} pane=${i} focused=${i === u.focusedPane} />`
        : u.layout === 1 ? html`<${Dashboard} />`              // the home view; with several panes an empty one stays a short hint
        : html`<div class="pane-empty" tabindex="-1"><p>${t('shell.pane.empty')}</p><p class="muted">${t('shell.pane.emptyHint')}</p>
            <p><button type="button" class="btn" onClick=${() => openOverlay('newChat')}><${Icon} n="plus" size=${14} /> ${t('nav.newChat')}</button>
            <button type="button" class="btn" onClick=${() => openOverlay('resume')}><${Icon} n="rotate" size=${14} /> ${t('nav.resume')}</button></p></div>`}
    </div>`)}
  </main>`;
}
