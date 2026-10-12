// @ts-check
// src/web/components/chat/model.js — pure transcript logic (ux §5): tool kinds, groups, focus view, mount window,
// stick-to-bottom, footers. No DOM, no Preact: unit-tested in Node.
import { t, fmtTokens, fmtCost, fmtDuration } from './text.js';
import { countChanges } from '../../lib/diff.js';

/** @typedef {import('../../../shared/protocol.ts').UiBlock} UiBlock */
/** @typedef {Extract<UiBlock, { k: 'tool' }>} ToolBlock */
/** @typedef {import('../../../shared/protocol.ts').UiTurn} UiTurn */
/** @typedef {import('../../../shared/protocol.ts').TurnFooter} TurnFooter */
/** @typedef {import('../../../shared/protocol.ts').ViewMode} ViewMode */
/** @typedef {'read' | 'search' | 'command' | 'edit' | 'web' | 'agent' | 'mcp' | 'todo' | 'ask' | 'meta' | 'other'} ToolKind */

/** @param {string} name @returns {ToolKind} */
export function toolKind(name) {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Read': case 'NotebookRead': return 'read';
    case 'Grep': case 'Glob': case 'LS': return 'search';
    case 'Bash': case 'PowerShell': case 'BashOutput': case 'KillShell': case 'Monitor': return 'command';
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return 'edit';
    case 'WebFetch': case 'WebSearch': return 'web';
    case 'Agent': case 'Task': case 'Workflow': return 'agent';
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': case 'TaskList': return 'todo';
    case 'AskUserQuestion': case 'ExitPlanMode': case 'EnterPlanMode': return 'ask';
    case 'ToolSearch': return 'meta';
    default: return 'other';
  }
}

/** MCP tool name → { server, tool } (both untrusted strings, rendered as text). @param {string} name */
export function mcpParts(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1] ?? '', tool: m[2] ?? '' } : null;
}

/** @typedef {{ kind: 'block'; block: UiBlock } | { kind: 'group'; id: string; tools: ToolBlock[] } | { kind: 'folded'; id: string; count: number }} Item */

/**
 * Layout of a turn's blocks for a view mode (ux §5.1–5.2).
 * - normal: contiguous tool blocks (2 or more, no text between) form one group; ToolSearch is hidden;
 * - detailed: every block on its own;
 * - focus: user blocks and the LAST text block; everything else becomes one « ▸ n actions » row.
 * @param {UiBlock[]} blocks @param {ViewMode} view @param {string} [headUuid] @returns {Item[]}
 */
export function layoutBlocks(blocks, view, headUuid) {
  if (headUuid) blocks = blocks.filter((b) => !(b.k === 'user' && b.msg.uuid === headUuid));   // the opening message is the turn head
  if (view === 'focus') {
    let lastText = -1;
    blocks.forEach((b, k) => { if (b.k === 'text') lastText = k; });
    /** @type {Item[]} */ const out = [];
    let hidden = 0;
    blocks.forEach((b, k) => {
      if (b.k === 'user' || k === lastText) {
        if (hidden) { out.push({ kind: 'folded', id: `f:${b.id}`, count: hidden }); hidden = 0; }
        out.push({ kind: 'block', block: b });
      } else if (b.k === 'tool' || b.k === 'thinking' || b.k === 'text') hidden++;
      else if (b.k === 'system' && (b.row.kind === 'crash' || b.row.kind === 'error' || b.row.kind === 'interrupted')) out.push({ kind: 'block', block: b });
    });
    if (hidden) out.push({ kind: 'folded', id: 'f:end', count: hidden });
    return out;
  }
  const visible = blocks.filter((b) => view === 'detailed' || !(b.k === 'tool' && b.name === 'ToolSearch')
    && !(b.k === 'system' && (b.row.kind === 'hook' || b.row.kind === 'modeChange')));
  if (view === 'detailed') return visible.map((block) => ({ kind: 'block', block }));
  /** @type {Item[]} */ const out = [];
  /** @type {ToolBlock[]} */ let run = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: 'group', id: `g:${run[0]?.id}`, tools: run });
    else for (const b of run) out.push({ kind: 'block', block: b });
    run = [];
  };
  for (const b of visible) {
    if (b.k === 'tool' && toolKind(b.name) !== 'ask' && !b.parentToolUseId) run.push(b);
    else if (b.k === 'tool' && b.parentToolUseId) continue;   // subagent tools live in the agent card / drawer
    else { flush(); out.push({ kind: 'block', block: b }); }
  }
  flush();
  return out;
}

