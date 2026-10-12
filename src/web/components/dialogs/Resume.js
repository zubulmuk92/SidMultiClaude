// @ts-check
// src/web/components/dialogs/Resume.js — « Reprendre une session » (Alt+R; ux §8.2). Every known session comes with
// hello/chats (ChatSummary), so search runs in memory: title, folder, branch, first prompt. Filters: account, archived,
// origin. Preview = last 3 exchanges through tx.page (read-only, cached, never spawns). Keys: ↑↓ · Espace (preview) ·
// F2 (rename) · Entrée / Ctrl+Entrée (open / new pane). Opening puts the chat in a pane, still cold.
import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { t, tParts } from '../../lib/i18n.js';
import { fmtBytes, fmtRel, baseName } from '../../lib/fmt.js';
import { fuzzyScore } from '../../lib/fuzzy.js';
import { accountById, accounts, chats, settings } from '../../store.js';
import { actions, closeOverlay, openChat, openTerminal, peekTurns } from '../../actions.js';
import { AccBadge, Glyph, Modal } from '../shell/common.js';
import { Icon } from '../../lib/icons.js';

/** @typedef {import('../../../shared/protocol.ts').ChatSummary} ChatSummary */
/** @typedef {import('../../../shared/protocol.ts').UiTurn} UiTurn */
const ORIGINS = /** @type {const} */ (['cli', 'desktop', 'app', 'other']);

/** Plain-text lines of the last exchanges (text nodes only: never HTML). @param {UiTurn[]} turns */
export function previewLines(turns) {
  /** @type {{ who: 'you' | 'claude'; text: string }[]} */
  const out = [];
  for (const tu of turns.slice(-3)) {
    if (tu.user?.text) out.push({ who: 'you', text: tu.user.text.slice(0, 300) });
    const last = [...tu.blocks].reverse().find((b) => b.k === 'text');
    if (last && last.k === 'text') out.push({ who: 'claude', text: last.md.slice(0, 300) });
  }
  return out;
}

