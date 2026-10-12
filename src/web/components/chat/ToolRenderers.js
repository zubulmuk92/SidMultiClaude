// @ts-check
// src/web/components/chat/ToolRenderers.js — per-tool collapsed line and expanded body (ux §5.4), from the LITE input
// (ToolInputView) and result (UiToolResult). Heavy fields are fetched only on expand (`detail`). Untrusted strings
// (tool and server names, paths, outputs) are always text nodes; tool output is never HTML (SPEC S5).
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { t, fmtClock } from './text.js';
import { act } from './env.js';
import { UI } from './consts.js';
import { mcpParts } from './model.js';
import { countChanges, patchToHunks } from '../../lib/diff.js';
import { DiffView } from './DiffView.js';
import { Markdown } from './Blocks.js';
import { openLightbox } from '../side/Lightbox.js';

/** @typedef {Extract<import('../../../shared/protocol.ts').UiBlock, { k: 'tool' }>} ToolBlock */

/** @param {ToolBlock} b @param {string} k */
const f = (b, k) => { const v = b.input.fields[k]; return v === undefined ? '' : String(v); };
/** @param {ToolBlock} b @param {string} k */
const d = (b, k) => { const v = b.result?.data?.[k]; return v === undefined ? undefined : String(v); };
/** @param {string} p */
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
/** @param {string} u */
const host = (u) => { try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return u; } };

/** Collapsed one-liner of a tool block (French, from i18n). @param {ToolBlock} b @param {number} [now] */
export function toolSummary(b, now) {
  const running = b.status === 'running';
  const el = fmtClock(b.elapsedMs ?? (now !== undefined ? 0 : 0));
  switch (b.name) {
    case 'Bash': case 'PowerShell': {
      const desc = f(b, 'description') || f(b, 'command') || b.input.summary;
      // a refused or withdrawn command never ran: never « A exécuté » next to « Refusé par vous »
      if (b.status === 'denied' || b.status === 'withdrawn') return t('tool.bash.not', { description: desc });
      return running ? t('tool.bash.run', { description: desc, 'durée': el }) : t('tool.bash', { description: desc });
    }
    case 'Read': {
      const start = Number(f(b, 'offset')) || 1, lim = Number(f(b, 'limit')) || 0;
      const plage = lim ? ` (L${start}–${start + lim - 1})` : start > 1 ? ` (L${start}–)` : '';
      return t('tool.read', { fichier: base(f(b, 'file_path')) || b.input.summary, plage });
    }
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': {
      const c = b.result?.patch ? countChanges(patchToHunks(b.result.patch).flatMap((h) => h.rows)) : null;
      return c ? t('tool.edit', { fichier: base(f(b, 'file_path') || f(b, 'notebook_path')), a: c.added, d: c.removed })
        : t('tool.edit', { fichier: base(f(b, 'file_path') || f(b, 'notebook_path')), a: '?', d: '?' }).replace(/ \(\+\? −\?\)$/, '');
    }
    case 'Write': {
      const p = base(f(b, 'file_path'));
      if (b.result?.patch?.length) { const c = countChanges(patchToHunks(b.result.patch).flatMap((h) => h.rows)); return t('tool.write.upd', { fichier: p, a: c.added, d: c.removed }); }
      return t('tool.write.new', { fichier: p, n: d(b, 'lines') ?? f(b, 'lines') ?? '?' });
    }
    case 'Grep': return b.result ? t('tool.grep', { motif: f(b, 'pattern'), n: d(b, 'numFiles') ?? '?', m: d(b, 'numMatches') ?? d(b, 'numLines') ?? '?' }) : `Grep « ${f(b, 'pattern')} »`;
    case 'Glob': return b.result ? t('tool.glob', { motif: f(b, 'pattern'), n: d(b, 'numFiles') ?? '?' }) : `Glob « ${f(b, 'pattern')} »`;
    case 'WebFetch': return t('tool.fetch', { domaine: host(f(b, 'url')), code: d(b, 'code') ?? '…' });
    case 'WebSearch': return t('tool.search', { 'requête': f(b, 'query'), n: d(b, 'results') ?? '…' });
    case 'Agent': case 'Task': return t('tool.agent', { type: f(b, 'subagent_type') || 'general-purpose', description: f(b, 'description') || b.input.summary });
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'TaskList': return b.result?.summary || b.input.summary || t('tool.todo', { fait: '?', total: '?' });
    case 'Skill': case 'SlashCommand': return t('tool.skill', { nom: f(b, 'skill') || f(b, 'command') || b.input.summary });
    case 'ToolSearch': return t('tool.toolsearch', { n: d(b, 'count') ?? '…' });
    case 'SendMessage': return t('tool.sendMessage', { nom: f(b, 'to') || b.input.summary });
    case 'TaskStop': return t('tool.taskStop', { id: f(b, 'task_id') || f(b, 'id') });
    case 'TaskOutput': return t('tool.taskOutput', { id: f(b, 'task_id') || f(b, 'id') });
    // never the CLI's own (English) tool_result text: the answers come from result.data (a0…), the plan state from the status
    case 'AskUserQuestion': {
      const n = Number(d(b, 'answered') ?? 0);
      const answers = Array.from({ length: n }, (_, i) => d(b, `a${i}`)).filter((x) => !!x).join(' · ');
      return answers ? `${t('tool.answers')} · ${answers}` : b.input.summary;
    }
    case 'ExitPlanMode': return b.status === 'ok' ? t('tool.planOk')
      : b.status === 'denied' && b.result?.summary ? `${t('plan.title')} · ${b.result.summary}` : t('plan.title');
    case 'Workflow': return t('tool.workflow', { nom: f(b, 'name') || b.input.summary, i: d(b, 'phase') ?? '?', n: d(b, 'phases') ?? '?', agents: d(b, 'agents') ?? '?' });
    default: {
      const m = mcpParts(b.name);
      if (m) return t('tool.mcp', { serveur: m.server, outil: m.tool });
      return b.input.summary || t('tool.unknown', { nom: b.name, 'clés': Object.keys(b.input.fields).join(', ') });
    }
  }
}

