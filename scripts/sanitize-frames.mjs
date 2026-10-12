// scripts/sanitize-frames.mjs — recorded SDK/CLI runs → STRUCTURE-ONLY test fixtures.
//
//   node scripts/sanitize-frames.mjs --verify-out <dir> --projects <profile>\projects --cwd-root <dir> --user <name>
//                                    [--user <8.3 name>] [--deny <file>] [--out test/fixtures]
//   node scripts/sanitize-frames.mjs --check [--deny <file>] [--out test/fixtures]   (privacy scan of existing fixtures only)
//
// Every input comes from the command line; nothing is derived from the machine the script runs on.
//   --verify-out  folder of the recordings: {dry,fork,main,plan}.frames.jsonl + .raw.jsonl (SDK 0.3.293 + CLI 2.1.294)
//   --projects    the recording profile's projects folder (the CLI transcripts of those runs)
//   --cwd-root    folder that held the recording cwds (one per run); repeatable for other spellings (8.3, forward slashes)
//   --user        the recording machine's user folder name; repeatable (long name and 8.3 alias)
//   --deny        optional private deny-list (one string per line) that the final privacy scan also checks
// Outputs:
//   frames/<name>.jsonl          every SDK frame the SDK yielded, in order: {"t":ms since spawn,"label":"…","m":<frame>}
//                                (stream_event frames are restored in full from the raw wire, the rest is the SDK copy)
//   frames/wire/<name>.jsonl     both directions of the stream-json protocol (+ spawn args and exit): {"t","dir","m"|…}
//   frames/index.json            counts, session ids, labelled user messages (main: T1 T2 T3 A B C D T6)
//   pairs/<name>/frames.jsonl    = frames/<name>.jsonl
//   pairs/<name>/transcript.jsonl  the session's JSONL as the CLI wrote it (sanitized the same way, same synthetic strings)
//   pairs/<name>/inputs.jsonl    the user messages the app pushed: {"t","uuid","text","priority"?,"images"}
//   protocol/<name>.jsonl        8 golden S2C scripts (stream, permission, question, plan, queue, crash, reconnect, cap)
// Rules: every free-text string is replaced by a deterministic synthetic string of the same shape (letters → letters,
// digits → digits, whitespace and punctuation kept, so markdown and code keep their structure); the same input string
// always gives the same output, so frames, wire and transcripts stay consistent ("live = reload"). Ids, uuids, enums,
// model names, numbers, timestamps and built-in tool/command names are kept. Paths keep their shape under a synthetic
// home (C:\Users\smc-user). Hook output, prompt_snapshot, CLAUDE.md/instructions, environment and other context
// attachments become placeholders. Account identity (email, organisation) becomes example.invalid placeholders.
// The run ends with a privacy scan; it exits 1 if any forbidden string survives.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = path.resolve(arg('--out') ?? path.join(HERE, '..', 'test', 'fixtures'));
const VERIFY_OUT = arg('--verify-out');
const PROJECTS = arg('--projects');
const CHECK_ONLY = args.includes('--check');
const argAll = (name) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
const CWD_ROOTS = argAll('--cwd-root');
const USERS = argAll('--user');
const DENY = arg('--deny');
const NAMES = ['dry', 'fork', 'main', 'plan'];

// ------------------------------------------------------------------ deterministic synthetic text
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function rng(seed) {                                   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const CONS = 'bdfgklmnprstvz';
const VOWS = 'aeiou';
const memoText = new Map();
/** Same shape as s: every letter → a letter of the same case (strict consonant/vowel alternation), digit → digit. */
function synthText(s) {
  if (typeof s !== 'string' || s === '') return s;
  const hit = memoText.get(s);
  if (hit !== undefined) return hit;
  const r = rng(fnv1a('smc-fixtures\u0000' + s));
  let out = '';
  let vowelNext = false;
  for (const ch of s) {
    if (/\p{L}/u.test(ch)) {
      const c = vowelNext ? VOWS[Math.floor(r() * VOWS.length)] : CONS[Math.floor(r() * CONS.length)];
      out += ch === ch.toLowerCase() && ch !== ch.toUpperCase() ? c : (ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? c.toUpperCase() : c);
      vowelNext = !vowelNext;
    } else if (/\p{N}/u.test(ch)) {
      out += String(Math.floor(r() * 10));
      vowelNext = false;
    } else {
      out += ch;
      vowelNext = false;
    }
  }
  memoText.set(s, out);
  return out;
}
/** Opaque base64 blobs (thinking signatures): same length and padding, synthetic content. */
function synthBase64(s) {
  const r = rng(fnv1a('smc-b64\u0000' + s));
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (const ch of s) out += ch === '=' ? '=' : A[Math.floor(r() * 64)];
  return out;
}
const memoUuid = new Map();
/** Identity uuids (account / organisation) are mapped to stable synthetic v4 uuids. */
function synthUuid(u) {
  if (!memoUuid.has(u)) {
    const r = rng(fnv1a('smc-uuid\u0000' + u));
    const hex = () => '0123456789abcdef'[Math.floor(r() * 16)];
    const g = (n) => Array.from({ length: n }, hex).join('');
    memoUuid.set(u, `${g(8)}-${g(4)}-4${g(3)}-8${g(3)}-${g(12)}`);
  }
  return memoUuid.get(u);
}

// ------------------------------------------------------------------ paths
const SYNTH_HOME = 'C:\\Users\\smc-user';
const SYNTH_CWD_ROOT = SYNTH_HOME + '\\Projects\\fixtures';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The recording machine's user folder names (--user) and cwd root (--cwd-root): path, 8.3 and CLI project-key spellings.
const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const keyOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const anySep = (p) => p.split(/[\\/]+/).filter(Boolean).map(escRe).join('[\\\\/]+');
const PATH_RULES = [
  // the recording cwds (long, 8.3 and forward-slash spellings) → C:\Users\smc-user\Projects\fixtures\<name>-<date>
  ...CWD_ROOTS.map((r) => [new RegExp(`${anySep(r)}(?=[\\\\/])`, 'gi'),
    (m) => (m.includes('/') && !m.includes('\\') ? SYNTH_CWD_ROOT.replace(/\\/g, '/') : SYNTH_CWD_ROOT)]),
  // the same, as CLI project keys (C--Users-…-cwd-main-…)
  ...CWD_ROOTS.map((r) => [new RegExp(escRe(keyOf(r)), 'gi'), 'C--Users-smc-user-Projects-fixtures']),
  ...USERS.flatMap((u) => [[new RegExp(escRe(u), 'gi'), /~\d/.test(u) ? 'SMC-US~1' : 'smc-user'], [new RegExp(escRe(keyOf(u)), 'gi'), 'smc-user']]),
];
/** Account / organisation uuids seen anywhere in the inputs (pre-pass); they are replaced wherever they appear (e.g. in paths). */
const IDENTITY_UUIDS = new Set();
function mapIdentity(s) {
  let out = s;
  for (const u of IDENTITY_UUIDS) if (out.includes(u)) out = out.split(u).join(synthUuid(u));
  return out;
}
function mapPath(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const [re, rep] of PATH_RULES) out = out.replace(re, rep);
  return mapIdentity(out);
}

// ------------------------------------------------------------------ key classes
const KEEP_EXACT = new Set([
  'LIVE-TITLE', 'EXPORTED-TITLE', 'verify-main', 'verify-fork', 'verify-plan', 'verify-dry',          // test titles (golden replay: LIVE-TITLE)
  '[Request interrupted by user]', '[Request interrupted by user for tool use]',                       // CLI markers the model package detects
  'User rejected tool use', '(Bash completed with no output)',
]);
const ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:msg|toolu|req|srvtoolu)_[A-Za-z0-9]+)$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/;
const KEEP_KEYS = new Set([
  'type', 'subtype', 'role', 'stop_reason', 'stop_sequence', 'status', 'state', 'permissionMode', 'current_permission_mode', 'mode',
  'terminal_reason', 'hook_event', 'hook_name', 'hookEvent', 'hookName', 'behavior', 'destination', 'decision', 'reason_type', 'reasonType',
  'non_execution_kind', 'apiKeySource', 'output_style', 'service_tier', 'speed', 'inference_geo', 'entrypoint', 'userType', 'level',
  'rateLimitType', 'overageStatus', 'overageDisabledReason', 'task_type', 'fast_mode_state', 'fast_mode_disabled_reason', 'costBasis',
  'provider', 'apiProvider', 'media_type', 'ev', 'd', 'dir', 'operation', 'reason', 'turnOrigin', 'promptSource', 'renderedRole',
  'contextRendering', 'commandMode', 'reminderType', 'copy', 'toolDenialKind', 'claude_code_version', 'version', 'model', 'canonicalModel',
  'resolvedModel', 'advisorModel', 'value', 'effort', 'perTurnEffort', 'thinking_display', 'view_mode', 'gitBranch', 'timestamp', 'date',
  'slug', 'editability', 'platform', 'knowledgeCutoff', 'marketingName', 'modelId', 'subscriptionType', 'session_state', 'outcome',
  'priority', 'field', 'listing', 'atis', 'decision_reason_type', 'kind', 'feedback_mode', 'source', 'session_id', 'sessionId', 'uuid',
  'parentUuid', 'leafUuid', 'logicalParentUuid', 'request_id', 'requestId', 'tool_use_id', 'toolUseID', 'toolUseId', 'id', 'command_uuid',
  'user_message_uuid', 'user_message_uuids', 'hook_id', 'task_id', 'run_id', 'promptId', 'delivery_id', 'deliveryId', 'source_uuid',
  'sourceToolAssistantUUID', 'serverClassifierRequest', 'commandUuid', 'message_uuid', 'agentId', 'agent_id', 'parent_tool_use_id',
  'available_output_styles', 'capabilities', 'supportedEffortLevels', 'displayName', 'stop_details', 'thinkingDisplay', 'label_kind',
  'event', 'caller', 'copyKind', 'exit_code', 'sig', 'signal', 'code', 'surface', 'section', 'severity', 'currency',
]);
const PATH_KEYS = new Set(['cwd', 'file_path', 'filePath', 'planFilePath', 'path', 'originalCwd', 'workingDirectory', 'powershell_path',
  'messaging_socket_path', 'user_output_styles_dir', 'blockedPath', 'blocked_path', 'command_path', 'auto', 'projectDir', 'transcriptPath',
  'from', 'relocatedCwd', 'persistedOutputPath', 'outputFile', 'output_file', 'workspaceDirectories']);
