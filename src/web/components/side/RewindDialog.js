// @ts-check
// src/web/components/side/RewindDialog.js — « Revenir à un point précédent » (ux §8.4, SPEC §2.10): pick a prompt (↑↓),
// an action (1–4), Entrée. Code options need tracked file changes (dry-run simulation); a conversation rewind puts the
// prompt back in the composer; « Bifurquer » forks up to that prompt into a new chat. Never claims a rewind is free.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { t, fmtTime } from '../chat/text.js';
import { act, setDraftText, useChatVM } from '../chat/env.js';
import { userPrompts } from '../chat/model.js';
import { closeOverlay } from './overlays.js';
import { Modal } from './Popovers.js';
import { Icon } from '../../lib/icons.js';

/** @typedef {import('../../../shared/protocol.ts').RewindPreview} RewindPreview */
/** @typedef {'both' | 'conv' | 'code' | 'fork'} RewindAction */

/** Actions offered for a point (code options only with tracked changes). @param {RewindPreview | null | undefined} p @returns {RewindAction[]} */
export function rewindActions(p) {
  return p && p.files.length ? ['both', 'conv', 'code', 'fork'] : ['conv', 'fork'];
}

/** @param {{ chatId: string; uuid?: string }} p */
export function RewindDialog({ chatId, uuid }) {
  const vm = useChatVM(chatId);
  const prompts = userPrompts(vm.turns.value.map((x) => x.sig.value));
  const [sel, setSel] = useState(() => Math.max(0, prompts.findIndex((x) => x.uuid === uuid)));
  const [action, setAction] = useState(/** @type {RewindAction} */ ('conv'));
  const [sims, setSims] = useState(/** @type {Record<string, RewindPreview | null>} */ ({}));
  const [busy, setBusy] = useState(false);
  const cur = prompts[sel];
  const sim = cur ? sims[cur.uuid] : undefined;
  useEffect(() => {
    if (!cur || cur.uuid in sims) return;
    act().rewind(chatId, cur.uuid, 'code', true).then((p) => setSims((s) => ({ ...s, [cur.uuid]: p })), () => setSims((s) => ({ ...s, [cur.uuid]: null })));
  }, [cur?.uuid]);
  const actions = rewindActions(sim);
  const act0 = actions.includes(action) ? action : 'conv';
  const go = async () => {
    if (!cur || busy) return;
    setBusy(true);
    try {
      if (act0 === 'fork') {
        const id = await act().fork(chatId, { upToUuid: cur.uuid });
        closeOverlay();
        act().openChat(id, 'focused');
        setDraftText(id, cur.text);
        return;
      }
      await act().rewind(chatId, cur.uuid, act0, false);
      closeOverlay();
      if (act0 !== 'code') { setDraftText(chatId, cur.text); act().toast('rewind.done'); }
    } catch { setBusy(false); }
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { setSel(Math.max(0, Math.min(prompts.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)))); return true; }
    const d = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
    if (d) { const a = /** @type {RewindAction[]} */ (['both', 'conv', 'code', 'fork'])[Number(d[1]) - 1]; if (a && actions.includes(a)) setAction(a); return true; }
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { void go(); return true; }
    return false;
  };
  const totals = sim ? sim.files.reduce((s, f) => ({ a: s.a + f.added, d: s.d + f.removed }), { a: 0, d: 0 }) : null;
  const footer = html`<button type="button" class="d-btn d-quiet" onClick=${closeOverlay}>${t('cap.cancel')}</button>
    <button type="button" class="d-btn d-primary" disabled=${!cur || busy} onClick=${go}>${t('rewind.ok')} <${Icon} n="enter" size=${14} /></button>`;
  return html`<${Modal} title=${t('rewind.title')} onClose=${closeOverlay} onKey=${onKey} cls="s-rewind" footer=${footer}>
    <p class="s-hint">${t('rewind.hint')}</p>
    ${!prompts.length ? html`<p>${t('rewind.none')}</p>` : html`<ul class="s-points" role="listbox" aria-label=${t('rewind.title')}>
      ${prompts.slice(0, 50).map((p, k) => html`<li role="option" aria-selected=${k === sel} class=${k === sel ? 'p-sel' : ''} onClick=${() => setSel(k)}>
        <time>${fmtTime(p.at)}</time> « ${p.text.split('\n')[0]?.slice(0, 80)} »
        <small>${sims[p.uuid]?.files.length ? t('rewind.files', { n: sims[p.uuid]?.files.length ?? 0 }) : '—'}</small></li>`)}</ul>`}
    <div class="s-actions" role="radiogroup" aria-label=${t('rewind.title')}>
      ${(/** @type {RewindAction[]} */ (['both', 'conv', 'code', 'fork'])).map((a, k) => actions.includes(a) ? html`<label class="s-radio">
        <input type="radio" name="rw" checked=${act0 === a} onChange=${() => setAction(a)} /> (${k + 1}) ${t('rewind.' + a)}</label>` : null)}
    </div>
    ${sim === undefined && cur ? html`<p class="s-hint">${t('rewind.simLoading')}</p>` : null}
    ${sim && totals && sim.files.length ? html`<p class="s-sim">${t('rewind.sim', { n: sim.files.length, a: totals.a, d: totals.d })} :
      ${sim.files.map((f) => `${f.path} (${f.deleted ? t('rewind.deleted') : `+${f.added} −${f.removed}`})`).join(', ')}</p>` : null}
    <p class="s-note">ⓘ ${t('rewind.warn')}</p>
    <p class="s-note">ⓘ ${act0 === 'fork' ? t('fork.grants') : t('rewind.recache')}</p>
  <//>`;
}
