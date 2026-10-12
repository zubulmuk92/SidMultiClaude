// @ts-check
// src/web/components/dock/PermissionCard.js — permission card and its Edit/Write variant (ux §6.2–6.3, SPEC §2.5).
// Keys (on the card, never in a text field): 1/O allow (not with defaultToNo) · 2/T always (←/→ scope) · 3/N deny… ·
// Échap deny and stop · Tab comment · E edit before accepting · V full screen. Never offers userSettings (S7).
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t } from '../chat/text.js';
import { getEnv } from '../chat/env.js';
import { inTextField } from '../../lib/keymap.js';
import { DiffView, opsToHunks } from '../chat/DiffView.js';
import { askSubject, canEditBefore, cycleScope, editTexts, editedInput, isEditAsk, permissionKey, permReasonKey, previewStats, SCOPE_KEYS } from './logic.js';
import { CardFrame, Kbd, useDecide } from './Card.js';

/** @typedef {import('../../../shared/protocol.ts').PendingAsk} PendingAsk */
/** @typedef {import('./logic.js').Scope} Scope */

/** @param {string} p */
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** @param {{ chatId: string; ask: PendingAsk; index: number; total: number; autoFocus?: boolean }} p */
export function PermissionCard({ chatId, ask, index, total, autoFocus }) {
  const { busy, elsewhere, decide } = useDecide(chatId, ask);
  const isEdit = isEditAsk(ask), canEdit = canEditBefore(ask);
  const [scope, setScope] = useState(/** @type {Scope} */ ('session'));
  const [mode, setMode] = useState(/** @type {null | 'deny' | 'comment' | 'edit'} */ (null));
  const [comment, setComment] = useState('');
  const [full, setFull] = useState(false);
  const texts = useMemo(() => (isEdit ? editTexts(ask) : null), [ask, isEdit]);
  const [editText, setEditText] = useState(texts?.after ?? '');
  const first = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const field = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  useEffect(() => {                  // never pull the focus back once the user is inside the card
    const cardEl = first.current?.closest('.d-card');
    if (autoFocus && !cardEl?.contains(document.activeElement)) /** @type {HTMLElement | null} */ (ask.defaultToNo ? cardEl ?? null : first.current)?.focus();
  }, [autoFocus]);
  useEffect(() => { if (mode) field.current?.focus(); }, [mode]);

  const denyMessage = () => comment.trim() || t('perm.deny.default');
  const allow = () => decide({ kind: 'allow-once' });
  const always = () => decide({ kind: 'allow-always', scope: isEdit ? 'session' : scope });
  const denyStop = () => decide({ kind: 'deny', message: denyMessage(), stopTurn: true });
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    const inText = inTextField(e.target);
    if (inText && mode) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMode(null); /** @type {HTMLElement | null} */ (first.current?.closest('.d-card') ?? null)?.focus(); return; }
      if (e.key === 'Enter' && !e.shiftKey && mode === 'deny') { e.preventDefault(); void decide({ kind: 'deny', message: denyMessage() }); return; }
      if (e.key === 'Enter' && e.ctrlKey && mode === 'edit') { e.preventDefault(); void decide({ kind: 'allow-edited', input: editedInput(ask, editText) }); }
      return;
    }
    const a = permissionKey(e, { inText, defaultToNo: ask.defaultToNo, offerAlways: ask.offerAlways, isEdit, canEdit });
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    if (a === 'allow') void allow();
    else if (a === 'always') void always();
    else if (a === 'deny') setMode('deny');
    else if (a === 'denyStop') void denyStop();
    else if (a === 'comment') setMode('comment');
    else if (a === 'edit') setMode('edit');
    else if (a === 'full') setFull(!full);
    else if (a === 'scopePrev' || a === 'scopeNext') setScope(cycleScope(scope, a === 'scopePrev' ? -1 : 1));
  };

  const subj = askSubject(ask);
  const name = ask.displayName || ask.toolName;
  const title = t('perm.title', { outil: isEdit && texts ? t(ask.toolName === 'Write' ? 'perm.title.write' : 'perm.title.edit', { fichier: base(texts.path) }) : name });
  const action = subj.kind === 'command' ? 'perm.action.command' : isEdit ? 'perm.action.edit' : ask.toolName === 'Read' ? 'perm.action.read' : 'perm.action.other';
  const cwd = getEnv().summaryOf?.(chatId)?.cwd;
  const scopeLabel = t(SCOPE_KEYS[scope]);
  const rule = ask.alwaysRules.join(', ');
  const reasonKey = permReasonKey(ask.decisionReason);       // the CLI's English reason in French (raw text in the tooltip)
  return html`<${CardFrame} ask=${ask} icon="!" title=${title} index=${index} total=${total} full=${full} busy=${busy} elsewhere=${elsewhere}
      onKey=${onKey} cls="d-perm">
    <p class="d-wants">${t('perm.wants', { action: t(action), 'libellé': ask.description || (subj.kind === 'json' ? name : subj.text) })}</p>
    ${isEdit && texts ? html`<${EditPreview} texts=${texts} />` : html`<pre class="d-subject">${subj.kind === 'command' ? '$ ' + subj.text : subj.text}</pre>`}
    <div class="d-facts">
      ${cwd ? html`<span>${t('perm.folder', { chemin: cwd })}</span>` : null}
      ${ask.decisionReason ? html`<span class="d-reason" title=${ask.decisionReason}>${t('perm.reason', { raison: reasonKey ? t(reasonKey) : ask.decisionReason })}</span>` : null}
      ${ask.blockedPath ? html`<span class="d-warn">${t('perm.blockedPath', { chemin: ask.blockedPath })}</span>` : null}
      ${ask.agentId ? html`<span>${t('perm.subagent', { nom: ask.agentId })}</span>` : null}
      ${ask.mcpServer ? html`<span>${t('perm.mcp', { nom: ask.mcpServer.name, source: ask.mcpServer.source })}</span>` : null}
      ${ask.matchedAskRule ? html`<span>${t('perm.askRule', { 'règle': ask.matchedAskRule })}</span>` : null}
    </div>
    <div class="d-actions">
      <button type="button" ref=${first} class="d-btn d-primary" onClick=${allow}
        title=${ask.defaultToNo ? t('perm.noShortcut') : ''}>${ask.defaultToNo ? null : html`<${Kbd} k="1" />`}${t('perm.allow')}</button>
      ${isEdit ? html`<button type="button" class="d-btn" onClick=${always}><${Kbd} k="2" />${t('perm.allEdits')}</button>`
        : ask.offerAlways ? html`<span class="d-scope">
          <button type="button" class="d-btn" onClick=${always} title=${t('perm.rule', { 'règle': rule })}
            aria-label=${`${t('perm.always')} ${rule} ${scopeLabel}`}><${Kbd} k="2" />${t('perm.always')} · ${scopeLabel}</button>
          <button type="button" class="d-icon" aria-label=${t('perm.scope.prev')} title=${t('perm.scope.prev')} onClick=${() => setScope(cycleScope(scope, -1))}>◂</button>
          <button type="button" class="d-icon" aria-label=${t('perm.scope.next')} title=${t('perm.scope.next')} onClick=${() => setScope(cycleScope(scope, 1))}>▸</button></span>` : null}
      <button type="button" class="d-btn" onClick=${() => setMode('deny')}><${Kbd} k="3" />${t('perm.deny')}</button>
      ${canEdit ? html`<button type="button" class="d-btn" onClick=${() => setMode('edit')}><${Kbd} k="E" />${t('perm.editBefore')}</button>` : null}
      ${ask.offerAuto ? html`<button type="button" class="d-btn d-more" onClick=${() => decide({ kind: 'allow-and-auto' })}>⋯ ${t('perm.switchAuto')}</button>` : null}
      <button type="button" class="d-btn d-quiet" onClick=${denyStop}>${t('perm.denyStop')}</button>
    </div>
    ${mode === 'deny' || mode === 'comment' ? html`<label class="d-field">
      <span>${mode === 'deny' ? t('perm.deny.placeholder') : t('perm.comment')}</span>
      <textarea ref=${field} rows="2" value=${comment} onInput=${(/** @type {any} */ e) => setComment(e.currentTarget.value)}></textarea>
      ${mode === 'deny' ? html`<button type="button" class="d-btn" onClick=${() => decide({ kind: 'deny', message: denyMessage() })}>${t('perm.deny.send')}</button>` : null}
    </label>` : null}
    ${mode === 'edit' ? html`<label class="d-field">
      <span>${t('perm.editNote')}</span>
      <textarea ref=${field} class="d-mono" rows="10" value=${editText} onInput=${(/** @type {any} */ e) => setEditText(e.currentTarget.value)}></textarea>
      <button type="button" class="d-btn d-primary" onClick=${() => decide({ kind: 'allow-edited', input: editedInput(ask, editText) })}>${t('perm.editAccept')}</button>
    </label>` : null}
    <p class="d-keys">${t('perm.keys')}</p>
  <//>`;
}

/** Client-side LCS preview of an Edit / Write ask (block view above 1e6 cells). @param {{ texts: NonNullable<ReturnType<typeof editTexts>> }} p */
function EditPreview({ texts }) {
  const st = useMemo(() => previewStats(texts.before, texts.after), [texts]);
  return html`<div class="d-edit">
    <div class="d-edit-head"><code>${texts.path}</code> <span>(+${st.added} −${st.removed})</span>
      ${texts.isNew ? html`<span class="c-badge">${t('perm.newFile')}</span>` : null}</div>
    ${texts.unavailable ? html`<p class="d-warn">${t('perm.baseUnavailable')}</p>` : null}
    <${DiffView} hunks=${st.block ? [] : opsToHunks(st.ops)} block=${st.block} oldCount=${st.oldLines} newCount=${st.newLines} />
  </div>`;
}
