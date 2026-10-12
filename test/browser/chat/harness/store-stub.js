// @ts-nocheck
// test/browser/chat/harness/store-stub.js — minimal store implementing src/web/contract.d.ts (useChat + actions) for the
// chat-surface harness (WP-F, M1). It applies S2C frames the way the real store does: one signal per turn and per
// block, deltas touch only their block signal. Actions are recorded in `calls` and answer plausibly.
import { signal, computed, batch } from '@preact/signals';

export function createStubStore() {
  const chats = signal(new Map());
  const asks = signal([]);
  const accounts = signal([]);
  const settings = signal(null);
  const procs = signal(null);
  const sendIssues = signal(new Map());
  const calls = [];
  const older = new Map();                        // chatId -> pages of UiTurn for loadOlder
  const notPending = new Set();                   // requestIds whose decide answers not_pending (answered elsewhere)
  const recs = new Map();
  const askEnds = new Map();                      // `${chatId}|${requestId}` -> AskEndReason (askEnd frames)
  const ui = { views: {}, scroll: {} };           // UiState.views / scroll as saved by saveView / saveScroll
  const placeholder = (id) => ({ chatId: id, accountId: id.split(':')[0], sessionId: id.split(':')[1] ?? '', title: id, titleSource: 'none', cwd: 'C:\\w',
    origin: 'app', createdAt: 0, updatedAt: 0, size: 0, pinned: false, archived: false, muted: false, keepAlive: false, activity: '',
    state: { phase: 'idle', since: 0, flags: { live: true, unread: false, bgTasks: 0, queued: 0, external: null, stuck: false, notStarted: false }, pending: { count: 0 } },
    expiresInDays: null, foreignOwner: false });
  function rec(id) {
    let r = recs.get(id);
    if (r) return r;
    r = { meta: signal(null), metrics: signal({}), turns: signal([]), turnSigs: new Map(), blockSigs: new Map(), blockTurn: new Map(),
      queue: signal([]), tasks: signal([]), todos: signal(null), hasMore: signal(false), loading: signal(false),
      draft: signal({ text: '', attachments: [], at: 0 }) };
    const summary = computed(() => chats.value.get(id) ?? placeholder(id));
    r.vm = { id, summary, meta: r.meta, metrics: r.metrics, turns: r.turns, blocks: (b) => r.blockSigs.get(b), queue: r.queue, tasks: r.tasks,
      todos: r.todos, asks: computed(() => asks.value.filter((a) => a.chatId === id)), hasMore: r.hasMore, loading: r.loading, draft: r.draft,
      askEndReason: (requestId) => askEnds.get(`${id}|${requestId}`), autoAvailable: computed(() => r.meta.value?.autoAvailable === true) };
    recs.set(id, r);
    return r;
  }
  const upsertChat = (s) => { const m = new Map(chats.value); m.set(s.chatId, s); chats.value = m; };
  function turnOf(r, turnId) {
    let t = r.turnSigs.get(turnId);
    if (!t) {
      t = signal({ id: turnId, at: Date.now(), user: null, blocks: [] });
      r.turnSigs.set(turnId, t);
      r.turns.value = [...r.turns.value, { id: turnId, sig: t }];
    }
    return t;
  }
  function upsertBlock(r, turnId, block) {
    const t = turnOf(r, turnId);
    const bs = r.blockSigs.get(block.id);
    if (bs) bs.value = block; else r.blockSigs.set(block.id, signal(block));
    r.blockTurn.set(block.id, turnId);
    const i = t.value.blocks.findIndex((b) => b.id === block.id);
    const blocks = [...t.value.blocks];
    if (i >= 0) blocks[i] = block; else blocks.push(block);
    t.value = { ...t.value, blocks };
  }
  function patchBlock(r, id, patch, structural) {
    const bs = r.blockSigs.get(id);
    if (!bs) return;
    const next = { ...bs.value, ...patch };
    if (structural) upsertBlock(r, r.blockTurn.get(id), next); else bs.value = next;
  }
  function ev(c, e) {
    const r = rec(c);
    switch (e.k) {
      case 'state': upsertChat({ ...(chats.value.get(c) ?? placeholder(c)), state: e.state }); break;
      case 'meta': r.meta.value = { ...(r.meta.value ?? { title: '', cwd: '', mode: 'default' }), ...e.meta }; break;
      case 'metrics': r.metrics.value = e.metrics; break;
      case 'turn.start': { const t = turnOf(r, e.turn.id); t.value = { ...t.value, ...e.turn }; break; }
      case 'block': upsertBlock(r, e.turnId, e.block); break;
      case 'delta': for (const [id, s] of e.parts) { const b = r.blockSigs.get(id)?.value; if (b) patchBlock(r, id, { md: b.md + s }, false); } break;
      case 'progress': patchBlock(r, e.blockId, { ...(e.chars !== undefined ? { chars: e.chars } : {}), ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
        ...(e.elapsedMs !== undefined ? { elapsedMs: e.elapsedMs } : {}) }, false); break;
      case 'tool.result': patchBlock(r, 't:' + e.toolUseId, { status: e.status, result: e.result }, true); break;
      case 'turn.end': { const t = turnOf(r, e.turnId); t.value = { ...t.value, footer: e.footer }; break; }
      case 'system': upsertBlock(r, e.turnId ?? e.id, { k: 'system', id: e.id, row: e.row }); break;
      case 'queue': r.queue.value = e.items; break;
      case 'tasks': r.tasks.value = e.tasks; break;
      case 'todos': r.todos.value = e.todos; break;
      case 'reset': r.turns.value = []; r.turnSigs.clear(); r.blockSigs.clear(); break;
    }
  }
  /** Applies one S2C frame (an array of messages). */
  function apply(frame) {
    batch(() => {
      for (const m of frame) {
        if (m.t === 'hello') { settings.value = m.settings; accounts.value = m.accounts; chats.value = new Map(m.chats.map((s) => [s.chatId, s])); asks.value = m.asks; }
        else if (m.t === 'chats') { const map = new Map(chats.value); for (const s of m.upsert) map.set(s.chatId, s); for (const id of m.remove) map.delete(id); chats.value = map; }
        else if (m.t === 'ask') asks.value = [...asks.value.filter((a) => a.requestId !== m.ask.requestId), m.ask];
        else if (m.t === 'askEnd') { askEnds.set(`${m.chatId}|${m.requestId}`, m.reason); asks.value = asks.value.filter((a) => a.requestId !== m.requestId); }
        else if (m.t === 'snap') {
          const r = rec(m.snap.chatId), s = m.snap;
          upsertChat({ ...(chats.value.get(s.chatId) ?? placeholder(s.chatId)), state: s.state });
          r.meta.value = s.meta; r.metrics.value = s.metrics; r.queue.value = s.queue; r.tasks.value = s.tasks; r.todos.value = s.todos;
          if (s.live) { const t = turnOf(r, s.live.id); t.value = s.live; for (const b of s.live.blocks) { r.blockSigs.set(b.id, signal(b)); r.blockTurn.set(b.id, s.live.id); } }
        }
        else if (m.t === 'ev') ev(m.c, m.ev);
        else if (m.t === 'procs') procs.value = m.procs;
        else if (m.t === 'settings') settings.value = m.settings;
      }
    });
  }
  let n = 0;
  const rec1 = (name, args, ret) => { calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) }); return ret; };
  const actions = {
    send: (c, text, o) => rec1('send', { c, text, o: o ?? {} }, 'uuid-' + (++n)),
    interrupt: (c) => rec1('interrupt', { c }),
    cancelQueued: async (c, uuid) => rec1('cancelQueued', { c, uuid }, true),
    decide: async (c, requestId, a) => { rec1('decide', { c, requestId, a }); if (notPending.has(requestId)) return 'not_pending';
      const had = asks.value.some((x) => x.requestId === requestId);
      asks.value = asks.value.filter((x) => x.requestId !== requestId); return had ? 'ok' : 'not_pending'; },
    prespawn: (c) => rec1('prespawn', { c }),
    loadOlder: async (c) => {                      // pages set by the test (older turns, oldest first) are prepended
      rec1('loadOlder', { c });
      const r = rec(c), pages = older.get(c) ?? [], page = pages.shift();
      if (!page) { r.hasMore.value = false; return; }
      r.loading.value = true;
      await new Promise((res) => setTimeout(res, 30));
      batch(() => {
        const add = page.map((turn) => {
          const sig = signal(turn);
          r.turnSigs.set(turn.id, sig);
          for (const b of turn.blocks) { r.blockSigs.set(b.id, signal(b)); r.blockTurn.set(b.id, turn.id); }
          return { id: turn.id, sig };
        });
        r.turns.value = [...add, ...r.turns.value];
        r.hasMore.value = pages.length > 0;
        r.loading.value = false;
      });
    },
    detail: async (c, id, f) => rec1('detail', { c, id, f }, { text: 'détail complet' }),
    mentions: async (c, q) => rec1('mentions', { c, q }, [{ path: 'src/parser.ts', dir: false }, { path: 'src', dir: true }]),
    prompts: async (q, c) => rec1('prompts', { q, c }, [{ text: 'Ancien prompt', at: 1, source: 'app' }]),
    setMode: async (c, m, typed) => rec1('setMode', { c, m, typed }),
    setModel: async (c, model, effort) => rec1('setModel', { c, model, effort }),
    rename: async (c, title) => rec1('rename', { c, title }),
    task: async (c, op, ref) => rec1('task', { c, op, ref }),
    rewind: async (c, u, a, d) => rec1('rewind', { c, u, a, d }, { files: d ? [{ path: 'src/a.ts', added: 0, removed: 4 }] : [] }),
    fork: async (c, o) => rec1('fork', { c, o }, 'perso:00000000-0000-4000-8000-00000000f0f0'),
    info: async (c, what) => rec1('info', { c, what }, what === 'context' ? { total: 1000, window: 200000, autoCompactAt: 167000, categories: [], memoryFiles: [] } : null),
    sleep: async (c, s) => rec1('sleep', { c, s }),
    openChat: (c, w) => rec1('openChat', { c, w }),
    openExternal: (u) => rec1('openExternal', { u }),
    toast: (k, a) => rec1('toast', { k, a }),
    // M2 contract additions
    resolveSend: (c, choice) => { rec1('resolveSend', { c, choice }); const m = new Map(sendIssues.value); m.delete(c); sendIssues.value = m; },
    resend: (c, uuid) => rec1('resend', { c, uuid }, 'uuid-' + (++n)),
    search: async (c, q) => { rec1('search', { c, q }); return window.__searchHits ?? []; },
    logClient: (level, msg, c) => { api.logs?.push({ level, msg, c }); },
    terminal: async (c, copyOnly) => rec1('terminal', { c, copyOnly }, { command: 'claude --resume x' }),
    flags: async (c, f) => rec1('flags', { c, f }),
    openPath: (what, target, c) => rec1('openPath', { what, target, c }),
    setSettings: (patch) => { rec1('setSettings', { patch }); settings.value = { ...(settings.value ?? {}), ...patch }; },
    closePane: (c) => rec1('closePane', { c }),
    forceStop: async (c) => rec1('forceStop', { c }),
    retry: async (c) => rec1('retry', { c }),
    saveView: (c, mode) => { rec1('saveView', { c, mode }); ui.views[c] = mode; },
    saveScroll: (c, anchor) => { rec1('saveScroll', { c, anchor }); if (anchor) ui.scroll[c] = anchor; else delete ui.scroll[c]; },
  };
  const api = { chats, asks, accounts, settings, procs, sendIssues, calls, actions, apply, rec, older, notPending, ui, askEnds, logs: null, useChat: (c) => rec(c).vm };
  return api;
}
