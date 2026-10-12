// Golden protocol scripts (test/fixtures/protocol): every frame is a JSON array of well-formed S2C (SPEC §4), snap precedes
// ev on every connection, per-chat seq is contiguous, every expect step yields exactly one ack, templates resolve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackFor, bindTemplates, loadProtocol, matchesRequest, PROTOCOL_SCRIPTS } from '../../helpers/scenario.ts';
import type { ProtocolStep } from '../../helpers/scenario.ts';
import type * as P from '../../../src/shared/protocol.ts';

type O = Record<string, unknown>;
const isObj = (v: unknown): v is O => !!v && typeof v === 'object' && !Array.isArray(v);
const PHASES = ['cold', 'starting', 'idle', 'running', 'needs_permission', 'needs_answer', 'needs_plan', 'rate_limited', 'error'];
const DELIVERY = ['pending', 'queued', 'started', 'folded', 'completed', 'cancelled', 'refused', 'returned'];
const TOOL_STATUS = ['running', 'asking', 'ok', 'error', 'denied', 'withdrawn', 'interrupted'];
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const CHAT_ID = /^[a-z][a-z0-9-]{0,23}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function need(o: unknown, where: string, spec: Record<string, string>): void {
  assert.ok(isObj(o), `${where}: object expected`);
  for (const [k, kind] of Object.entries(spec)) {
    const optional = kind.endsWith('?');
    const v = o[k];
    if (v === undefined) { assert.ok(optional, `${where}.${k} missing`); continue; }
    const kinds = kind.replace('?', '').split('|');
    const ok = kinds.some((t) => (t === 'array' ? Array.isArray(v) : t === 'null' ? v === null : t === 'object' ? isObj(v) : typeof v === t));
    assert.ok(ok, `${where}.${k}: ${kind} expected, got ${JSON.stringify(v)?.slice(0, 60)}`);
  }
}
function stateView(s: unknown, w: string): void {
  need(s, w, { phase: 'string', since: 'number', flags: 'object', pending: 'object', sub: 'string?', subTool: 'string?', error: 'object?', limit: 'object?' });
  assert.ok(PHASES.includes((s as O)['phase'] as string), `${w}.phase`);
  need((s as O)['flags'], `${w}.flags`, { live: 'boolean', unread: 'boolean', bgTasks: 'number', queued: 'number', external: 'object|null', stuck: 'boolean', notStarted: 'boolean' });
  need((s as O)['pending'], `${w}.pending`, { count: 'number', oldestAt: 'number?', kind: 'string?' });
}
function summary(c: unknown, w: string): void {
  need(c, w, { chatId: 'string', accountId: 'string', sessionId: 'string', title: 'string', titleSource: 'string', cwd: 'string', origin: 'string', createdAt: 'number',
    updatedAt: 'number', size: 'number', pinned: 'boolean', archived: 'boolean', muted: 'boolean', keepAlive: 'boolean', state: 'object', activity: 'string',
    expiresInDays: 'number|null', foreignOwner: 'boolean', mode: 'string?', model: 'string?', costUsd: 'number?', wake: 'object?' });
  assert.match((c as O)['chatId'] as string, CHAT_ID, w);
  assert.equal((c as O)['chatId'], `${(c as O)['accountId']}:${(c as O)['sessionId']}`, `${w}: chatId = accountId:sessionId`);
  stateView((c as O)['state'], `${w}.state`);
}
function uiUser(m: unknown, w: string): void {
  need(m, w, { uuid: 'string', text: 'string', origin: 'string', delivery: 'string?' });
  if ((m as O)['delivery'] !== undefined) assert.ok(DELIVERY.includes((m as O)['delivery'] as string), `${w}.delivery`);
}
function block(b: unknown, w: string): void {
  need(b, w, { k: 'string', id: 'string' });
  const o = b as O;
  switch (o['k']) {
    case 'user': assert.match(o['id'] as string, /^u:/); uiUser(o['msg'], `${w}.msg`); break;
    case 'text': assert.match(o['id'] as string, /^a:msg_[^:]+:\d+$/); need(o, w, { md: 'string', model: 'string?', live: 'boolean?', aborted: 'boolean?' }); break;
    case 'thinking': assert.match(o['id'] as string, /^a:msg_[^:]+:\d+$/); need(o, w, { chars: 'number', tokens: 'number?', live: 'boolean?' }); break;
    case 'tool':
      need(o, w, { toolUseId: 'string', name: 'string', input: 'object', status: 'string', askId: 'string?', model: 'string?' });
      assert.equal(o['id'], `t:${o['toolUseId']}`);
      assert.ok(TOOL_STATUS.includes(o['status'] as string));
      need(o['input'], `${w}.input`, { summary: 'string', fields: 'object' });
      break;
    case 'system': need(o, w, { row: 'object' }); break;
    default: assert.fail(`${w}: unknown block kind ${String(o['k'])}`);
  }
}
function chatEvent(ev: unknown, w: string): void {
  need(ev, w, { k: 'string' });
  const e = ev as O;
  switch (e['k']) {
    case 'state': stateView(e['state'], `${w}.state`); break;
    case 'meta': need(e, w, { meta: 'object' }); if ((e['meta'] as O)['mode'] !== undefined) assert.ok(MODES.includes((e['meta'] as O)['mode'] as string)); break;
    case 'metrics': need(e, w, { metrics: 'object' }); break;
    case 'turn.start': need(e['turn'], `${w}.turn`, { id: 'string', at: 'number', user: 'object|null' }); if ((e['turn'] as O)['user']) uiUser((e['turn'] as O)['user'], `${w}.turn.user`); break;
    case 'block': need(e, w, { turnId: 'string', block: 'object' }); block(e['block'], `${w}.block`); break;
    case 'delta': {
      need(e, w, { parts: 'array' });
      for (const p of e['parts'] as unknown[]) assert.ok(Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string', `${w}.parts`);
      break;
    }
    case 'progress': need(e, w, { blockId: 'string', elapsedMs: 'number?', chars: 'number?', tokens: 'number?' }); break;
    case 'tool.result':
      need(e, w, { turnId: 'string', toolUseId: 'string', status: 'string', result: 'object' });
      assert.ok(TOOL_STATUS.includes(e['status'] as string));
      need(e['result'], `${w}.result`, { isError: 'boolean', summary: 'string' });
      break;
    case 'turn.end': need(e, w, { turnId: 'string', footer: 'object' }); need(e['footer'], `${w}.footer`, { input: 'number', cacheRead: 'number', cacheWrite: 'number', output: 'number', models: 'array', auxTokens: 'number?' }); break;
    case 'system': need(e, w, { id: 'string', row: 'object', turnId: 'string?' }); need(e['row'], `${w}.row`, { kind: 'string', text: 'string?' }); break;
    case 'queue':
      need(e, w, { items: 'array' });
      for (const q of e['items'] as unknown[]) { need(q, `${w}.item`, { uuid: 'string', text: 'string', images: 'number', delivery: 'string', priority: 'string?' }); assert.ok(DELIVERY.includes((q as O)['delivery'] as string)); }
      break;
    case 'tasks': need(e, w, { tasks: 'array' }); break;
    case 'todos': assert.ok(e['todos'] === null || Array.isArray(e['todos'])); break;
    case 'reset': assert.ok(['clear', 'rewind', 'resume'].includes(e['reason'] as string)); break;
    default: assert.fail(`${w}: unknown event kind ${String(e['k'])}`);
  }
}
function s2c(m: unknown, w: string): void {
  need(m, w, { t: 'string' });
  const o = m as O;
  switch (o['t']) {
    case 'hello':
      need(o, w, { v: 'number', boot: 'string', now: 'number', settings: 'object', accounts: 'array', chats: 'array', asks: 'array', ui: 'object', drafts: 'object', procs: 'object' });
      need(o['settings'], `${w}.settings`, { port: 'number', browser: 'string', exe: 'string', isolation: 'string', maxLive: 'number', reapMin: 'number|null', prespawn: 'boolean',
        allowBypass: 'boolean', aiTitles: 'boolean', notifications: 'boolean', sound: 'boolean', volume: 'number', onlyWhenAway: 'boolean', dndUntil: 'number|null',
        reopenWindowOnAttention: 'boolean', ctrlEnterSends: 'boolean', shiftTabModes: 'boolean', showOtherOrigins: 'boolean', wakeNeverAsk: 'boolean', theme: 'string',
        density: 'string', defaultView: 'string' });
      for (const a of o['accounts'] as unknown[]) need(a, `${w}.account`, { id: 'string', name: 'string', color: 'number', monogram: 'string', configDir: 'string|null', isDefault: 'boolean', hidden: 'boolean', login: 'string', defaults: 'object', diag: 'object' });
      (o['chats'] as unknown[]).forEach((c, i) => summary(c, `${w}.chats[${i}]`));
      need(o['ui'], `${w}.ui`, { layout: 'number', tabs: 'array', closed: 'array', panes: 'array', focusedPane: 'number', sidebar: 'object', scroll: 'object', views: 'object' });
      need(o['procs'], `${w}.procs`, { live: 'number', max: 'number', effectiveMax: 'number', lowMem: 'boolean', estRamMB: 'number', isolation: 'string', items: 'array' });
      break;
    case 'device-token': need(o, w, { token: 'string' }); break;
    case 'ack': need(o, w, { id: 'number', ok: 'boolean' }); break;
    case 'accounts': need(o, w, { accounts: 'array' }); break;
    case 'chats': need(o, w, { upsert: 'array', remove: 'array', rekey: 'array?' }); (o['upsert'] as unknown[]).forEach((c, i) => summary(c, `${w}.upsert[${i}]`)); break;
    case 'ask':
      need(o['ask'], `${w}.ask`, { chatId: 'string', requestId: 'string', toolUseId: 'string', kind: 'string', toolName: 'string', input: 'object', offerAlways: 'boolean',
        alwaysRules: 'array', offerAuto: 'boolean', defaultToNo: 'boolean', since: 'number', plan: 'string?', planFilePath: 'string?', questions: 'array?' });
      assert.ok(['permission', 'question', 'plan', 'elicitation'].includes((o['ask'] as O)['kind'] as string));
      break;
    case 'askEnd': need(o, w, { chatId: 'string', requestId: 'string', reason: 'string' }); assert.ok(['answered', 'cancelled', 'crash'].includes(o['reason'] as string)); break;
    case 'snap': {
      const s = o['snap'];
      need(s, `${w}.snap`, { chatId: 'string', seq: 'number', state: 'object', meta: 'object', metrics: 'object', queue: 'array', tasks: 'array', todos: 'array|null', live: 'object|null', lastDiskTurnId: 'string|null' });
      stateView((s as O)['state'], `${w}.snap.state`);
      need((s as O)['meta'], `${w}.snap.meta`, { title: 'string', cwd: 'string', mode: 'string' });
      const live = (s as O)['live'];
      if (live) { need(live, `${w}.snap.live`, { id: 'string', at: 'number', blocks: 'array' }); ((live as O)['blocks'] as unknown[]).forEach((b, i) => block(b, `${w}.snap.live.blocks[${i}]`)); }
      break;
    }
    case 'ev': need(o, w, { c: 'string', s: 'number', ev: 'object' }); chatEvent(o['ev'], `${w}.ev`); break;
    case 'procs': need(o, w, { procs: 'object' }); break;
    case 'settings': need(o, w, { settings: 'object' }); break;
    case 'login': need(o, w, { accountId: 'string', step: 'object' }); break;
    case 'orphans': need(o, w, { items: 'array' }); break;
    case 'toast': need(o, w, { level: 'string', key: 'string', args: 'object?', chatId: 'string?' }); assert.ok(['info', 'warn', 'error'].includes(o['level'] as string)); break;
    case 'bye': assert.ok(['quit', 'restart'].includes(o['reason'] as string)); break;
    default: assert.fail(`${w}: unknown S2C type ${String(o['t'])}`);
  }
}

/** Replays a script as a mock server would, with a client that sends a request for every expect step. */
function replay(name: string, steps: ProtocolStep[]): { frames: P.S2C[][]; acks: number } {
  const vars: Record<string, O> = {};
  const frames: P.S2C[][] = [];
  let nextId = 1;
  let acks = 0;
  let snapped = new Map<string, number>();                 // per connection: chatId → last seq seen
  let connected = false;
  const take = (frame: P.S2C[], w: string): void => {
    assert.ok(Array.isArray(frame) && frame.length > 0, `${w}: a frame is a non-empty array`);
    const bound = bindTemplates(frame, vars);
    for (const [i, m] of bound.entries()) {
      s2c(m, `${w}[${i}]`);
      assert.ok(!JSON.stringify(m).includes('$'), `${w}[${i}]: unresolved template`);
      if (m.t === 'snap') snapped.set(m.snap.chatId, m.snap.seq);
      if (m.t === 'ev') {
        assert.ok(snapped.has(m.c), `${w}[${i}]: ev for ${m.c} before its snap on this connection`);
        assert.equal(m.s, snapped.get(m.c)! + 1, `${w}[${i}]: seq contiguous for ${m.c}`);
        snapped.set(m.c, m.s);
      }
    }
    frames.push(bound);
  };
  steps.forEach((st, i) => {
    const w = `${name}#${i}`;
    switch (st.step) {
      case 'meta': assert.equal(i, 0, 'meta first'); assert.equal(st.name, name); break;
      case 'connect': connected = true; snapped = new Map(); break;
      case 'drop': assert.ok(connected, `${w}: drop while connected`); connected = false; break;
      case 'send': assert.ok(connected, `${w}: send needs a connection`); assert.equal(typeof st.delayMs, 'number'); take(st.frame, w); break;
      case 'expect': {
        assert.ok(connected, `${w}: expect needs a connection`);
        // the client sends a request matching the step (fresh uuid/text where the match leaves them free)
        const req: O = { id: nextId++, uuid: crypto.randomUUID(), text: `message ${i}`, ...bindTemplates(st.match, vars) };
        if (req['t'] === 'chat.decide') req['answer'] = { kind: 'allow-once' };
        assert.ok(matchesRequest(st.match, req, vars), `${w}: match is satisfiable`);
        vars['req'] = req;
        if (st.as) vars[st.as] = req;
        const frame = [ackFor(req['id'] as number, st.ack), ...st.then];
        take(frame, w);
        acks++;
        break;
      }
      default: assert.fail(`${w}: unknown step ${JSON.stringify(st)}`);
    }
  });
  return { frames, acks };
}

test('the 8 golden scripts exist and replay cleanly', () => {
  assert.deepEqual([...PROTOCOL_SCRIPTS], ['stream', 'permission', 'question', 'plan', 'queue', 'crash', 'reconnect', 'cap']);
  for (const name of PROTOCOL_SCRIPTS) {
    const steps = loadProtocol(name);
    const { frames, acks } = replay(name, steps);
    assert.ok(frames.length >= 4, name);
    assert.ok(acks >= 2, name);
    assert.equal(frames[0]![0]!.t, 'hello', `${name}: hello first`);
  }
});

test('script semantics: ask before needs_*, askEnd after decide, cap error then evict retry, reconnect keeps seq / new boot resets', () => {
  const perm = replay('permission', loadProtocol('permission')).frames.flat();
  const ask = perm.findIndex((m) => m.t === 'ask');
  const needs = perm.findIndex((m) => m.t === 'ev' && m.ev.k === 'state' && m.ev.state.phase === 'needs_permission');
  assert.ok(ask >= 0 && needs > ask, 'ask is sent before the needs_permission state');
  assert.ok(perm.some((m) => m.t === 'askEnd' && m.reason === 'answered'));
  const cap = loadProtocol('cap').filter((s): s is Extract<ProtocolStep, { step: 'expect' }> => s.step === 'expect' && s.match['t'] === 'chat.send');
  assert.equal(cap[0]!.ack.ok, false);
  assert.equal(!cap[0]!.ack.ok && cap[0]!.ack.err.code, 'cap');
  assert.equal(cap[1]!.match['uuid'], '$A.uuid', 'the retry reuses the same uuid');
  assert.ok(typeof cap[1]!.match['evict'] === 'string');
  const rec = replay('reconnect', loadProtocol('reconnect')).frames.flat();
  const boots = rec.filter((m): m is Extract<P.S2C, { t: 'hello' }> => m.t === 'hello').map((h) => h.boot);
  assert.equal(boots.length, 3);
  assert.equal(boots[0], boots[1], 'same boot after a drop');
  assert.notEqual(boots[1], boots[2], 'new boot after a server restart');
  const snaps = rec.filter((m): m is Extract<P.S2C, { t: 'snap' }> => m.t === 'snap').map((m) => m.snap.seq);
  assert.ok(snaps[1]! > 0 && snaps[2] === 0, `snap seq continues on the same boot, restarts on a new one (${snaps.join(',')})`);
  const queue = replay('queue', loadProtocol('queue')).frames.flat();
  assert.ok(queue.some((m) => m.t === 'ev' && m.ev.k === 'block' && m.ev.block.k === 'user' && m.ev.block.msg.delivery === 'folded'));
  const crash = replay('crash', loadProtocol('crash')).frames.flat();
  assert.ok(crash.some((m) => m.t === 'askEnd' && m.reason === 'crash'));
  assert.ok(crash.some((m) => m.t === 'ev' && m.ev.k === 'queue' && m.ev.items.some((q) => q.delivery === 'returned')));
});