const NAME_KEYS = new Set(['name', 'tool_name', 'toolName', 'display_name', 'tools', 'addedNames', 'removedNames', 'names', 'matches',
  'builtInTypes', 'addedTypes', 'agents', 'skills', 'slash_commands', 'terminal_slash_commands', 'aliases', 'needsAuthMcpServers',
  'pendingMcpServers', 'surfacedNames', 'agentType', 'subagent_type', 'commandName', 'allowedTools']);
const PII_KEYS = new Map([
  ['email', 'user@example.invalid'], ['emailAddress', 'user@example.invalid'], ['userEmail', 'user@example.invalid'],
  ['organization', 'Example Org'], ['organizationName', 'Example Org'], ['orgName', 'Example Org'], ['displayName_account', 'Example User'],
  ['fullName', 'Example User'],
]);
const IDENTITY_UUID_KEYS = new Set(['accountUuid', 'organizationUuid', 'organization_uuid', 'account_uuid', 'ownerAccountUuid', 'ownerOrganizationUuid', 'orgId']);
const KEEP_NAME_PARTS = new Set(['synced', 'builtin', 'claude-plugins-official']);
/** Attachment types whose content is context the CLI injected (hooks, prompt snapshot, CLAUDE.md, environment…): placeholders. */
const PLACEHOLDER_ATTACHMENTS = new Set(['hook_success', 'hook_additional_context', 'hook_non_blocking_error', 'hook_blocking_error',
  'hook_error_during_execution', 'prompt_snapshot', 'instructions', 'environment', 'session_context', 'skill_listing',
  'mcp_instructions_delta', 'deferred_tools_delta', 'deferred_tools_record', 'agent_listing_delta', 'credential_org',
  'remote_session_change', 'total_tokens_reminder', 'auto_mode', 'command_permissions', 'file', 'edited_text_file',
  'compact_file_reference', 'task_reminder', 'silent_turn_reminder', 'nested_memory', 'memory', 'output_style', 'ide_selection',
  'opened_file_in_ide', 'diagnostics', 'plan_file_reference', 'invoked_skills']);
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

const placeholder = (what) => `[placeholder: ${what}]`;
function mapName(s) {
  if (typeof s !== 'string' || !s) return s;
  if (s.startsWith('mcp__')) return 'mcp__' + s.slice(5).split('__').map(synthText).join('__');
  if (/^claude\.ai /.test(s)) return 'claude.ai ' + synthText(s.slice('claude.ai '.length));
  if (s.includes(':')) return s.split(':').map(synthText).join(':');
  if (s.includes('@')) return s.split('@').map((p) => (KEEP_NAME_PARTS.has(p) ? p : synthText(p))).join('@');
  return s;                                                     // built-in tools / commands / agents keep their names
}
/** Free text, with the few structural prefixes the model package relies on kept. */
function freeText(s) {
  if (KEEP_EXACT.has(s)) return s;
  const err = /^Error: ([\s\S]*)$/.exec(s);
  if (err) return 'Error: ' + freeText(err[1]);
  const img = /^\[Image: source: ([^\]]*)\]$/.exec(s);
  if (img) return `[Image: source: ${mapPath(img[1])}]`;
  return synthText(s);
}

// ------------------------------------------------------------------ the walker
function sanitizeString(s, key, ctx) {
  if (s === '') return s;
  if (IDENTITY_UUID_KEYS.has(key) || IDENTITY_UUIDS.has(s)) return synthUuid(s);
  if (ctx.placeholder) {                                        // inside injected context: keep only structure
    if (key === 'type' || ID_RE.test(s) || TIME_RE.test(s)) return s;
    if (PATH_KEYS.has(key)) return mapPath(s);
    if (NAME_KEYS.has(key)) return mapName(s);
    if (KEEP_KEYS.has(key) && s.length <= 64 && /^[\w .:/@+-]*$/.test(s)) return mapPath(s);
    return placeholder(`${ctx.placeholder}${key ? '.' + key : ''}`);
  }
  if (ctx.hook && (key === 'output' || key === 'stdout' || key === 'stderr')) return placeholder('hook output');
  if (IDENTITY_UUID_KEYS.has(key)) return synthUuid(s);
  if (PII_KEYS.has(key)) return PII_KEYS.get(key);
  if (ctx.accountLike && (key === 'displayName' || key === 'fullName')) return 'Example User';
  if (KEEP_EXACT.has(s)) return s;
  if (key === 'signature') return synthBase64(s);
  if (PATH_KEYS.has(key)) return mapPath(s);
  if (NAME_KEYS.has(key)) return mapName(s);
  if (key === 'source') return /^[a-z_]+$/i.test(s) ? s : (s.includes('@') || s.includes(':') ? mapName(s) : freeText(s));
  if (KEEP_KEYS.has(key)) return mapPath(s);
  if (ID_RE.test(s) || TIME_RE.test(s)) return s;
  return freeText(s);
}
function sanitize(v, key = '', ctx = {}) {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return sanitizeString(v, key, ctx);
  if (Array.isArray(v)) return v.map((x) => sanitize(x, key, ctx));
  if (typeof v !== 'object') return v;
  let c = ctx;
  if (key === 'attachment' && typeof v.type === 'string' && PLACEHOLDER_ATTACHMENTS.has(v.type)) c = { ...ctx, placeholder: `attachment ${v.type}` };
  if (v.type === 'system' && typeof v.subtype === 'string' && v.subtype.startsWith('hook_')) c = { ...c, hook: true };
  if (v.type === 'attachment' && v.attachment && typeof v.attachment.type === 'string' && v.attachment.type.startsWith('hook_')) c = { ...c, hook: true };
  const accountLike = typeof v.email === 'string' || typeof v.emailAddress === 'string';
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const nk = key === 'answers' || key === 'annotations' ? freeText(k) : k;
    if (k === 'data' && v.type === 'base64' && typeof x === 'string') {          // inline images: keep the tiny test PNG only
      out[nk] = x.length <= 256 && x.startsWith('iVBORw0KGgo') ? x : TINY_PNG;
      continue;
    }
    if (k === 'rendered' && v.type === 'attachment' && v.attachment && PLACEHOLDER_ATTACHMENTS.has(v.attachment.type)) {
      out[nk] = sanitize(x, k, { ...c, placeholder: `attachment ${v.attachment.type}.rendered` });
      continue;
    }
    out[nk] = sanitize(x, k, accountLike ? { ...c, accountLike: true } : (c.accountLike ? { ...c, accountLike: false } : c));
  }
  if (typeof v.name === 'string' && v.name.includes(':') && Array.isArray(v.aliases)) out.aliases = v.aliases.map((a) => (typeof a === 'string' ? synthText(a) : a));
  if (key === 'plugins' && typeof v.name === 'string') {        // installed plugins: synthetic names, consistent with their commands
    const synthName = synthText(v.name);
    out.name = synthName;
    if (typeof v.path === 'string') {
      out.path = mapPath(v.path).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => synthUuid(u))
        .split(/([\\/])/).map((seg) => (seg === v.name ? synthName : seg)).join('');
    }
  }
  return out;
}
/** Pre-pass: every value of an identity key (accountUuid, organizationUuid…) in the inputs. */
function collectIdentity(v) {
  if (Array.isArray(v)) { for (const x of v) collectIdentity(x); return; }
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (IDENTITY_UUID_KEYS.has(k) && typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x)) IDENTITY_UUIDS.add(x);
    else collectIdentity(x);
  }
}

/** Python-style JSON (", " and ": "), the shape of the CLI's input_json_delta stream. */
function pyJson(v) {
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + pyJson(x)).join(', ') + '}';
  return JSON.stringify(v);
}
/** Splits `s` into pieces with the same code-point lengths as `lengths` (the last piece takes any remainder). */
function resplit(s, lengths) {
  const cps = [...s];
  const out = [];
  let i = 0;
  lengths.forEach((n, k) => { out.push(cps.slice(i, k === lengths.length - 1 ? cps.length : i + n).join('')); i += n; });
  return out;
}
/**
 * Stream deltas are sanitized per content block: the concatenated text (or tool-input JSON) is sanitized as ONE string,
 * then cut back into pieces of the original lengths, so the deltas still add up to the final `assistant` block.
 * Returns Map<stream_event message object, replacement delta fields>.
 */
