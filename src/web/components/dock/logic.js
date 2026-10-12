// @ts-check
// src/web/components/dock/logic.js — pure logic of the pending cards (ux §6, SPEC §2.5): key map, scopes, previews,
// question answers, plan options, elicitation fields. Unit-tested in Node.
import { diffLinesDetailed, splitLines } from '../../lib/diff.js';

/** @typedef {import('../../../shared/protocol.ts').PendingAsk} PendingAsk */
/** @typedef {import('../../../shared/protocol.ts').UiAnswer} UiAnswer */
/** @typedef {import('../../../shared/protocol.ts').AskQuestion} AskQuestion */
/** @typedef {'session' | 'localSettings' | 'projectSettings'} Scope */

/** Scopes offered by « Toujours autoriser » — never userSettings (SPEC §2.5, S7). */
export const SCOPES = /** @type {readonly Scope[]} */ (Object.freeze(['session', 'localSettings', 'projectSettings']));
export const SCOPE_KEYS = Object.freeze({ session: 'perm.scope.session', localSettings: 'perm.scope.local', projectSettings: 'perm.scope.project' });

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** @param {PendingAsk} a */
export const isEditAsk = (a) => a.kind === 'permission' && EDIT_TOOLS.has(a.toolName);
/** « Modifier avant d'accepter » edits one text (Edit new_string, Write content, NotebookEdit new_source); a MultiEdit
 * has several, so it is not offered there (editedInput could not apply the change). @param {PendingAsk} a */
export const canEditBefore = (a) => isEditAsk(a) && a.toolName !== 'MultiEdit';

/**
 * Card key → action (SPEC §9.3 « Cards »). Digits on event.code, letters on event.key. Never acts while the target is
 * a text field (except Échap / Ctrl+Entrée). `1` is disabled when defaultToNo.
 * @param {{ key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey?: boolean }} e
 * @param {{ inText: boolean; defaultToNo: boolean; offerAlways: boolean; isEdit: boolean; canEdit?: boolean }} s
 * @returns {'allow' | 'always' | 'deny' | 'denyStop' | 'comment' | 'edit' | 'full' | 'scopePrev' | 'scopeNext' | null}
 */
export function permissionKey(e, s) {
  if (e.key === 'Escape') return s.inText ? null : 'denyStop';
  if (s.inText || e.ctrlKey || e.altKey || e.metaKey) return null;
  const k = e.key.toLowerCase();
  if (e.code === 'Digit1' || e.code === 'Numpad1' || k === 'o') return s.defaultToNo ? null : 'allow';
  if (e.code === 'Digit2' || e.code === 'Numpad2' || k === 't') return s.offerAlways || s.isEdit ? 'always' : null;
  if (e.code === 'Digit3' || e.code === 'Numpad3' || k === 'n') return 'deny';
  if (e.key === 'Tab' && !e.shiftKey) return 'comment';
  if (k === 'e') return (s.canEdit ?? s.isEdit) ? 'edit' : null;
  if (k === 'v') return 'full';
  if (e.key === 'ArrowLeft') return s.offerAlways ? 'scopePrev' : null;
  if (e.key === 'ArrowRight') return s.offerAlways ? 'scopeNext' : null;
  return null;
}

/** @param {Scope} cur @param {1 | -1} dir */
export function cycleScope(cur, dir) {
  const i = SCOPES.indexOf(cur);
  return /** @type {Scope} */ (SCOPES[(i + dir + SCOPES.length) % SCOPES.length]);
}

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** Monospace preview of what the tool will do (SPEC §2.5 « Card text »). @param {PendingAsk} a */
export function askSubject(a) {
  const i = a.input;
  if (a.toolName === 'Bash' || a.toolName === 'PowerShell') return { kind: 'command', text: str(i['command']) };
  if (typeof i['file_path'] === 'string') return { kind: 'path', text: /** @type {string} */ (i['file_path']) };
  if (typeof i['notebook_path'] === 'string') return { kind: 'path', text: /** @type {string} */ (i['notebook_path']) };
  if (typeof i['url'] === 'string') return { kind: 'url', text: /** @type {string} */ (i['url']) };
  if (typeof i['pattern'] === 'string') return { kind: 'pattern', text: /** @type {string} */ (i['pattern']) };
  const json = JSON.stringify(i, null, 2);
  return { kind: 'json', text: json.length > 4000 ? json.slice(0, 4000) + '\n…' : json };
}

