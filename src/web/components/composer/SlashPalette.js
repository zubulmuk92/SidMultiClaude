// @ts-check
// src/web/components/composer/SlashPalette.js — « / » palette (ux §7.4): commands from meta.commands (terminal-only ones
// are hidden: logic.js TERMINAL_ONLY), grouped Commandes intégrées / Skills / Plugins / MCP, fuzzy on names, aliases and
// descriptions, badge « local » (no model call) or « ↯ modèle ». Keys are driven by the composer.
import { html } from 'htm/preact';
import { useEffect, useRef } from 'preact/hooks';
import { t, tp } from '../chat/text.js';
import { slashResults } from './logic.js';
import { Icon } from '../../lib/icons.js';

/** @typedef {import('../../../shared/protocol.ts').SlashCommandView} SlashCommandView */

const GROUP_INDEX = /** @type {const} */ ({ builtin: 0, skill: 1, plugin: 2, mcp: 3 });

/** Flat, ordered rows of the palette (what ↑ / ↓ walk through). @param {SlashCommandView[]} cmds @param {string} q */
export function slashRows(cmds, q) {
  return slashResults(cmds, q).flatMap((g) => g.items);
}

// Hover follows real pointer moves only: a palette that opens under a resting pointer must not steal the keyboard selection.
/** @param {{ cmds: SlashCommandView[]; q: string; sel: number; onPick: (c: SlashCommandView) => void; onHover: (k: number) => void }} p */
export function SlashPalette({ cmds, q, sel, onPick, onHover }) {
  const groups = slashResults(cmds, q);
  const list = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel, q]);
  let k = -1;
  return html`<div ref=${list} class="p-pop p-slash" role="listbox" id="p-slash" aria-label="/">
    ${groups.length ? groups.map((g) => html`<div role="group" aria-label=${tp('slash.groups', GROUP_INDEX[g.group])}>
      <div class="p-group">${tp('slash.groups', GROUP_INDEX[g.group])}</div>
      ${g.items.map((c) => { k++; const i = k; return html`<div role="option" id=${'p-slash-' + i} aria-selected=${i === sel}
          class=${'p-row' + (i === sel ? ' p-sel' : '')} onMouseDown=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); onPick(c); }}
          onMouseMove=${(/** @type {MouseEvent} */ e) => { if (e.movementX || e.movementY) onHover(i); }}>
        <span class="p-name">/${c.name}${c.hint ? html` <span class="p-hint">${c.hint}</span>` : null}</span>
        <span class="p-desc">${c.description}</span>
        <span class=${'p-badge' + (c.local ? ' p-local' : ' p-model')}>${c.local ? t('slash.local') : html`<${Icon} n="zap" size=${11} /> ${t('slash.model')}`}</span>
      </div>`; })}
    </div>`) : html`<div class="p-empty">${t('slash.empty')}</div>`}
  </div>`;
}
