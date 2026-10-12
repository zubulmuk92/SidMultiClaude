// @ts-check
// src/web/components/chat/ToolCard.js — one tool call (collapsed line, lazy expanded body, status, denial, background
// and stop actions) and the ToolGroup summary row (ux §5.2, §5.4). Each card has its own error boundary.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from './text.js';
import { act, useChatVM } from './env.js';
import { UI } from './consts.js';
import { groupMustOpen, groupSummary, toolKind } from './model.js';
import { toolSummary, toolCode, denialText, ToolBody } from './ToolRenderers.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { useBlock } from './Blocks.js';

/** @typedef {Extract<import('../../../shared/protocol.ts').UiBlock, { k: 'tool' }>} ToolBlock */

const GLYPH = /** @type {Record<string, string>} */ ({ running: '◐', asking: '!', ok: '✓', error: '✕', denied: '⊘', withdrawn: '⊘', interrupted: '■' });

/** @param {{ chatId: string; block: ToolBlock; expanded?: boolean }} p */
export function ToolCard(p) {
  return html`<${ErrorBoundary} label=${'tool ' + p.block.name} chatId=${p.chatId}><${ToolCardInner} ...${p} /><//>`;
}

/** @param {{ chatId: string; block: ToolBlock; expanded?: boolean }} p */
function ToolCardInner({ chatId, block, expanded }) {
  const b = useBlock(chatId, block);
  const auto = b.status === 'running' && (b.name === 'Bash' || b.name === 'PowerShell') || b.status === 'error';
  const [open, setOpen] = useState(!!expanded || auto);
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setOpen(!!expanded || auto); }, [expanded, auto]);
  const denial = denialText(b);
  const err = b.status === 'error' && !denial;
  const cls = 'c-tool c-st-' + b.status + (denial ? ' c-tool-denied' : '') + (err ? ' c-tool-error' : '');
  const code = toolCode(b);
  const canBg = b.status === 'running' && (b.name === 'Bash' || b.name === 'PowerShell') && (b.elapsedMs ?? 0) >= 2000;
  const canStop = b.status === 'running' && !!b.taskId;
  return html`<div class=${cls} data-block=${b.id} role="group" aria-label=${t('a11y.claude') + ', ' + b.name}>
    <div class="c-tool-line">
      <button type="button" class="c-disclosure" aria-expanded=${open} onClick=${() => { touched.current = true; setOpen(!open); }}>
        <span class="c-glyph" aria-hidden="true">${GLYPH[b.status] ?? '·'}</span>
        <span class="c-tool-sum">${err ? t('tool.error', { outil: b.name }) + ' · ' : ''}${toolSummary(b)}</span>
        ${b.input.fields['replace_all'] === true ? html`<span class="c-badge">replace_all</span>` : null}
        ${b.agentId ? html`<span class="c-badge">${b.agentId}</span>` : null}
      </button>
      ${denial ? html`<span class="c-denial">${denial}</span>` : null}
      ${b.status === 'asking' ? html`<span class="c-ask-anchor">${t('chat.askAnchor')}</span>` : null}
      ${canBg ? html`<button type="button" class="c-mini" onClick=${() => { void act().task(chatId, 'background', b.toolUseId).catch(() => {}); }}>${t('tool.bash.toBg')}</button>` : null}
      ${canStop ? html`<button type="button" class="c-mini" onClick=${() => { void act().task(chatId, 'stop', b.taskId).catch(() => {}); }}>■ ${t('agents.stop')}</button>` : null}
    </div>
    ${!open && code && (b.name === 'Bash' || b.name === 'PowerShell') ? html`<div class="c-cmd-line">${code}</div>` : null}
    ${err && !open && b.result?.summary ? html`<div class="c-err-line">${b.result.summary.split('\n')[0]}</div>` : null}
    ${open ? html`<${ToolBody} chatId=${chatId} b=${b} />` : null}
  </div>`;
}

/** Contiguous tools in Normal view: one summary line, open while a tool runs / asks / failed, closes 1.5 s later.
 * @param {{ chatId: string; tools: ToolBlock[] }} p */
export function ToolGroup({ chatId, tools }) {
  const vm = useChatVM(chatId);
  const live = tools.map((b) => { const s = vm.blocks(b.id); return /** @type {ToolBlock} */ (s ? s.value : b); });
  const must = groupMustOpen(live);
  const [userOpen, setUserOpen] = useState(/** @type {boolean | null} */ (null));
  const [lingering, setLingering] = useState(false);
  const was = useRef(must);
  useEffect(() => {
    if (was.current && !must) { setLingering(true); const id = setTimeout(() => setLingering(false), UI.GROUP_COLLAPSE_MS); was.current = must; return () => clearTimeout(id); }
    was.current = must;
    return undefined;
  }, [must]);
  const open = userOpen ?? (must || lingering);
  const anyErr = live.some((b) => b.status === 'error');
  const anyRun = live.some((b) => b.status === 'running' || b.status === 'asking');
  return html`<div class="c-group" data-group=${tools[0]?.id}>
    <button type="button" class="c-disclosure c-group-line" aria-expanded=${open} onClick=${() => setUserOpen(!open)}>
      <span>${open ? '▾' : '▸'} ${groupSummary(live)}</span>
      <span class="c-glyph" aria-hidden="true">${anyRun ? '◐' : anyErr ? '✕' : '✓'}</span>
    </button>
    ${open ? html`<div class="c-group-body">${live.map((b) => html`<${ToolCard} key=${b.id} chatId=${chatId} block=${b} expanded=${toolKind(b.name) === 'command' && b.status === 'running'} />`)}</div>` : null}
  </div>`;
}