/**
 * Before/after texts of an Edit/Write ask, for the client-side LCS preview (ux §6.3). Write diffs against the file
 * the server read (`diffBase`); a missing base means a new file.
 * @param {PendingAsk} a @returns {{ path: string; before: string; after: string; isNew: boolean; unavailable: boolean } | null}
 */
export function editTexts(a) {
  const i = a.input, path = str(i['file_path'] ?? i['notebook_path']);
  if (a.toolName === 'Edit') return { path, before: str(i['old_string']), after: str(i['new_string']), isNew: false, unavailable: false };
  if (a.toolName === 'MultiEdit' && Array.isArray(i['edits'])) {
    const ed = /** @type {{ old_string?: string; new_string?: string }[]} */ (i['edits']);
    return { path, before: ed.map((x) => x.old_string ?? '').join('\n'), after: ed.map((x) => x.new_string ?? '').join('\n'), isNew: false, unavailable: false };
  }
  if (a.toolName === 'Write') {
    const base = a.diffBase;
    if (base && 'unavailable' in base) return { path, before: '', after: str(i['content']), isNew: false, unavailable: true };
    return { path, before: base ? base.text : '', after: str(i['content']), isNew: !base, unavailable: false };
  }
  if (a.toolName === 'NotebookEdit') return { path, before: '', after: str(i['new_source']), isNew: false, unavailable: false };
  return null;
}

/** Edited input for « Modifier avant d'accepter ». @param {PendingAsk} a @param {string} text */
export function editedInput(a, text) {
  if (a.toolName === 'Edit') return { ...a.input, new_string: text };
  if (a.toolName === 'Write') return { ...a.input, content: text };
  if (a.toolName === 'NotebookEdit') return { ...a.input, new_source: text };
  return { ...a.input };
}

/** @param {string} before @param {string} after */
export function previewStats(before, after) {
  const { ops, block } = diffLinesDetailed(before, after);
  let added = 0, removed = 0;
  for (const o of ops) { if (o.op === '+') added++; else if (o.op === '-') removed++; }
  return { ops, block, added, removed, oldLines: splitLines(before).length, newLines: splitLines(after).length };
}

/** @typedef {{ selected: number[]; other: string; otherOn: boolean; note: string }} QState */
/** @param {AskQuestion[]} qs @returns {QState[]} */
export const initQuestions = (qs) => qs.map(() => ({ selected: [], other: '', otherOn: false, note: '' }));

/** @param {AskQuestion} q @param {QState} s */
export function questionAnswer(q, s) {
  const labels = s.selected.map((k) => q.options[k]?.label ?? '').filter(Boolean);
  if (s.otherOn && s.other.trim()) labels.push(s.other.trim());
  return q.multiSelect ? labels.join(', ') : (labels[labels.length - 1] ?? '');
}

/** Every question answered → the `answers` UiAnswer (keys = exact question text). @param {AskQuestion[]} qs @param {QState[]} st @returns {UiAnswer | null} */
export function buildAnswers(qs, st) {
  /** @type {Record<string, string>} */ const answers = {};
  /** @type {Record<string, string>} */ const notes = {};
  for (let k = 0; k < qs.length; k++) {
    const q = /** @type {AskQuestion} */ (qs[k]), s = /** @type {QState} */ (st[k]);
    const a = questionAnswer(q, s);
    if (!a) return null;
    answers[q.question] = a;
    if (s.note.trim()) notes[q.question] = s.note.trim();
  }
  return Object.keys(notes).length ? { kind: 'answers', answers, notes } : { kind: 'answers', answers };
}

