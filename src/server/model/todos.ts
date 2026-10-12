// src/server/model/todos.ts — the to-do strip from TodoWrite / TaskCreate / TaskUpdate tool inputs (replace semantics).
import type * as P from '../../shared/protocol.ts';
import { arr, num, rec, str } from './blocks.ts';

const STATUS: Record<string, P.TodoItem['status']> = { pending: 'pending', in_progress: 'in_progress', completed: 'completed', blocked: 'blocked' };
export const TODO_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);

/** New to-do list after a todo tool call, or `undefined` when the tool is not a todo tool (list unchanged). */
export function todosFromTool(name: string, input: Record<string, unknown>, prev: readonly P.TodoItem[] | null): P.TodoItem[] | undefined {
  if (name === 'TodoWrite') {
    return arr(input['todos']).map((t) => {
      const r = rec(t);
      const item: P.TodoItem = { text: str(r['content']) || str(r['subject']), status: STATUS[str(r['status'])] ?? 'pending' };
      const af = str(r['activeForm']);
      if (af) item.activeForm = af;
      return item;
    });
  }
  if (name === 'TaskCreate') {
    const item: P.TodoItem = { text: str(input['subject']) || str(input['description']), status: 'pending' };
    const af = str(input['activeForm']);
    if (af) item.activeForm = af;
    return [...(prev ?? []), item];
  }
  if (name === 'TaskUpdate') {
    const list = [...(prev ?? [])];
    const n = num(Number(str(input['taskId']) || String(input['taskId'] ?? '')));
    const i = n !== undefined ? n - 1 : -1;
    const old = list[i];
    if (!old) return list;
    const st = str(input['status']);
    if (st === 'deleted') { list.splice(i, 1); return list; }
    const next: P.TodoItem = { ...old };
    if (STATUS[st]) next.status = STATUS[st]!;
    if (arr(input['addBlockedBy']).length) next.status = 'blocked';
    const subj = str(input['subject']);
    if (subj) next.text = subj;
    const af = str(input['activeForm']);
    if (af) next.activeForm = af;
    list[i] = next;
    return list;
  }
  return undefined;
}