function planDeltas(msgs) {
  const blocks = new Map();
  let current = '';
  for (const m of msgs) {
    if (!m || m.type !== 'stream_event' || !m.event) continue;
    const e = m.event;
    if (e.type === 'message_start') current = `${m.parent_tool_use_id ?? ''}|${e.message?.id ?? ''}`;
    if (e.type !== 'content_block_delta' || !e.delta) continue;
    const key = `${current}|${e.index}|${e.delta.type}`;
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(m);
  }
  const repl = new Map();
  for (const [key, list] of blocks) {
    const kind = key.split('|').pop();
    const field = kind === 'text_delta' ? 'text' : kind === 'input_json_delta' ? 'partial_json' : kind === 'thinking_delta' ? 'thinking' : null;
    if (!field) continue;
    const pieces = list.map((m) => String(m.event.delta[field] ?? ''));
    const full = pieces.join('');
    let sanitized;
    if (kind === 'input_json_delta') {
      try { sanitized = full === '' ? '' : pyJson(sanitize(JSON.parse(full), 'input')); } catch { sanitized = null; }
      if (sanitized === null) { list.forEach((m, i) => repl.set(m, { [field]: freeText(pieces[i]) })); continue; }
    } else sanitized = freeText(full);
    const parts = resplit(sanitized, pieces.map((p) => [...p].length));
    list.forEach((m, i) => repl.set(m, { [field]: parts[i] }));
  }
  return repl;
}
function sanitizeFrame(m, deltas) {
  const s = sanitize(m);
  const d = deltas.get(m);
  if (d && s?.event?.delta) Object.assign(s.event.delta, d);
  return s;
}
/** Spawn record of the wire file: exe path, flags, the --settings JSON and the cwd. */
function sanitizeSpawn(r) {
  const argsOut = (r.args ?? []).map((a) => {
    if (typeof a !== 'string') return a;
    if (a.startsWith('{')) {
      try {
        const o = JSON.parse(a);
        if (Array.isArray(o.claudeMdExcludes)) o.claudeMdExcludes = o.claudeMdExcludes.map(mapPath);
        return JSON.stringify(o);
      } catch { return mapPath(a); }
    }
    if (/^--[\w-]+=/.test(a)) { const i = a.indexOf('='); return a.slice(0, i + 1) + mapPath(a.slice(i + 1)); }
    return mapPath(a);
  });
  return { ...r, command: mapPath(r.command), cwd: mapPath(r.cwd), args: argsOut };
}

// ------------------------------------------------------------------ labels
function labelOf(m) {
  if (!m || typeof m !== 'object') return 'unknown';
  if (m.type === 'stream_event') {
    const e = m.event ?? {};
    const d = e.delta?.type ?? e.content_block?.type;
    return `stream_event:${e.type ?? m.ev}${d ? `(${d})` : ''}`;
  }
  if (m.type === 'assistant') {
    const b = m.message?.content?.[0];
    return `assistant[${b?.type ?? '?'}${b?.type === 'tool_use' ? ':' + b.name : ''}]`;
  }
  if (m.type === 'user') {
    const c = m.message?.content;
    return `user[${Array.isArray(c) ? (c[0]?.type ?? '?') : 'text'}]`;
  }
  if (m.type === 'command_lifecycle') return `command_lifecycle(${m.state}:${String(m.command_uuid).slice(0, 8)})`;
  return m.subtype ? `${m.type}:${m.subtype}` : String(m.type);
}

// ------------------------------------------------------------------ one recorded run
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
const writeJsonl = (f, rows) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); };
/** The SDK yields every CLI line except the control protocol and sdk_host_only frames. */
const sdkYields = (m) => m && typeof m === 'object' && !['control_request', 'control_response', 'control_cancel_request', 'keep_alive'].includes(m.type) && !(m.type === 'system' && m.sdk_host_only === true);

function processRun(name) {
  const frames = readJsonl(path.join(VERIFY_OUT, `${name}.frames.jsonl`));
  const raw = readJsonl(path.join(VERIFY_OUT, `${name}.raw.jsonl`));
  const cli = raw.filter((r) => r.dir === 'cli>' && sdkYields(r.m)).map((r) => r.m);
  const fullStreams = cli.filter((m) => m.type === 'stream_event');
  const abbrStreams = frames.filter((f) => f.m?.type === 'stream_event');
  if (fullStreams.length !== abbrStreams.length) throw new Error(`${name}: ${abbrStreams.length} stream frames recorded vs ${fullStreams.length} on the wire`);
  abbrStreams.forEach((f, i) => {
    if (f.m.ev !== fullStreams[i].event?.type) throw new Error(`${name}: stream frame ${i} is ${f.m.ev} vs wire ${fullStreams[i].event?.type}`);
  });
  // restored SDK frame list: the SDK's own copy, except stream events, restored in full from the wire (same order)
  let si = 0;
  const restored = frames.map((f) => ({ t: f.t, m: f.m?.type === 'stream_event' ? fullStreams[si++] : f.m }));
  const deltas = planDeltas(raw.map((r) => r.m));                // the wire holds every stream event, in order
  const framesOut = restored.map((r) => { const m = sanitizeFrame(r.m, deltas); return { t: r.t, label: labelOf(m), m }; });
  const wireOut = raw.map((r) => {
    if (r.dir === 'spawn') return sanitizeSpawn(r);
    if (r.dir === 'exit') return r;
    return { t: r.t, dir: r.dir, m: sanitizeFrame(r.m, deltas) };
  });
  const inputs = raw.filter((r) => r.dir === '>cli' && r.m?.type === 'user').map((r) => {
    const c = r.m.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
    const images = Array.isArray(c) ? c.filter((b) => b.type === 'image').length : 0;
    return { t: r.t, uuid: r.m.uuid, text: freeText(text), ...(r.m.priority ? { priority: r.m.priority } : {}), images };
  });
  const sessionIds = [...new Set(framesOut.map((f) => f.m?.session_id).filter((s) => typeof s === 'string' && s))];
  return { name, framesOut, wireOut, inputs, sessionIds, raw, frames };
}

function findTranscript(sessionId) {
  if (!PROJECTS) return null;
  for (const d of fs.readdirSync(PROJECTS)) {
    if (!CWD_ROOTS.some((r) => d.toLowerCase().startsWith(keyOf(r).toLowerCase() + '-'))) continue;
    const f = path.join(PROJECTS, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Labels of the pushed user messages, from the verify summary (<name>.json phases): main → T1 T2 T3 A B C D T6. */
function inputLabels(name, inputs) {
  const map = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(VERIFY_OUT, `${name}.json`), 'utf8'));
    for (const [k, v] of Object.entries(j.phases ?? {})) {
      if (v && typeof v.uuid === 'string') map.set(v.uuid, k);
      if (v && v.uuids && typeof v.uuids === 'object') for (const [lk, u] of Object.entries(v.uuids)) map.set(u, lk);
    }
  } catch { /* no summary */ }
  return inputs.map((m, i) => ({ label: map.get(m.uuid) ?? `${name}#${i + 1}`, uuid: m.uuid, ...(m.priority ? { priority: m.priority } : {}), images: m.images }));
}
/** Facts the golden replays assert, derived here from the frames (delivery per message, mode trail, last title). */
function deriveFacts(framesOut, inputs) {
  const delivery = {};
  for (const m of inputs) delivery[m.uuid] = 'pending';
  const modes = [];
  let title = null;
  for (const { m } of framesOut) {
    if (m.type === 'command_lifecycle' && m.command_uuid in delivery && delivery[m.command_uuid] !== 'folded') delivery[m.command_uuid] = m.state;
    if (m.type === 'result') for (const u of m.user_message_uuids ?? []) if (u !== m.user_message_uuid && u in delivery) delivery[u] = 'folded';
    const mode = m.type === 'system' && m.subtype === 'init' ? m.permissionMode : (m.type === 'system' && m.subtype === 'status' && m.status === null ? m.permissionMode : undefined);
    if (typeof mode === 'string' && modes[modes.length - 1] !== mode) modes.push(mode);
    if (m.type === 'system' && m.subtype === 'session_title_changed') title = m.title;
  }
  const models = [...new Set(framesOut.filter((f) => f.m.type === 'assistant').map((f) => f.m.message?.model))];
  return { delivery, modeTrail: modes, title, assistantModels: models };
}

// ------------------------------------------------------------------ golden protocol scripts (S2C, SPEC §4 / §6)
const FORMAT = 'JSONL, one step per line. step=meta (this line) | connect (wait for a client WebSocket) | send (push `frame`, '
  + 'a JSON array of S2C, after `delayMs`) | expect (wait for a C2S matching `match` (subset), reply with one frame: '
  + 'an ack built from `ack` with the request id, then `then`; `as` names the request) | drop (close the socket abruptly). '
  + 'In strings, `$req.<field>` and `$<as>.<field>` are replaced by fields of the latest / named request.';
