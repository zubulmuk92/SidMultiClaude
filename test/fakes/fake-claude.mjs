// fake-claude.mjs — protocol-level stand-in for claude.exe (stream-json in/out), for ZERO-TOKEN tests.
// Launched by the real Agent SDK through `pathToClaudeCodeExecutable: '<this file>'` (the SDK runs .mjs with node).
// Frames mirror shapes recorded from CLI 2.1.294 (see test/fixtures/frames/wire). SPEC §12.2(b).
// Magic prompts ("VERB:arg"):
//   ECHO:<text>     stream <text> in 3 deltas, then result success
//   ASK:<cmd>       Bash ask (addRules localSettings suggestion); allow => "ALLOWED", deny => "DENIED:<msg>"; interrupt => aborted_tools
//   WRITE:<path>    Write ask with the setMode acceptEdits (session) suggestion; an accepted setMode echoes system:status
//   QUESTION:<q>    AskUserQuestion (requires_user_interaction); answers echoed as "ANSWERS:<json>"
//   PLAN:<text>     ExitPlanMode with input.plan; approve => "PLAN-OK:<mode>", reject => "PLAN-REJECTED:<feedback>"
//   SLOW:<n>        n deltas 40 ms apart; interrupt => aborted_streaming
//   SLEEP:<n>       a background task (task_started + background_tasks_changed) that ends after n ms, or on stop_task
//   FOLD:<ms>       a tool round of <ms> (default 800); messages queued meanwhile without priority fold into this turn
//   ASKCRASH:<c>    can_use_tool, then exit(<c>) 150 ms later (crash with a pending ask)
//   CRASH:<c>       one delta, then exit(<c>)
//   HANG            never ends the turn and ignores stdin EOF (forces the kill path)
//   RESET           conversation_reset to a new session id (/clear); "/clear" does the same
//   TITLE:<t>       system:session_title_changed
//   HOOKS:<pidfile> hook frames + a hook grandchild started through bash (Job Object tests); BGJOB:<pidfile> alias
//   AUTHFAIL        assistant error authentication_failed + "Please run /login" result
// Startup controls (no prompt exists yet): initialize.title or env SMC_FAKE_HANGINIT=1 containing HANGINIT never answers
// initialize; title HOOKS or SMC_FAKE_HOOKS=1 emits SessionStart hook frames before init; SMC_FAKE_IGNORE_FORK_ID=1 makes a
// fork pick its own session id. SMC_FAKE_RECORD=<file> appends argv / env NAMES / initialize (T-P2).
// Transcript: with CLAUDE_CONFIG_DIR set (never a real profile), appends a structure-faithful JSONL under
// <cfg>\projects\<key(cwd)>\<sid>.jsonl from the first prompt on.
// Identity (initialize.account.email): SMC_FAKE_EMAIL, else the profile's own oauthAccount.emailAddress (CLAUDE_CONFIG_DIR\.claude.json,
// read-only, never .credentials.json), else fake@example.invalid, so a fake chat only shows « Identité inattendue » when a test asks.
// `auth login|logout` runs the LoginService fake (test/unit/claude/fakes/fake-login.mjs: writes only inside the OS temp dir).
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv[0] === 'auth') {                                    // e2e login: the same fake as the LoginService unit tests
  await import(new URL('../unit/claude/fakes/fake-login.mjs', import.meta.url).href);
  await new Promise(() => {});                               // fake-login exits by itself; the stream-json fake never starts
}
const profileEmail = () => {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (!cfg) return undefined;
  try { const e = JSON.parse(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress; return typeof e === 'string' && e ? e : undefined; }
  catch { return undefined; }
};
const argVal = (name) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1);
  }
  return undefined;
};
const resume = argVal('--resume');
const fork = argv.includes('--fork-session');
const wantedSid = argVal('--session-id');
const resumeFile = resume && /\.jsonl$/i.test(resume) ? resume : null;
const resumeAt = argVal('--resume-session-at');                       // rewind: the next entry's parent (CLI)
let SID;
if (fork) SID = process.env.SMC_FAKE_IGNORE_FORK_ID === '1' || !wantedSid ? randomUUID() : wantedSid;
else if (resumeFile) SID = path.basename(resumeFile, '.jsonl');           // the CLI adopts the file's own id (forbidden by the app)
else if (resume) SID = resume;
else SID = wantedSid ?? randomUUID();
let mode = argVal('--permission-mode') ?? 'default';
let model = argVal('--model') ?? 'fake-model';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- T-P2 recording (env NAMES only, plus a few safe values)
const RECORD = process.env.SMC_FAKE_RECORD;
const record = (o) => { if (RECORD) try { fs.appendFileSync(RECORD, JSON.stringify(o) + '\n'); } catch { /* ignore */ } };
const SAFE_VALUES = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_ENTRYPOINT'];
record({ kind: 'spawn', pid: process.pid, argv, cwd: process.cwd(), envNames: Object.keys(process.env).sort(),
  env: Object.fromEntries(SAFE_VALUES.filter((k) => k in process.env).map((k) => [k, process.env[k]])) });

