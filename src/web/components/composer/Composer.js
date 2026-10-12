// @ts-check
// src/web/components/composer/Composer.js — the chat composer (ux §7, SPEC §2.4, §9.2–9.3): queue strip, attachments,
// editor with slash palette / @ mentions / Ctrl+R history, token hints, cap choice and the footer (mode, model,
// agents, attach, split send button, stop). Entrée sends (folds while running) · Alt+Entrée after this turn ·
// Ctrl+Entrée now (capability-gated) · ↑ takes queued messages back · Échap interrupts, Échap Échap (idle) clears the
// draft or opens « Revenir à… ». The draft lives in vm.draft (saved by the store) and in localStorage.
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t, tp } from '../chat/text.js';
import { act, announce, chatUi, getEnv, useChatVM, accountOf } from '../chat/env.js';
import { LIMITS, UI } from '../chat/consts.js';
import { openOverlay } from '../side/overlays.js';
import { userPrompts } from '../chat/model.js';
import { INTERCEPTED, insertMention, mentionQuery, sendKey, slashQuery, stripInvisible, takeBackable, utf8Bytes } from './logic.js';
import { QueueList, takeBack } from './QueueList.js';
import { Attachments, attachmentsOf, fitImages, readImage } from './Attachments.js';
import { SlashPalette, slashRows } from './SlashPalette.js';
import { MentionPopup } from './MentionPopup.js';
import { HistorySearch } from './HistorySearch.js';
import { WakeHint } from './WakeHint.js';
import { CapChoice } from './CapChoice.js';
import { modalOpen } from '../../lib/modal.js';

/** @typedef {import('../../../shared/protocol.ts').ChatPhase} ChatPhase */
/** @typedef {import('../../../shared/protocol.ts').FileHit} FileHit */
/** @typedef {import('./Attachments.js').Att} Att */
/** @typedef {null | { kind: 'slash'; q: string } | { kind: 'mention'; start: number; q: string } | { kind: 'history' }} Popup */

/** Phases in which Entrée queues instead of starting a turn. @param {ChatPhase} p */
export const isBusy = (p) => p === 'running' || p === 'starting' || p === 'needs_permission' || p === 'needs_answer' || p === 'needs_plan';

/** Échap / ■: interrupt (the queue is kept); background agents keep running, which the toast says (ux §7.9).
 * @param {string} chatId */
export function interruptChat(chatId) {
  act().interrupt(chatId);
  const n = getEnv().useChat(chatId).tasks.value.filter((x) => x.status === 'running' && x.background).length;
  if (n) act().toast('agents.interrupted', { n });
}

/** Stashed drafts (Ctrl+S). @type {Map<string, { text: string; atts: Att[] }>} */
const stashes = new Map();
/** Draft cleared by Échap Échap, for « Annuler ». @type {Map<string, string>} */
const cleared = new Map();

/** @param {string} chatId */
const lsKey = (chatId) => 'draft:' + chatId;
/** @param {string} chatId @returns {{ text: string; at: number } | null} */
function readLocal(chatId) {
  try { const s = localStorage.getItem(lsKey(chatId)); return s ? JSON.parse(s) : null; } catch { return null; }
}
/** @param {string} chatId @param {string} text @param {number} at */
function writeLocal(chatId, text, at) {
  try { if (text) localStorage.setItem(lsKey(chatId), JSON.stringify({ text, at })); else localStorage.removeItem(lsKey(chatId)); } catch { /* storage off */ }
}

/** Images sent so far in these turns (user messages, head included once). Never throws on a malformed turn (the composer
 * must survive what the transcript's error boundaries contain). @param {import('../../../shared/protocol.ts').UiTurn[]} turns */
export function countImages(turns) {
  let n = 0;
  for (const tr of turns) {
    let head = !!tr.user;
    for (const b of tr.blocks ?? []) if (b?.k === 'user') { n += b.msg?.images?.length ?? 0; if (b.msg?.uuid === tr.user?.uuid) head = false; }
    if (head) n += tr.user?.images?.length ?? 0;
  }
  return n;
}

