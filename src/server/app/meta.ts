// src/server/app/meta.ts — MetaStore: chats.json, ui.json, drafts\*.json, settings, app-trusted folders (SPEC §7.1).
// Every write goes through util/fs-guard → json-store: tmp + fsync + rename, a .bak of the previous version,
// debounced 1 s, flushed at shutdown. Light metadata only: conversation content lives in Claude's JSONL.
// Settings + port live in state\settings.json and app-trusted folders in state\trusted.json, not in
// config.json, which AccountStore owns: two debounced writers of one file would overwrite each other.
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../../shared/protocol.ts';
import type { ChatMeta, Clock, Logger, MetaStore } from '../contracts.ts';
import { MAX_LIVE_DEFAULT, MAX_LIVE_MAX, MAX_LIVE_MIN, PORT_DEFAULT, REAP_MIN_CHOICES, REAP_MIN_DEFAULT, SIDEBAR_WIDTH_DEFAULT_PX } from '../../shared/limits.ts';
import { openJsonStore } from '../util/json-store.ts';
import type { JsonStore } from '../util/json-store.ts';
import { fsGuard } from '../util/fs-guard.ts';
import type { FsGuard } from '../util/fs-guard.ts';
import { appPaths, chatIdFromDraftFile, draftFile, pathKey } from '../util/paths.ts';
import { realClock } from '../util/clock.ts';
import { isChatId } from '../util/ids.ts';

export function defaultSettings(): P.Settings {
  return {
    port: PORT_DEFAULT, browser: 'edge', exe: 'installed', isolation: 'job', maxLive: MAX_LIVE_DEFAULT, reapMin: REAP_MIN_DEFAULT,
    prespawn: true, allowBypass: false, aiTitles: false, notifications: true, sound: false, volume: 0.5, onlyWhenAway: true,
    dndUntil: null, reopenWindowOnAttention: true, ctrlEnterSends: false, shiftTabModes: true, showOtherOrigins: true, wakeNeverAsk: false,
    theme: 'system', density: 'comfortable', defaultView: 'normal',
  };
}
export function defaultUi(): P.UiState {
  return { layout: 1, tabs: [], closed: [], panes: [null], focusedPane: 0,
    sidebar: { width: SIDEBAR_WIDTH_DEFAULT_PX, collapsed: false, grouping: 'account', showArchived: false }, scroll: {}, views: {} };
}
/** Unknown or out-of-range stored values fall back to the defaults, key by key (a hand-edited file never breaks boot). */
export function normaliseSettings(raw: unknown): P.Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const out = { ...d } as Record<string, unknown>;
  for (const k of Object.keys(d) as (keyof P.Settings)[]) {
    const v = r[k];
    const dv = d[k];
    if (v === undefined) continue;
    if (k === 'reapMin') { if (REAP_MIN_CHOICES.includes(v as number | null)) out[k] = v; continue; }
    if (k === 'dndUntil') { if (v === null || typeof v === 'number') out[k] = v; continue; }
    if (k === 'maxLive') { if (Number.isInteger(v) && (v as number) >= MAX_LIVE_MIN && (v as number) <= MAX_LIVE_MAX) out[k] = v; continue; }
    if (typeof v === typeof dv) out[k] = v;
  }
  return out as P.Settings;
}

type ChatsFile = Record<P.ChatId, ChatMeta>;
type SettingsFile = { settings: P.Settings };
type TrustedFile = Record<P.AccountId, string[]>;          // pathKey() of each folder trusted in the app

