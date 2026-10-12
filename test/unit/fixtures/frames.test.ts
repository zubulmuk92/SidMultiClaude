// Sanitized SDK frame fixtures (test/fixtures/frames, pairs): shape, counts and the facts the golden replays rely on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputUuid, loadFrames, loadIndex, loadPair, loadWire, scenario, transcriptRawEntries } from '../../helpers/scenario.ts';
import type { FixtureName, FrameRec } from '../../helpers/scenario.ts';
import { projectKey } from '../../../src/server/util/paths.ts';

const NAMES: FixtureName[] = ['dry', 'fork', 'main', 'plan'];
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

test('538 frames (dry 10, fork 16, main 276, plan 236), every line {t, label, m:{type}}', () => {
  const counts = Object.fromEntries(NAMES.map((n) => [n, loadFrames(n).length]));
  assert.deepEqual(counts, { dry: 10, fork: 16, main: 276, plan: 236 });
  assert.equal(loadIndex().totalFrames, 538);
  for (const n of NAMES) {
    let last = -1;
    for (const f of loadFrames(n)) {
      assert.equal(typeof f.t, 'number');
      assert.ok(f.t >= last, `${n}: time goes forward`);
      last = f.t;
      assert.equal(typeof f.label, 'string');
      assert.equal(typeof f.m.type, 'string');
      assert.notEqual(f.m.type, 'control_request', 'control protocol is not an SDK frame');
      assert.ok(!(f.m.type === 'system' && rec(f.m)['sdk_host_only'] === true), 'sdk_host_only frames are dropped by the SDK');
    }
  }
});

test('stream deltas add up to the final assistant block (text and tool input)', () => {
  for (const n of NAMES) {
    let acc = new Map<string, string>();
    let checked = 0;
    for (const { m } of loadFrames(n)) {
      const e = rec(m['event']);
      if (m.type === 'stream_event' && e['type'] === 'message_start') acc = new Map();
      if (m.type === 'stream_event' && e['type'] === 'content_block_delta') {
        const d = rec(e['delta']);
        const k = `${String(e['index'])}:${String(d['type'])}`;
        acc.set(k, (acc.get(k) ?? '') + str(d['text']) + str(d['partial_json']));
      }
      if (m.type === 'assistant') {
        const b = rec((rec(m['message'])['content'] as unknown[])[0]);
        if (b['type'] === 'text') { assert.ok([...acc.values()].includes(str(b['text'])), `${n}: text deltas == assistant text`); checked++; }
        if (b['type'] === 'tool_use') {
          const streamed = [...acc.entries()].filter(([k]) => k.endsWith('input_json_delta')).flatMap(([, v]) => {
            try { return [JSON.stringify(JSON.parse(v))]; } catch { return []; }            // '' = nothing streamed for that block
          });
          if (streamed.includes(JSON.stringify(b['input']))) checked++;
          // ExitPlanMode: the model streams {} and the CLI injects {plan, planFilePath} into the assistant frame
          else assert.equal(b['name'], 'ExitPlanMode', `${n}: input_json deltas == tool_use input (${String(b['name'])})`);
        }
      }
    }
    if (n !== 'dry') assert.ok(checked > 0, n);
  }
});

function delivery(frames: FrameRec[], uuids: string[]): Record<string, string> {
  const d: Record<string, string> = Object.fromEntries(uuids.map((u) => [u, 'pending']));
  for (const { m } of frames) {
    const u = str(m['command_uuid']);
    if (m.type === 'command_lifecycle' && u in d && d[u] !== 'folded') d[u] = str(m['state']);
    if (m.type === 'result') for (const x of (m['user_message_uuids'] as string[] | undefined) ?? []) if (x !== m['user_message_uuid'] && x in d) d[x] = 'folded';
  }
  return d;
}

test('main fixture: A completed, B folded, C completed, D cancelled; mode trail default › acceptEdits › default; title LIVE-TITLE', () => {
  const frames = loadFrames('main');
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((l) => inputUuid('main', l)) as [string, string, string, string];
  assert.deepEqual(delivery(frames, [A, B, C, D]), { [A]: 'completed', [B]: 'folded', [C]: 'completed', [D]: 'cancelled' });
  const trail: string[] = [];
  for (const { m } of frames) {
    const mode = m.type === 'system' && (m['subtype'] === 'init' || (m['subtype'] === 'status' && m['status'] === null)) ? str(m['permissionMode']) : '';
    if (mode && trail.at(-1) !== mode) trail.push(mode);
  }
  assert.deepEqual(trail, ['default', 'acceptEdits', 'default']);
  const titles = frames.filter((f) => f.m.type === 'system' && f.m['subtype'] === 'session_title_changed').map((f) => str(f.m['title']));
  assert.equal(titles.at(-1), 'LIVE-TITLE');
  assert.deepEqual(loadIndex().fixtures.main.facts.modeTrail, ['default', 'acceptEdits', 'default']);
  // the interrupt during an ask (T1) ends aborted_tools and its lifecycle is cancelled
  const t1 = inputUuid('main', 'T1');
  assert.equal(delivery(frames, [t1])[t1], 'cancelled');
  assert.ok(frames.some((f) => f.m.type === 'result' && f.m['terminal_reason'] === 'aborted_tools'));
  assert.ok(frames.some((f) => f.m.type === 'user' && JSON.stringify(f.m['message']).includes('[Request interrupted by user for tool use]')));
});