/** Caret on the first / last line of a textarea. @param {HTMLTextAreaElement} el */
const onFirstLine = (el) => !el.value.slice(0, el.selectionStart).includes('\n');
/** @param {HTMLTextAreaElement} el */
const onLastLine = (el) => !el.value.slice(el.selectionEnd).includes('\n');

/** @param {{ chatId: string; focused?: boolean }} p */
export function Composer({ chatId, focused }) {
  const env = getEnv();
  const vm = useChatVM(chatId);
  const u = chatUi(chatId);
  const sum = vm.summary.value;
  const phase = sum.state.phase;
  const busy = isBusy(phase);
  const meta = vm.meta.value;
  const draft = vm.draft.value;
  const attsSig = attachmentsOf(chatId);
  const atts = attsSig.value;
  const [popup, setPopup] = useState(/** @type {Popup} */ (null));
  const [sel, setSel] = useState(0);
  const [hits, setHits] = useState(/** @type {FileHit[]} */ ([]));
  const [hitsLoading, setHitsLoading] = useState(false);
  const [notice, setNotice] = useState(/** @type {string | null} */ (null));
  const [undo, setUndo] = useState(false);
  const [sendMenu, setSendMenu] = useState(false);
  const hist = useRef(/** @type {{ i: number; list: string[]; saved: string } | null} */ (null));
  const sending = useRef(false);
  const ta = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const canNow = !!meta?.capabilities?.includes('interrupt_send_now_v1');
  const ctrlEnterSends = !!env.settings.value?.ctrlEnterSends;

  // focus requests (rewind gives the prompt back, a card was answered, Échap from a card)
  // an async focus request (pane focus, card answered, rewind) never takes the focus away from an open overlay / dialog
  useEffect(() => { if (u.focusComposer.value && !modalOpen()) ta.current?.focus(); }, [u.focusComposer.value]);
  // restore: the attachments of the saved draft, and the localStorage mirror when it is newer (crash / reload)
  useEffect(() => {
    if (!attsSig.value.length && draft.attachments.length) attsSig.value = draft.attachments;
    const loc = readLocal(chatId);
    if (loc && loc.at > draft.at && loc.text !== draft.text) vm.draft.value = { ...vm.draft.value, text: loc.text, at: loc.at };
  }, [chatId]);
  useEffect(() => { const id = setTimeout(() => writeLocal(chatId, draft.text, draft.at), UI.DRAFT_DEBOUNCE_MS); return () => clearTimeout(id); }, [draft.text]);
  // the draft mirrors the attachments only while the whole draft fits MAX_DRAFT_BYTES
  useEffect(() => {
    const size = atts.reduce((n, a) => n + a.base64.length + 200, utf8Bytes(vm.draft.value.text));
    const want = size <= LIMITS.MAX_DRAFT_BYTES ? atts : [];
    if (want.length !== vm.draft.value.attachments.length || want.some((a, k) => a !== vm.draft.value.attachments[k]))
      vm.draft.value = { ...vm.draft.value, attachments: want, at: Date.now() };
  }, [atts]);
  // @ mentions: fs.mentions, debounced
  useEffect(() => {
    if (popup?.kind !== 'mention') return undefined;
    setHitsLoading(true);
    let alive = true;
    const id = setTimeout(() => act().mentions(chatId, popup.q).then((h) => { if (alive) { setHits(h); setSel(0); setHitsLoading(false); } },
      () => { if (alive) { setHits([]); setHitsLoading(false); } }), 120);
    return () => { alive = false; clearTimeout(id); };
  }, [popup?.kind === 'mention' ? popup.q : null]);

  /** @param {string} text @param {number} [caret] */
  const setText = (text, caret) => {
    vm.draft.value = { ...vm.draft.value, text, at: Date.now() };
    if (caret !== undefined) requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(caret, caret); } });
  };
  /** @param {string} key @param {Record<string, string | number>} [args] */
  const flash = (key, args) => { setNotice(t(key, args)); setTimeout(() => setNotice(null), 6000); };
  const clearDraft = () => { setText(''); attsSig.value = []; hist.current = null; };

  /** @param {'send' | 'later' | 'now'} how */
  const send = async (how) => {
    const text = vm.draft.value.text;
    const body = text.trim();
    if (!body && !atts.length) return;
    const cmd = /^\/([\w-]+)/.exec(body)?.[1];
    if (cmd && INTERCEPTED.includes(cmd) && !atts.length) {
      if (cmd === 'model' || cmd === 'effort') { u.menu.value = 'model'; clearDraft(); return; }
      if (cmd === 'rewind') { clearDraft(); openOverlay({ kind: 'rewind', chatId }); return; }
      if (cmd === 'clear') {
        openOverlay({ kind: 'confirm', chatId, title: '/clear', body: t('slash.clear.confirm'), ok: tp('common', 1), danger: true,
          onOk: () => { act().send(chatId, '/clear'); clearDraft(); } });
        return;
      }
    }
    if (utf8Bytes(text) > LIMITS.MAX_TEXT_BYTES) { flash('composer.text.tooLong'); return; }
    let images = atts;
    if (atts.length) {                   // re-encoding takes a moment: a second Entrée meanwhile must not send twice
      if (sending.current) return;
      sending.current = true;
      try {
        const fit = await fitImages(atts);
        if (fit.reencoded) flash('composer.image.fitted');
        if (fit.dropped) flash('composer.image.failed');
        images = fit.atts;
      } finally { sending.current = false; }
    }
    // what was typed while the images were being fitted stays in the composer
    const clearSent = () => { if (vm.draft.value.text === text) setText(''); attsSig.value = []; hist.current = null; };
    const imgs = images.map((a) => ({ mediaType: a.mediaType, base64: a.base64 }));
    if (sum.wake?.dialog && phase === 'cold' && !env.settings.value?.wakeNeverAsk) {
      openOverlay({ kind: 'wake', chatId, text, ...(imgs.length ? { images: imgs } : {}) });
      clearSent();
      return;
    }
    const priority = how === 'later' && busy ? 'later' : how === 'now' && busy && canNow ? 'now' : undefined;
    if (how === 'now' && busy && !canNow) act().toast('sendNow.unavailable');
    act().send(chatId, text, { ...(imgs.length ? { images: imgs } : {}), ...(priority ? { priority } : {}) });
    if (busy) announce(t('a11y.queued'));
    clearSent();
    setSendMenu(false);
  };
  /** @param {string[]} texts */
  const takeBackInto = (texts) => {
    if (!texts.length) return;
    const cur = vm.draft.value.text;
    const next = texts.join('\n') + (cur ? '\n' + cur : '');
    setText(next, texts.join('\n').length);
  };
  /** @param {(File | null)[]} files */
  const addFiles = async (files) => {
    const imgs = files.filter((f) => f && f.type.startsWith('image/'));
    if (!imgs.length) return;
    /** @type {Att[]} */ const add = [];
    for (const f of imgs) {
      const a = f ? await readImage(f, f.name || 'capture.png') : null;
      if (!a) { flash('composer.image.unsupported'); continue; }
      add.push(a);
    }
    const all = [...attsSig.value, ...add];
    if (all.length > LIMITS.MAX_IMAGES_PER_MESSAGE) flash('composer.image.max', { n: LIMITS.MAX_IMAGES_PER_MESSAGE });
    attsSig.value = all.slice(0, LIMITS.MAX_IMAGES_PER_MESSAGE);
  };
  /** @param {ClipboardEvent} e */
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); void addFiles(files); return; }
    const txt = e.clipboardData?.getData('text/plain') ?? '';
    const s = stripInvisible(txt);
    if (s.removed && ta.current) {
      e.preventDefault();
      ta.current.setRangeText(s.text, ta.current.selectionStart, ta.current.selectionEnd, 'end');
      setText(ta.current.value);
      flash('composer.invisible', { n: s.removed });
    }
  };
  /** @param {Event} e */
  const onInput = (e) => {
    const el = /** @type {HTMLTextAreaElement} */ (e.currentTarget);
    const first = !vm.draft.value.text && el.value;
    setText(el.value);
    u.lastTypedAt = Date.now();
    hist.current = null;
    if (first && (phase === 'cold')) act().prespawn(chatId);     // no tokens; the server may refuse (cap)
    const caret = el.selectionStart;
    const sq = meta?.commands?.length ? slashQuery(el.value, caret) : null;
    const mq = sq === null ? mentionQuery(el.value, caret) : null;
    setPopup(sq !== null ? { kind: 'slash', q: sq } : mq ? { kind: 'mention', start: mq.start, q: mq.q } : popup?.kind === 'history' ? popup : null);
    if (sq !== null && popup?.kind !== 'slash') setSel(0);
  };
  /** @param {import('../../../shared/protocol.ts').SlashCommandView} c */
  const pickSlash = (c) => { const v = '/' + c.name + ' '; setText(v + vm.draft.value.text.replace(/^\/\S*\s?/, ''), v.length); setPopup(null); };
  /** @param {FileHit} h */
  const pickMention = (h) => {
    if (popup?.kind !== 'mention' || !ta.current) return;
    const r = insertMention(vm.draft.value.text, popup, ta.current.selectionStart, h.path, h.dir);
    setText(r.text, r.caret); setPopup(null);
  };
  /** @param {1 | -1} dir */
  const browseHistory = (dir) => {
    if (!hist.current) {
      const mine = userPrompts(vm.turns.value.map((x) => x.sig.value)).map((p) => p.text);
      hist.current = { i: -1, list: [...new Set(mine)], saved: vm.draft.value.text };
      if (dir === 1) void act().prompts('', chatId).then((h) => { if (hist.current) hist.current.list = [...new Set([...hist.current.list, ...h.map((x) => x.text)])]; });
    }
    const h = hist.current;
    const i = Math.max(-1, Math.min(h.list.length - 1, h.i + dir));
    h.i = i;
    vm.draft.value = { ...vm.draft.value, text: i < 0 ? h.saved : h.list[i] ?? '', at: Date.now() };
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    const el = /** @type {HTMLTextAreaElement} */ (e.currentTarget);
    if (popup && popup.kind !== 'history') {
      const rows = popup.kind === 'slash' ? slashRows(meta?.commands ?? [], popup.q) : hits.slice(0, 50);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, Math.min(rows.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)))); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.ctrlKey && !e.altKey && rows.length) {
        e.preventDefault();
        if (popup.kind === 'slash') pickSlash(/** @type {any} */ (rows[sel])); else pickMention(/** @type {FileHit} */ (rows[sel]));
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPopup(null); return; }
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'r') { e.preventDefault(); setPopup({ kind: 'history' }); return; }
      if (k === 'g') { e.preventDefault(); u.expanded.value = !u.expanded.value; return; }
      if (k === 's') {
        e.preventDefault();
        const st = stashes.get(chatId);
        if (st && !vm.draft.value.text && !atts.length) { stashes.delete(chatId); setText(st.text); attsSig.value = st.atts; flash('composer.unstash'); }
        else if (vm.draft.value.text || atts.length) { stashes.set(chatId, { text: vm.draft.value.text, atts }); clearDraft(); flash('composer.stash'); }
        return;
      }
    }
    const how = sendKey(e, { running: busy, canSendNow: canNow, ctrlEnterSends, popupOpen: false });
    if (how === 'newline') { if (!e.shiftKey) { e.preventDefault(); el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end'); setText(el.value); } return; }
    if (how) { e.preventDefault(); void send(how === 'send' ? 'send' : how); return; }
    if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.shiftKey && onFirstLine(el)) {
      const back = takeBackable(vm.queue.value);
      if (busy && back.length) { e.preventDefault(); void takeBack(chatId, back).then(takeBackInto); return; }
      if (!busy && (!el.value || hist.current)) { e.preventDefault(); browseHistory(1); }
      return;
    }
    if (e.key === 'ArrowDown' && hist.current && !e.altKey && onLastLine(el)) { e.preventDefault(); browseHistory(-1); return; }
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      const double = now - u.lastEscAt < LIMITS.DOUBLE_ESC_MS;
      if (busy) {                         // interrupt; a second press within 600 ms is swallowed (never a rewind)
        e.preventDefault();
        if (!double) interruptChat(chatId);
        u.lastEscAt = double ? 0 : now;
        return;
      }
      if (double) {
        e.preventDefault(); u.lastEscAt = 0;
        if (vm.draft.value.text.trim()) { cleared.set(chatId, vm.draft.value.text); setText(''); setUndo(true); setTimeout(() => setUndo(false), 8000); }
        else openOverlay({ kind: 'rewind', chatId });
        return;
      }
      u.lastEscAt = now;
    }
  };
  const acc = accountOf(sum.accountId);
  // ux §7.6 (E3): from 10 images in the conversation, older ones leave the context (cache rebuilt): say so before sending
  const convImages = useMemo(() => countImages(vm.turns.value.map((x) => x.sig.peek())), [vm.turns.value]);
  const tooMany = atts.length > 0 && convImages + atts.length >= UI.IMAGE_TOO_MANY;
  const mode = meta?.mode ?? sum.mode ?? 'default';
  const placeholder = mode === 'plan' ? t('composer.placeholder.plan') : busy ? t('composer.placeholder.running')
    : t('composer.placeholder', { compte: acc?.name ?? sum.accountId });
  const tasks = vm.tasks.value.filter((x) => x.status === 'running');
  const agentAsks = vm.asks.value.some((a) => !!a.agentId);
  const sendLabel = busy ? t('composer.queue') : t('composer.send', { monogramme: acc?.monogram ?? '' });
  const fileIn = useRef(/** @type {HTMLInputElement | null} */ (null));
  const popupId = popup?.kind === 'slash' ? 'p-slash' : popup?.kind === 'mention' ? 'p-mention' : undefined;
  return html`<div class=${'k-composer' + (acc ? ' acc-' + acc.color : '') + (mode === 'bypassPermissions' ? ' k-bypass' : '') + (u.expanded.value ? ' k-expanded' : '')}
      onDragOver=${(/** @type {DragEvent} */ e) => { if ([...(e.dataTransfer?.items ?? [])].some((i) => i.type.startsWith('image/'))) e.preventDefault(); }}
      onDrop=${(/** @type {DragEvent} */ e) => { const f = [...(e.dataTransfer?.files ?? [])]; if (f.length) { e.preventDefault(); void addFiles(f); } }}>
    <${QueueList} chatId=${chatId} onTakeBack=${takeBackInto} />
    <${CapChoice} chatId=${chatId} />
    <${Attachments} chatId=${chatId} items=${atts} onRemove=${(/** @type {number} */ k) => { attsSig.value = atts.filter((_, j) => j !== k); }} />
    ${tooMany ? html`<div class="w-hint w-warn" role="note">${t('composer.image.tooMany')}</div>` : null}
    <div class="k-editor">
      ${popup?.kind === 'slash' ? html`<${SlashPalette} cmds=${meta?.commands ?? []} q=${popup.q} sel=${sel} onPick=${pickSlash} onHover=${setSel} />` : null}
      ${popup?.kind === 'mention' ? html`<${MentionPopup} hits=${hits} q=${popup.q} sel=${sel} loading=${hitsLoading} onPick=${pickMention} onHover=${setSel} />` : null}
      ${popup?.kind === 'history' ? html`<${HistorySearch} chatId=${chatId} onClose=${() => { setPopup(null); ta.current?.focus(); }}
          onPick=${(/** @type {string} */ s) => { setPopup(null); setText(s, s.length); }} />` : null}
      <textarea ref=${ta} class="k-input" rows=${u.expanded.value ? 16 : 3} value=${draft.text} placeholder=${placeholder}
        aria-label=${t('composer.label')} aria-autocomplete=${popupId ? 'list' : undefined} aria-controls=${popupId}
        aria-activedescendant=${popupId ? `${popupId}-${sel}` : undefined}
        onInput=${onInput} onKeyDown=${onKey} onPaste=${onPaste} onBlur=${() => { if (popup?.kind !== 'history') setPopup(null); }}></textarea>
    </div>
    <${WakeHint} chatId=${chatId} onCompact=${() => setText('/compact ', 9)} />
    ${notice ? html`<div class="k-notice" role="status">${notice}</div>` : null}
    ${undo ? html`<div class="k-notice" role="status">${tp('draft.cleared', 0)} <button type="button" class="c-link"
        onClick=${() => { setText(cleared.get(chatId) ?? ''); setUndo(false); }}>${tp('draft.cleared', 1)}</button></div>` : null}
    <div class="k-foot">
      <input ref=${fileIn} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
        onChange=${(/** @type {any} */ e) => { void addFiles([...e.currentTarget.files]); e.currentTarget.value = ''; }} />
      <button type="button" class="c-icon" title=${t('composer.attach')} aria-label=${t('composer.attach')} onClick=${() => fileIn.current?.click()}>+</button>
      <button type="button" class=${'k-pill k-mode m-' + mode} onClick=${() => { u.menu.value = 'mode'; }}>${t('mode.' + (mode === 'bypassPermissions' ? 'bypass' : mode)).split(' — ')[0]} ▾</button>
      <button type="button" class="k-pill" onClick=${() => { u.menu.value = 'model'; }}>${meta?.model ?? sum.model ?? t('model.default')}${meta?.effort ? ' · ' + meta.effort : ''} ▾</button>
      ${tasks.length ? html`<button type="button" class="k-pill k-agents" onClick=${() => { u.drawer.value = !u.drawer.value; }}>
        ⚙ ${t('agents.chip', { n: tasks.length })} <span class=${'k-dot' + (agentAsks ? ' k-dot-ask' : '')} aria-hidden="true">●</span></button>` : null}
      <span class="k-spacer"></span>
      ${busy ? html`<button type="button" class="d-btn k-stop" title=${t('composer.stop')} onClick=${() => interruptChat(chatId)}>■ ${tp('composer.stop', 0).split(' (')[0]}</button>` : null}
      <span class="k-send">
        <button type="button" class="d-btn d-primary" disabled=${!draft.text.trim() && !atts.length} onClick=${() => send('send')}>${sendLabel} ⏎</button>
        ${busy ? html`<button type="button" class="d-btn d-primary k-split" aria-haspopup="menu" aria-expanded=${sendMenu} aria-label=${t('composer.later')}
          onClick=${() => setSendMenu(!sendMenu)}>▾</button>` : null}
        ${sendMenu && busy ? html`<div class="c-menu-list k-sendmenu" role="menu">
          <button type="button" role="menuitem" class="c-menu-item" onClick=${() => send('later')}>${t('composer.later')}</button>
          <button type="button" role="menuitem" class="c-menu-item" disabled=${!canNow} title=${canNow ? '' : t('composer.sendNow.fallback')}
            onClick=${() => send('now')}>${t('composer.sendNow')}</button></div>` : null}
      </span>
    </div>
  </div>`;
}
