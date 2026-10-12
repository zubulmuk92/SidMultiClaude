// @ts-check
// src/web/components/dialogs/NewChat.js — « Nouveau chat » (Alt+N; ux §8.1, SPEC §9.2.5). Account (Alt+1…9), folder
// (S9 checks through fs.dirs, recent folders, usual-account hint), model and effort (« Par défaut » omits the option:
// token parity), mode, name, first prompt. « Créer et envoyer » (Entrée in the prompt) · « Créer sans envoyer »
// (Ctrl+Entrée: no process until the user types). Errors: untrusted → Trust; not_logged_in → Se connecter; cwd_* inline.
import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { accounts, chats, focusedChat } from '../../store.js';
import { recentFolders } from '../../derived.js';
import { actions, closeOverlay, createChat, listDirs, openChat, openOverlay } from '../../actions.js';
import { errorKey } from '../../actions.js';
import { Modal } from '../shell/common.js';
import { DirBrowser } from './DirBrowser.js';
import { Trust } from './Trust.js';
import { baseName } from '../../lib/fmt.js';
import { Icon } from '../../lib/icons.js';

/** @typedef {import('../../../shared/protocol.ts').PermissionModeId} Mode */
/** @typedef {import('../../../shared/protocol.ts').Effort} Effort */
const LAST_KEY = 'smc.lastAccount';
const MODES = /** @type {Mode[]} */ (['default', 'acceptEdits', 'plan', 'auto']);
const MODE_KEY = { default: 'mode.default', acceptEdits: 'mode.acceptEdits', plan: 'mode.plan', auto: 'mode.auto', bypassPermissions: 'mode.bypass' };
const EFFORTS = /** @type {Effort[]} */ (['low', 'medium', 'high', 'xhigh', 'max']);
/** Fallback when the server sends no catalog (older servers may omit AccountView.models). */
const ALIASES = [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' }];

/** First prompt line, cleaned of @mentions and /commands, cut to 60 chars (ux §8.1). @param {string} prompt */
export function titleFromPrompt(prompt) {
  const line = prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('/')) ?? '';
  const clean = line.replace(/(^|\s)@\S+/g, ' ').replace(/(^|\s)\/[\w:-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 59).trimEnd()}…` : clean;
}
const readLast = () => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } };
/** @param {string} id */
const writeLast = (id) => { try { localStorage.setItem(LAST_KEY, id); } catch { /* */ } };

/** @param {{ accountId?: string; cwd?: string }} props */
export function NewChat(props) {
  const accts = accounts.value.filter((a) => !a.hidden);
  const fc = focusedChat.value ? chats.value.get(focusedChat.value) : undefined;
  const list = [...chats.value.values()];
  const initAcc = props.accountId ?? fc?.accountId ?? readLast() ?? accts.find((a) => a.login === 'connected')?.id ?? accts[0]?.id ?? '';
  const [acc, setAcc] = useState(initAcc);
  const a = accts.find((x) => x.id === acc);
  const initCwd = props.cwd ?? (fc?.accountId === acc ? fc.cwd : undefined) ?? recentFolders(list.filter((s) => s.accountId === acc), 1)[0]?.path ?? '';
  const [cwd, setCwd] = useState(initCwd);
  const [model, setModel] = useState(a?.defaults.model ?? '');
  const [effort, setEffort] = useState(/** @type {Effort | ''} */ (a?.defaults.effort ?? ''));
  const [mode, setMode] = useState(/** @type {Mode} */ (a?.defaults.mode && a.defaults.mode !== 'bypassPermissions' ? a.defaults.mode : 'default'));
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [step, setStep] = useState(/** @type {'form' | 'browse' | 'trust'} */ ('form'));
  const [check, setCheck] = useState(/** @type {{ level: 'error' | 'warn'; key: string; args?: Record<string, string | number>; path: string } | null} */ (null));
  const [err, setErr] = useState(/** @type {{ key: string; args?: Record<string, string | number>; login?: boolean } | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [sendAfter, setSendAfter] = useState(true);
  const recents = useMemo(() => recentFolders(list, 6), [chats.value]);
  // S9 pre-check (the server re-checks on create): missing, too long, home, profile, very large ancestor. A result
  // belongs to the folder it was computed for: a refusal of the previous value never blocks a new one still being checked
  useEffect(() => {
    const path = cwd.trim();
    if (!path) { setCheck(null); return undefined; }
    let live = true;
    const tm = setTimeout(() => void listDirs(path).then((r) => {
      if (!live) return;
      if ('dirs' in r) setCheck(r.warning === 'home' ? { level: 'error', key: 'new.homeRefused', path } : r.warning === 'ancestor' ? { level: 'warn', key: 'new.ancestorWarn', args: { chemin: r.path }, path } : null);
      else if (r.code === 'not_found' || r.code === 'cwd_missing') setCheck({ level: 'error', key: 'new.missing', path });
      else { const k = errorKey(r, path); setCheck({ level: 'error', key: k.key, ...(k.args ? { args: k.args } : {}), path }); }
    }), 300);
    return () => { live = false; clearTimeout(tm); };
  }, [cwd]);
  const blocked = check?.level === 'error' && check.path === cwd.trim();
  const usual = useMemo(() => {
    const used = new Set(list.filter((s) => s.cwd && s.cwd.toLowerCase() === cwd.trim().toLowerCase()).map((s) => s.accountId));
    if (!used.size || used.has(acc)) return null;
    const other = accts.find((x) => used.has(x.id));
    return other ? other.name : null;
  }, [cwd, acc, chats.value]);
  /** the account's model catalog (AccountView.models); the aliases when it is absent or empty */
  const models = a?.models?.length ? a.models.map((m) => ({ value: m.value, label: m.label || m.value })) : ALIASES;
  /** Another account: its own defaults (model, effort, mode) replace the previous account's. @param {string} id */
  const pickAccount = (id) => {
    const x = accts.find((q) => q.id === id);
    setAcc(id);
    setModel(x?.defaults.model ?? '');
    setEffort(x?.defaults.effort ?? '');
    setMode(x?.defaults.mode && x.defaults.mode !== 'bypassPermissions' ? x.defaults.mode : 'default');
  };

  /** @param {boolean} send @param {boolean} [trust] */
  const submit = async (send, trust) => {
    if (busy || !acc || !cwd.trim() || blocked) return;
    setBusy(true); setErr(null); setSendAfter(send);
    const title = name.trim() || titleFromPrompt(prompt);
    const r = await createChat({ accountId: acc, cwd: cwd.trim(), mode, ...(title ? { title } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(trust ? { trust: true } : {}) });
    setBusy(false);
    if ('chatId' in r) {
      writeLast(acc);
      closeOverlay();
      openChat(r.chatId);
      if (send && prompt.trim()) actions.send(r.chatId, prompt);
      return;
    }
    if (r.error.code === 'untrusted') { setStep('trust'); return; }
    const k = errorKey(r.error, cwd.trim());
    setErr({ key: k.key, ...(k.args ? { args: k.args } : {}), login: r.error.code === 'not_logged_in' });
  };
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.altKey && !e.ctrlKey && !e.shiftKey && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
      const x = accts[Number(e.code.slice(-1)) - 1];
      if (x) { e.preventDefault(); e.stopPropagation(); pickAccount(x.id); }
    } else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); void submit(false); }
  };
  if (step === 'browse') return html`<${DirBrowser} start=${cwd || null} onClose=${() => setStep('form')} onPick=${(/** @type {string} */ p) => { setCwd(p); setStep('form'); }} />`;
  if (step === 'trust') return html`<${Trust} path=${cwd.trim()} onAnswer=${(/** @type {boolean} */ ok) => { setStep('form'); if (ok) void submit(sendAfter, true); }} />`;
  return html`<${Modal} title=${t('new.title')} onClose=${closeOverlay} wide=${true} cls="newchat"
      footer=${html`<span class="muted foot-note">${t('new.ram')}</span>
        <button type="button" class="btn" disabled=${busy} onClick=${() => void submit(false)}>${t('new.createEmpty')} <kbd>Ctrl+Entrée</kbd></button>
        <button type="button" class="btn primary" disabled=${busy || !prompt.trim()} onClick=${() => void submit(true)}>${t('new.create')} <kbd>Entrée</kbd></button>`}>
    <div class="form" onKeyDown=${onKey}>
      <fieldset class="field-row"><legend>${t('new.account')}</legend>
        <div class="acc-choices" role="radiogroup">${accts.map((x, i) => html`<label key=${x.id} class=${`acc-choice acc-${x.color} ${x.id === acc ? 'on' : ''}`}>
          <input type="radio" name="nc-acc" checked=${x.id === acc} onChange=${() => pickAccount(x.id)} />
          <span class=${`acc-badge acc-${x.color}`}>${x.monogram}</span> ${x.name}${x.identity?.plan ? ` · ${x.identity.plan}` : ''}
          ${x.login !== 'connected' ? html` — <em>${t('acc.notConnected')}</em>` : null}<kbd>Alt+${i + 1}</kbd></label>`)}</div>
      </fieldset>
      <div class="field-row"><label for="nc-cwd">${t('new.folder')}</label>
        <div class="field-col"><div class="inline"><input id="nc-cwd" class="grow mono" value=${cwd} spellcheck="false" data-autofocus=${initCwd ? undefined : ''}
            onInput=${(/** @type {InputEvent} */ e) => setCwd(/** @type {HTMLInputElement} */ (e.target).value)} />
          <button type="button" class="btn" onClick=${() => setStep('browse')}>${t('new.browse')}</button></div>
          ${recents.length ? html`<div class="chips"><span class="muted">${t('new.recent')} :</span>${recents.map((r) => html`<button type="button" key=${r.path} class="chip" title=${r.path} onClick=${() => setCwd(r.path)}>${baseName(r.path)}</button>`)}</div>` : null}
          ${check ? html`<p class=${`msg ${check.level}`}>${t(check.key, check.args)}</p>` : null}
          ${usual ? html`<p class="msg info">ⓘ ${t('new.usual', { compte: usual })}</p>` : null}</div></div>
      <div class="field-row"><label for="nc-model">${t('new.model')}</label>
        <div class="inline"><select id="nc-model" value=${model} onChange=${(/** @type {Event} */ e) => setModel(/** @type {HTMLSelectElement} */ (e.target).value)}>
            <option value="">${t('shell.new.modelDefault')}</option>${models.map((m) => html`<option key=${m.value} value=${m.value}>${m.label}</option>`)}</select>
          <label for="nc-effort">${t('header.effort')}</label>
          <select id="nc-effort" value=${effort} onChange=${(/** @type {Event} */ e) => setEffort(/** @type {Effort | ''} */ (/** @type {HTMLSelectElement} */ (e.target).value))}>
            <option value="">${t('shell.new.effortDefault')}</option>${EFFORTS.map((x) => html`<option key=${x} value=${x}>${t(`shell.effort.${x}`)}</option>`)}</select></div></div>
      ${model === 'haiku' && mode === 'plan' ? html`<p class="msg info">${t('warn.haikuPlan')}</p>` : null}
      <fieldset class="field-row"><legend>${t('new.mode')}</legend><div class="seg" role="radiogroup">${MODES.map((m) => html`<label key=${m} class=${`seg-btn mode-${m} ${m === mode ? 'on' : ''}`}>
        <input type="radio" name="nc-mode" checked=${m === mode} onChange=${() => setMode(m)} />${t(MODE_KEY[m])}</label>`)}</div></fieldset>
      <div class="field-row"><label for="nc-name">${t('shell.new.nameLabel')}</label><input id="nc-name" class="grow" placeholder=${t('new.name')} value=${name}
        onInput=${(/** @type {InputEvent} */ e) => setName(/** @type {HTMLInputElement} */ (e.target).value)} /></div>
      <textarea class="nc-prompt" rows="5" placeholder=${t('new.prompt')} aria-label=${t('new.prompt')} value=${prompt} data-autofocus=${initCwd ? '' : undefined}
        onInput=${(/** @type {InputEvent} */ e) => setPrompt(/** @type {HTMLTextAreaElement} */ (e.target).value)}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.isComposing) { e.preventDefault(); if (prompt.trim()) void submit(true); } }}></textarea>
      ${err ? html`<p class="msg error" role="alert">${t(err.key, err.args)}
        ${err.login ? html` <button type="button" class="btn sm" onClick=${() => openOverlay('login', { accountId: acc })}>${t('acc.login')}</button>` : null}</p>` : null}
    </div>
  </${Modal}>`;
}
