// @ts-check
// src/web/components/dialogs/Orphans.js — after a crash in `plain` isolation, processes started by Claude may still run
// (SPEC §9.2.12): « Arrêter » kills exactly the listed pids (orphans.kill), « Laisser tourner » dismisses.
import { html } from 'htm/preact';
import { t } from '../../lib/i18n.js';
import { orphans, overlay } from '../../store.js';
import { killOrphans } from '../../actions.js';
import { Modal } from '../shell/common.js';

export function Orphans() {
  const items = orphans.value ?? [];
  const keep = () => { orphans.value = null; if (overlay.value?.kind === 'orphans') overlay.value = null; };
  const names = [...new Set(items.map((x) => x.name))].slice(0, 6).join(', ');
  return html`<${Modal} title=${t('shell.orphans.head')} onClose=${keep}
      footer=${html`<button type="button" class="btn" onClick=${keep}>${t('orphans.keep')}</button>
        <button type="button" class="btn danger" data-autofocus onClick=${() => { const pids = items.map((x) => x.pid); keep(); void killOrphans(pids).catch(() => {}); }}>${t('orphans.kill')}</button>`}>
    <p>${t('orphans.title', { noms: names })}</p>
    <ul class="orphans">${items.map((x) => html`<li key=${x.pid}><code>${x.name}</code> <span class="muted">pid ${x.pid}</span></li>`)}</ul>
  </${Modal}>`;
}