// ---------------------------------------------------------------- transcript (structure of CLI 2.1.294)
const CFG = process.env.CLAUDE_CONFIG_DIR;
function safeConfigDir(d) {
  if (!d) return null;
  const abs = path.resolve(d);
  const rel = path.relative(os.homedir(), abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel) && /^\.claude/i.test(rel.split(/[\\/]/)[0] ?? '')) return null;   // a real profile
  return abs;
}
const TX_DIR = safeConfigDir(CFG) ? path.join(safeConfigDir(CFG), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-')) : null;
let txParent = null;
let txStarted = false;
const txEnv = () => ({ isSidechain: false, userType: 'external', entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? 'sdk-ts', cwd: process.cwd(), sessionId: SID, version: '0.0.0-fake', gitBranch: 'HEAD' });
function txFile() { return TX_DIR ? path.join(TX_DIR, SID + '.jsonl') : null; }
/**
 * First write of this process: the folder, the fork copy (history, uuids kept, sessionId rewritten) and the parent of the
 * next entry, like the CLI: the last user/assistant entry of the file, or the --resume-session-at point (rewind).
 * Runs BEFORE the first entry is built (it used to run inside txAppend, after the entry already had parentUuid null, which
 * broke the chain of every resumed / forked / rewound session on disk).
 */
function txInit() {
  const f = txFile();
  if (!f || txStarted) return;
  txStarted = true;
  try {
    fs.mkdirSync(TX_DIR, { recursive: true });
    if (fork && resumeFile && fs.existsSync(resumeFile)) {
      const lines = fs.readFileSync(resumeFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      for (const l of lines) { const o = JSON.parse(l); if (o.sessionId) o.sessionId = SID; fs.appendFileSync(f, JSON.stringify(o) + '\n'); if (o.uuid && (o.type === 'user' || o.type === 'assistant')) txParent = o.uuid; }
    } else if (fs.existsSync(f)) {
      for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { try { const o = JSON.parse(l); if (o.uuid && (o.type === 'user' || o.type === 'assistant')) txParent = o.uuid; } catch { /* skip */ } }
    }
    if (resumeAt) txParent = resumeAt;
  } catch { /* transcript is best effort */ }
}
function txAppend(e) {
  const f = txFile();
  if (!f) return;
  txInit();
  try { fs.appendFileSync(f, JSON.stringify(e) + '\n'); } catch { /* transcript is best effort */ }
}
function txChain(type, body, id) {
  txInit();                                                            // sets txParent BEFORE this entry is built
  const uuid = id ?? randomUUID();
  txAppend({ parentUuid: txParent, ...txEnv(), type, ...body, uuid, timestamp: new Date().toISOString() });
  txParent = uuid;
  return uuid;
}

// ---------------------------------------------------------------- output helpers
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const sys = (subtype, extra = {}) => out({ type: 'system', subtype, ...extra, uuid: randomUUID(), session_id: SID });
const ssc = (state) => sys('session_state_changed', { state, sdk_host_only: true });
const lifecycle = (uuid, state) => out({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: randomUUID(), session_id: SID });
const toolId = () => 'toolu_' + randomBytes(10).toString('hex');
const USAGE = { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40,
  cache_creation: { ephemeral_1h_input_tokens: 40, ephemeral_5m_input_tokens: 0 } };
let costUsd = 0;
const modelUsageTotal = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
// Like the CLI: a resumed / forked process restores its cumulative totals from the transcript's
// last `cost-state`, and a closing process appends one (exercises the app's cost baseline end to end).
(function restoreCostState() {
  const src = resumeFile ?? (resume && TX_DIR ? path.join(TX_DIR, resume + '.jsonl') : null);
  if (!src) return;
  try {
    const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"cost-state"')) continue;
      const o = JSON.parse(lines[i]);
      if (o.type !== 'cost-state') continue;
      if (typeof o.totalCostUSD === 'number') costUsd = o.totalCostUSD;
      const mu = o.modelUsage?.[model] ?? Object.values(o.modelUsage ?? {})[0];
      if (mu) for (const k of Object.keys(modelUsageTotal)) if (typeof mu[k] === 'number') modelUsageTotal[k] = mu[k];
      return;
    }
  } catch { /* no transcript yet */ }
})();
function closeOut() {
  if (txStarted) txAppend({ type: 'cost-state', totalCostUSD: costUsd, totalAPIDuration: 1, totalToolDuration: 0, totalLinesAdded: 0,
    totalLinesRemoved: 0, totalDuration: 2, startTime: 0, modelUsage: { [model]: { ...modelUsageTotal, webSearchRequests: 0, costUSD: costUsd } }, sessionId: SID });
  process.exit(0);
}

/** Like the CLI, a streamed message and its final assistant frame share ONE message id (block ids are keyed by it). */
let streamMsgId = null;
const newMsgId = () => 'msg_' + randomBytes(12).toString('hex');
/** A user denial carries tool_result_meta like the CLI (live denial → « Refusé par vous »). @param {string} tid */
const denyMeta = (tid) => ({ tool_result_meta: [{ id: tid, non_execution_kind: 'permission-rule', permission_decision: { decision: 'reject', source: 'user_reject' } }] });
function streamEvent(event, u) { out({ type: 'stream_event', event, session_id: SID, parent_tool_use_id: null, uuid: randomUUID(), user_message_uuid: u }); }
function assistant(content, u, extra = {}) {
  const message = { model, id: streamMsgId ?? newMsgId(), type: 'message', role: 'assistant', content,
    stop_reason: null, usage: { ...USAGE } };
  streamMsgId = null;
  out({ type: 'assistant', message, parent_tool_use_id: null, session_id: SID, uuid: randomUUID(), user_message_uuid: u, ...extra });
  txChain('assistant', { message, requestId: 'req_' + randomBytes(8).toString('hex') });
}
function userFrame(content, extra = {}) {
  out({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: SID, uuid: randomUUID(), ...extra });
  // a denial is recorded on disk too, like the CLI (toolDenialKind + permissionDecision; test/fixtures/pairs/*/transcript.jsonl)
  const meta = extra.tool_result_meta?.[0];
  txChain('user', { message: { role: 'user', content }, ...(extra.tool_use_result !== undefined ? { toolUseResult: extra.tool_use_result } : {}),
    ...(meta?.non_execution_kind ? { toolDenialKind: meta.non_execution_kind, permissionDecision: meta.permission_decision } : {}) });
}
function result(ok, text, extra = {}) {
  const uuids = current?.uuids ?? [];
  if (current && !current.foldedDone) { current.foldedDone = true; for (const x of uuids.slice(1)) lifecycle(x, ok ? 'completed' : 'cancelled'); }  // CLI order: folded completed, result, main completed
  const usage = ok ? { ...USAGE } : { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (ok) {
    costUsd += 0.0001;
    modelUsageTotal.inputTokens += usage.input_tokens; modelUsageTotal.outputTokens += usage.output_tokens;
    modelUsageTotal.cacheReadInputTokens += usage.cache_read_input_tokens; modelUsageTotal.cacheCreationInputTokens += usage.cache_creation_input_tokens;
  }
  out({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, num_turns: 1, session_id: SID,
    ...(ok ? { result: text } : { errors: ['[fake] ' + text] }), duration_ms: 1, duration_api_ms: 1, total_cost_usd: costUsd,
    usage, modelUsage: { [model]: { ...modelUsageTotal, webSearchRequests: 0, costUSD: costUsd, contextWindow: 200000, maxOutputTokens: 32000 } },
    permission_denials: [], user_message_uuid: uuids[0], user_message_uuids: uuids, queued_turn_count: queue.filter((q) => !q.cancelled).length,
    uuid: randomUUID(), stop_reason: ok ? 'end_turn' : null, ...extra });
}
async function streamText(u, text, parts = 3, gapMs = 5) {
  streamMsgId = newMsgId();
  streamEvent({ type: 'message_start', message: { id: streamMsgId, model, usage: { ...USAGE } } }, u);
  streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, u);
  const step = Math.max(1, Math.ceil(text.length / parts));
  for (let i = 0; i < text.length; i += step) {
    if (current?.abort) return false;
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + step) } }, u);
    await sleep(gapMs);
  }
  return true;
}
function endStream(u) {
  streamEvent({ type: 'content_block_stop', index: 0 }, u);
  streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, u);
  streamEvent({ type: 'message_stop' }, u);
}
async function reply(u, t) { await streamText(u, t); assistant([{ type: 'text', text: t }], u); endStream(u); result(true, t); }
function textOf(msg) {
  const c = msg.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return '';
}
function imagesOf(msg) { const c = msg.message?.content; return Array.isArray(c) ? c.filter((b) => b.type === 'image').length : 0; }