test('plan fixture: plan text from the ask input (the assistant copy is stale), Sonnet planning blocks', () => {
  const wire = loadWire('plan');
  const asks = wire.flatMap((w) => ('m' in w && w.m['type'] === 'control_request' && rec(w.m['request'])['subtype'] === 'can_use_tool' ? [rec(w.m['request'])] : []));
  const exits = asks.filter((a) => a['tool_name'] === 'ExitPlanMode');
  assert.equal(exits.length, 2);
  for (const a of exits) { assert.equal(a['requires_user_interaction'], true); assert.ok(str(rec(a['input'])['plan']).length > 0); }
  const copies = loadFrames('plan').filter((f) => f.m.type === 'assistant').map((f) => rec((rec(f.m['message'])['content'] as unknown[])[0])).filter((b) => b['name'] === 'ExitPlanMode');
  assert.equal(copies.length, 2);
  assert.notEqual(str(rec(copies[1]!['input'])['plan']), str(rec(exits[1]!['input'])['plan']), 'second ask: fresh plan ≠ stale assistant copy');
  const models = new Set(loadFrames('plan').filter((f) => f.m.type === 'assistant').map((f) => str(rec(f.m['message'])['model'])));
  assert.deepEqual([...models].sort(), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
});

test('fork fixture: a new session id, different from its source', () => {
  const ids = new Set(loadFrames('fork').map((f) => str(f.m['session_id'])).filter(Boolean));
  assert.deepEqual([...ids], ['aa719553-107b-4579-ac44-e53f12efc6e1']);
  assert.ok(!ids.has('4adf4c63-b504-4be1-804b-92a88963e275'));
  const spawn = loadWire('fork').find((w) => w.dir === 'spawn');
  assert.ok(spawn && spawn.dir === 'spawn' && spawn.args.includes('--fork-session') && spawn.args.some((a) => a.startsWith('--resume=') && a.endsWith('.jsonl')));
});

test('pairs: transcript, frames and inputs agree (session, cwd/project key, prompts, queued_command)', () => {
  for (const n of ['fork', 'main', 'plan'] as const) {
    const p = loadPair(n);
    const sid = loadIndex().fixtures[n].pair!.sessionId;
    assert.ok(p.transcript.some((e) => e['sessionId'] === sid), n);
    assert.ok(p.frames.some((f) => f.m['session_id'] === sid), n);
    const cwd = str(p.transcript.find((e) => typeof e['cwd'] === 'string')?.['cwd']);
    assert.match(cwd, /^C:\\Users\\smc-user\\Projects\\fixtures\\/);
    const init = p.frames.find((f) => f.m.type === 'system' && f.m['subtype'] === 'init');
    assert.ok(str(rec(init?.m['memory_paths'])['auto']).includes(projectKey(cwd)), `${n}: project key of the mapped cwd`);
    for (const i of p.inputs) assert.equal(typeof i.text, 'string');
    assert.ok(transcriptRawEntries(n).every((r) => r.len > 0 && typeof r.e === 'object'));
  }
  const main = loadPair('main');
  const userTexts = new Set(main.transcript.filter((e) => e['type'] === 'user').map((e) => rec(e['message'])['content']).filter((c): c is string => typeof c === 'string'));
  for (const l of ['T1', 'T2', 'T3', 'A', 'C']) assert.ok(userTexts.has(main.inputs.find((i) => i.uuid === inputUuid('main', l))!.text), `prompt ${l} in the transcript`);
  const qc = main.transcript.find((e) => e['type'] === 'attachment' && rec(e['attachment'])['type'] === 'queued_command');
  assert.equal(rec(qc?.['attachment'])['prompt'], main.inputs.find((i) => i.uuid === inputUuid('main', 'B'))!.text, 'folded B is a queued_command attachment');
  for (const e of main.transcript) if (e['type'] === 'attachment' && rec(e['attachment'])['type'] === 'instructions')
    for (const f of (rec(e['attachment'])['files'] as Record<string, unknown>[])) assert.match(str(f['content']), /^\[placeholder: /);
});

test('scenario() builds frames with the recorded shapes', () => {
  const s = scenario({ sessionId: '11111111-2222-4333-8444-555555555555' });
  const u = '22222222-3333-4444-8555-666666666666';
  s.lifecycle(u, 'queued').lifecycle(u, 'started').init().requesting([u]);
  const id = s.text('Bonjour le monde', { parts: 3 });
  s.result({ uuids: [u], text: 'Bonjour le monde' }).lifecycle(u, 'completed');
  const f = s.frames();
  assert.ok(id.startsWith('msg_'));
  assert.deepEqual(f.filter((m) => m.type === 'stream_event').map((m) => rec(m['event'])['type']),
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const r = f.find((m) => m.type === 'result')!;
  assert.deepEqual(r['user_message_uuids'], [u]);
  assert.ok(f.every((m) => m['session_id'] === '11111111-2222-4333-8444-555555555555'));
});