const T0 = Date.UTC(2026, 9, 8, 10, 0, 0);
const ACC_PERSO = { id: 'perso', name: 'Perso', color: 1, monogram: 'P', configDir: null, isDefault: true, hidden: false, login: 'connected',
  identity: { email: 'perso@example.invalid', displayName: 'Utilisateur Test', org: 'Org Perso', plan: 'Max 5x', accountUuid: '5e1f0a3c-7b2d-4e8f-9a01-23456789abcd' },
  usage: { source: 'snapshot', at: T0 - 600_000, stale: false, rows: [
    { key: 'five_hour', label: 'Session (5 h)', pct: 18, resetsAt: T0 + 3 * 3_600_000, severity: 'normal', headline: true },
    { key: 'seven_day', label: 'Semaine', pct: 41, resetsAt: T0 + 4 * 86_400_000, severity: 'normal', headline: false }] },
  defaults: {}, diag: { leakFiles: [], leakExcluded: false, resumeStable: null, cleanupDays: 30, expiringSoon: 0, cliVersion: '2.1.294' } };
const ACC_TRAVAIL = { id: 'travail', name: 'Travail', color: 2, monogram: 'T', configDir: 'C:\\Users\\smc-user\\.claude-pro', isDefault: false, hidden: false,
  login: 'connected', identity: { email: 'travail@example.invalid', displayName: 'Utilisateur Test', org: 'Org Travail', plan: 'Team', role: 'membre', accountUuid: '6f2a1b4d-8c3e-4f90-8b12-3456789abcde' },
  usage: { source: 'event', at: T0 - 60_000, stale: false, status: 'allowed', rows: [{ key: 'five_hour', label: 'Session (5 h)', pct: 63, resetsAt: T0 + 2 * 3_600_000, severity: 'warning', headline: true }] },
  defaults: { mode: 'default' }, diag: { leakFiles: ['C:\\Users\\smc-user\\.claude\\CLAUDE.md'], leakExcluded: true, resumeStable: false, cleanupDays: 30, expiringSoon: 1, cliVersion: '2.1.294', mcp: { ok: 2, auth: 9 } } };
const SETTINGS = { port: 41731, browser: 'edge', exe: 'installed', isolation: 'job', maxLive: 4, reapMin: 60, prespawn: true, allowBypass: false, aiTitles: false,
  notifications: true, sound: false, volume: 0.6, onlyWhenAway: true, dndUntil: null, reopenWindowOnAttention: true, ctrlEnterSends: false,
  shiftTabModes: false, showOtherOrigins: true, wakeNeverAsk: false, theme: 'system', density: 'compact', defaultView: 'normal' };
const CWD = 'C:\\Users\\smc-user\\Projects\\demo-app';
const CHAT = {
  main: 'travail:4adf4c63-b504-4be1-804b-92a88963e275',
  plan: 'travail:3f23c3e1-f254-421b-bfe5-9d26da76dc57',
  fork: 'travail:aa719553-107b-4579-ac44-e53f12efc6e1',
  perso1: 'perso:0b5f6a2c-9d7e-4c1a-8f3b-2e4d6c8a0b1c',
  perso2: 'perso:1c6a7b3d-0e8f-4d2b-9a4c-3f5e7d9b1c2d',
  perso3: 'perso:2d7b8c4e-1f90-4e3c-8b5d-4a6f8e0c2d3e',
  perso4: 'perso:3e8c9d5f-2a01-4f4d-9c6e-5b7a9f1d3e4f',
};
const sidOf = (c) => c.slice(c.indexOf(':') + 1);
const accOf = (c) => c.slice(0, c.indexOf(':'));
const stateView = (phase, x = {}) => ({ phase, since: x.since ?? T0, ...(x.sub ? { sub: x.sub } : {}), ...(x.subTool ? { subTool: x.subTool } : {}),
  flags: { live: x.live ?? phase !== 'cold', unread: x.unread ?? false, bgTasks: x.bgTasks ?? 0, queued: x.queued ?? 0, external: null, stuck: false, notStarted: x.notStarted ?? false },
  pending: x.pending ?? { count: 0 }, ...(x.error ? { error: x.error } : {}), ...(x.limit ? { limit: x.limit } : {}) });
const summary = (chatId, title, phase, x = {}) => ({ chatId, accountId: accOf(chatId), sessionId: sidOf(chatId), title, titleSource: x.titleSource ?? 'custom',
  cwd: x.cwd ?? CWD, branch: 'main', origin: 'app', firstPrompt: x.firstPrompt ?? title, createdAt: T0 - 86_400_000, updatedAt: x.updatedAt ?? T0 - 120_000,
  size: x.size ?? 284_131, model: x.model ?? 'claude-haiku-5-5', mode: x.mode ?? 'default', pinned: x.pinned ?? false, archived: false, muted: false,
  keepAlive: false, state: x.state ?? stateView(phase, x), activity: x.activity ?? 'Prêt', ...(x.wake ? { wake: x.wake } : {}),
  expiresInDays: null, foreignOwner: false, costUsd: x.costUsd ?? 0.0095 });
const metaView = (title, x = {}) => ({ title, cwd: x.cwd ?? CWD, branch: 'main', mode: x.mode ?? 'default', model: x.model ?? 'claude-haiku-5-5',
  cliVersion: '2.1.294', tools: 32, mcp: [{ name: 'claude.ai Docs', status: 'connected' }],
  commands: [{ name: 'compact', description: 'Compacter la conversation', group: 'builtin', local: false }, { name: 'context', description: 'Contexte utilisé', group: 'builtin', local: true }],
  capabilities: x.capabilities ?? ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'] });
const metrics = (x = {}) => ({ contextTokens: x.ctx ?? 37_152, contextWindow: 1_000_000, autoCompactAt: 967_000, lastRequestAt: x.at ?? T0 - 120_000,
  cacheTtlMs: 3_600_000, cacheWarmUntil: (x.at ?? T0 - 120_000) + 3_600_000, costUsd: x.cost ?? 0.0095 });
const procs = (live, items) => ({ live, max: 4, effectiveMax: 4, lowMem: false, estRamMB: live * 450, isolation: 'job', items });
const procItem = (chatId, phase, x = {}) => ({ chatId, pid: x.pid ?? 4100, phase, since: T0, lastRequestAt: x.at ?? T0 - 120_000, warmUntil: (x.at ?? T0 - 120_000) + 3_600_000, neverRequested: false, protected: x.protected ?? true });
const uiState = (chats) => ({ layout: 1, tabs: chats, closed: [], panes: [chats[0] ?? null], focusedPane: 0,
  sidebar: { width: 280, collapsed: false, grouping: 'account', showArchived: false }, scroll: {}, views: {} });
const footer = (x = {}) => ({ durationMs: x.ms ?? 2_300, input: 2, cacheRead: x.read ?? 37_152, cacheWrite: x.write ?? 81, output: x.out ?? 64, costUsd: x.cost ?? 0.0021,
  auxTokens: 0, models: x.models ?? ['claude-haiku-5-5'], ...(x.interrupted ? { interrupted: true } : {}), ...(x.terminal ? { terminal: x.terminal } : {}) });

function scriptBuilder(name, description) {
  const steps = [{ step: 'meta', v: 1, name, description, format: FORMAT }];
  let seq = new Map();
  const b = {
    steps,
    connect() { steps.push({ step: 'connect' }); return b; },
    send(frame, delayMs = 0) { steps.push({ step: 'send', delayMs, frame }); return b; },
    expect(match, ack, then = [], as) { steps.push({ step: 'expect', match, ...(as ? { as } : {}), ack, then }); return b; },
    drop() { steps.push({ step: 'drop' }); return b; },
    newServer() { seq = new Map(); return b; },
    snap(chatId, s) { if (!seq.has(chatId)) seq.set(chatId, 0); return { t: 'snap', snap: { chatId, seq: seq.get(chatId), ...s } }; },
    ev(chatId, ev) { const n = (seq.get(chatId) ?? 0) + 1; seq.set(chatId, n); return { t: 'ev', c: chatId, s: n, ev }; },
  };
  return b;
}
const hello = (boot, chats, x = {}) => ({ t: 'hello', v: 1, boot, now: x.now ?? T0, settings: SETTINGS, accounts: [ACC_PERSO, ACC_TRAVAIL], chats,
  asks: x.asks ?? [], ui: uiState(x.tabs ?? chats.map((c) => c.chatId).slice(0, 2)), drafts: {}, procs: x.procs ?? procs(0, []) });
const coldSnap = (b, chatId, title, x = {}) => b.snap(chatId, { state: stateView(x.phase ?? 'cold', x), meta: metaView(title, x), metrics: metrics(x),
  queue: [], tasks: [], todos: null, live: x.liveTurn ?? null, lastDiskTurnId: x.lastDiskTurnId ?? 'u:ca4b0112-e963-461f-b8ff-bd24341c4719' });
const BOOT1 = 'mgxk3a1c-Tq7vZ2pLwA';
const BOOT2 = 'mgxk9f0e-Hn4cR8sJxB';
const userMsg = (who, text, delivery = 'started', origin = 'human') => ({ uuid: `$${who}.uuid`, text, origin, delivery });
const textBlock = (msgId, i, md, live = false) => ({ k: 'text', id: `a:${msgId}:${i}`, md, model: 'claude-haiku-5-5', ...(live ? { live: true } : {}) });
const deltas = (b, chatId, id, text, n = 4) => {
  const step = Math.ceil(text.length / n);
  const out = [];
  for (let i = 0; i < text.length; i += step) out.push(b.ev(chatId, { k: 'delta', parts: [[id, text.slice(i, i + step)]] }));
  return out;
};

function streamScript() {
  const b = scriptBuilder('stream', 'Envoi dans un chat actif au repos : file, tour, réflexion, texte en streaming (deltas coalescés), pied de tour, retour au repos.');
  const c = CHAT.main;
  const title = 'Corriger le test du parseur';
  b.connect().send([hello(BOOT1, [summary(c, title, 'idle', { live: true }), summary(CHAT.perso1, 'Notes de réunion', 'cold', { live: false, model: 'claude-opus-5-5' })],
    { procs: procs(1, [procItem(c, 'idle')]) })]);
  b.expect({ t: 'view' }, { ok: true }, [coldSnap(b, c, title, { phase: 'idle', live: true })]);
  const text = 'Le test échoue parce que `parseDate` attend un fuseau.\n\n```ts\nparseDate(\'2026-10-08\', { tz: \'Europe/Paris\' });\n```\n\nJe corrige l\'appel et je relance les tests.';
  const msgId = 'msg_01StreamDemo0000000000001';
  b.expect({ t: 'chat.send', chatId: c }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'queue', items: [{ uuid: '$A.uuid', text: '$A.text', images: 0, delivery: 'queued' }] }),
  ], 'A');
  b.send([b.ev(c, { k: 'state', state: stateView('running', { sub: 'requesting', since: T0 + 1_000, queued: 0 }) }),
    { t: 'chats', upsert: [summary(c, title, 'running', { sub: 'requesting', activity: 'Requête…', since: T0 + 1_000 })], remove: [] },
    b.ev(c, { k: 'turn.start', turn: { id: 'u:$A.uuid', at: T0 + 1_000, user: userMsg('A', '$A.text') } }),
    b.ev(c, { k: 'queue', items: [] })], 20);
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { k: 'thinking', id: `a:${msgId}:0`, chars: 0, live: true } })], 400);
  b.send([b.ev(c, { k: 'progress', blockId: `a:${msgId}:0`, chars: 512, tokens: 128 })], 300);
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { k: 'thinking', id: `a:${msgId}:0`, chars: 812, tokens: 203 } }),
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'writing', since: T0 + 1_000 }) }),
    b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: textBlock(msgId, 1, '', true) })], 200);
  for (const d of deltas(b, c, `a:${msgId}:1`, text, 6)) b.send([d], 50);
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: textBlock(msgId, 1, text) }),
    b.ev(c, { k: 'turn.end', turnId: 'u:$A.uuid', footer: footer({ ms: 2_960 }) }),
    b.ev(c, { k: 'metrics', metrics: metrics({ at: T0 + 1_000, cost: 0.0116, ctx: 37_297 }) }),
    b.ev(c, { k: 'state', state: stateView('idle', { since: T0 + 3_960 }) }),
    { t: 'chats', upsert: [summary(c, title, 'idle', { since: T0 + 3_960, activity: 'Je corrige l\'appel et je relance les tests.', updatedAt: T0 + 3_960, costUsd: 0.0116 })], remove: [] }], 60);
  return b.steps;
}

