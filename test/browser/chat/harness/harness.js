// @ts-nocheck
// test/browser/chat/harness/harness.js — mounts the real chat surface (Pane, PendingDock, Peek, ChatOverlays) on the
// stub store, and exposes window.__h for the browser tests (apply frames, set panes, read recorded actions). WP-F.
import { html, render } from 'htm/preact';
import { signal } from '@preact/signals';
import { configureChatSurface } from '/app/components/chat/env.js';
import { Pane, ChatOverlays } from '/app/components/chat/Pane.js';
import { Peek } from '/app/components/chat/Peek.js';
import { renderMarkdown } from '/app/lib/md.js';
import { createStubStore } from './store-stub.js';

const store = createStubStore();
const logs = [];
store.logs = logs;
// the whole ChatEnv of components/chat/env.js (typed since M2): contract.d.ts useChat + actions, and the store data
configureChatSurface({
  useChat: store.useChat, actions: store.actions, accounts: store.accounts, settings: store.settings, procs: store.procs,
  summaryOf: (c) => store.chats.value.get(c), sendIssue: (c) => store.sendIssues.value.get(c),
  peekTurns: async (c) => store.rec(c).turns.value.map((x) => x.sig.value),
  savedView: (c) => store.ui.views[c], savedScroll: (c) => store.ui.scroll[c],
});
const panes = signal([]);
const focused = signal(0);
const peek = signal(null);
function App() {
  return html`<div class=${'hz-grid hz-' + Math.max(1, panes.value.length)}>
      ${panes.value.map((c, i) => html`<${Pane} key=${c} chatId=${c} pane=${i} focused=${focused.value === i} />`)}</div>
    ${peek.value ? html`<div class="hz-peek"><${Peek} chatId=${peek.value} onClose=${() => { peek.value = null; }} /></div>` : null}
    <${ChatOverlays} />`;
}
render(html`<${App} />`, document.getElementById('app'));
window.__h = {
  store, logs,
  apply: (frame) => store.apply(frame),
  setPanes: (ids, f = 0) => { panes.value = ids; focused.value = f; },
  peek: (id) => { peek.value = id; },
  calls: (name) => store.calls.filter((c) => !name || c.name === name).map((c) => c.args),
  clearCalls: () => { store.calls.length = 0; },
  setIssue: (c, issue) => { const m = new Map(store.sendIssues.value); m.set(c, issue); store.sendIssues.value = m; },
  md: (text) => { const d = document.createElement('div'); d.className = 'md xss-probe'; d.innerHTML = renderMarkdown(text); document.body.append(d); return d.innerHTML; },
  isTrusted: () => trustedTypes.isHTML(renderMarkdown('x')),
  setOlder: (c, pages) => { store.older.set(c, pages); store.rec(c).hasMore.value = pages.length > 0; },
  notPending: (requestId) => { store.notPending.add(requestId); },
  setSearchHits: (hits) => { window.__searchHits = hits; },
};
document.title = 'READY';