/** Toggle / select option k (single choice replaces; « Autre » is index options.length). @param {AskQuestion} q @param {QState} s @param {number} k @returns {QState} */
export function pickOption(q, s, k) {
  if (k === q.options.length) return q.multiSelect ? { ...s, otherOn: !s.otherOn } : { ...s, selected: [], otherOn: true };
  if (k < 0 || k > q.options.length) return s;
  if (!q.multiSelect) return { ...s, selected: [k], otherOn: false };
  return { ...s, selected: s.selected.includes(k) ? s.selected.filter((x) => x !== k) : [...s.selected, k].sort((a, b) => a - b) };
}

/**
 * Plan options (ux §6.5): 1 = Auto (or « accepter les modifications » when auto is unavailable, or Contournement when
 * bypass is allowed for this chat), 2 = Manuel. Returns the nextMode and the i18n key of each.
 * @param {{ autoAvailable: boolean; bypassAllowed: boolean }} o
 * @returns {{ key: string; nextMode: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' }[]}
 */
export function planOptions(o) {
  const first = o.bypassAllowed ? { key: 'plan.yesBypass', nextMode: /** @type {const} */ ('bypassPermissions') }
    : o.autoAvailable ? { key: 'plan.yesAuto', nextMode: /** @type {const} */ ('auto') }
    : { key: 'plan.yesEdits', nextMode: /** @type {const} */ ('acceptEdits') };
  return [first, { key: 'plan.yesManual', nextMode: 'default' }];
}

/** Plan text in order of preference: ask.plan, input.plan (never the assistant frame copy). @param {PendingAsk} a */
export function planText(a) {
  if (typeof a.plan === 'string' && a.plan) return a.plan;
  const p = a.input['plan'];
  return typeof p === 'string' ? p : '';
}

/** @typedef {{ name: string; label: string; type: 'string' | 'number' | 'boolean' | 'enum'; required: boolean; options?: string[]; description?: string; integer?: boolean }} ElicitField */
/** Form fields of an elicitation JSON schema (text, number, boolean, enum). @param {Record<string, unknown> | undefined} schema @returns {ElicitField[]} */
export function elicitFields(schema) {
  const props = /** @type {Record<string, Record<string, unknown>>} */ ((schema && schema['properties']) || {});
  const req = Array.isArray(schema?.['required']) ? /** @type {string[]} */ (schema['required']) : [];
  return Object.entries(props).map(([name, p]) => {
    const en = Array.isArray(p['enum']) ? p['enum'].map(String) : undefined;
    const ty = en ? 'enum' : p['type'] === 'number' || p['type'] === 'integer' ? 'number' : p['type'] === 'boolean' ? 'boolean' : 'string';
    return { name, label: str(p['title']) || name, type: /** @type {ElicitField['type']} */ (ty), required: req.includes(name),
      ...(en ? { options: en } : {}), ...(typeof p['description'] === 'string' ? { description: p['description'] } : {}),
      ...(!en && p['type'] === 'integer' ? { integer: true } : {}) };
  });
}

/** Typed content for `elicit{accept}`; null when a required field is empty. @param {ElicitField[]} fields @param {Record<string, string | boolean>} v */
export function elicitContent(fields, v) {
  /** @type {Record<string, unknown>} */ const out = {};
  for (const f of fields) {
    const x = v[f.name];
    if (f.type === 'boolean') { out[f.name] = !!x; continue; }
    const s = typeof x === 'string' ? x.trim() : '';
    if (!s) { if (f.required) return null; continue; }
    if (f.type === 'number') { const n = Number(s.replace(',', '.')); if (!Number.isFinite(n) || (f.integer && !Number.isInteger(n))) return null; out[f.name] = n; }
    else out[f.name] = s;
  }
  return out;
}

