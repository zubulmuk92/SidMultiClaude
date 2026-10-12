// @ts-check
// src/web/components/side/AgentsDrawer.js — « Agents & tâches d'arrière-plan » drawer on the right of the pane (ux §7.9):
// agents (nested by depth) and commands from the `tasks` events, live line (time · tokens · tools), ■ stop one,
// « Tout arrêter » with a confirmation, « Voir la sortie » fetched on demand. Alt+G / Échap.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, fmtClock, fmtTokens } from '../chat/text.js';
import { act, chatUi, useChatVM } from '../chat/env.js';
import { useNow } from '../dock/Card.js';
import { GlyphIcon, Icon } from '../../lib/icons.js';

/** @typedef {import('../../../shared/protocol.ts').TaskView} TaskView */

/** @param {TaskView} x @param {number} now */
export function taskLine(x, now) {
  if (x.status !== 'running') return t(`agents.status.${x.status}`);
  return [fmtClock(now - x.startedAt), x.tokens ? fmtTokens(x.tokens) : '', x.tools ? t('agents.tools', { n: x.tools }) : '', x.detail ?? ''].filter(Boolean).join(' · ');
}

/** @param {{ chatId: string }} p */
export function AgentsDrawer({ chatId }) {
  const vm = useChatVM(chatId);
  const u = chatUi(chatId);
  const now = useNow();
  const [confirm, setConfirm] = useState(false);
  const [out, setOut] = useState(/** @type {Record<string, string>} */ ({}));
  const root = useRef(/** @type {HTMLElement | null} */ (null));
  useEffect(() => { root.current?.focus(); }, []);
  const tasks = vm.tasks.value;
  const agents = tasks.filter((x) => x.kind === 'agent' || x.kind === 'workflow');
  const cmds = tasks.filter((x) => x.kind !== 'agent' && x.kind !== 'workflow');
  const running = tasks.filter((x) => x.status === 'running').length;
  /** @param {TaskView} x */
  const output = (x) => {
    if (!x.toolUseId) return;
    act().detail(chatId, `t:${x.toolUseId}`, 'output').then((d) => setOut({ ...out, [x.id]: d.text ?? '' }), () => setOut({ ...out, [x.id]: t('tool.detail.error') }));
  };
  /** @param {TaskView} x */
  const row = (x) => html`<li key=${x.id} class=${'s-task s-' + x.status} style=${{ paddingInlineStart: `${(x.depth ?? 0) * 14}px` }}>
    <span class="s-task-main"><span aria-hidden="true"><${GlyphIcon} g=${x.status === 'running' ? '◐' : x.status === 'done' ? '✓' : x.status === 'failed' ? '✕' : '■'} size=${13} /></span>
      ${x.title}${x.background ? html` <span class="c-badge">${t('tool.bash.bg')}</span>` : null}</span>
    <span class="s-task-line">${taskLine(x, now)}</span>
    ${x.kind !== 'agent' && x.toolUseId ? html`<button type="button" class="c-mini" onClick=${() => output(x)}>${t('agents.output')}</button>` : null}
    ${x.status === 'running' ? html`<button type="button" class="c-icon" aria-label=${t('agents.stop') + ' ' + x.title} onClick=${() => { void act().task(chatId, 'stop', x.id).catch(() => {}); }}><${Icon} n="stop-fill" size=${12} /></button>` : null}
    ${out[x.id] !== undefined ? html`<pre class="c-out">${out[x.id]}</pre>` : null}
  </li>`;
  return html`<aside ref=${root} class="s-drawer" tabindex="-1" aria-label=${t('agents.title')}
      onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); u.drawer.value = false; } }}>
    <header class="s-drawer-head"><h2>${t('agents.title')}</h2>
      <button type="button" class="d-btn" disabled=${!running} onClick=${() => setConfirm(true)}>${t('agents.stopAll')}</button>
      <button type="button" class="c-icon" aria-label=${t('agents.close')} onClick=${() => { u.drawer.value = false; }}><${Icon} n="x" /></button></header>
    ${confirm ? html`<div class="s-confirm" role="alertdialog">${t('agents.stopAll.confirm', { n: running })}
      <button type="button" class="d-btn d-danger" onClick=${() => { setConfirm(false); void act().task(chatId, 'stopAll').catch(() => {}); }}>${t('agents.stopAll')}</button>
      <button type="button" class="d-btn d-quiet" onClick=${() => setConfirm(false)}>${t('cap.cancel')}</button></div>` : null}
    ${!tasks.length ? html`<p class="s-empty">${t('agents.none')}</p>` : null}
    ${agents.length ? html`<h3>${t('agents.group.agents')}</h3><ul class="s-tasks">${agents.map(row)}</ul>` : null}
    ${cmds.length ? html`<h3>${t('agents.group.commands')}</h3><ul class="s-tasks">${cmds.map(row)}</ul>` : null}
  </aside>`;
}
