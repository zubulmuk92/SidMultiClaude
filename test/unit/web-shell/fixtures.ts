// test/unit/web-shell/fixtures.ts — small protocol builders for the WP-E tests.
import type * as P from '../../../src/shared/protocol.ts';

export const SETTINGS: P.Settings = { port: 41731, browser: 'edge', exe: 'installed', isolation: 'job', maxLive: 4, reapMin: 60, prespawn: true,
  allowBypass: false, aiTitles: false, notifications: true, sound: false, volume: 0.6, onlyWhenAway: true, dndUntil: null,
  reopenWindowOnAttention: true, ctrlEnterSends: false, shiftTabModes: false, showOtherOrigins: true, wakeNeverAsk: false,
  theme: 'system', density: 'compact', defaultView: 'normal' };
export const UI: P.UiState = { layout: 1, tabs: [], closed: [], panes: [null], focusedPane: 0,
  sidebar: { width: 280, collapsed: false, grouping: 'account', showArchived: false }, scroll: {}, views: {} };
export const sid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
export const cid = (n: number, acc = 'perso'): string => `${acc}:${sid(n)}`;
export function state(phase: P.ChatPhase, since = 1000, o: Partial<P.ChatStateView> & { unread?: boolean; external?: P.ExternalHolder | null } = {}): P.ChatStateView {
  const { unread, external, ...rest } = o;
  return { phase, since, flags: { live: phase !== 'cold', unread: unread ?? false, bgTasks: 0, queued: 0, external: external ?? null, stuck: false, notStarted: false },
    pending: { count: 0 }, ...rest };
}
export function summary(n: number, o: Partial<P.ChatSummary> = {}, acc = 'perso'): P.ChatSummary {
  return { chatId: cid(n, acc), accountId: acc, sessionId: sid(n), title: `Chat ${n}`, titleSource: 'custom', cwd: `C:\\proj\\p${n % 3}`, origin: 'app',
    createdAt: 0, updatedAt: 1000 + n, size: 100, pinned: false, archived: false, muted: false, keepAlive: false, state: state('cold'),
    activity: '', expiresInDays: null, foreignOwner: false, ...o };
}
export function accountView(id: string, name: string, color: number): P.AccountView {
  return { id, name, color, monogram: name.charAt(0), configDir: null, isDefault: id === 'perso', hidden: false, login: 'connected', defaults: {},
    diag: { leakFiles: [], leakExcluded: false, resumeStable: true, cleanupDays: 30, expiringSoon: 0 } };
}
export function hello(boot: string, chats: P.ChatSummary[], o: Partial<Extract<P.S2C, { t: 'hello' }>> = {}): Extract<P.S2C, { t: 'hello' }> {
  return { t: 'hello', v: 1, boot, now: Date.now(), settings: SETTINGS, accounts: [accountView('perso', 'Perso', 1), accountView('pro', 'ACME', 2)],
    chats, asks: [], ui: UI, drafts: {}, procs: { live: 0, max: 4, effectiveMax: 4, lowMem: false, estRamMB: 0, isolation: 'job', items: [] }, ...o };
}
export function snap(chatId: string, seq: number, o: Partial<P.ChatSnapshot> = {}): P.ChatSnapshot {
  return { chatId, seq, state: state('idle'), meta: { title: 't', cwd: 'C:\\proj', mode: 'default' }, metrics: {}, queue: [], tasks: [], todos: null,
    live: null, lastDiskTurnId: null, ...o };
}
export function turn(id: string, text: string, blocks: P.UiBlock[] = []): P.UiTurn {
  const uuid = id.slice(2);
  const user: P.UiUserMsg = { uuid, text, origin: 'human' };
  return { id, at: 1, user, blocks: [{ k: 'user', id, msg: user }, ...blocks] };
}
