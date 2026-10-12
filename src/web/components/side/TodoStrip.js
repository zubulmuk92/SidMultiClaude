// @ts-check
// src/web/components/side/TodoStrip.js — « Tâches n/total · ◐ en cours » strip above the queue (ux §7.1): collapsed by
// default, Alt+T expands it (up to 7 items), hidden without a task list. Stays visible in Focus view.
import { html } from 'htm/preact';
import { t } from '../chat/text.js';
import { chatUi, useChatVM } from '../chat/env.js';
import { UI } from '../chat/consts.js';

/** @typedef {import('../../../shared/protocol.ts').TodoItem} TodoItem */

const GLYPH = /** @type {const} */ ({ pending: '☐', in_progress: '◐', completed: '☑', blocked: '⊘' });

/** Strip summary (pure). @param {TodoItem[]} todos */
export function todoSummary(todos) {
  const done = todos.filter((x) => x.status === 'completed').length;
  const cur = todos.find((x) => x.status === 'in_progress');
  return { done, total: todos.length, active: cur ? (cur.activeForm || cur.text) : '' };
}

/** @param {{ chatId: string }} p */
export function TodoStrip({ chatId }) {
  const vm = useChatVM(chatId);
  const u = chatUi(chatId);
  const todos = vm.todos.value;
  if (!todos || !todos.length) return null;
  const s = todoSummary(todos);
  const open = u.todosOpen.value;
  return html`<div class=${'s-todos' + (open ? ' s-open' : '')}>
    <button type="button" class="c-disclosure s-todo-line" aria-expanded=${open} title="Alt+T" onClick=${() => { u.todosOpen.value = !open; }}>
      ${t('tasks.strip', { fait: s.done, total: s.total, activeForm: s.active ? '◐ ' + s.active : '' }).replace(/ · $/, '')} ${open ? '▾' : '▸'}
    </button>
    ${open ? html`<ul class="s-todo-list">${todos.slice(0, UI.BOTTOM_STRIP_MAX_TODOS).map((x) => html`<li class=${'s-todo s-' + x.status}>
      <span aria-hidden="true">${GLYPH[x.status]}</span> ${x.status === 'in_progress' && x.activeForm ? x.activeForm : x.text}
      ${x.status === 'blocked' ? html` <small>(${t('todo.blocked')})</small>` : null}</li>`)}
      ${todos.length > UI.BOTTOM_STRIP_MAX_TODOS ? html`<li class="s-todo-more">… +${todos.length - UI.BOTTOM_STRIP_MAX_TODOS}</li>` : null}</ul>` : null}
  </div>`;
}