function permissionScript() {
  const b = scriptBuilder('permission', 'Demande d\'autorisation Bash : carte dans toutes les fenêtres (ask avant le passage en needs_permission), réponse, askEnd, résultat d\'outil, fin du tour.');
  const c = CHAT.main;
  const title = 'Installer les dépendances';
  const toolId = 'toolu_01PermDemo00000000000001';
  const msgId = 'msg_01PermDemo000000000000001';
  b.connect().send([hello(BOOT1, [summary(c, title, 'idle', { live: true })], { procs: procs(1, [procItem(c, 'idle')]) })]);
  b.expect({ t: 'view' }, { ok: true }, [coldSnap(b, c, title, { phase: 'idle', live: true })]);
  b.expect({ t: 'chat.send', chatId: c }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'requesting' }) }),
    b.ev(c, { k: 'turn.start', turn: { id: 'u:$A.uuid', at: T0 + 1_000, user: userMsg('A', '$A.text') } })], 'A');
  const input = { summary: 'npm ci', fields: { command: 'npm ci', description: 'Installer les dépendances' } };
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { k: 'tool', id: `t:${toolId}`, toolUseId: toolId, name: 'Bash', input, status: 'running', model: 'claude-haiku-5-5' } })], 600);
  const ask = { chatId: c, requestId: 'b7d1c2e3-0f4a-4b5c-8d6e-7f8091a2b3c4', toolUseId: toolId, kind: 'permission', toolName: 'Bash', displayName: 'Bash',
    description: 'Installer les dépendances', decisionReason: 'This command requires approval', input: { command: 'npm ci', description: 'Installer les dépendances' },
    offerAlways: true, alwaysRules: ['Bash(npm ci)'], offerAuto: false, defaultToNo: false, since: T0 + 1_700 };
  b.send([{ t: 'ask', ask },
    b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { k: 'tool', id: `t:${toolId}`, toolUseId: toolId, name: 'Bash', input, status: 'asking', askId: ask.requestId, model: 'claude-haiku-5-5' } }),
    b.ev(c, { k: 'state', state: stateView('needs_permission', { since: T0 + 1_700, pending: { count: 1, oldestAt: T0 + 1_700, kind: 'permission' } }) }),
    { t: 'chats', upsert: [summary(c, title, 'needs_permission', { since: T0 + 1_700, pending: { count: 1, oldestAt: T0 + 1_700, kind: 'permission' }, activity: 'Autorisation requise · Bash : npm ci' })], remove: [] }], 50);
  b.expect({ t: 'chat.decide', chatId: c, requestId: ask.requestId }, { ok: true }, [
    { t: 'askEnd', chatId: c, requestId: ask.requestId, reason: 'answered' },
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'tool', subTool: 'Bash', since: T0 + 2_500 }) }),
    { t: 'chats', upsert: [summary(c, title, 'running', { sub: 'tool', subTool: 'Bash', since: T0 + 2_500, activity: 'Exécute : Installer les dépendances…' })], remove: [] }]);
  b.send([b.ev(c, { k: 'tool.result', turnId: 'u:$A.uuid', toolUseId: toolId, status: 'ok', result: { isError: false, summary: '312 paquets installés', head: 'added 312 packages in 9s', totalLines: 1 } })], 900);
  const text = 'Les dépendances sont installées (312 paquets).';
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: textBlock(msgId, 0, text) }),
    b.ev(c, { k: 'turn.end', turnId: 'u:$A.uuid', footer: footer({ ms: 11_400 }) }),
    b.ev(c, { k: 'state', state: stateView('idle', { since: T0 + 12_400 }) }),
    { t: 'chats', upsert: [summary(c, title, 'idle', { since: T0 + 12_400, activity: text })], remove: [] }], 300);
  return b.steps;
}

