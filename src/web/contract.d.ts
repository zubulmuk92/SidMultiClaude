// src/web/contract.d.ts — shell/store <-> chat surface contract. Types only. It formalises
// what the chat surface used to receive loosely through configureChatSurface (cap choice, Renvoyer, search, retry, scroll...).
import type { ReadonlySignal, Signal } from '@preact/signals-core';
import type * as P from '../shared/protocol.ts';

export interface ChatVM {
  id: P.ChatId;
  summary: ReadonlySignal<P.ChatSummary>;
  meta: ReadonlySignal<P.ChatMetaView | null>;
  metrics: ReadonlySignal<P.ChatMetrics>;
  turns: ReadonlySignal<{ id: string; sig: Signal<P.UiTurn> }[]>;   // one signal per turn; streaming touches one block only
  blocks: (blockId: string) => Signal<P.UiBlock> | undefined;
  queue: ReadonlySignal<P.QueueItem[]>; tasks: ReadonlySignal<P.TaskView[]>; todos: ReadonlySignal<P.TodoItem[] | null>;
  asks: ReadonlySignal<P.PendingAsk[]>;                               // oldest first
  hasMore: ReadonlySignal<boolean>; loading: ReadonlySignal<boolean>;
  draft: Signal<P.Draft>;
  /** Why an ask left the dock (askEnd frame): 'cancelled' / 'crash' show « Demande annulée ». Undefined while pending or unknown. */
  askEndReason(requestId: string): P.AskEndReason | undefined;
  /** meta.autoAvailable === true (ModelInfo.supportsAutoMode of the current model); false hides Auto (mode menu, plan card). */
  autoAvailable: ReadonlySignal<boolean>;
}
/** Answer to a cap / external refusal of chat.send: the SAME uuid is re-sent with evict / exceed / force; 'cancel' gives the text back. */
export type SendChoice = { evict: P.ChatId } | { exceed: true } | { force: true } | 'cancel';
/** The last chat.send of a chat refused with cap / external, waiting for the user's SendChoice. */
export interface SendIssue {
  uuid: P.Uuid; text: string; images?: P.ImageInput[]; priority?: 'later' | 'now'; wake?: 'asIs' | 'summary'; err: P.WireError;
}
/** Saved scroll position of a chat (UiState.scroll, persisted across reloads). */
export type ScrollAnchor = { turnId: string; offset: number };
export interface Actions {
  send(c: P.ChatId, text: string, o?: { images?: P.ImageInput[]; priority?: 'later' | 'now'; wake?: 'asIs' | 'summary' }): P.Uuid; // optimistic chip
  interrupt(c: P.ChatId): void;
  cancelQueued(c: P.ChatId, uuid: P.Uuid): Promise<boolean>;
  decide(c: P.ChatId, requestId: string, a: P.UiAnswer): Promise<'ok' | 'not_pending'>;
  prespawn(c: P.ChatId): void;
  loadOlder(c: P.ChatId): Promise<void>;
  detail(c: P.ChatId, id: string, f: P.DetailField): Promise<P.DetailPayload>;
  mentions(c: P.ChatId, q: string): Promise<P.FileHit[]>;
  prompts(q: string, c?: P.ChatId): Promise<P.PromptHit[]>;
  setMode(c: P.ChatId, m: P.PermissionModeId, typed?: string): Promise<void>;
  setModel(c: P.ChatId, model: string | null, effort: P.Effort | null): Promise<void>;
  rename(c: P.ChatId, title: string): Promise<void>;
  task(c: P.ChatId, op: 'stop' | 'background' | 'stopAll', ref?: string): Promise<void>;
  rewind(c: P.ChatId, userUuid: P.Uuid, action: 'both' | 'conv' | 'code', dryRun: boolean): Promise<P.RewindPreview>;
  fork(c: P.ChatId, o: { upToUuid?: P.Uuid; accountId?: P.AccountId }): Promise<P.ChatId>;
  info(c: P.ChatId, what: 'context' | 'rules' | 'session' | 'commands'): Promise<unknown>;
  sleep(c: P.ChatId, stopTasks?: boolean): Promise<void>;
  openChat(c: P.ChatId, where?: 'focused' | 'newPane' | 'background'): void;
  openExternal(url: string): void;
  toast(key: string, args?: Record<string, string | number>): void;
  // ---- formerly wired loosely through configureChatSurface
  resolveSend(c: P.ChatId, choice: SendChoice): void;                 // cap choice: retry the same uuid (evict / exceed / force) or cancel
  resend(c: P.ChatId, uuid: P.Uuid): P.Uuid | null;                    // « Renvoyer » a returned chip: NEW uuid (SPEC §9.2.6)
  search(c: P.ChatId, q: string): Promise<P.SearchHit[]>;              // tx.search
  logClient(level: 'warn' | 'error', msg: string, c?: P.ChatId): void; // log.client
  terminal(c: P.ChatId, copyOnly: boolean): Promise<{ command: string }>; // chat.terminal
  flags(c: P.ChatId, f: { keepAlive?: boolean; muted?: boolean; pinned?: boolean }): Promise<void>; // chat.flags
  openPath(what: 'explorer' | 'vscode', target: string, c?: P.ChatId): void; // open
  setSettings(patch: Partial<P.Settings>): void;                       // settings.set (optimistic)
  closePane(c: P.ChatId): void;                                        // closes the tab / pane (Claude keeps running)
  forceStop(c: P.ChatId): Promise<void>;                               // chat.sleep{force} (« Forcer l'arrêt », SPEC §9.2.7)
  retry(c: P.ChatId): Promise<void>;                                   // chat.retry: reset the crash breaker + error state; never spawns
  saveView(c: P.ChatId, mode: P.ViewMode): void;                       // UiState.views
  saveScroll(c: P.ChatId, anchor: ScrollAnchor | null): void;          // UiState.scroll (null = at the bottom, follow)
}
export declare function useChat(c: P.ChatId): ChatVM;   // the shell implements; the chat surface consumes
export declare const actions: Actions;                   // the shell implements; the chat surface consumes
// Store data the chat surface reads (store.js, typed there): accounts, settings, procs, chats (summaryOf),
// sendIssues (SendIssue per chat), ui (views, scroll). Test harnesses replace them through configureChatSurface (typed).
// Chat-surface exports (the shell mounts them): Pane({chatId, pane, focused}), Peek({chatId, onClose}), PendingDock({chatId, compact?}),
// ChatOverlays() (Rewind, ContinueOn, Wake, ModelSwitchConfirm, CapChoice, Lightbox, AgentsDrawer)