// ---------------------------------------------------------------- asks (can_use_tool, outbound control requests)
const asks = new Map();      // request_id -> resolve(response)
/** Sends can_use_tool and resolves with the host's PermissionResult, or null when the turn is interrupted (withdrawn). */
function askHost(req) {
  const request_id = randomUUID();
  ssc('requires_action');
  const answer = new Promise((resolve) => asks.set(request_id, resolve));
  const cur = current;
  const aborted = new Promise((res) => { cur.onAbort = () => { if (asks.has(request_id)) { asks.delete(request_id); out({ type: 'control_cancel_request', request_id }); } res(null); }; });
  out({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', ...req } });
  return Promise.race([answer, aborted]).then((r) => { ssc('running'); return r; });
}
function withdrawn(tid, name, input) {
  userFrame([{ type: 'tool_result', tool_use_id: tid, is_error: true, content: 'The user doesn\'t want to proceed with this tool use.' }], { tool_use_result: 'User rejected tool use' });
  result(false, 'aborted', { terminal_reason: 'aborted_tools', permission_denials: [{ tool_name: name, tool_use_id: tid, tool_input: input }] });
}
function applyUpdates(r) {
  for (const u of r?.updatedPermissions ?? []) if (u.type === 'setMode' && u.mode) { mode = u.mode; sys('status', { status: null, permissionMode: mode }); }
}

// ---------------------------------------------------------------- turns
const queue = [];            // pending user messages (the CLI queue)
let current = null;          // { uuid, uuids, abort, onAbort? }
let firstTurn = true;
let stdinEnded = false;
let stubborn = false;        // HANG: a CLI that does not exit on stdin EOF (forces the kill path)
const bgTasks = new Map();   // task_id -> { timer, toolUseId, description }
const ARGV_TOOLS = ['Bash', 'Write', 'Edit', 'Read', 'AskUserQuestion', 'ExitPlanMode'];

function bgChanged() { sys('background_tasks_changed', { tasks: [...bgTasks.entries()].map(([task_id, t]) => ({ task_id, task_type: 'local_bash', description: t.description, ambient: false })) }); }
function endTask(id, status) {
  const t = bgTasks.get(id);
  if (!t) return false;
  clearTimeout(t.timer);
  bgTasks.delete(id);
  sys('task_notification', { task_id: id, tool_use_id: t.toolUseId, status, output_file: '', summary: t.description });
  bgChanged();
  return true;
}
function hookGrandchild(pidFile, linked) {         // a long-lived process started THROUGH bash (MSYS bash has no job of its own)
  const gc = path.join(path.dirname(pidFile), 'gc-' + process.pid + '.cjs');
  fs.writeFileSync(gc, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1e6);");
  const fwd = (s) => s.split(path.sep).join('/');
  const git = path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git');
  const bash = [path.join(git, 'bin', 'bash.exe'), path.join(git, 'usr', 'bin', 'bash.exe')].find((p) => fs.existsSync(p));
  if (bash) spawn(bash, ['-c', `node "${fwd(gc)}" "${fwd(pidFile)}" ${linked ? "; echo done" : "& echo started"}`], { stdio: 'ignore', windowsHide: true });
  else spawn(process.execPath, [gc, pidFile], { stdio: 'ignore', windowsHide: true });
}
function hookFrames(event) {
  const id = randomUUID();
  sys('hook_started', { hook_id: id, hook_name: `${event}:startup`, hook_event: event });
  sys('hook_response', { hook_id: id, hook_name: `${event}:startup`, hook_event: event, output: '', stdout: '', stderr: '', exit_code: 0, outcome: 'success' });
}

async function runTurn(msg) {
  const u = msg.uuid;
  current = { uuid: u, uuids: [u], abort: false };
  lifecycle(u, 'started');
  txChain('user', { message: msg.message, promptSource: 'sdk', origin: { kind: 'human' }, permissionMode: mode }, u);
  sys('init', { cwd: process.cwd(), tools: ARGV_TOOLS, mcp_servers: [], model, permissionMode: mode, slash_commands: ['compact', 'clear', 'usage'],
    apiKeySource: 'none', claude_code_version: '0.0.0-fake', output_style: 'default', agents: [], skills: [], plugins: [], capabilities: ['interrupt_receipt_v1'] });
  sys('status', { status: 'requesting', user_message_uuids: [u] });
  const text = textOf(msg);
  const ci = text.indexOf(':');
  const verb = ci > 0 && /^[A-Z]+$/.test(text.slice(0, ci)) ? text.slice(0, ci) : text.trim();
  const arg = ci > 0 && /^[A-Z]+$/.test(text.slice(0, ci)) ? text.slice(ci + 1) : '';
  if (firstTurn) { out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, uuid: randomUUID(), session_id: SID }); firstTurn = false; }
  switch (verb) {
    case 'CRASH': await streamText(u, 'x', 1); process.exit(Number(arg) || 3); break;
    case 'HANG': stubborn = true; setInterval(() => {}, 1000); await new Promise(() => {}); break;
    case 'HOOKS': case 'BGJOB': hookFrames('PreToolUse'); if (arg) { hookGrandchild(arg, verb === 'BGJOB'); for (let i = 0; i < 100 && !(fs.existsSync(arg) && fs.readFileSync(arg, 'utf8').trim()); i++) await sleep(50); } await reply(u, 'HOOKS'); return true;
    case 'TITLE': sys('session_title_changed', { title: arg || 'TITLE' }); txAppend({ type: 'custom-title', customTitle: arg || 'TITLE', sessionId: SID }); await reply(u, 'TITLED'); return true;
    case 'RESET': case '/clear': {
      const next = randomUUID();
      out({ type: 'conversation_reset', new_conversation_id: next, trigger: 'clear', user_message_uuid: u, uuid: randomUUID(), session_id: SID });
      SID = next; txStarted = false; txParent = null;
      result(true, '', { num_turns: 0 });
      return true;
    }
    case 'AUTHFAIL': {
      const message = { model: '<synthetic>', id: 'msg_' + randomBytes(8).toString('hex'), type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Invalid API key · Please run /login' }], stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0 } };
      out({ type: 'assistant', message, parent_tool_use_id: null, session_id: SID, uuid: randomUUID(), error: 'authentication_failed' });
      result(true, 'Invalid API key · Please run /login', { is_error: true });
      return true;
    }
    case 'SLOW': return slowTurn(u, Number(arg) || 50);
    case 'SLEEP': {
      const id = 'b' + randomBytes(4).toString('hex'); const tid = toolId(); const ms = Number(arg) || 1000;
      assistant([{ type: 'tool_use', id: tid, name: 'Bash', input: { command: `sleep ${ms / 1000}`, run_in_background: true } }], u);
      bgTasks.set(id, { toolUseId: tid, description: `sleep ${ms}`, timer: setTimeout(() => endTask(id, 'completed'), ms) });
      bgChanged();
      sys('task_started', { task_id: id, tool_use_id: tid, description: `sleep ${ms}`, is_backgrounded: true, task_type: 'local_bash' });
      userFrame([{ type: 'tool_result', tool_use_id: tid, content: `Command running in background with ID: ${id}` }], { tool_use_result: { stdout: '', stderr: '', backgroundTaskId: id } });
      await reply(u, 'BG:' + id); return true;
    }
    case 'FOLD': return foldTurn(u, Number(arg) || 800);
    case 'ASK': case 'ASKCRASH': return askTurn(u, verb, arg);
    case 'WRITE': return writeTurn(u, arg || 'fake.txt');
    case 'QUESTION': return questionTurn(u, arg || 'Quelle couleur ?');
    case 'PLAN': return planTurn(u, arg || '# Plan\n1. Faire');
    default: await reply(u, verb === 'ECHO' ? arg : text); return true;
  }
  return true;
}

async function slowTurn(u, n) {
  streamMsgId = newMsgId();
  streamEvent({ type: 'message_start', message: { id: streamMsgId, model, usage: { ...USAGE } } }, u);
  streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, u);
  let acc = '';
  for (let i = 0; i < n && !current.abort; i++) {
    acc += 'w' + i + ' ';
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'w' + i + ' ' } }, u);
    await sleep(40);
  }
  if (current.abort) {
    assistant([{ type: 'text', text: acc }], u, { aborted: true });
    userFrame([{ type: 'text', text: '[Request interrupted by user]' }]);
    result(false, 'aborted', { terminal_reason: 'aborted_streaming' });
    return false;
  }
  assistant([{ type: 'text', text: acc }], u); endStream(u); result(true, acc.trim());
  return true;
}
async function foldTurn(u, ms) {
  const tid = toolId();
  assistant([{ type: 'tool_use', id: tid, name: 'Bash', input: { command: `sleep ${ms / 1000}`, description: 'Sleep' } }], u);
  for (let t = 0; t < ms && !current.abort; t += 20) await sleep(20);
  if (current.abort) { withdrawn(tid, 'Bash', { command: 'sleep' }); return false; }
  userFrame([{ type: 'tool_result', tool_use_id: tid, content: '(Bash completed with no output)' }], { tool_use_result: { stdout: '', stderr: '', interrupted: false } });
  // Tool boundary: 'next' (no priority) messages fold into this turn; 'later' ones wait for their own turn.
  for (const q of [...queue]) {
    if (q.cancelled || (q.priority && q.priority !== 'next')) continue;
    queue.splice(queue.indexOf(q), 1);
    lifecycle(q.uuid, 'started');
    current.uuids.push(q.uuid);
    txChain('attachment', { attachment: { type: 'queued_command', prompt: textOf(q), commandUuid: q.uuid } });
  }
  sys('status', { status: 'requesting', user_message_uuids: current.uuids });
  await reply(u, 'FOLDED:' + current.uuids.length);
  return true;
}
async function askTurn(u, verb, arg) {
  const tid = toolId(); const input = { command: arg, description: 'Run ' + arg };
  assistant([{ type: 'tool_use', id: tid, name: 'Bash', input }], u);
  const p = askHost({ tool_name: 'Bash', display_name: 'Bash', input, description: 'Run ' + arg, tool_use_id: tid, decision_reason: 'This command requires approval',
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: arg }], behavior: 'allow', destination: 'localSettings' },
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: arg }], behavior: 'allow', destination: 'userSettings' }] });
  if (verb === 'ASKCRASH') { await sleep(150); process.exit(Number(arg) || 3); }
  const r = await p;
  if (r === null || current.abort) { withdrawn(tid, 'Bash', input); return false; }
  const allow = r.behavior === 'allow';
  if (allow) applyUpdates(r);
  userFrame([{ type: 'tool_result', tool_use_id: tid, is_error: !allow, content: allow ? 'ok' : r.message }], { tool_use_result: allow ? { stdout: 'ok', stderr: '' } : 'Error: ' + r.message, ...(allow ? {} : denyMeta(tid)) });
  if (!allow && r.interrupt) { result(false, 'denied', { terminal_reason: 'aborted_tools' }); return false; }
  const rules = (r.updatedPermissions ?? []).flatMap((x) => (x.rules ?? []).map((y) => `${x.destination}:${y.toolName}(${y.ruleContent})`));
  await reply(u, allow ? 'ALLOWED' + (rules.length ? ' ' + rules.join(',') : '') + (r.updatedInput?.command && r.updatedInput.command !== arg ? ' EDITED:' + r.updatedInput.command : '') : 'DENIED:' + r.message);
  return true;
}
async function writeTurn(u, file) {
  const tid = toolId(); const input = { file_path: file, content: 'fake content\n' };
  assistant([{ type: 'tool_use', id: tid, name: 'Write', input }], u);
  const r = await askHost({ tool_name: 'Write', display_name: 'Write', input, description: 'Write ' + file, tool_use_id: tid,
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  if (r === null || current.abort) { withdrawn(tid, 'Write', input); return false; }
  const allow = r.behavior === 'allow';
  if (allow) applyUpdates(r);
  userFrame([{ type: 'tool_result', tool_use_id: tid, is_error: !allow, content: allow ? 'File created' : r.message }], { tool_use_result: allow ? { type: 'create', filePath: file, content: input.content, structuredPatch: [], originalFile: null } : 'Error: ' + r.message, ...(allow ? {} : denyMeta(tid)) });
  await reply(u, allow ? 'WROTE mode=' + mode : 'DENIED:' + r.message);
  return true;
}
async function questionTurn(u, q) {
  const tid = toolId();
  const input = { questions: [{ question: q, header: 'Couleur', multiSelect: false, options: [{ label: 'Bleu', description: 'b' }, { label: 'Rouge', description: 'r' }] }] };
  assistant([{ type: 'tool_use', id: tid, name: 'AskUserQuestion', input }], u);
  const r = await askHost({ tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input, tool_use_id: tid, requires_user_interaction: true });
  if (r === null || current.abort) { withdrawn(tid, 'AskUserQuestion', input); return false; }
  userFrame([{ type: 'tool_result', tool_use_id: tid, content: 'answered' }], { tool_use_result: { questions: input.questions, answers: r.updatedInput?.answers ?? {} } });
  await reply(u, r.behavior === 'allow' ? 'ANSWERS:' + JSON.stringify(r.updatedInput?.answers ?? {}) : 'SKIPPED:' + r.message);
  return true;
}
async function planTurn(u, plan) {
  for (;;) {
    const tid = toolId();
    assistant([{ type: 'tool_use', id: tid, name: 'ExitPlanMode', input: {} }], u);
    const input = { plan, planFilePath: path.join(os.tmpdir(), 'fake-plan.md') };
    const r = await askHost({ tool_name: 'ExitPlanMode', display_name: 'ExitPlanMode', input, tool_use_id: tid, requires_user_interaction: true });
    if (r === null || current.abort) { withdrawn(tid, 'ExitPlanMode', input); return false; }
    if (r.behavior === 'allow') {
      applyUpdates(r);
      userFrame([{ type: 'tool_result', tool_use_id: tid, content: 'approved' }], { tool_use_result: { plan: r.updatedInput?.plan ?? plan, isAgent: false, filePath: input.planFilePath } });
      await reply(u, 'PLAN-OK:' + mode + ':' + (r.updatedInput?.plan ?? plan)); return true;
    }
    // like CLI 2.1.294 (test/fixtures/frames/plan.jsonl): a rejected plan is a user denial (« Refusé par vous »)
    userFrame([{ type: 'tool_result', tool_use_id: tid, is_error: true, content: r.message }], { tool_use_result: 'Error: ' + r.message, ...denyMeta(tid) });
    if (r.interrupt) { result(false, 'rejected'); return false; }
    plan = plan + '\n(révisé: ' + r.message + ')';
    if (plan.length > 2000) { await reply(u, 'PLAN-REJECTED:' + r.message); return true; }
  }
}

let working = false;
async function pump() {
  if (working) return;
  working = true;
  for (;;) {
    const i = queue.findIndex((q) => !q.cancelled);
    if (i < 0) break;
    const [m] = queue.splice(i, 1);
    ssc('running');
    const ok = await runTurn(m);
    if (!current.foldedDone) for (const x of current.uuids.slice(1)) lifecycle(x, ok ? 'completed' : 'cancelled');
    lifecycle(m.uuid, ok ? 'completed' : 'cancelled');
    current = null;
    if (!queue.some((q) => !q.cancelled)) ssc('idle');
  }
  working = false;
  if (stdinEnded && !stubborn) setTimeout(closeOut, 50);
}

function respond(request_id, response) { out({ type: 'control_response', response: { subtype: 'success', request_id, response } }); }
function respondError(request_id, error) { out({ type: 'control_response', response: { subtype: 'error', request_id, error } }); }

let initialized = false;
function onControl(request_id, request) {
  record({ kind: 'control', subtype: request.subtype, ...(request.subtype === 'initialize' ? { request } : {}) });
  switch (request.subtype) {
    case 'initialize': {
      const title = typeof request.title === 'string' ? request.title : '';
      if (/HANGINIT/.test(title) || process.env.SMC_FAKE_HANGINIT === '1') { stubborn = true; setInterval(() => {}, 1000); return; }
      if (/HOOKS/.test(title) || process.env.SMC_FAKE_HOOKS === '1') { hookFrames('SessionStart'); hookFrames('SessionStart'); }
      if (title) sys('session_title_changed', { title });
      initialized = true;
      respond(request_id, { commands: [{ name: 'compact', description: 'Compact', argumentHint: '[instructions]' }, { name: 'usage', description: 'Usage' }],
        agents: [], output_style: 'default', available_output_styles: ['default'],
        models: [{ value: 'default', resolvedModel: 'fake-model', displayName: 'Fake', supportsAutoMode: true }],
        account: { email: process.env.SMC_FAKE_EMAIL || profileEmail() || 'fake@example.invalid', organization: 'Fake Org', subscriptionType: 'fake', apiProvider: 'firstParty' },
        pid: process.pid, current_permission_mode: mode, capabilities: ['interrupt_receipt_v1'] });
      return;
    }
    case 'interrupt': {
      if (current) { current.abort = true; current.onAbort?.(); }
      const still = queue.filter((q) => !q.cancelled).map((q) => q.uuid);
      respond(request_id, { still_queued: still });
      return;
    }
    case 'set_permission_mode': mode = request.mode; respond(request_id, { mode }); sys('status', { status: null, permissionMode: mode }); return;
    case 'set_model': model = request.model ?? 'fake-model'; respond(request_id, {}); return;
    case 'apply_flag_settings': respond(request_id, {}); return;
    case 'cancel_async_message': {
      const q = queue.find((x) => x.uuid === request.message_uuid && !x.cancelled);
      if (q) { q.cancelled = true; queue.splice(queue.indexOf(q), 1); lifecycle(q.uuid, 'cancelled'); }
      respond(request_id, { cancelled: !!q });
      return;
    }
    case 'rename_session':
      if (request.session_id && request.session_id !== SID) { respondError(request_id, 'session moved'); return; }
      sys('session_title_changed', { title: request.title });
      txAppend({ type: 'custom-title', customTitle: request.title, sessionId: SID });
      txAppend({ type: 'agent-name', agentName: request.title, sessionId: SID });
      respond(request_id, {});
      return;
    case 'get_context_usage':
      if (request.detail === 'full' || request.detail === undefined) { respondError(request_id, 'fake-claude: full context usage would call count_tokens'); return; }
      respond(request_id, { categories: [{ name: 'System prompt', tokens: 3117, color: 'x', kind: 'used' }, { name: 'Free space', tokens: 150000, color: 'y', kind: 'free' }],
        totalTokens: 37152, maxTokens: 200000, rawMaxTokens: 200000, percentage: 18, gridRows: [], model, memoryFiles: [{ path: path.join(process.cwd(), 'CLAUDE.md'), type: 'Project', tokens: 10 }], mcpTools: [] });
      return;
    case 'stop_task': respond(request_id, {}); endTask(request.task_id, 'stopped'); return;
    case 'background_tasks': respond(request_id, { backgrounded: true }); return;
    case 'list_permission_rules': respond(request_id, { state: { rules: [{ behavior: 'allow', source: 'localSettings', rule: 'Bash(npm ci)', editability: 'persistent' }] } }); return;
    case 'get_usage': respond(request_id, { five_hour: { utilization: 10 } }); return;
    case 'rewind_files': respond(request_id, { canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: 2 }); return;
    case 'mcp_status': respond(request_id, { mcpServers: [] }); return;
    default: respondError(request_id, 'unsupported by fake-claude: ' + request.subtype);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request') { onControl(m.request_id, m.request); return; }
  if (m.type === 'control_response') {
    const resolve = asks.get(m.response.request_id);
    // T-P2 / acceptance 3: a withdrawn ask must get NO answer (the host's canUseTool returns null): `late` records one.
    record({ kind: 'control_response', request_id: m.response.request_id, late: !resolve });
    if (resolve) { asks.delete(m.response.request_id); resolve(m.response.response ?? m.response); }
    return;
  }
  if (m.type === 'user') {
    record({ kind: 'user', uuid: m.uuid, priority: m.priority, images: imagesOf(m) });
    if (m.priority === 'now' && current) { current.abort = true; current.onAbort?.(); }
    queue.push(m);
    lifecycle(m.uuid, 'queued');
    void pump();
  }
});
rl.on('close', () => { stdinEnded = true; if (!working && !stubborn) setTimeout(closeOut, 50); });
void initialized;