function questionScript() {
  const b = scriptBuilder('question', 'AskUserQuestion : formulaire (requiresUserInteraction), réponse libre « Autre », askEnd, résultat structuré.');
  const c = CHAT.perso1;
  const title = 'Choisir une palette';
  const toolId = 'toolu_01QuestDemo0000000000001';
  b.connect().send([hello(BOOT1, [summary(c, title, 'idle', { live: true, model: 'claude-opus-5-5' })], { procs: procs(1, [procItem(c, 'idle')]) })]);
  b.expect({ t: 'view' }, { ok: true }, [coldSnap(b, c, title, { phase: 'idle', live: true, model: 'claude-opus-5-5' })]);
  b.expect({ t: 'chat.send', chatId: c }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'requesting' }) }),
    b.ev(c, { k: 'turn.start', turn: { id: 'u:$A.uuid', at: T0 + 1_000, user: userMsg('A', '$A.text') } })], 'A');
  const questions = [{ question: 'Quelle couleur préférez-vous pour le thème ?', header: 'Couleur', multiSelect: false,
    options: [{ label: 'Rouge', description: 'Accent chaud' }, { label: 'Bleu', description: 'Accent froid' }] },
  { question: 'Quels écrans faut-il adapter ?', header: 'Écrans', multiSelect: true,
    options: [{ label: 'Accueil', description: 'Page principale' }, { label: 'Réglages', description: 'Panneau des réglages' }, { label: 'Aide', description: 'Page d\'aide' }] }];
  const input = { summary: '2 questions', fields: { questions: 2 } };
  const ask = { chatId: c, requestId: 'c8e2d3f4-1a5b-4c6d-9e7f-8091a2b3c4d5', toolUseId: toolId, kind: 'question', toolName: 'AskUserQuestion', displayName: 'AskUserQuestion',
    input: { questions }, offerAlways: false, alwaysRules: [], offerAuto: false, defaultToNo: false, questions, since: T0 + 1_800 };
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { k: 'tool', id: `t:${toolId}`, toolUseId: toolId, name: 'AskUserQuestion', input, status: 'asking', askId: ask.requestId } }),
    { t: 'ask', ask },
    b.ev(c, { k: 'state', state: stateView('needs_answer', { since: T0 + 1_800, pending: { count: 1, oldestAt: T0 + 1_800, kind: 'question' } }) }),
    { t: 'chats', upsert: [summary(c, title, 'needs_answer', { since: T0 + 1_800, pending: { count: 1, oldestAt: T0 + 1_800, kind: 'question' }, activity: 'Question en attente', model: 'claude-opus-5-5' })], remove: [] }], 800);
  b.expect({ t: 'chat.decide', chatId: c, requestId: ask.requestId }, { ok: true }, [
    { t: 'askEnd', chatId: c, requestId: ask.requestId, reason: 'answered' },
    b.ev(c, { k: 'tool.result', turnId: 'u:$A.uuid', toolUseId: toolId, status: 'ok', result: { isError: false, summary: 'Couleur → Vert sapin · Écrans → Accueil, Aide', data: { answered: 2 } } }),
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'requesting', since: T0 + 5_000 }) })]);
  const text = 'Parfait : vert sapin pour l\'accent, appliqué à l\'accueil et à l\'aide.';
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { ...textBlock('msg_01QuestDemo00000000000002', 0, text), model: 'claude-opus-5-5' } }),
    b.ev(c, { k: 'turn.end', turnId: 'u:$A.uuid', footer: footer({ ms: 6_200, models: ['claude-opus-5-5'], cost: 0.0412 }) }),
    b.ev(c, { k: 'state', state: stateView('idle', { since: T0 + 7_200 }) }),
    { t: 'chats', upsert: [summary(c, title, 'idle', { since: T0 + 7_200, activity: text, model: 'claude-opus-5-5' })], remove: [] }], 700);
  return b.steps;
}

function planScript() {
  const b = scriptBuilder('plan', 'Mode Plan avec l\'alias haiku : les requêtes de planification tournent sur Sonnet (badge plan.modelBadge), carte de plan depuis ask.plan, approbation avec passage en mode Manuel.');
  const c = CHAT.plan;
  const title = 'Plan : fichier plan.txt';
  const toolId = 'toolu_01PlanDemo000000000000001';
  const plan = '- Écrire `plan.txt` dans le dossier courant avec le contenu `plan ok`.\n- Relire le fichier pour vérifier.\n- Vérifier le contenu avec `cat`.\n';
  b.connect().send([hello(BOOT1, [summary(c, title, 'idle', { live: true, mode: 'plan' })], { procs: procs(1, [procItem(c, 'idle')]) })]);
  b.expect({ t: 'view' }, { ok: true }, [coldSnap(b, c, title, { phase: 'idle', live: true, mode: 'plan' })]);
  b.expect({ t: 'chat.send', chatId: c }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'requesting' }) }),
    b.ev(c, { k: 'turn.start', turn: { id: 'u:$A.uuid', at: T0 + 1_000, user: userMsg('A', '$A.text') } })], 'A');
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { k: 'text', id: 'a:msg_01PlanDemo00000000000000a:0', md: 'Je prépare le plan.', model: 'claude-sonnet-5-5' } }),
    b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { k: 'tool', id: `t:${toolId}`, toolUseId: toolId, name: 'ExitPlanMode', input: { summary: 'Plan proposé', fields: {} }, status: 'asking', askId: 'd9f3e4a5-2b6c-4d7e-8f90-91a2b3c4d5e6', model: 'claude-sonnet-5-5' } })], 900);
  const ask = { chatId: c, requestId: 'd9f3e4a5-2b6c-4d7e-8f90-91a2b3c4d5e6', toolUseId: toolId, kind: 'plan', toolName: 'ExitPlanMode', displayName: 'ExitPlanMode',
    input: { plan, planFilePath: `${CWD}\\.plans\\plan-fichier-plan.md` }, offerAlways: false, alwaysRules: [], offerAuto: false, defaultToNo: false,
    plan, planFilePath: `${CWD}\\.plans\\plan-fichier-plan.md`, since: T0 + 2_000 };
  b.send([{ t: 'ask', ask },
    b.ev(c, { k: 'state', state: stateView('needs_plan', { since: T0 + 2_000, pending: { count: 1, oldestAt: T0 + 2_000, kind: 'plan' } }) }),
    { t: 'chats', upsert: [summary(c, title, 'needs_plan', { since: T0 + 2_000, mode: 'plan', pending: { count: 1, oldestAt: T0 + 2_000, kind: 'plan' }, activity: 'Plan à valider' })], remove: [] }]);
  b.expect({ t: 'chat.decide', chatId: c, requestId: ask.requestId }, { ok: true }, [
    { t: 'askEnd', chatId: c, requestId: ask.requestId, reason: 'answered' },
    b.ev(c, { k: 'meta', meta: { mode: 'default' } }),
    b.ev(c, { k: 'system', turnId: 'u:$A.uuid', id: 'x:app:1', row: { kind: 'modeChange', text: 'Mode : Manuel', data: { from: 'plan', to: 'default' } } }),
    b.ev(c, { k: 'tool.result', turnId: 'u:$A.uuid', toolUseId: toolId, status: 'ok', result: { isError: false, summary: 'Plan approuvé' } }),
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'requesting', since: T0 + 4_000 }) })]);
  const text = 'Fichier `plan.txt` créé et vérifié : il contient `plan ok`.';
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: textBlock('msg_01PlanDemo00000000000000b', 0, text) }),
    b.ev(c, { k: 'turn.end', turnId: 'u:$A.uuid', footer: footer({ ms: 9_800, models: ['claude-sonnet-5-5', 'claude-haiku-5-5'], cost: 0.1304, write: 24_306 }) }),
    b.ev(c, { k: 'state', state: stateView('idle', { since: T0 + 10_800 }) }),
    { t: 'chats', upsert: [summary(c, title, 'idle', { since: T0 + 10_800, activity: text, mode: 'default', costUsd: 0.1304 })], remove: [] }], 1_200);
  return b.steps;
}

function queueScript() {
  const b = scriptBuilder('queue', 'File pendant un tour : B sans priorité (repli dans le tour), C et D « après ce tour », D retiré (cancelQueued), puis tour de C.');
  const c = CHAT.main;
  const title = 'File d\'attente';
  const toolId = 'toolu_01QueueDemo0000000000001';
  b.connect().send([hello(BOOT1, [summary(c, title, 'idle', { live: true })], { procs: procs(1, [procItem(c, 'idle')]) })]);
  b.expect({ t: 'view' }, { ok: true }, [coldSnap(b, c, title, { phase: 'idle', live: true })]);
  b.expect({ t: 'chat.send', chatId: c }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'tool', subTool: 'Bash' }) }),
    b.ev(c, { k: 'turn.start', turn: { id: 'u:$A.uuid', at: T0 + 1_000, user: userMsg('A', '$A.text') } }),
    b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { k: 'tool', id: `t:${toolId}`, toolUseId: toolId, name: 'Bash', input: { summary: 'sleep 6', fields: { command: 'sleep 6', description: 'Attendre 6 secondes' } }, status: 'running' } })], 'A');
  b.expect({ t: 'chat.send', chatId: c }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'queue', items: [{ uuid: '$B.uuid', text: '$B.text', images: 0, delivery: 'queued' }] }),
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'tool', subTool: 'Bash', queued: 1 }) })], 'B');
  b.expect({ t: 'chat.send', chatId: c, priority: 'later' }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'queue', items: [{ uuid: '$B.uuid', text: '$B.text', images: 0, delivery: 'queued' }, { uuid: '$C.uuid', text: '$C.text', images: 0, priority: 'later', delivery: 'queued' }] })], 'C');
  b.expect({ t: 'chat.send', chatId: c, priority: 'later' }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'queue', items: [{ uuid: '$B.uuid', text: '$B.text', images: 0, delivery: 'queued' }, { uuid: '$C.uuid', text: '$C.text', images: 0, priority: 'later', delivery: 'queued' },
      { uuid: '$D.uuid', text: '$D.text', images: 0, priority: 'later', delivery: 'queued' }] })], 'D');
  b.expect({ t: 'chat.cancelQueued', chatId: c, uuid: '$D.uuid' }, { ok: true, data: { cancelled: true } }, [
    b.ev(c, { k: 'queue', items: [{ uuid: '$B.uuid', text: '$B.text', images: 0, delivery: 'queued' }, { uuid: '$C.uuid', text: '$C.text', images: 0, priority: 'later', delivery: 'queued' }] })]);
  b.send([b.ev(c, { k: 'tool.result', turnId: 'u:$A.uuid', toolUseId: toolId, status: 'ok', result: { isError: false, summary: 'Terminé sans sortie' } }),
    b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { k: 'user', id: 'u:$B.uuid', msg: userMsg('B', '$B.text', 'folded') } }),
    b.ev(c, { k: 'queue', items: [{ uuid: '$C.uuid', text: '$C.text', images: 0, priority: 'later', delivery: 'queued' }] })], 1_500);
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: textBlock('msg_01QueueDemo00000000000001', 0, 'TERMINÉ-A, avec la précision demandée.') }),
    b.ev(c, { k: 'turn.end', turnId: 'u:$A.uuid', footer: footer({ ms: 8_100 }) }),
    b.ev(c, { k: 'turn.start', turn: { id: 'u:$C.uuid', at: T0 + 9_200, user: userMsg('C', '$C.text') } }),
    b.ev(c, { k: 'queue', items: [] })], 600);
  b.send([b.ev(c, { k: 'block', turnId: 'u:$C.uuid', block: textBlock('msg_01QueueDemo00000000000002', 0, 'C-APRÈS') }),
    b.ev(c, { k: 'turn.end', turnId: 'u:$C.uuid', footer: footer({ ms: 950 }) }),
    b.ev(c, { k: 'state', state: stateView('idle', { since: T0 + 10_200 }) }),
    { t: 'chats', upsert: [summary(c, title, 'idle', { since: T0 + 10_200, activity: 'C-APRÈS' })], remove: [] }], 900);
  return b.steps;
}

