// @ts-check
// src/web/components/chat/PaneHeader.js — per-chat header (ux §3.5): account badge, state, title (F2 renames inline),
// flag badges and link chips, folder ⎇ branch menu, model · effort menu (Alt+P), mode pill (Alt+M then 1–5), context
// ring, cache clock, cost, ⋯ menu, ■ stop. Everything shown costs zero tokens.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, tp, fmtTokens, fmtCost, fmtPct } from './text.js';
import { act, accountOf, chatUi, cycleView, getEnv, useChatVM, viewModeOf } from './env.js';
import { exportMarkdown, stateView } from './model.js';
import { toolSummary } from './ToolRenderers.js';
import { Menu } from '../side/Popovers.js';
import { openOverlay } from '../side/overlays.js';
import { switchModel } from '../side/ModelSwitchConfirm.js';
import { interruptChat, isBusy } from '../composer/Composer.js';
import { useNow } from '../dock/Card.js';
import { GlyphIcon, Icon } from '../../lib/icons.js';

/** @typedef {import('../../../shared/protocol.ts').PermissionModeId} PermissionModeId */
/** @typedef {import('../../../shared/protocol.ts').Effort} Effort */

export const MODES = /** @type {readonly PermissionModeId[]} */ (['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
const MODE_GLYPH = /** @type {Record<PermissionModeId, string>} */ ({ default: '‖', acceptEdits: '✎', plan: '◇', auto: '✦', bypassPermissions: '⚠' });
/** Model aliases offered (never free text: an unknown string triggers a validation model call). */
export const MODEL_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku']);
export const EFFORTS = /** @type {readonly Effort[]} */ (['low', 'medium', 'high', 'xhigh', 'max']);
/** @typedef {import('../../../shared/protocol.ts').ModelOption} ModelOption */

/**
 * Models offered for an account (pure): its catalog (AccountView.models) or, when absent / empty, the aliases.
 * @param {{ models?: ModelOption[] } | undefined} acc @returns {ModelOption[]}
 */
export function modelChoices(acc) {
  const list = acc?.models?.filter((m) => m && typeof m.value === 'string' && m.value) ?? [];
  return list.length ? list : MODEL_ALIASES.map((a) => ({ value: a, label: a, efforts: [...EFFORTS] }));
}
/** The catalog entry of the chat's model (exact value, else the alias it contains). @param {ModelOption[]} list @param {string | null} model */
export const currentModel = (list, model) => (model ? list.find((o) => o.value === model) ?? list.find((o) => model.includes(o.value)) : undefined);

/**
 * Modes of the mode menu (pure): Auto only when the chat's model supports it (meta.autoAvailable) — the current mode
 * always stays listed; bypass only when the setting allows it.
 * @param {{ allowBypass: boolean; autoAvailable: boolean; current: PermissionModeId }} o @returns {PermissionModeId[]}
 */
export function menuModes(o) {
  return MODES.filter((x) => x === o.current || (x === 'auto' ? o.autoAvailable : x === 'bypassPermissions' ? o.allowBypass : true));
}
/** @param {string} p */
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Cache clock state (pure). @param {{ cacheWarmUntil?: number }} m @param {boolean} live @param {number} now */
export function cacheClock(m, live, now) {
  if (!live || !m.cacheWarmUntil) return null;
  const min = Math.ceil((m.cacheWarmUntil - now) / 60_000);
  if (min <= 0) return { tone: 'cold', min: 0 };
  return { tone: m.cacheWarmUntil - now < 5 * 60_000 ? 'soon' : 'warm', min };
}

/** @param {string} chatId @param {PermissionModeId} m */
export function pickMode(chatId, m) {
  if (m === 'bypassPermissions') {
    openOverlay({ kind: 'confirm', chatId, title: t('mode.bypass').split(' — ')[0] ?? '', body: t('mode.bypass.confirm'), ok: t('mode.bypass').split(' — ')[0] ?? '',
      danger: true, typed: 'CONTOURNER', onOk: () => { void act().setMode(chatId, 'bypassPermissions', 'CONTOURNER').catch(() => {}); } });
    return;
  }
  void act().setMode(chatId, m).catch(() => {});
}

/** @param {{ chatId: string; narrow?: boolean }} p */
export function PaneHeader({ chatId, narrow }) {
  const env = getEnv();
  const vm = useChatVM(chatId);
  const u = chatUi(chatId);
  const now = useNow(15_000);
  const sum = vm.summary.value, meta = vm.meta.value, m = vm.metrics.value;
  const acc = accountOf(sum.accountId);
  const st = stateView(sum.state, now);
  const mode = meta?.mode ?? sum.mode ?? 'default';
  const model = meta?.model ?? sum.model;
  const busy = isBusy(sum.state.phase);
  const [title, setTitle] = useState(sum.title);
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  useEffect(() => { if (u.renaming.value) { setTitle(sum.title); setTimeout(() => input.current?.select(), 0); } }, [u.renaming.value]);
  // once: Entrée ends the edit, then the input unmounts and its blur calls this again (it used to send chat.rename twice)
  const rename = () => { if (!u.renaming.value) return; u.renaming.value = false; const v = title.trim(); if (v && v !== sum.title) void act().rename(chatId, v).catch(() => {}); };
  const pct = m.contextTokens && m.contextWindow ? m.contextTokens / m.contextWindow : null;
  const clock = cacheClock(m, sum.state.flags.live, now);
  const allowBypass = !!env.settings.value?.allowBypass;
  const modeItems = menuModes({ allowBypass, autoAvailable: vm.autoAvailable.value, current: mode }).map((x) => ({ id: x, glyph: MODE_GLYPH[x], label: t('mode.' + (x === 'bypassPermissions' ? 'bypass' : x)), checked: x === mode }));
  const effort = meta?.effort ?? null;
  const choices = modelChoices(acc);
  const cur = currentModel(choices, model ?? null);
  const efforts = cur?.efforts?.length ? EFFORTS.filter((e) => cur.efforts.includes(e)) : EFFORTS;
  const modelItems = [{ id: 'm:', label: t('model.default'), checked: !model }, ...choices.map((o) => ({ id: 'm:' + o.value, label: o.label || o.value, checked: o === cur })),
    { id: 'sep', label: '', sep: true }, ...efforts.map((e) => ({ id: 'e:' + e, label: tp('header.effort', EFFORTS.indexOf(e)), checked: e === effort }))];
  /** @param {string} id */
  const onModel = (id) => {
    if (id.startsWith('m:')) { const v = id.slice(2) || null; switchModel(chatId, v, effort, m, (v ?? '') !== (model ?? '') && !(v && model?.includes(v))); }
    else if (id.startsWith('e:')) void act().setModel(chatId, model ?? null, /** @type {Effort} */ (id.slice(2))).catch(() => {});
  };
  const view = viewModeOf(chatId).value;
  const moreItems = [
    { id: 'view', label: `${tp('menu.view', 0).split(' : ')[0]} : ${tp('menu.view', ['normal', 'detailed', 'focus'].indexOf(view)).replace(/^Vue : /, '')} (Ctrl+O)` },
    { id: 'search', label: t('menu.search') }, { id: 'rewind', label: t('menu.rewind') }, { id: 'fork', label: t('menu.fork') },
    { id: 'continue', label: t('menu.continue') }, { id: 'terminal', label: t('menu.terminal') },
    { id: 'export', label: t('menu.export') }, { id: 'info', label: t('menu.info') }, { id: 'sep', label: '', sep: true },
    { id: 'sleep', label: t('menu.sleep'), disabled: !sum.state.flags.live },
    { id: 'keepAlive', label: t('menu.keepAlive'), checked: sum.keepAlive },
    { id: 'mute', label: t('menu.mute'), checked: sum.muted },
    { id: 'close', label: t('header.closePane') },
  ];
  /** @param {string} id */
  const onMore = (id) => {
    switch (id) {
      case 'view': cycleView(chatId); break;
      case 'search': u.search.value = true; break;
      case 'rewind': openOverlay({ kind: 'rewind', chatId }); break;
      case 'fork': void act().fork(chatId, {}).then((c) => act().openChat(c, 'focused'), () => {}); break;
      case 'continue': openOverlay({ kind: 'continue', chatId }); break;
      case 'terminal': void act().terminal(chatId, false).catch(() => {}); break;
      case 'export': {
        const md = exportMarkdown(vm.turns.value.map((x) => x.sig.value), sum.title, (b) => toolSummary(b));
        void navigator.clipboard?.writeText(md).then(() => act().toast('export.done'));
        break;
      }
      case 'info': openOverlay({ kind: 'info', chatId, what: 'session' }); break;
      case 'sleep': void act().sleep(chatId).catch(() => {}); break;
      case 'keepAlive': void act().flags(chatId, { keepAlive: !sum.keepAlive }).catch(() => {}); break;
      case 'mute': void act().flags(chatId, { muted: !sum.muted }).catch(() => {}); break;
      case 'close': act().closePane(chatId); break;
    }
  };
  /** @param {'mode' | 'model' | 'more' | 'folder'} k */
  const menuOpen = (k) => u.menu.value === k;
  /** @param {'mode' | 'model' | 'more' | 'folder'} k @returns {(o: boolean) => void} */
  const setMenu = (k) => (o) => { u.menu.value = o ? k : (u.menu.value === k ? null : u.menu.value); };
  const links = sum.links;
  const linkAcc = (/** @type {string} */ c) => accountOf(c.split(':')[0] ?? '')?.name ?? c.split(':')[0] ?? '';
  const folderItems = [{ id: 'copy', label: t('header.folder.copy') }, { id: 'explorer', label: t('header.folder.explorer') },
    { id: 'vscode', label: t('header.folder.vscode') }, { id: 'term', label: t('header.folder.terminal') }];
  /** @param {string} id */
  const onFolder = (id) => {
    if (id === 'copy') void navigator.clipboard?.writeText(sum.cwd).then(() => act().toast('chat.copied'));
    else if (id === 'explorer' || id === 'vscode') act().openPath(id, sum.cwd, chatId);
    else if (id === 'term') void act().terminal(chatId, false).catch(() => {});
  };
  return html`<header class=${'h-head h-' + st.tone + (narrow ? ' h-narrow' : '')}>
    <span class=${'h-acc' + (acc ? ' acc-' + acc.color : '')} title=${acc ? t('header.badge', { nom: acc.name, email: acc.identity?.email ?? '', plan: acc.identity?.plan ?? '' }) : sum.accountId}>${acc?.monogram ?? '?'}</span>
    <span class=${'h-state st-' + st.tone} role="status" aria-label=${st.label}><span aria-hidden="true"><${GlyphIcon} g=${st.glyph} size=${14} /></span> <span class="h-state-text">${st.label}</span></span>
    ${u.renaming.value ? html`<input ref=${input} class="h-title-edit" value=${title} aria-label=${t('header.rename')}
        onInput=${(/** @type {any} */ e) => setTitle(e.currentTarget.value)} onBlur=${rename}
        onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); u.renaming.value = false; } }} />`
      : html`<button type="button" class="h-title" title=${t('header.rename')} onClick=${() => { u.renaming.value = true; }}>${sum.title || t('state.new')}</button>`}
    ${sum.expiresInDays !== null && sum.expiresInDays <= 7 ? html`<span class="c-badge" title=${t('flag.expiring.tip', { jours: 30 })}><${Icon} n="hourglass" size=${13} /> ${t('flag.expiring', { n: sum.expiresInDays })}</span>` : null}
    ${sum.foreignOwner ? html`<span class="c-badge" title=${t('flag.foreignOwner.tip', { compte: acc?.name ?? '' })}><${Icon} n="swap" size=${13} /></span>` : null}
    ${sum.state.flags.queued ? html`<span class="c-badge" title=${t('queue.header', { n: sum.state.flags.queued })}><${Icon} n="list" size=${12} /> ${sum.state.flags.queued}</span>` : null}
    ${links?.continuedTo ? html`<button type="button" class="c-link" onClick=${() => links.continuedTo && act().openChat(links.continuedTo, 'focused')}>${t('cont.linkTo', { compte: linkAcc(links.continuedTo) })}</button>` : null}
    ${links?.continuedFrom ? html`<button type="button" class="c-link" onClick=${() => links.continuedFrom && act().openChat(links.continuedFrom, 'focused')}>${t('cont.linkFrom', { compte: linkAcc(links.continuedFrom) })}</button>` : null}
    <span class="h-spacer"></span>
    ${narrow ? null : html`<${Menu} cls="h-folder" title=${sum.cwd} label=${html`${base(sum.cwd)}${sum.branch ? html` <span class="h-branch"><${Icon} n="branch" size=${12} /> ${sum.branch}</span>` : null}`}
      items=${folderItems} onPick=${onFolder} open=${menuOpen('folder')} onOpenChange=${setMenu('folder')} />`}
    <${Menu} cls="h-model" title=${t('model.menu') + ' (Alt+P)'} label=${html`${model ?? t('model.default')}${effort ? ' · ' + effort : ''} <${Icon} n="chevron-down" size=${12} />`}
      items=${modelItems} onPick=${onModel} radio=${true} open=${menuOpen('model')} onOpenChange=${setMenu('model')} />
    <${Menu} cls=${'h-mode m-' + mode} title=${t('mode.menu') + ' (Alt+M)'} label=${html`<${GlyphIcon} g=${MODE_GLYPH[mode]} size=${13} /> ${t('mode.' + (mode === 'bypassPermissions' ? 'bypass' : mode)).split(' — ')[0]} <${Icon} n="chevron-down" size=${12} />`}
      items=${modeItems} onPick=${(/** @type {string} */ id) => pickMode(chatId, /** @type {PermissionModeId} */ (id))} radio=${true} open=${menuOpen('mode')} onOpenChange=${setMenu('mode')} />
    ${pct !== null ? html`<button type="button" class="h-chip h-ctx" title=${t('header.context', { pct: fmtPct(pct), used: fmtTokens(m.contextTokens), max: fmtTokens(m.contextWindow) })}
      onClick=${() => openOverlay({ kind: 'info', chatId, what: 'context' })}><${Icon} n="pie" size=${13} /> ${fmtPct(pct)} %</button>` : null}
    ${clock ? html`<span class=${'h-chip h-cache h-cache-' + clock.tone} title=${clock.tone === 'cold' ? t('header.cache.cold', { tokens: fmtTokens(m.contextTokens) })
      : t(clock.tone === 'soon' ? 'header.cache.soon' : 'header.cache.warm', { min: clock.min })}><${Icon} n="clock" size=${13} /> ${clock.tone === 'cold' ? '—' : clock.min + ' min'}</span>` : null}
    ${!narrow && m.costUsd !== undefined ? html`<span class="h-chip h-cost" title=${t('header.cost', { 'coût': fmtCost(m.costUsd) })}>≈ ${fmtCost(m.costUsd)}</span>` : null}
    <${Menu} cls="h-more" title=${t('header.menu')} label=${html`<${Icon} n="more" />`} items=${moreItems} onPick=${onMore} open=${menuOpen('more')} onOpenChange=${setMenu('more')} />
    ${busy ? html`<button type="button" class="h-stop" title=${t('header.stop')} aria-label=${t('header.stop')} onClick=${() => interruptChat(chatId)}><${Icon} n="stop-fill" size=${12} /></button>` : null}
  </header>`;
}