/** Denial label (amber row, ux §5.4). @param {ToolBlock} b */
export function denialText(b) {
  const k = b.result?.denial;
  // no result (the process ended first: crash, force stop): the status alone says it, never a bare « A exécuté »
  if (!k) return b.status === 'interrupted' ? t('tool.denied.interrupted') : b.status === 'withdrawn' ? t('tool.withdrawn') : null;
  if (k === 'withdrawn') return t('tool.withdrawn');
  return t(`tool.denied.${k === 'autoNa' ? 'autoNa' : k}`);
}

/** Monospace field of a tool's input (Bash command…). @param {ToolBlock} b */
export function toolCode(b) {
  if (b.name === 'Bash' || b.name === 'PowerShell') return '$ ' + f(b, 'command');
  if (b.name === 'Read' || b.name === 'Edit' || b.name === 'Write' || b.name === 'MultiEdit') return f(b, 'file_path');
  return '';
}

/** Output text: tail of 8 lines, « Afficher tout (n lignes) » loads the full output through `detail` when cut.
 * @param {{ chatId: string; b: ToolBlock }} p */
function Output({ chatId, b }) {
  const r = b.result;
  const [full, setFull] = useState(/** @type {string | null} */ (null));
  const [all, setAll] = useState(false);
  const [err, setErr] = useState(false);
  if (!r || (!r.head && !r.tail)) return r?.summary ? html`<div class=${'c-out-summary' + (r.isError ? ' c-err' : '')}>${r.summary}</div>` : null;
  const text = full ?? (r.tail && r.head !== r.tail ? `${r.head ?? ''}\n…\n${r.tail}` : r.head ?? r.tail ?? '');
  const lines = text.split('\n');
  const n = r.totalLines ?? lines.length;
  const shown = all ? lines : lines.slice(-UI.OUTPUT_TAIL_LINES);
  const more = () => {
    setAll(true);
    if (r.truncated && full === null) act().detail(chatId, b.id, 'output').then((x) => setFull(x.text ?? ''), () => setErr(true));
  };
  return html`<div class="c-out">
    <pre class=${r.isError ? 'c-err' : ''}>${shown.join('\n')}</pre>
    ${!all && (lines.length > UI.OUTPUT_TAIL_LINES || r.truncated) ? html`<button type="button" class="c-link" onClick=${more}>${t('tool.showAll', { n })}</button>` : null}
    ${err ? html`<div class="c-err">${t('tool.detail.error')}</div>` : null}
  </div>`;
}

/** Expanded body of a tool card (lazy: mounted only when expanded). @param {{ chatId: string; b: ToolBlock }} p */
export function ToolBody({ chatId, b }) {
  const r = b.result;
  const code = toolCode(b);
  const isEdit = b.name === 'Edit' || b.name === 'Write' || b.name === 'MultiEdit' || b.name === 'NotebookEdit';
  return html`<div class="c-tool-body">
    ${code && !isEdit ? html`<pre class="c-cmd">${code}</pre>` : null}
    ${isEdit && r?.patch?.length ? html`<${DiffView} hunks=${patchToHunks(r.patch)} />` : null}
    ${isEdit && r?.data?.['userModified'] ? html`<span class="c-badge">${t('tool.userModified')}</span>` : null}
    ${b.name === 'ExitPlanMode' && typeof b.input.fields['plan'] === 'string' ? html`<${Markdown} md=${String(b.input.fields['plan'])} />` : null}
    ${!isEdit && b.name !== 'Bash' && b.name !== 'PowerShell' && Object.keys(b.input.fields).length ? html`<dl class="c-fields">
      ${Object.entries(b.input.fields).map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}</dl>` : null}
    ${b.input.truncated?.length ? html`<${FullInput} chatId=${chatId} b=${b} />` : null}
    ${r?.denial ? html`<div class="c-denied">${r.summary}</div>` : html`<${Output} chatId=${chatId} b=${b} />`}
    ${r?.images?.length ? html`<div class="c-user-images">${r.images.map((im) => html`<button type="button" class="c-chip c-imgchip"
      onClick=${() => openLightbox(chatId, im.ref, im.mediaType)}>🖼 ${im.mediaType}</button>`)}</div>` : null}
  </div>`;
}

/** Fields cut by the server (strings over 200 chars…): the full input is fetched on demand and shown as text.
 * @param {{ chatId: string; b: ToolBlock }} p */
function FullInput({ chatId, b }) {
  const [text, setText] = useState(/** @type {string | null} */ (null));
  const [err, setErr] = useState(false);
  if (text !== null) return html`<pre class="c-out c-full-input">${text}</pre>`;
  return html`<button type="button" class="c-link" onClick=${() => act().detail(chatId, b.id, 'input').then((x) => setText(x.text ?? ''), () => setErr(true))}>
    ${err ? t('tool.detail.error') : t('tool.detail.load')}</button>`;
}