/** A group stays open while a tool runs, asks or failed (ux §5.2). @param {ToolBlock[]} tools */
export const groupMustOpen = (tools) => tools.some((b) => b.status === 'running' || b.status === 'asking' || b.status === 'error');

/** « 5 actions (3 lectures, 1 commande, 1 modification (+12 −3)) ». @param {ToolBlock[]} tools */
export function groupSummary(tools) {
  /** @type {Record<string, number>} */ const n = {};
  let add = 0, del = 0;
  for (const b of tools) {
    const k = toolKind(b.name);
    n[k] = (n[k] ?? 0) + 1;
    if (k === 'edit' && b.result?.patch) {
      const c = countChanges(b.result.patch.flatMap((h) => h.lines.map((l) => ({ op: /** @type {' '|'+'|'-'} */ (l[0] === '+' || l[0] === '-' ? l[0] : ' ') }))));
      add += c.added; del += c.removed;
    }
  }
  const order = ['read', 'search', 'command', 'edit', 'web', 'agent', 'mcp', 'todo', 'other', 'meta'];
  const parts = order.filter((k) => n[k]).map((k) => {
    const c = /** @type {number} */ (n[k]);
    const s = t(c > 1 ? `grp.${k}.n` : `grp.${k}`, { n: c });
    return k === 'edit' && (add || del) ? `${s} (+${add} −${del})` : s;
  });
  return t('tool.group', { n: tools.length, 'détail': parts.join(', ') });
}

/** Mount window: the last `max` turns, or `max` turns ending at an anchor the user scrolled to.
 * @param {number} total @param {number} max @param {number | null} anchorIndex @returns {{ start: number; end: number }} */
export function mountWindow(total, max, anchorIndex) {
  if (total <= max) return { start: 0, end: total };
  if (anchorIndex === null || anchorIndex >= total - max) return { start: total - max, end: total };
  const start = Math.max(0, anchorIndex - Math.floor(max / 3));
  return { start, end: Math.min(total, start + max) };
}

/** @param {{ scrollTop: number; scrollHeight: number; clientHeight: number }} el @param {number} px */
export const nearBottom = (el, px) => el.scrollHeight - el.scrollTop - el.clientHeight <= px;

/** « 1 min 12 s · 34 k entrée (91 % cache) · 1,2 k sortie · ≈ 0,05 $ » (+ aux line when > 0). @param {TurnFooter} f */
export function footerText(f) {
  const input = f.input + f.cacheRead + f.cacheWrite;
  const cache = input ? Math.round((f.cacheRead / input) * 100) : 0;
  const main = t('sys.footer', { 'durée': fmtDuration(f.durationMs ?? 0), in: fmtTokens(input), cache, out: fmtTokens(f.output), 'coût': fmtCost(f.costUsd) });
  return f.auxTokens && f.auxTokens > 0 ? `${main} · ${t('sys.footer.aux', { n: fmtTokens(f.auxTokens) })}` : main;
}

/** Visible label of a user message by origin (ux §5.2). @param {import('../../../shared/protocol.ts').UiUserMsg} m */
export function userLabel(m) {
  switch (m.origin) {
    case 'peer': return t('chat.origin.peer');
    case 'task': return t('chat.origin.task');
    case 'auto': return t('chat.origin.auto');
    case 'command': return t('chat.origin.command');
    default: return t('a11y.you');
  }
}