function crashScript() {
  const b = scriptBuilder('crash', 'Arrêt inattendu de claude.exe avec une demande en attente et un message en file : askEnd crash, ligne sys.crash, message rendu (« Non envoyé · Renvoyer »), état error.');
  const c = CHAT.main;
  const title = 'Migration de la base';
  const toolId = 'toolu_01CrashDemo0000000000001';
  b.connect().send([hello(BOOT1, [summary(c, title, 'idle', { live: true })], { procs: procs(1, [procItem(c, 'idle', { pid: 4242 })]) })]);
  b.expect({ t: 'view' }, { ok: true }, [coldSnap(b, c, title, { phase: 'idle', live: true })]);
  b.expect({ t: 'chat.send', chatId: c }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'requesting' }) }),
    b.ev(c, { k: 'turn.start', turn: { id: 'u:$A.uuid', at: T0 + 1_000, user: userMsg('A', '$A.text') } }),
    b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: { k: 'tool', id: `t:${toolId}`, toolUseId: toolId, name: 'Bash', input: { summary: 'npm run migrate', fields: { command: 'npm run migrate', description: 'Migrer la base' } }, status: 'asking', askId: 'e0a4f5b6-3c7d-4e8f-9a01-a2b3c4d5e6f7' } }),
    { t: 'ask', ask: { chatId: c, requestId: 'e0a4f5b6-3c7d-4e8f-9a01-a2b3c4d5e6f7', toolUseId: toolId, kind: 'permission', toolName: 'Bash', displayName: 'Bash', description: 'Migrer la base',
      input: { command: 'npm run migrate', description: 'Migrer la base' }, offerAlways: true, alwaysRules: ['Bash(npm run migrate)'], offerAuto: false, defaultToNo: false, since: T0 + 1_500 } },
    b.ev(c, { k: 'state', state: stateView('needs_permission', { since: T0 + 1_500, pending: { count: 1, oldestAt: T0 + 1_500, kind: 'permission' } }) })], 'A');
  b.expect({ t: 'chat.send', chatId: c }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'queue', items: [{ uuid: '$B.uuid', text: '$B.text', images: 0, delivery: 'queued' }] })], 'B');
  b.send([{ t: 'askEnd', chatId: c, requestId: 'e0a4f5b6-3c7d-4e8f-9a01-a2b3c4d5e6f7', reason: 'crash' },
    b.ev(c, { k: 'tool.result', turnId: 'u:$A.uuid', toolUseId: toolId, status: 'withdrawn', result: { isError: true, summary: 'Demande annulée', denial: 'withdrawn' } }),
    b.ev(c, { k: 'system', turnId: 'u:$A.uuid', id: 'x:app:1', row: { kind: 'crash', text: 'Interrompu (le processus Claude s\'est arrêté)', data: { exitCode: 3 } } }),
    b.ev(c, { k: 'queue', items: [{ uuid: '$B.uuid', text: '$B.text', images: 0, delivery: 'returned' }] }),
    b.ev(c, { k: 'state', state: stateView('error', { live: false, since: T0 + 4_000, error: { code: 'crash', message: 'Claude Code process exited with code 3', exitCode: 3 } }) }),
    { t: 'chats', upsert: [summary(c, title, 'error', { live: false, since: T0 + 4_000, error: { code: 'crash', exitCode: 3 }, activity: 'Le processus Claude s\'est arrêté (code 3).' })], remove: [] },
    { t: 'procs', procs: procs(0, []) },
    { t: 'toast', level: 'error', key: 'err.crash', args: { code: 3 }, chatId: c }], 2_500);
  return b.steps;
}

function reconnectScript() {
  const b = scriptBuilder('reconnect', 'Coupure pendant un tour (même boot : view + snap avec le tour en cours, seq contigu), puis redémarrage du serveur (nouveau boot : caches vidés, chats froids, ligne sys.serverRestart).');
  const c = CHAT.main;
  const title = 'Refactorisation du module';
  const msgId = 'msg_01ReconDemo0000000000001';
  const part1 = 'Je découpe le module en trois fichiers : ';
  const part2 = '`lexer.ts`, `parser.ts` et `index.ts`.';
  b.connect().send([hello(BOOT1, [summary(c, title, 'idle', { live: true })], { procs: procs(1, [procItem(c, 'idle')]) })]);
  b.expect({ t: 'view' }, { ok: true }, [coldSnap(b, c, title, { phase: 'idle', live: true })]);
  b.expect({ t: 'chat.send', chatId: c }, { ok: true, data: { accepted: 'new' } }, [
    b.ev(c, { k: 'state', state: stateView('running', { sub: 'writing' }) }),
    b.ev(c, { k: 'turn.start', turn: { id: 'u:$A.uuid', at: T0 + 1_000, user: userMsg('A', '$A.text') } }),
    b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: textBlock(msgId, 0, '', true) })], 'A');
  b.send([b.ev(c, { k: 'delta', parts: [[`a:${msgId}:0`, part1]] })], 200);
  b.drop();
  // same boot: the live turn comes back in the snapshot, then ev continues at snap.seq + 1
  b.connect().send([hello(BOOT1, [summary(c, title, 'running', { live: true, sub: 'writing' })], { procs: procs(1, [procItem(c, 'running')]) })]);
  b.expect({ t: 'view' }, { ok: true }, [b.snap(c, { state: stateView('running', { sub: 'writing' }), meta: metaView(title), metrics: metrics(), queue: [], tasks: [], todos: null,
    live: { id: 'u:$A.uuid', at: T0 + 1_000, user: userMsg('A', '$A.text'), blocks: [textBlock(msgId, 0, part1, true)] }, lastDiskTurnId: 'u:ca4b0112-e963-461f-b8ff-bd24341c4719' })]);
  b.send([b.ev(c, { k: 'delta', parts: [[`a:${msgId}:0`, part2]] })], 100);
  b.send([b.ev(c, { k: 'block', turnId: 'u:$A.uuid', block: textBlock(msgId, 0, part1 + part2) }),
    b.ev(c, { k: 'turn.end', turnId: 'u:$A.uuid', footer: footer({ ms: 4_100 }) }),
    b.ev(c, { k: 'state', state: stateView('idle', { since: T0 + 5_100 }) })], 300);
  b.drop();
  // new boot (server restarted): per-chat seq restart at the new snapshot; the chat is cold again
  b.newServer().connect().send([hello(BOOT2, [summary(c, title, 'cold', { live: false })], { now: T0 + 60_000 }),
    { t: 'toast', level: 'warn', key: 'server.restarted' }]);
  b.expect({ t: 'view' }, { ok: true }, [coldSnap(b, c, title, { live: false, lastDiskTurnId: 'u:$A.uuid' })]);
  return b.steps;
}