/**
 * Known `decisionReason` texts of the CLI (claude.exe permission checks, observed on real runs) → French i18n keys. The model's
 * own `description` is never translated; an unknown reason stays as the raw text (and is always in the tooltip).
 * Exact strings first, then a few patterns for texts that embed a variable part.
 */
export const PERM_REASON_KEYS = Object.freeze(/** @type {Record<string, string>} */ ({
  'This command requires approval': 'perm.why.approval',
  'Multiple directory changes in one command require approval for clarity': 'perm.why.multiCd',
  'Glob patterns in paths cannot be statically validated — symlinks inside the glob expansion are not examined. Requires manual approval.': 'perm.why.glob',
  'Glob patterns are not allowed in write operations. Please specify an exact file path.': 'perm.why.globWrite',
  "Path contains '..' traversal after a directory segment, which may follow a symlink outside the working directory": 'perm.why.traversal',
  'This command uses the `&` background operator, which defers execution past approval-time safety checks. Approve only if you trust it.': 'perm.why.background',
  'This command creates git repository structure files (HEAD/objects/refs/hooks) and then runs git, which can execute hooks/fsmonitor from the created files.': 'perm.why.gitStructure',
  'This connector call requires your approval to proceed.': 'perm.why.connector',
  'Removal targets a protected system path': 'perm.why.protectedPath',
  'requiresUserInteraction': 'perm.why.interaction',
  'permission check failed': 'perm.why.checkFailed',
  'dangerouslyDisableSandbox': 'perm.why.noSandbox',
  // other everyday reasons of the same binary (workingDir, Bash / PowerShell path and operator checks)
  'Path is outside allowed working directories': 'perm.why.outsideDirs',
  'This command uses shell operators that require approval for safety': 'perm.why.operators',
  'This command changes directory before running a version-control command, which can pick up untrusted hooks or repository configuration from the target directory. Approve only if you trust it.': 'perm.why.cdVcs',
  'Shell expansion syntax in paths requires manual approval': 'perm.why.shellExpansion',
  'Variable expansion syntax in paths requires manual approval': 'perm.why.varExpansion',
  'Tilde expansion variants (~user, ~+, ~-) in paths require manual approval': 'perm.why.tilde',
  'Paths containing quote characters cannot be statically validated and require manual approval': 'perm.why.quotes',
  'Process substitution requires manual approval': 'perm.why.procSubst',
  'UNC network paths require manual approval': 'perm.why.unc',
  'Write target is a symbolic link': 'perm.why.symlink',
  'Compound command contains cd with write operation - manual approval required to prevent path resolution bypass': 'perm.why.cdCompound',
  'Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass': 'perm.why.cdCompound',
  'Compound command contains cd with path operation — manual approval required to prevent path resolution bypass': 'perm.why.cdCompound',
  'sed command contains operations that require explicit approval (e.g., write commands, execute commands)': 'perm.why.sed',
  'Command uses the background job operator (`&`) which spawns a child PowerShell process': 'perm.why.psBackground',
  'Path contains suspicious Windows-specific patterns (alternate data streams, short names, long path prefixes, or three or more consecutive dots) that require manual verification': 'perm.why.winPath',
}));
/** @type {readonly [RegExp, string][]} */
const PERM_REASON_PATTERNS = [
  [/^This command requires approval\b/i, 'perm.why.approval'],     // same text with a trailing period / detail
];
/** i18n key of a known CLI decision reason, or null (shown raw). @param {string | undefined | null} raw @returns {string | null} */
export function permReasonKey(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  const exact = Object.prototype.hasOwnProperty.call(PERM_REASON_KEYS, s) ? PERM_REASON_KEYS[s] : undefined;
  if (exact) return exact;
  for (const [re, key] of PERM_REASON_PATTERNS) if (re.test(s)) return key;
  return null;
}