export function Resume() {
  const [q, setQ] = useState('');
  const [acc, setAcc] = useState('');
  const [archived, setArchived] = useState(false);
  const [origins, setOrigins] = useState(new Set(settings.value?.showOtherOrigins ? ORIGINS : ORIGINS.slice(0, 3)));
  const [sel, setSel] = useState(0);
  const [preview, setPreview] = useState(/** @type {{ id: string; lines: ReturnType<typeof previewLines> } | null} */ (null));
  const [renaming, setRenaming] = useState(/** @type {string | null} */ (null));
  const rows = useMemo(() => {
    const list = [...chats.value.values()].filter((s) => (!acc || s.accountId === acc) && (archived || !s.archived) && origins.has(s.origin));
    if (!q.trim()) return list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
    return list.map((s) => ({ s, sc: fuzzyScore(q, [s.title, s.cwd, s.branch ?? '', s.firstPrompt ?? ''].join(' · ')) }))
      .filter((x) => x.sc !== null).sort((a, b) => /** @type {number} */ (b.sc) - /** @type {number} */ (a.sc) || b.s.updatedAt - a.s.updatedAt).slice(0, 200).map((x) => x.s);
  }, [q, acc, archived, origins, chats.value]);
  const i = Math.min(sel, Math.max(0, rows.length - 1));
  const cur = rows[i];
  useEffect(() => {
    if (!cur) { setPreview(null); return undefined; }
    let live = true;
    const tm = setTimeout(() => void peekTurns(cur.chatId).then((turns) => { if (live) setPreview({ id: cur.chatId, lines: previewLines(turns) }); }), 150);
    return () => { live = false; clearTimeout(tm); };
  }, [cur?.chatId]);
  /** @param {ChatSummary | undefined} s @param {boolean} pane */
  const open = (s, pane) => { if (!s) return; closeOverlay(); openChat(s.chatId, pane ? 'newPane' : 'focused'); };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (renaming) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))); }
    else if (e.key === 'Enter') { e.preventDefault(); open(cur, e.ctrlKey); }
    else if (e.key === 'F2' && cur && !cur.state.flags.external) { e.preventDefault(); setRenaming(cur.chatId); }
    else if (e.key === ' ' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      if (preview) setPreview(null);
      else if (cur) { const id = cur.chatId; void peekTurns(id).then((turns) => setPreview({ id, lines: previewLines(turns) })); }   // cached: no new tx.page
    }
  };
  const originLabels = tParts('resume.origin');
  /** @param {typeof ORIGINS[number]} o */
  const toggleOrigin = (o) => { const n = new Set(origins); if (n.has(o)) n.delete(o); else n.add(o); setOrigins(n); };
  const nowMs = Date.now();
  return html`<${Modal} title=${t('resume.title')} onClose=${closeOverlay} wide=${true} cls="resume"
      footer=${html`<button type="button" class="btn" disabled=${!cur} onClick=${() => cur && void openTerminal(cur.chatId, false).catch(() => {})}>${t('resume.openTerm')}</button>
        <button type="button" class="btn" disabled=${!cur} onClick=${() => open(cur, true)}>${t('resume.openPane')} <kbd>Ctrl+Entrée</kbd></button>
        <button type="button" class="btn primary" disabled=${!cur} onClick=${() => open(cur, false)}>${t('resume.open')} <kbd>Entrée</kbd></button>`}>
    <div class="resume-wrap" onKeyDown=${onKey}>
      <div class="inline">
        <input type="search" class="grow" data-autofocus placeholder=${t('resume.search')} aria-label=${t('resume.search')} value=${q}
          onInput=${(/** @type {InputEvent} */ e) => { setQ(/** @type {HTMLInputElement} */ (e.target).value); setSel(0); }} />
        <select aria-label=${t('new.account')} value=${acc} onChange=${(/** @type {Event} */ e) => setAcc(/** @type {HTMLSelectElement} */ (e.target).value)}>
          <option value="">${t('shell.resume.allAccounts')}</option>${accounts.value.map((a) => html`<option key=${a.id} value=${a.id}>${a.name}</option>`)}</select>
        <label class="check"><input type="checkbox" checked=${archived} onChange=${() => setArchived(!archived)} />${t('shell.resume.archived')}</label>
      </div>
      <div class="chips">${ORIGINS.map((o, k) => html`<label key=${o} class="check chip"><input type="checkbox" checked=${origins.has(o)} onChange=${() => toggleOrigin(o)} />${originLabels[k]}</label>`)}</div>
      <ul class="resume-list" role="listbox" aria-label=${t('resume.title')}>
        ${!rows.length ? html`<li class="muted">${t('shell.sw.none')}</li>` : null}
        ${rows.map((s, k) => html`<li key=${s.chatId} role="option" aria-selected=${String(k === i)} class=${`resume-row acc-${accountById.value.get(s.accountId)?.color ?? 8} ${k === i ? 'sel' : ''}`}
            onClick=${() => setSel(k)} onDblClick=${() => open(s, false)}>
          <${Glyph} s=${s} /><${AccBadge} a=${accountById.value.get(s.accountId)} id=${s.accountId} />
          ${renaming === s.chatId ? html`<input class="row-edit grow" value=${s.title} ref=${(/** @type {HTMLInputElement | null} */ el) => { if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
              onKeyDown=${(/** @type {KeyboardEvent} */ e) => { e.stopPropagation(); const v = /** @type {HTMLInputElement} */ (e.target).value; if (e.key === 'Enter') { setRenaming(null); if (v.trim()) void actions.rename(s.chatId, v).catch(() => {}); } else if (e.key === 'Escape') setRenaming(null); }} />`
            : html`<span class="r-title">${s.title || t('state.new')}${s.foreignOwner ? html` <span class="flag" title=${t('flag.foreignOwner')}><${Icon} n="swap" size=${13} /></span>` : null}${s.expiresInDays !== null && s.expiresInDays <= 5 ? html` <span class="flag"><${Icon} n="hourglass" size=${13} /> ${t('flag.expiring', { n: s.expiresInDays })}</span>` : null}${s.state.flags.external ? html` <span class="flag"><${Icon} n="terminal" size=${13} /></span>` : null}</span>`}
          <span class="r-dir" title=${s.cwd}>${baseName(s.cwd)}${s.branch ? html` <${Icon} n="branch" size=${12} /> ${s.branch}` : ''}</span>
          <span class="r-age">${s.updatedAt ? fmtRel(s.updatedAt, nowMs) : ''}</span><span class="r-size">${s.size ? fmtBytes(s.size) : '—'}</span>
          <span class="r-origin">${originLabels[ORIGINS.indexOf(s.origin)] ?? s.origin}</span></li>`)}
      </ul>
      ${preview && cur && preview.id === cur.chatId ? html`<section class="resume-preview" aria-label=${t('resume.preview')}>
        <h3>${t('resume.preview')} — ${t('shell.resume.lastExchanges')}</h3>
        ${preview.lines.map((l) => html`<p class=${`pv-${l.who}`}><b>${t(l.who === 'you' ? 'a11y.you' : 'a11y.claude')} :</b> ${l.text}</p>`)}
      </section>` : null}
    </div>
  </${Modal}>`;
}
