// @ts-check
// src/web/components/side/ContinueOnDialog.js — « Continuer sur un autre compte » (ux §8.6, SPEC §2.10):
// always a deliberate, one-chat action. chat.fork{accountId} creates a cold chat on the target account; its first send
// makes Claude Code copy the session into the target profile (the app never writes into a profile). The dialog states
// the cost (full re-cache on the target) and shows the cont.note.instructions info note (whether those instructions carry over is not verified).
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { t, fmtTokens } from '../chat/text.js';
import { act, getEnv, useChatVM, accountOf } from '../chat/env.js';
import { closeOverlay } from './overlays.js';
import { Modal } from './Popovers.js';

/** @typedef {import('../../../shared/protocol.ts').AccountView} AccountView */

/** Accounts a chat can continue on (pure): every visible account but its own; connected ones first. @param {AccountView[]} all @param {string} own */
export function continueTargets(all, own) {
  return all.filter((a) => a.id !== own && !a.hidden).sort((a, b) => Number(b.login === 'connected') - Number(a.login === 'connected'));
}

/** @param {{ chatId: string; target?: string }} p */
export function ContinueOnDialog({ chatId, target }) {
  const vm = useChatVM(chatId);
  const sum = vm.summary.value;
  const targets = continueTargets(getEnv().accounts.value, sum.accountId);
  const firstOk = targets.find((a) => a.login === 'connected');
  const [to, setTo] = useState(target ?? firstOk?.id ?? '');
  const [busy, setBusy] = useState(false);
  const acc = targets.find((a) => a.id === to);
  const own = accountOf(sum.accountId);
  const tokens = fmtTokens(vm.metrics.value.contextTokens ?? sum.wake?.lastContext ?? 0);
  const go = async () => {
    if (!acc || acc.login !== 'connected' || busy) return;
    setBusy(true);
    try {
      const id = await act().fork(chatId, { accountId: acc.id });
      closeOverlay();
      act().openChat(id, 'focused');
    } catch { setBusy(false); }
  };
  const footer = html`<button type="button" class="d-btn d-quiet" onClick=${closeOverlay}>${t('cap.cancel')}</button>
    <button type="button" class="d-btn d-primary" disabled=${!acc || acc.login !== 'connected' || busy} onClick=${go}>
      ${t('cont.ok', { compte: acc?.name ?? '…' })} ⏎</button>`;
  /** @param {KeyboardEvent} e */
  const onKey = (e) => { if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { void go(); return true; } return false; };
  return html`<${Modal} title=${t('cont.title')} onClose=${closeOverlay} onKey=${onKey} cls="s-continue" footer=${footer}>
    <p>${t('cont.context', { titre: sum.title, compte: own?.name ?? sum.accountId, tokens })}</p>
    ${!targets.length ? html`<p>${t('cont.none')}</p>` : html`<fieldset class="s-targets"><legend>${t('cont.to')}</legend>
      ${targets.map((a) => { const h = a.usage?.rows.find((r) => r.headline); return html`<label class=${'s-radio acc-' + a.color}>
        <input type="radio" name="cont" value=${a.id} checked=${to === a.id} disabled=${a.login !== 'connected'} onChange=${() => setTo(a.id)} />
        <span class="s-mono" aria-hidden="true">${a.monogram}</span> ${a.name}
        ${a.login !== 'connected' ? html` — <em>${t('cont.notConnected')}</em>` : h ? html` · <small>${h.label} ${h.pct} %</small>` : null}</label>`; })}
    </fieldset>`}
    ${acc ? html`<div class="s-bullets"><p>${t('cont.what')}</p><ul>
      <li>${t('cont.b1', { compte: acc.name })}</li>
      <li>${t('cont.b2', { compte: acc.name, tokens })}</li>
      <li>${t('cont.b3')}</li>
      <li>${t('cont.b4', { compte: acc.name })}</li>
      <li>${t('cont.b5', { chemin: sum.cwd })}</li></ul>
      <p class="s-note" role="note">ⓘ ${t('cont.note.instructions')}</p></div>` : null}
  <//>`;
}
