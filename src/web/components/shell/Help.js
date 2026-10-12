// @ts-check
// src/web/components/shell/Help.js — keyboard map overlay (F1 or `?` outside text; SPEC §9.3).
// Every row is an i18n key `shell.help.<row>` (what it does) plus `shell.help.<row>.keys` (the French key names:
// Échap, Entrée, Maj… are copy too).
import { html } from 'htm/preact';
import { t } from '../../lib/i18n.js';
import { closeOverlay } from '../../actions.js';
import { Modal } from './common.js';

/** [section key, row keys][] */
const MAP = /** @type {[string, string[]][]} */ ([
  ['shell.help.global', ['shell.help.switcher', 'shell.help.newResumeAccounts', 'shell.help.nextAttention', 'shell.help.tabs', 'shell.help.tabOps', 'shell.help.regions']],
  ['shell.help.chat', ['shell.help.interrupt', 'shell.help.view', 'shell.help.modes']],
  ['shell.help.composer', ['shell.help.send', 'shell.help.later', 'shell.help.composerMore']],
  ['shell.help.cards', ['shell.help.cardKeys']],
  ['shell.help.sidebar', ['shell.help.sideKeys']],
]);

export function Help() {
  return html`<${Modal} title=${t('shell.help.title')} onClose=${closeOverlay} wide=${true}>
    <div class="help-grid">${MAP.map(([sec, rows]) => html`<section key=${sec}><h3>${t(sec)}</h3>
      <dl>${rows.map((k) => html`<dt><kbd>${t(`${k}.keys`)}</kbd></dt><dd>${t(k)}</dd>`)}</dl></section>`)}</div>
  </${Modal}>`;
}
