// src/server/model/derive.ts — deriveTitle, activityLine, slash command grouping/local badge, plan model badge.
// Pure and deterministic: never model-generated (SPEC C12, ux §3.3).
import type { ActivityLine, DeriveTitle } from '../contracts.ts';
import type * as P from '../../shared/protocol.ts';
import { TITLE_MAX_CHARS } from '../../shared/limits.ts';
import { arr, cut, rec, str } from './blocks.ts';

export const ACTIVITY_MAX_CHARS = 80;
const MENTION_RE = /(^|\s)@(?:"([^"]+)"|(\S+))/g;
const COMMAND_RE = /^\/[A-Za-z0-9][\w:.-]*(?=\s|$)\s*/;   // a /command token, not a /path/to/file

/** First meaningful line of a prompt: leading /command dropped, @mentions reduced to their basename, ≤ 60 chars with « … ». */
export const deriveTitle: DeriveTitle = (prompt) => {
  const lines = String(prompt ?? '').replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(COMMAND_RE, '');
    line = line.replace(MENTION_RE, (_m, pre: string, quoted: string | undefined, bare: string | undefined) => {
      const p = (quoted ?? bare ?? '').replace(/[\\/]+$/, '');
      const base = p.split(/[\\/]/).pop() ?? p;
      return base ? `${pre}${base}` : pre;
    });
    line = line.replace(/\s+/g, ' ').trim();
    if (line) return cut(line, TITLE_MAX_CHARS);
  }
  return '';
};

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** First non-empty line; `md` drops leading Markdown markers (# > * -). */
const firstText = (t: string, md = true): string => {
  const l = String(t ?? '').split('\n').find((x) => x.trim()) ?? '';
  return md ? l.replace(/^[#>*\-\s]+/, '') : l;
};
/** Tool name as data: `mcp__slack__post_message` → `slack › post_message`. */
const toolLabel = (name: string): string => (name.startsWith('mcp__') ? name.split('__').slice(1).join(' › ') : name);

/** Deterministic one-liner for the sidebar's second line (ux §3.3), DATA ONLY in the ux form « Bash : npm test »:
 *  the French framing (state labels, verbs) is the client's i18n, never copy built on the server.
 *  Priority: pending ask › running tool › last reply › first prompt. */
export const activityLine: ActivityLine = (s) => {
  const out = (t: string): string => cut(oneLine(t), ACTIVITY_MAX_CHARS);
  const pair = (who: string, what: string): string => out(what ? `${who} : ${what}` : who);
  const a = s.ask;
  if (a) {
    if (a.kind === 'question') return out(firstText(a.questions?.[0]?.question ?? '', false) || a.toolName);
    if (a.kind === 'plan') return out(firstText(a.plan ?? '') || a.toolName);
    if (a.kind === 'elicitation') return pair(a.elicitation?.server ?? a.mcpServer?.name ?? a.toolName, firstText(a.elicitation?.message ?? '', false));
    const input = rec(a.input);
    const what = str(input['command']) || str(input['file_path']) || str(input['path']) || str(input['url']) || str(input['pattern'])
      || a.blockedPath || a.description || '';
    return pair(a.displayName ?? a.toolName, firstText(what, false));
  }
  if (s.tool) return pair(toolLabel(s.tool.name), firstText(s.tool.description ?? '', false));
  if (s.lastText) { const l = firstText(s.lastText); if (l) return out(l); }
  if (s.firstPrompt) return out(firstText(s.firstPrompt, false));
  return '';
};

/** Slash commands that run locally in the CLI (no model call): shown with the « local » badge. */
export const LOCAL_COMMANDS: ReadonlySet<string> = new Set(['clear', 'context', 'cost', 'usage', 'status', 'help', 'doctor', 'memory',
  'permissions', 'mcp', 'hooks', 'agents', 'release-notes', 'export', 'config', 'todos', 'add-dir', 'rename', 'tasks', 'files']);

/** system:init slash_commands (names) + skills/plugins, or initializationResult().commands (objects) → SlashCommandView[]. */
export function slashCommandViews(commands: unknown, o: { skills?: unknown; plugins?: unknown } = {}): P.SlashCommandView[] {
  const skills = new Set(arr(o.skills).map((s) => (typeof s === 'string' ? s : str(rec(s)['name']))));
  const out: P.SlashCommandView[] = [];
  const seen = new Set<string>();
  for (const c of arr(commands)) {
    const r = rec(c);
    const name = (typeof c === 'string' ? c : str(r['name'])).replace(/^\//, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const group: P.SlashCommandView['group'] = name.startsWith('mcp__') || name.includes('(MCP)') ? 'mcp'
      : skills.has(name) ? 'skill' : name.includes(':') ? 'plugin' : 'builtin';
    const v: P.SlashCommandView = { name, description: str(r['description']), group, local: LOCAL_COMMANDS.has(name) };
    const hint = str(r['argumentHint']);
    if (hint) v.hint = hint;
    const aliases = arr(r['aliases']).map(str).filter(Boolean);
    if (aliases.length) v.aliases = aliases;
    out.push(v);
  }
  return out;
}

/** Model family of a model id or alias (« Sonnet », « Opus », « Haiku »…), or the id itself. */
export function modelFamily(model: string | undefined): string {
  const m = (model ?? '').toLowerCase();
  for (const f of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(f)) return f[0]!.toUpperCase() + f.slice(1);
  return model ?? '';
}
/** `plan.modelBadge`: the family a block ran on when it differs from the chat's model (the `haiku` alias plans on Sonnet). */
export function planModelBadge(chatModel: string | undefined, blockModel: string | undefined): string | null {
  if (!chatModel || !blockModel || blockModel === '<synthetic>') return null;
  const a = modelFamily(chatModel), b = modelFamily(blockModel);
  return a && b && a !== b ? b : null;
}
/** The plan of an ExitPlanMode ask: always from the ask input (fresh), never from the assistant frame copy. */
export function planOfAsk(input: Record<string, unknown>): { plan?: string; planFilePath?: string } {
  const out: { plan?: string; planFilePath?: string } = {};
  if (typeof input['plan'] === 'string') out.plan = input['plan'];
  if (typeof input['planFilePath'] === 'string') out.planFilePath = input['planFilePath'];
  return out;
}