function capScript() {
  const b = scriptBuilder('cap', 'Plafond de 4 processus atteint : chat.send sur un 5e chat → erreur cap avec candidats, nouvel essai (même uuid) avec evict, le chat évincé passe en veille.');
  const target = CHAT.perso4;
  const live = [CHAT.main, CHAT.perso1, CHAT.perso2, CHAT.perso3];
  const items = live.map((c, i) => procItem(c, 'idle', { pid: 4100 + i, at: T0 - (i + 1) * 600_000, protected: c === CHAT.main }));
  const chats = [summary(CHAT.main, 'Corriger le test du parseur', 'idle', { live: true }), summary(CHAT.perso1, 'Notes de réunion', 'idle', { live: true }),
    summary(CHAT.perso2, 'Script de sauvegarde', 'idle', { live: true }), summary(CHAT.perso3, 'Lecture du rapport', 'idle', { live: true }),
    summary(target, 'Brouillon d\'article', 'cold', { live: false, wake: { lastContext: 52_000, recacheTokens: 52_000, idleMs: 7_200_000, dialog: false } })];
  b.connect().send([hello(BOOT1, chats, { procs: procs(4, items), tabs: [target] })]);
  b.expect({ t: 'view' }, { ok: true }, [coldSnap(b, target, 'Brouillon d\'article', { live: false })]);
  const candidates = [
    { chatId: CHAT.perso3, title: 'Lecture du rapport', warmMin: 20, recacheTokens: 31_400, stable: true },
    { chatId: CHAT.perso2, title: 'Script de sauvegarde', warmMin: 30, recacheTokens: 44_900, stable: false },
  ];
  b.expect({ t: 'chat.send', chatId: target }, { ok: false, err: { code: 'cap', candidates } }, [], 'A');
  b.expect({ t: 'chat.send', chatId: target, uuid: '$A.uuid', evict: CHAT.perso3 }, { ok: true, data: { accepted: 'new' } }, [
    { t: 'chats', upsert: [summary(CHAT.perso3, 'Lecture du rapport', 'cold', { live: false })], remove: [] },
    { t: 'toast', level: 'info', key: 'chat.sleep', args: { titre: 'Lecture du rapport', n: 4 }, chatId: CHAT.perso3 },
    b.ev(target, { k: 'state', state: stateView('starting', { since: T0 + 1_000 }) }),
    { t: 'procs', procs: procs(4, [...items.filter((x) => x.chatId !== CHAT.perso3), procItem(target, 'starting', { pid: 4300 })]) }]);
  b.send([b.ev(target, { k: 'state', state: stateView('running', { sub: 'requesting', since: T0 + 3_000 }) }),
    b.ev(target, { k: 'turn.start', turn: { id: 'u:$A.uuid', at: T0 + 3_000, user: userMsg('A', '$A.text') } })], 2_000);
  b.send([b.ev(target, { k: 'block', turnId: 'u:$A.uuid', block: textBlock('msg_01CapDemo000000000000001', 0, 'Voici une nouvelle version de l\'introduction.') }),
    b.ev(target, { k: 'turn.end', turnId: 'u:$A.uuid', footer: footer({ ms: 3_300, read: 0, write: 52_310 }) }),
    b.ev(target, { k: 'state', state: stateView('idle', { since: T0 + 6_300 }) })], 1_000);
  return b.steps;
}
const PROTOCOL_SCRIPTS = { stream: streamScript, permission: permissionScript, question: questionScript, plan: planScript,
  queue: queueScript, crash: crashScript, reconnect: reconnectScript, cap: capScript };

// ------------------------------------------------------------------ privacy scan
// The private deny-list (--deny, kept outside the repository), the recording machine's user folder names and generic
// leak markers.
const FORBIDDEN_STATIC = [
  ...(DENY ? fs.readFileSync(DENY, 'utf8').split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean) : []),
  ...USERS.flatMap((u) => [u.toLowerCase(), keyOf(u).toLowerCase()]),
  ...CWD_ROOTS.map((r) => keyOf(r).toLowerCase()),
  'sessionstart hook', '.credentials.json',
];
function collectStrings(v, out) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); collectStrings(x, out); }
  return out;
}
function fixtureFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? fixtureFiles(path.join(dir, e.name)) : /\.(jsonl|json)$/.test(e.name) ? [path.join(dir, e.name)] : []));
}
/** Scans every fixture (decoded JSON strings, so escaping cannot hide anything) for the static list plus `extra` needles. */
function privacyScan(extra = []) {
  const files = ['frames', 'pairs', 'protocol'].flatMap((d) => fixtureFiles(path.join(OUT, d)));
  const needles = [...FORBIDDEN_STATIC, ...extra.map((s) => s.toLowerCase())];
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const strings = f.endsWith('.jsonl') ? text.split(/\r?\n/).filter(Boolean).flatMap((l) => collectStrings(JSON.parse(l), [])) : collectStrings(JSON.parse(text), []);
    const hay = (strings.join('\n') + '\n' + text).toLowerCase();
    for (const n of needles) if (n && hay.includes(n)) hits.push(`${path.relative(OUT, f)}: needle #${needles.indexOf(n) + 1}`);
  }
  return { files: files.length, needles: needles.length, hits };
}
/** Distinctive lines of the private inputs: hook output, CLAUDE.md / instructions, prompt snapshot, env, session context. */
function privateNeedles(runs, transcripts) {
  const out = new Set();
  const addText = (s) => {
    if (typeof s !== 'string') return;
    for (const line of s.split(/\r?\n/)) { const t = line.trim(); if (t.length >= 24 && /[A-Za-z]{4}/.test(t)) out.add(t); }
  };
  const walk = (v, inside) => {
    if (typeof v === 'string') { if (inside) addText(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, inside); return; }
    if (!v || typeof v !== 'object') return;
    const hook = (v.type === 'system' && typeof v.subtype === 'string' && v.subtype.startsWith('hook_'));
    for (const [k, x] of Object.entries(v)) {
      const priv = inside || (hook && ['output', 'stdout', 'stderr'].includes(k))
        || (k === 'attachment' && x && PLACEHOLDER_ATTACHMENTS.has(x.type)) || (k === 'rendered' && v.attachment && PLACEHOLDER_ATTACHMENTS.has(v.attachment.type))
        || ['email', 'emailAddress', 'organization', 'userEmail'].includes(k);
      walk(x, priv);
    }
  };
  for (const r of runs) { for (const f of r.frames) walk(f.m, false); for (const w of r.raw) walk(w.m, false); }
  for (const t of transcripts) for (const e of t) walk(e, false);
  // tool and command names stay (they are not private); drop lines that are only such lists
  return [...out].filter((s) => !/^[\w:,\s.-]+$/.test(s) || s.length > 60);
}

// ------------------------------------------------------------------ main
function main() {
  if (CHECK_ONLY) {
    const r = privacyScan();
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.hits.length ? 1 : 0);
  }
  if (!VERIFY_OUT || !PROJECTS || !CWD_ROOTS.length || !USERS.length) {
    console.error('usage: node scripts/sanitize-frames.mjs --verify-out <dir> --projects <profile\\projects> --cwd-root <dir> --user <name> [--user <8.3 name>] [--deny <file>] [--out test/fixtures]');
    process.exit(2);
  }
  // pre-pass: identity uuids from every input (frames, wire, transcripts) so they are mapped wherever they appear
  for (const n of NAMES) {
    const raw = readJsonl(path.join(VERIFY_OUT, `${n}.raw.jsonl`));
    collectIdentity(raw.map((r) => r.m));
    collectIdentity(readJsonl(path.join(VERIFY_OUT, `${n}.frames.jsonl`)).map((f) => f.m));
    for (const sid of new Set(raw.map((r) => r.m?.session_id).filter((s) => typeof s === 'string' && s))) {
      const tf = findTranscript(sid);
      if (tf) collectIdentity(readJsonl(tf));
    }
  }
  const runs = NAMES.map(processRun);
  const index = { generatedBy: 'scripts/sanitize-frames.mjs', source: 'recorded runs: SDK 0.3.293 + CLI 2.1.294 (structure only, synthetic text)',
    totalFrames: 0, fixtures: {} };
  const transcripts = [];
  for (const r of runs) {
    writeJsonl(path.join(OUT, 'frames', `${r.name}.jsonl`), r.framesOut);
    writeJsonl(path.join(OUT, 'frames', 'wire', `${r.name}.jsonl`), r.wireOut);
    index.totalFrames += r.framesOut.length;
    const entry = { frames: r.framesOut.length, wire: r.wireOut.length, sessionIds: r.sessionIds, inputs: inputLabels(r.name, r.inputs), facts: deriveFacts(r.framesOut, r.inputs) };
    // the session the run wrote (fork: the NEW id) — its transcript is the pair
    const sid = r.sessionIds.find((s) => findTranscript(s));
    const tf = sid ? findTranscript(sid) : null;
    if (tf) {
      const entries = readJsonl(tf);
      transcripts.push(entries);
      const sanitized = entries.map((e) => sanitize(e));
      writeJsonl(path.join(OUT, 'pairs', r.name, 'frames.jsonl'), r.framesOut);
      writeJsonl(path.join(OUT, 'pairs', r.name, 'transcript.jsonl'), sanitized);
      writeJsonl(path.join(OUT, 'pairs', r.name, 'inputs.jsonl'), r.inputs);
      entry.pair = { sessionId: sid, transcriptLines: sanitized.length, cwd: mapPath(String(entries.find((e) => typeof e.cwd === 'string')?.cwd ?? '')) };
    }
    index.fixtures[r.name] = entry;
  }
  fs.writeFileSync(path.join(OUT, 'frames', 'index.json'), JSON.stringify(index, null, 1) + '\n');
  for (const [n, fn] of Object.entries(PROTOCOL_SCRIPTS)) writeJsonl(path.join(OUT, 'protocol', `${n}.jsonl`), fn());
  const needles = privateNeedles(runs, transcripts);
  const scan = privacyScan(needles);
  console.log(JSON.stringify({ out: OUT, frames: Object.fromEntries(runs.map((r) => [r.name, r.framesOut.length])), totalFrames: index.totalFrames,
    pairs: Object.fromEntries(Object.entries(index.fixtures).filter(([, e]) => e.pair).map(([k, e]) => [k, e.pair.transcriptLines])),
    protocol: Object.keys(PROTOCOL_SCRIPTS), privacy: { files: scan.files, needles: scan.needles, hits: scan.hits } }, null, 1));
  if (scan.hits.length) { console.error('PRIVACY SCAN FAILED'); process.exit(1); }
}
main();