export type MetaStoreImpl = MetaStore & { flushSync(): void };
export function createMetaStore(d: { appDir: string; log: Logger; clock?: Clock; fs?: FsGuard }): MetaStoreImpl {
  const paths = appPaths(d.appDir);
  const clock = d.clock ?? realClock;
  const g = (): FsGuard => d.fs ?? fsGuard();
  for (const dir of [paths.stateDir, paths.draftsDir]) { try { g().mkdirSync(dir, { recursive: true }); } catch (e) { d.log.error('meta: mkdir failed', { err: String(e) }); } }
  const open = <T>(file: string, defaults: () => T, accept: (x: unknown) => T | undefined): JsonStore<T> =>
    openJsonStore<T>({ file, version: 1, defaults, accept, clock, fs: d.fs, log: d.log });
  const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const chats = open<ChatsFile>(paths.chats, () => ({}), (x) => {
    if (!isRec(x)) return undefined;
    const out: ChatsFile = {};
    for (const [k, v] of Object.entries(x)) if (isChatId(k) && isRec(v) && v['chatId'] === k) out[k] = v as ChatMeta;
    return out;
  });
  const ui = open<P.UiState>(paths.ui, defaultUi, (x) => (isRec(x) && Array.isArray(x['tabs']) && Array.isArray(x['panes']) ? { ...defaultUi(), ...(x as P.UiState) } : undefined));
  const settings = open<SettingsFile>(path.join(paths.stateDir, 'settings.json'), () => ({ settings: defaultSettings() }),
    (x) => (isRec(x) ? { settings: normaliseSettings(x['settings']) } : undefined));
  const trusted = open<TrustedFile>(path.join(paths.stateDir, 'trusted.json'), () => ({}), (x) => (isRec(x) ? (x as TrustedFile) : undefined));

  // drafts: one file per chat, loaded once, written debounced (one timer for all pending drafts)
  const drafts: Record<P.ChatId, P.Draft> = {};
  try {
    for (const name of fs.readdirSync(paths.draftsDir)) {
      const id = chatIdFromDraftFile(name);
      if (!id) continue;
      try { const o = JSON.parse(fs.readFileSync(path.join(paths.draftsDir, name), 'utf8')) as { v?: number; data?: P.Draft }; if (o.data && typeof o.data.text === 'string') drafts[id] = o.data; } catch { /* skip */ }
    }
  } catch { /* no drafts dir yet */ }
  const pendingDrafts = new Set<P.ChatId>();
  let draftTimer: { cancel(): void } | null = null;
  async function flushDrafts(): Promise<void> {
    draftTimer?.cancel();
    draftTimer = null;
    const ids = [...pendingDrafts];
    pendingDrafts.clear();
    for (const id of ids) {
      const file = draftFile(paths, id);
      try {
        const dft = drafts[id];
        if (dft) await g().writeFileAtomic(file, JSON.stringify({ v: 1, data: dft }), { backup: false });
        else await g().rm(file, { force: true });
      } catch (e) { d.log.warn('meta: draft write failed', { err: String(e) }); }
    }
  }

  const store: MetaStore = {
    chat: (id) => chats.get()[id],
    chats: () => Object.values(chats.get()),
    upsert(m) { chats.update((c) => { c[m.chatId] = { ...m }; }); },
    patch(id, p) {
      chats.update((c) => {
        const cur = c[id];
        if (!cur) return;
        const next: ChatMeta = { ...cur, ...p };
        for (const k of Object.keys(p) as (keyof ChatMeta)[]) if (p[k] === undefined) delete next[k];
        c[id] = next;
      });
    },
    remove(id) { chats.update((c) => { delete c[id]; }); },
    rekey(from, to) {
      chats.update((c) => {
        const cur = c[from];
        if (!cur) return;
        const sessionId = to.slice(to.indexOf(':') + 1);
        c[to] = { ...cur, chatId: to, sessionId, pendingStart: undefined };
        delete c[to]!.pendingStart;
        delete c[from];
      });
      if (drafts[from]) { drafts[to] = drafts[from]!; delete drafts[from]; pendingDrafts.add(from).add(to); }
      void chats.flush().catch((e) => d.log.error('meta: flush failed', { err: String(e) }));   // flushed at once (§7.1)
    },
    ui: () => ui.get(),
    saveUi(s) { ui.set(s); },
    drafts: () => ({ ...drafts }),
    saveDraft(id, dft) {
      if (dft) drafts[id] = dft; else delete drafts[id];
      pendingDrafts.add(id);
      if (!draftTimer) draftTimer = clock.timer(1_000, () => { void flushDrafts(); });
    },
    settings: () => settings.get().settings,
    saveSettings(p) {
      const next = normaliseSettings({ ...settings.get().settings, ...p });
      settings.set({ settings: next });
      return next;
    },
    appTrusted(accountId, cwd) { return (trusted.get()[accountId] ?? []).includes(pathKey(cwd)); },
    trust(accountId, cwd) {
      trusted.update((t) => { const l = t[accountId] ?? []; const k = pathKey(cwd); if (!l.includes(k)) l.push(k); t[accountId] = l; });
    },
    async flush() {
      await Promise.all([chats.flush(), ui.flush(), settings.flush(), trusted.flush(), flushDrafts()]);
    },
  };
  return Object.assign(store, {
    flushSync() { for (const s of [chats, ui, settings, trusted]) { try { s.flushSync(); } catch (e) { d.log.error('meta: flushSync failed', { err: String(e) }); } } },
  });
}