/** Last user prompts of a list of turns, newest first (rewind points, history ↑). @param {UiTurn[]} turns */
export function userPrompts(turns) {
  /** @type {{ uuid: string; text: string; at: number; turnId: string }[]} */ const out = [];
  for (const turn of turns) {
    const blocks = turn.blocks ?? [];                       // a malformed turn (shown « Bloc illisible ») is skipped, never fatal
    for (const b of blocks) if (b?.k === 'user' && b.msg?.origin === 'human') out.push({ uuid: b.msg.uuid, text: b.msg.text, at: turn.at, turnId: turn.id });
    if (turn.user && turn.user.origin === 'human' && !blocks.some((b) => b?.k === 'user' && b.msg?.uuid === turn.user?.uuid))
      out.push({ uuid: turn.user.uuid, text: turn.user.text, at: turn.at, turnId: turn.id });
  }
  return out.reverse();
}

/** Glyph + French label of a chat state on the pane header (ux §4.4; colour is never the only cue).
 * @param {import('../../../shared/protocol.ts').ChatStateView} s @param {number} now @returns {{ glyph: string; label: string; tone: string }} */
export function stateView(s, now) {
  const since = fmtDuration(Math.max(0, now - s.since));
  if (s.flags.external) return { glyph: '⌨', label: t(`state.external.${s.flags.external.status}`), tone: 'ext' };
  switch (s.phase) {
    case 'cold': return { glyph: '○', label: t(s.flags.notStarted ? 'state.new' : 'state.cold'), tone: 'cold' };
    case 'starting': return { glyph: '◌', label: t('state.starting'), tone: 'run' };
    case 'idle': return s.flags.bgTasks ? { glyph: '⚙', label: t('state.bg', { n: s.flags.bgTasks }), tone: 'idle' }
      : { glyph: s.flags.unread ? '✓' : '', label: t(s.flags.unread ? 'state.done' : 'state.idle'), tone: s.flags.unread ? 'done' : 'idle' };
    case 'running': {
      const sub = s.sub;
      const label = sub === 'tool' ? t('state.tool', { outil: s.subTool ?? '', 'durée': since })
        : sub === 'requesting' || sub === 'thinking' || sub === 'writing' || sub === 'compacting' || sub === 'stopping' ? t(`state.${sub}`)
        : sub === 'retry' ? t('state.running') : t('state.running');
      return { glyph: '◐', label, tone: 'run' };
    }
    case 'needs_permission': return { glyph: '!', label: `${t('state.needsPermission')} · ${t('state.waiting', { 'durée': since })}`, tone: 'needs' };
    case 'needs_answer': return { glyph: '?', label: t('state.needsAnswer'), tone: 'needs' };
    case 'needs_plan': return { glyph: '≡', label: t('state.needsPlan'), tone: 'needs' };
    case 'rate_limited': return { glyph: '⧗', label: t('state.rateLimited'), tone: 'limit' };
    default: return { glyph: '✕', label: t('state.error'), tone: 'err' };
  }
}

/** Markdown export of the loaded turns (« Exporter en Markdown »; text and tool one-liners only).
 * @param {UiTurn[]} turns @param {string} title @param {(b: ToolBlock) => string} toolLine */
export function exportMarkdown(turns, title, toolLine) {
  const out = [`# ${title}`, ''];
  for (const turn of turns) {
    if (turn.user) out.push(`## ${t('a11y.you')}`, '', turn.user.text, '');
    const parts = [];
    for (const b of turn.blocks) {
      if (b.k === 'text') parts.push(b.md);
      else if (b.k === 'tool') parts.push(`- ${toolLine(b)}`);
      else if (b.k === 'user' && b.msg.uuid !== turn.user?.uuid) parts.push(`> ${b.msg.text.replace(/\n/g, '\n> ')}`);
    }
    if (parts.length) out.push(`## ${t('a11y.claude')}`, '', parts.join('\n\n'), '');
  }
  return out.join('\n');
}
