// @ts-check
// src/web/actions.js — Actions of src/web/contract.d.ts (implemented by the shell, used by the chat surface) + the shell's own commands.
// Rules:
// - send() is optimistic: the chip shows at once (local queue, delivery 'pending'); on a refusal the chip turns
//   'returned' (« Non envoyé · Renvoyer ») or, for cap / external, the send waits in `sendIssues` for the user's choice
//   (CapChoice / banner) and resolveSend() re-sends the SAME uuid with evict / exceed / force.
// - Promise-returning actions reject with the WireError after showing a toast (except the codes the caller handles:
//   decide → not_pending is a value; setMode → forbidden is left to the mode menu).
// - The client never sends a frame above WS_MAX_PAYLOAD_BYTES: images over MAX_IMAGES_TOTAL_BYTES are
//   refused here with a toast (the composer re-encodes first).
import { batch } from '@preact/signals-core';
import { attention } from './derived.js';
import { mergePage, pruneLocalQueue } from './apply.js';
import { onEveryHello, request } from './net.js';
import {
  accounts, chats, getRec, hooks, later, LIMITS, OLDER_PAGE, orphans, overlay, procs, pushToast, recs, sendIssues, settings, TAIL_PAGE, ui, windowState,
} from './store.js';

/** @typedef {import('../shared/protocol.ts').ChatId} ChatId */
/** @typedef {import('../shared/protocol.ts').WireError} WireError */
/** @typedef {import('../shared/protocol.ts').UiState} UiState */
/** @typedef {import('../shared/protocol.ts').ImageInput} ImageInput */
/** @typedef {import('../shared/protocol.ts').UiTurn} UiTurn */
/** @typedef {import('./net.js').AckResult} AckResult */
/** @typedef {import('./net.js').C2SBody} C2SBody */

/**
 * cwd_refused carries no detail: the home folder itself, or a folder inside a Claude profile / the app data (S9).
 * @param {string} path @returns {{ key: string; args?: Record<string, string | number> }}
 */
export function cwdRefusedKey(path) {
  const inside = /(^|[\\/])\.claude(-[^\\/]*)?([\\/]|$)/i.test(path) || /[\\/]AppData[\\/]Local[\\/]SidMultiClaude([\\/]|$)/i.test(path);
  return inside ? { key: 'new.profileRefused', args: { chemin: path } } : { key: 'new.homeRefused' };
}
/**
 * Error code → i18n key (SPEC §6.4). `forbidden` maps to the bypass copy only where the mode menu asks for it (it handles
 * that code itself); elsewhere (rename of a terminal chat, delete…) it is a plain refusal.
 * @param {WireError} err @param {string} [cwd] the folder of a chat.create / setCwd, to tell the two cwd_refused cases apart
 * @returns {{ key: string; args?: Record<string, string | number> }}
 */
export function errorKey(err, cwd) {
  switch (err.code) {
    case 'cap': return { key: 'cap.busy' };
    case 'cap_busy': return { key: 'cap.busy' };
    case 'external': return { key: 'resume.elsewhere', args: { 'où': err.holder.kind } };
    case 'not_logged_in': return { key: 'acc.notConnected' };
    case 'untrusted': return { key: 'trust.title' };
    case 'cwd_missing': return { key: 'resume.cwdMissing', args: { chemin: err.message ?? '' } };
    case 'cwd_too_long': return { key: 'new.tooLong' };
    case 'cwd_refused': return cwdRefusedKey(cwd ?? err.message ?? '');
    case 'exe_missing': return { key: /bundled|embarqu/i.test(err.message ?? '') ? 'exe.bundledMissing' : 'exe.missing' };
    case 'spawn_failed': return { key: 'err.startup', args: { raison: err.message ?? '' } };
    case 'breaker_open': return { key: 'err.breaker' };
    case 'forbidden': return { key: 'shell.err.forbidden' };
    case 'not_pending': return { key: 'perm.elsewhere' };
    case 'timeout': return { key: 'err.timeout' };
    case 'unsupported': return { key: 'err.unsupported' };
    case 'too_large': return { key: 'shell.err.tooLarge' };
    case 'busy': return { key: 'shell.err.busy' };
    case 'internal':
      if (err.message === 'server_restarted') return { key: 'send.serverRestarted' };      // a chat.send (net.js)
      if (err.message === 'restarted') return { key: 'shell.err.restarted' };             // any other request (net.js)
      if (err.message === 'connection_lost') return { key: 'shell.err.connectionLost' };  // not re-sent blindly (net.js)
      return { key: 'shell.err.internal' };
    default: return { key: 'shell.err.internal' };
  }
}
/** @param {WireError} err @param {ChatId} [chatId] */
export function toastError(err, chatId) {
  const { key, args } = errorKey(err);
  pushToast({ level: 'error', key, ...(args ? { args } : {}), ...(chatId ? { chatId } : {}) });
}
/** Resolves with data, or toasts and rejects with the WireError. @param {C2SBody} body @param {{ quiet?: string[] }} [o] */
async function call(body, o = {}) {
  const r = await request(body);
  if (r.ok) return r.data;
  if (!o.quiet?.includes(r.err.code)) toastError(r.err, 'chatId' in body ? /** @type {{ chatId: ChatId }} */ (body).chatId : undefined);
  throw r.err;
}
const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : fallbackUuid());
function fallbackUuid() {
  const h = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}
const utf8Len = (/** @type {string} */ s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length * 3);

/** Room left in a chat.send frame for the request id and the evict / exceed / force extras of a cap retry. */
const FRAME_MARGIN_BYTES = 512;
/**
 * Last-resort checks before a chat.send: text, image count and sizes, and the serialized UTF-8 byte length of the
 * whole frame (JSON escaping can grow control-character text up to 6x) against WS_MAX_PAYLOAD_BYTES.
 * @param {string} text @param {ImageInput[]} images @param {C2SBody} [frame] the chat.send body as it will be sent
 * @returns {string | null} i18n key of the refusal
 */
export function checkSendLimits(text, images, frame) {
  if (utf8Len(text) > LIMITS.MAX_TEXT_BYTES) return 'shell.send.textTooLarge';
  if (images.length > LIMITS.MAX_IMAGES_PER_MESSAGE) return 'composer.image.tooMany';
  let total = 0;
  for (const im of images) {
    if (im.base64.length > LIMITS.MAX_IMAGE_BYTES) return 'shell.send.imageTooLarge';
    total += im.base64.length;
  }
  if (total > LIMITS.MAX_IMAGES_TOTAL_BYTES) return 'shell.send.imagesTooLarge';
  if (frame && utf8Len(JSON.stringify(frame)) + FRAME_MARGIN_BYTES > LIMITS.WS_MAX_PAYLOAD_BYTES) return 'shell.err.tooLarge';
  return null;
}

// ------------------------------------------------------------------ sending
/** @typedef {{ images?: ImageInput[]; priority?: 'later' | 'now'; wake?: 'asIs' | 'summary' }} SendOpts */
/** @param {ChatId} c @param {string} id @param {Partial<import('./store.js').LocalQueueItem>} patch */
function patchChip(c, id, patch) {
  const rec = getRec(c);
  rec.localQueue.value = rec.localQueue.value.map((q) => (q.uuid === id ? { ...q, ...patch } : q));
}
/** @param {ChatId} c @param {string} id */
function dropChip(c, id) {
  const rec = getRec(c);
  rec.localQueue.value = rec.localQueue.value.filter((q) => q.uuid !== id);
}
/** @param {ChatId} c @param {import('./store.js').SendIssue | null} issue */
function setIssue(c, issue) {
  const n = new Map(sendIssues.value);
  if (issue) n.set(c, issue); else n.delete(c);
  sendIssues.value = n;
}

/** @param {ChatId} c @param {string} id @param {string} text @param {SendOpts} o @param {{ evict?: ChatId; exceed?: boolean; force?: boolean }} [extra] */
async function transmit(c, id, text, o, extra = {}) {
  const r = await request(sendBody(c, id, text, o, extra));
  if (r.ok) {
    batch(() => { dropChip(c, id); if (sendIssues.value.get(c)?.uuid === id) setIssue(c, null); pruneLocalQueue(getRec(c)); });
    return;
  }
  const err = r.err;
  // cap_busy: every live chat is busy, shown in a pane or kept active (a 3rd pane on a machine under 1.5 GB
  // free hits it at once): the message waits inline like `cap`, with « Dépasser la limite » / « Annuler » — never a dead end
  if (err.code === 'cap' || err.code === 'cap_busy' || err.code === 'external') {
    setIssue(c, { uuid: id, text, ...(o.images ? { images: o.images } : {}), ...(o.priority ? { priority: o.priority } : {}), ...(o.wake ? { wake: o.wake } : {}), err });
    return;
  }
  batch(() => {
    patchChip(c, id, { delivery: 'returned', returned: true });
    if (sendIssues.value.get(c)?.uuid === id) setIssue(c, null);
  });
  toastError(err, c);
}

/** @param {ChatId} c @param {string} id @param {string} text @param {SendOpts} o @param {{ evict?: ChatId; exceed?: boolean; force?: boolean }} [extra] @returns {C2SBody} */
function sendBody(c, id, text, o, extra = {}) {
  return { t: 'chat.send', chatId: c, uuid: id, text, ...(o.images?.length ? { images: o.images } : {}),
    ...(o.priority ? { priority: o.priority } : {}), ...(o.wake ? { wake: o.wake } : {}), ...extra };
}

/** @param {ChatId} c @param {string} text @param {SendOpts} [o] @returns {string} */
function send(c, text, o = {}) {
  const id = uuid();
  const images = o.images ?? [];
  const rec = getRec(c);
  /** @type {import('./store.js').LocalQueueItem} */
  const chip = { uuid: id, text, images: images.length, ...(o.priority ? { priority: o.priority } : {}), delivery: 'pending', local: true,
    ...(images.length ? { imageData: images } : {}) };
  const refused = checkSendLimits(text, images, sendBody(c, id, text, o));
  if (refused) {
    rec.localQueue.value = [...rec.localQueue.value, { ...chip, delivery: 'returned', returned: true }];
    pushToast({ level: 'error', key: refused, chatId: c });
    return id;
  }
  rec.localQueue.value = [...rec.localQueue.value, chip];
  rememberImages(id, images);
  void transmit(c, id, text, o);
  return id;
}

/**
 * Answer to a cap / external refusal: 'cancel' gives the text back to the composer (draft) and drops the chip.
 * Also callable as resolveSend(c, uuid, choice) (CapChoice passes the uuid it shows).
 * @typedef {{ evict: ChatId } | { exceed: true } | { force: true } | { evict?: ChatId; exceed?: boolean; force?: boolean } | 'cancel'} SendChoice
 * @param {ChatId} c @param {SendChoice | string} a @param {SendChoice} [b]
 */
export function resolveSend(c, a, b) {
  const issue = sendIssues.value.get(c);
  if (!issue) return;
  const byUuid = typeof a === 'string' && a !== 'cancel';
  if (byUuid && a !== issue.uuid) return;
  const choice = /** @type {SendChoice} */ (byUuid ? (b ?? 'cancel') : a);
  setIssue(c, null);
  if (choice === 'cancel') {
    const rec = getRec(c);
    dropChip(c, issue.uuid);
    const d = rec.draft.value;
    if (!d.text.trim()) rec.draft.value = { text: issue.text, attachments: d.attachments, at: Date.now() };
    return;
  }
  const extra = { ...('evict' in choice && choice.evict ? { evict: choice.evict } : {}), ...('exceed' in choice && choice.exceed ? { exceed: true } : {}), ...('force' in choice && choice.force ? { force: true } : {}) };
  void transmit(c, issue.uuid, issue.text, { ...(issue.images ? { images: issue.images } : {}), ...(issue.priority ? { priority: issue.priority } : {}), ...(issue.wake ? { wake: issue.wake } : {}) }, extra);
}

/**
 * Image data of recent sends by uuid (bounded to twice the per-message cap, oldest dropped first), so a message a crash
 * hands back (server queue item `returned`: text + image COUNT only) can be re-sent whole.
 * @type {Map<string, { images: ImageInput[]; n: number }>}
 */
const sentImages = new Map();
let sentImagesBytes = 0;
/** @param {string} id @param {ImageInput[]} images */
function rememberImages(id, images) {
  if (!images.length) return;
  const n = images.reduce((a, im) => a + im.base64.length, 0);
  sentImages.set(id, { images, n });
  sentImagesBytes += n;
  for (const [k, v] of sentImages) {
    if (sentImagesBytes <= 2 * LIMITS.MAX_IMAGES_TOTAL_BYTES || k === id) break;
    sentImages.delete(k);
    sentImagesBytes -= v.n;
  }
}

/**
 * « Renvoyer » on a returned chip: a NEW uuid (SPEC §9.2.6). The chip is a local one (a refused send) or a message the
 * server handed back after a crash: that one first leaves the server queue (chat.cancelQueued → every window).
 * Its images come from `sentImages`; if they are gone, the text returns to the editor instead (never re-sent without them).
 * @param {ChatId} c @param {string} id @returns {string | null}
 */
export function resend(c, id) {
  const rec = getRec(c);
  const chip = rec.localQueue.value.find((q) => q.uuid === id);
  if (chip) {
    dropChip(c, id);
    return send(c, chip.text, { ...(chip.imageData ? { images: chip.imageData } : {}), ...(chip.priority === 'later' || chip.priority === 'now' ? { priority: chip.priority } : {}) });
  }
  const item = rec.serverQueue.value.find((q) => q.uuid === id && q.delivery === 'returned');
  if (!item) return null;
  const images = sentImages.get(id)?.images;
  void request({ t: 'chat.cancelQueued', chatId: c, uuid: id }).then((r) => { if (!r.ok) toastError(r.err, c); });
  if (item.images && !images) {
    const d = rec.draft.value;
    rec.draft.value = { text: d.text.trim() ? `${d.text}\n${item.text}` : item.text, attachments: d.attachments, at: Date.now() };
    pushToast({ level: 'warn', key: 'queue.imagesLost', chatId: c });
    return null;
  }
  return send(c, item.text, { ...(images ? { images } : {}), ...(item.priority === 'later' || item.priority === 'now' ? { priority: item.priority } : {}) });
}

/** @param {ChatId} c @param {string} id @returns {Promise<boolean>} */
async function cancelQueued(c, id) {
  const rec = getRec(c);
  const chip = rec.localQueue.value.find((q) => q.uuid === id);
  if (chip?.returned) { dropChip(c, id); return true; }
  const r = await request({ t: 'chat.cancelQueued', chatId: c, uuid: id });
  if (r.ok) { if (r.data?.cancelled) dropChip(c, id); return Boolean(r.data?.cancelled); }
  toastError(r.err, c);
  return false;
}

// ------------------------------------------------------------------ transcript paging and peek
/** @param {ChatId} c */
async function loadTail(c) {
  const rec = getRec(c);
  if (rec.tailLoading) return;
  rec.tailLoading = true;
  rec.loading.value = true;
  let again = false;
  try {
    const gen = rec.gen;
    const r = await request({ t: 'tx.page', chatId: c, limit: TAIL_PAGE });
    if (rec.gen !== gen) again = true;               // reset / new boot while in flight: that page is stale, ask again
    else if (r.ok && r.data) mergePage(rec, r.data, 'tail');
  } finally { rec.tailLoading = false; rec.loading.value = false; }
  if (again && recs.get(c) === rec) await loadTail(c);
}
/** @param {ChatId} c */
async function loadOlder(c) {
  const rec = getRec(c);
  if (!rec.hasMore.value || rec.loading.value || !rec.cursor) return;
  rec.loading.value = true;
  try {
    const gen = rec.gen;
    const r = await request({ t: 'tx.page', chatId: c, before: rec.cursor, limit: OLDER_PAGE });
    if (rec.gen !== gen) return;                     // the transcript was reset meanwhile: that page no longer fits
    if (r.ok && r.data) mergePage(rec, r.data, 'older');
    else if (!r.ok) toastError(r.err, c);
  } finally { rec.loading.value = false; }
}
const PEEK_TTL_MS = 60_000;
/** @type {Map<ChatId, Promise<UiTurn[]>>} one tx.page in flight per chat (hover prefetch, then Espace) */
const peeking = new Map();
/** Last turns for Peek / Resume preview (tx.page, cached 60 s; never spawns). @param {ChatId} c @returns {Promise<UiTurn[]>} */
export async function peekTurns(c) {
  const rec = getRec(c);
  if (rec.loadedTail && rec.turns.value.length) return rec.turns.value.slice(-LIMITS.PEEK_EXCHANGES * 2).map((x) => x.sig.value);
  if (rec.peekCache && Date.now() - rec.peekCache.at < PEEK_TTL_MS) return rec.peekCache.turns;
  const inFlight = peeking.get(c);
  if (inFlight) return inFlight;
  const p = request({ t: 'tx.page', chatId: c, limit: LIMITS.PEEK_EXCHANGES * 2 }).then((r) => {
    const turns = r.ok && r.data ? /** @type {UiTurn[]} */ (r.data.turns) : [];
    if (r.ok) rec.peekCache = { at: Date.now(), turns };     // a failure is not cached: the next hover asks again
    return turns;
  }).finally(() => { peeking.delete(c); });
  peeking.set(c, p);
  return p;
}
/** @type {ReturnType<typeof setTimeout> | null} */
let prefetchTimer = null;
/** Hover / arrow focus on a row: prefetch after 150 ms. @param {ChatId | null} c */
export function prefetch(c) {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = null;
  if (c) prefetchTimer = later(() => { void peekTurns(c); }, LIMITS.PREFETCH_DEBOUNCE_MS);
}
const prespawnAt = new Map();
/** @param {ChatId} c */
function prespawn(c) {
  const s = chats.value.get(c);
  if (!settings.value?.prespawn || !s || s.state.phase !== 'cold' || s.state.flags.external) return;
  const last = prespawnAt.get(c) ?? 0;
  if (Date.now() - last < 10_000) return;
  prespawnAt.set(c, Date.now());
  void request({ t: 'chat.prespawn', chatId: c });
}

// ------------------------------------------------------------------ chat controls (contract.d.ts)
/** @param {ChatId} c @param {string} requestId @param {import('../shared/protocol.ts').UiAnswer} a @returns {Promise<'ok' | 'not_pending'>} */
async function decide(c, requestId, a) {
  const r = await request({ t: 'chat.decide', chatId: c, requestId, answer: a });
  if (r.ok) return 'ok';
  if (r.err.code === 'not_pending') return 'not_pending';
  toastError(r.err, c);
  throw r.err;
}
/** @param {ChatId} c */
function interrupt(c) {
  void request({ t: 'chat.interrupt', chatId: c }).then((r) => { if (!r.ok) toastError(r.err, c); });
}
/** Phases where a turn is in progress: sleeping then interrupts it. */
const TURN_PHASES = new Set(['running', 'needs_permission', 'needs_answer', 'needs_plan']);
/**
 * Sleep with the confirmations of SPEC §6.3: a chat in the middle of a turn is confirmed first (« Running → the client
 * confirmed first »); background tasks (`busy`) ask sleep.tasks.confirm, then retry with stopTasks. `force`
 * (« Forcer l'arrêt » of a stuck interrupt) skips both.
 * @param {ChatId} c @param {boolean} [stopTasks] @param {boolean} [force]
 */
export async function sleepChat(c, stopTasks, force) {
  const s = chats.value.get(c);
  if (!force && !stopTasks && s && TURN_PHASES.has(s.state.phase)) {
    if (!(await confirmBox({ body: 'shell.sleep.running', args: { titre: s.title || s.sessionId.slice(0, 8) }, ok: 'shell.sleep.ok', danger: true }))) return;
  }
  const r = await request({ t: 'chat.sleep', chatId: c, ...(stopTasks ? { stopTasks: true } : {}), ...(force ? { force: true } : {}) });
  if (r.ok) return;
  if (r.err.code === 'busy' && !stopTasks) {
    const n = chats.value.get(c)?.state.flags.bgTasks ?? 1;
    if (await confirmBox({ body: 'sleep.tasks.confirm', args: { n }, ok: 'shell.sleep.ok', danger: true })) return sleepChat(c, true, force);
    return;
  }
  toastError(r.err, c);
  throw r.err;
}

/** Shell-level confirm dialog (components/dialogs/Confirm.js renders it). @typedef {{ title?: string; body: string; args?: Record<string, string | number>; ok?: string; cancel?: string; danger?: boolean; typed?: string }} ConfirmSpec */
/** @param {ConfirmSpec} spec @returns {Promise<boolean>} */
export function confirmBox(spec) {
  return new Promise((resolve) => { overlay.value = { kind: 'confirm', props: { ...spec, resolve } }; });
}
/** @param {string} kind @param {Record<string, any>} [props] */
export function openOverlay(kind, props) { overlay.value = { kind, ...(props ? { props } : {}) }; }
export function closeOverlay() { overlay.value = null; }

/** @type {import('./contract.d.ts').Actions} */
export const actions = {
  send,
  interrupt,
  cancelQueued,
  decide,
  prespawn,
  loadOlder,
  // tx.detail names the block `blockId`: a string `id` would collide with the numeric request id of every C2S frame.
  detail: (c, id, f) => call(/** @type {C2SBody} */ (/** @type {unknown} */ ({ t: 'tx.detail', chatId: c, blockId: id, field: f }))),
  mentions: async (c, q) => { const r = await request({ t: 'fs.mentions', chatId: c, q }); return r.ok ? r.data ?? [] : []; },
  prompts: async (q, c) => { const r = await request({ t: 'prompts.search', q, ...(c ? { chatId: c } : {}) }); return r.ok ? r.data ?? [] : []; },
  setMode: async (c, m, typed) => { await call({ t: 'chat.setMode', chatId: c, mode: m, ...(typed !== undefined ? { typed } : {}) }, { quiet: ['forbidden'] }); },
  setModel: async (c, model, effort) => { await call({ t: 'chat.setModel', chatId: c, model, effort }); },
  rename: async (c, title) => { await call({ t: 'chat.rename', chatId: c, title: title.trim().slice(0, 200) }); },
  task: async (c, op, ref) => { await call({ t: 'chat.task', chatId: c, op, ...(ref ? { ref } : {}) }); },
  rewind: (c, userUuid, action, dryRun) => call({ t: 'chat.rewind', chatId: c, userUuid, action, dryRun }),
  fork: async (c, o) => /** @type {{ chatId: ChatId }} */ (await call({ t: 'chat.fork', chatId: c, ...(o.upToUuid ? { upToUuid: o.upToUuid } : {}), ...(o.accountId ? { accountId: o.accountId } : {}) })).chatId,
  info: (c, what) => call({ t: 'chat.info', chatId: c, what }),
  sleep: (c, stopTasks) => sleepChat(c, stopTasks),
  openChat: (c, where) => openChat(c, where),
  openExternal: (url) => { if (/^https?:\/\//i.test(url)) void request({ t: 'open', what: 'url', target: url }); },
  toast: (key, args) => { pushToast({ level: 'info', key, ...(args ? { args } : {}) }); },
  // ---- formerly wired loosely through configureChatSurface
  resolveSend: (c, choice) => { resolveSend(c, choice); },
  resend: (c, id) => resend(c, id),
  search: (c, q) => searchChat(c, q),
  logClient: (level, msg, c) => { logClient(level, msg, c); },
  terminal: (c, copyOnly) => openTerminal(c, copyOnly),
  flags: (c, f) => setFlags(c, f),
  openPath: (what, target, c) => { openPath(what, target, c); },
  setSettings: (patch) => { setSettings(patch); },
  closePane: (c) => { closeTab(c); },
  forceStop: (c) => sleepChat(c, false, true),
  retry: (c) => retryChat(c),
  saveView: (c, mode) => { if (ui.value.views[c] !== mode) updateUi((u) => ({ ...u, views: { ...u.views, [c]: mode } })); },
  saveScroll: (c, anchor) => { saveScroll(c, anchor); },
};

/**
 * « Réessayer » / « Relancer » of an error banner: chat.retry resets the chat's crash breaker and clears its error state
 * It never spawns: the user then re-sends (a returned chip only on an explicit « Renvoyer »).
 * @param {ChatId} c
 */
export async function retryChat(c) { await call({ t: 'chat.retry', chatId: c }); }

/**
 * Persists where the user left a chat's transcript (UiState.scroll), so a reload lands at the same place. `null` = at
 * the bottom (follow mode): the key is dropped. Unchanged anchors write nothing (ui.save is debounced anyway).
 * @param {ChatId} c @param {import('./contract.d.ts').ScrollAnchor | null} anchor
 */
export function saveScroll(c, anchor) {
  const cur = ui.value.scroll[c];
  if (!anchor ? !cur : cur && cur.turnId === anchor.turnId && cur.offset === anchor.offset) return;
  updateUi((u) => {
    const scroll = { ...u.scroll };
    if (anchor) scroll[c] = { turnId: anchor.turnId, offset: Math.round(anchor.offset) }; else delete scroll[c];
    return { ...u, scroll };
  });
}

// ------------------------------------------------------------------ layout, tabs, panes (ux §3.4) — a tab is only a view
/** @type {ReturnType<typeof setTimeout> | null} */
let uiTimer = null;
/** @type {number[]} most recently focused pane first */
let paneMru = [0];
let uiSaving = 0;
hooks.uiPending = () => uiTimer !== null || uiSaving > 0;
/** @param {(u: UiState) => UiState} fn */
export function updateUi(fn) {
  const next = fn(ui.value);
  if (next === ui.value) return;
  ui.value = next;
  if (!paneMru.includes(next.focusedPane) || paneMru[0] !== next.focusedPane) paneMru = [next.focusedPane, ...paneMru.filter((i) => i !== next.focusedPane)];
  scheduleUiSave();
  syncView();
}
/** ui.save, debounced 1 s (MetaStore). */
function scheduleUiSave() {
  // at most 1 s late, never postponed — a trailing debounce re-armed by every change (scroll anchors while
  // a chat streams) could hold the layout back for as long as the stream lasts, and a reload then lost the open panes
  if (uiTimer) return;
  uiTimer = later(flushUiSave, LIMITS.META_DEBOUNCE_MS);
}
/** Sends the pending ui.save now (timer, or the page going away). */
export function flushUiSave() {
  if (!uiTimer) return;
  clearTimeout(uiTimer);
  uiTimer = null;
  uiSaving++;
  void request({ t: 'ui.save', ui: ui.value }).finally(() => { uiSaving--; });
}
/**
 * Chats the server removed (deleted from another window, gone from disk): their tabs close, the panes showing them take
 * another open tab, and « Rouvrir l'onglet » forgets them. @param {ChatId[]} ids
 */
export function forgetChats(ids) {
  const gone = new Set(ids);
  const u = ui.value;
  if (!u.tabs.some((c) => gone.has(c)) && !u.panes.some((c) => c !== null && gone.has(c)) && !u.closed.some((c) => gone.has(c))) return;
  updateUi((v) => {
    const tabs = v.tabs.filter((c) => !gone.has(c));
    const free = tabs.filter((x) => !v.panes.includes(x));
    const panes = v.panes.map((p) => (p !== null && gone.has(p) ? (free.shift() ?? null) : p));
    const keep = (/** @type {Record<string, any>} */ r) => Object.fromEntries(Object.entries(r).filter(([k]) => !gone.has(k)));
    return { ...v, tabs, panes, closed: v.closed.filter((c) => !gone.has(c)), views: keep(v.views), scroll: keep(v.scroll) };
  });
}
const MAX_CLOSED = 20;
/** @param {UiState} u @param {ChatId} c */
const withTab = (u, c) => (u.tabs.includes(c) ? u.tabs : [...u.tabs, c]);

/**
 * Opens a chat. 'focused': in the focused pane (or focuses the pane that already shows it: no duplicates);
 * 'newPane': adds a pane up to 4, else replaces the least recently focused one; 'background': tab only.
 * @param {ChatId} c @param {'focused' | 'newPane' | 'background'} [where]
 */
export function openChat(c, where = 'focused') {
  updateUi((u) => {
    const tabs = withTab(u, c);
    const shown = u.panes.indexOf(c);
    if (where === 'background') return { ...u, tabs };
    if (shown >= 0) return { ...u, tabs, focusedPane: shown };
    if (where === 'newPane') {
      const empty = u.panes.indexOf(null);
      if (empty >= 0) { const panes = u.panes.slice(); panes[empty] = c; return { ...u, tabs, panes, focusedPane: empty }; }
      if (u.layout < 4) {
        const layout = /** @type {1 | 2 | 3 | 4} */ (u.layout + 1);
        return { ...u, tabs, layout, panes: [...u.panes, c], focusedPane: u.panes.length };
      }
      const lru = paneMru.filter((i) => i < u.panes.length).at(-1) ?? 0;
      const panes = u.panes.slice(); panes[lru] = c;
      return { ...u, tabs, panes, focusedPane: lru };
    }
    const panes = u.panes.slice();
    panes[u.focusedPane] = c;
    return { ...u, tabs, panes };
  });
}
/** @param {number} i */
export function focusPane(i) { updateUi((u) => (i >= 0 && i < u.panes.length && u.focusedPane !== i ? { ...u, focusedPane: i } : u)); }
/** Shows `c` in pane `i` (tab drop). @param {ChatId} c @param {number} i */
export function showInPane(c, i) {
  updateUi((u) => {
    const panes = u.panes.map((p) => (p === c ? null : p));
    panes[i] = c;
    return { ...u, tabs: withTab(u, c), panes, focusedPane: i };
  });
}
/** Closes a tab (default: the focused one). Claude keeps running. @param {ChatId | null} [c] */
export function closeTab(c) {
  updateUi((u) => {
    const id = c ?? u.panes[u.focusedPane] ?? null;
    if (!id || !u.tabs.includes(id)) return u;
    const tabs = u.tabs.filter((x) => x !== id);
    const idx = u.tabs.indexOf(id);
    const free = tabs.filter((x) => !u.panes.includes(x));
    const panes = u.panes.map((p) => (p === id ? (free[Math.min(idx, free.length - 1)] ?? null) : p));
    return { ...u, tabs, panes, closed: [id, ...u.closed.filter((x) => x !== id)].slice(0, MAX_CLOSED) };
  });
}
export function reopenTab() {
  const u = ui.value;
  const c = u.closed.find((x) => chats.value.has(x));
  if (!c) return;
  updateUi((v) => ({ ...v, closed: v.closed.filter((x) => x !== c) }));
  openChat(c);
}
/** Alt+1…9 (9 = last tab). @param {number} n */
export function tabAt(n) {
  const tabs = ui.value.tabs;
  const c = n >= 9 ? tabs.at(-1) : tabs[n - 1];
  if (c) openChat(c);
}
/** @param {1 | -1} d */
export function tabStep(d) {
  const u = ui.value;
  if (!u.tabs.length) return;
  const cur = u.tabs.indexOf(u.panes[u.focusedPane] ?? '');
  const c = u.tabs[(cur + d + u.tabs.length) % u.tabs.length];
  if (c) openChat(c);
}
/** @param {number} from @param {number} to */
export function moveTab(from, to) {
  updateUi((u) => {
    if (from === to || from < 0 || from >= u.tabs.length) return u;
    const tabs = u.tabs.slice();
    const [x] = tabs.splice(from, 1);
    if (x) tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, x);
    return { ...u, tabs };
  });
}
/** @param {1 | 2 | 3 | 4} [n] Alt+L cycles 1 → 2 → 3 → 4 → 1. */
export function setLayout(n) {
  updateUi((u) => {
    const layout = n ?? /** @type {1 | 2 | 3 | 4} */ ((u.layout % 4) + 1);
    if (layout === u.layout) return u;
    const panes = u.panes.slice(0, layout);
    const free = u.tabs.filter((x) => !panes.includes(x));
    while (panes.length < layout) panes.push(free.shift() ?? null);
    return { ...u, layout, panes, focusedPane: Math.min(u.focusedPane, layout - 1) };
  });
}
export function toggleSidebar() { updateUi((u) => ({ ...u, sidebar: { ...u.sidebar, collapsed: !u.sidebar.collapsed } })); }
/** @param {Partial<UiState['sidebar']>} p */
export function patchSidebar(p) { updateUi((u) => ({ ...u, sidebar: { ...u.sidebar, ...p } })); }

// ------------------------------------------------------------------ view (SPEC §6.2): the chats shown in panes get ev frames
let lastView = '';
/** Sends `view` when it changed (force: after hello, a seq gap or a rekey). @param {boolean} [force] */
export function syncView(force = false) {
  const u = ui.value;
  const full = /** @type {ChatId[]} */ ([...new Set(u.panes.filter((p) => p !== null))]);
  const focused = u.panes[u.focusedPane] ?? null;
  const w = windowState.value;
  const windowFocused = w.visible && w.focused;
  const key = JSON.stringify([full, focused, windowFocused]);
  if (!force && key === lastView) return;
  lastView = key;
  void request({ t: 'view', full, focused, windowFocused });
}
/** Alt+A: next « À traiter » chat (oldest needs first), cycling. */
export function nextAttention() {
  const list = attention.value;                     // the same list as the sidebar's « À traiter »
  if (!list.length) return false;
  const cur = list.findIndex((s) => s.chatId === (ui.value.panes[ui.value.focusedPane] ?? null));
  const next = list[(cur + 1) % list.length];
  if (next) openChat(next.chatId);
  return true;
}

// ------------------------------------------------------------------ shell commands (not in the chat-surface contract)
/** @param {ChatId} c @param {{ pinned?: boolean; archived?: boolean; keepAlive?: boolean; muted?: boolean }} f */
export async function setFlags(c, f) {
  await call({ t: 'chat.flags', chatId: c, ...f });
  if (f.archived) {
    pushToast({ level: 'info', key: 'chat.archived', chatId: c, action: { label: 'shell.undo', run: () => { void setFlags(c, { archived: false }); } }, ttl: 8000 });
    if (ui.value.tabs.includes(c)) closeTab(c);
  }
}
/** Permanent delete: cold only, confirmed (S7). @param {ChatId} c */
export async function deleteChat(c) {
  const s = chats.value.get(c);
  if (!s) return;
  if (s.state.flags.live) { pushToast({ level: 'warn', key: 'shell.delete.live', chatId: c }); return; }
  if (!(await confirmBox({ body: 'chat.delete.confirm', args: { titre: s.title || s.sessionId.slice(0, 8) }, ok: 'shell.delete.ok', danger: true }))) return;
  if (ui.value.tabs.includes(c)) closeTab(c);
  await call({ t: 'chat.delete', chatId: c, confirm: true });
}
/**
 * chat.create. Resolves with the chat id, or with { error } for the codes the dialog shows inline (S9, trust, login).
 * @param {{ accountId: string; cwd: string; title?: string; mode: import('../shared/protocol.ts').PermissionModeId; model?: string; effort?: import('../shared/protocol.ts').Effort; trust?: boolean }} o
 * @returns {Promise<{ chatId: ChatId } | { error: WireError }>}
 */
export async function createChat(o) {
  const r = await request({ t: 'chat.create', ...o });
  if (r.ok) return { chatId: /** @type {{ chatId: ChatId }} */ (r.data).chatId };
  return { error: r.err };
}
/** @param {ChatId} c @param {boolean} copyOnly */
export async function openTerminal(c, copyOnly) {
  const d = /** @type {{ command: string }} */ (await call({ t: 'chat.terminal', chatId: c, copyOnly }));
  if (copyOnly && d?.command) await copyText(d.command);
  return d;
}
/** @param {string} text */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); pushToast({ level: 'info', key: 'shell.copied' }); } catch { pushToast({ level: 'warn', key: 'shell.copyFailed' }); }
}
/** @param {'explorer' | 'vscode'} what @param {string} target @param {ChatId} [c] */
export function openPath(what, target, c) { void request({ t: 'open', what, target, ...(c ? { chatId: c } : {}) }); }
/** @param {string | null} path @returns {Promise<import('../shared/protocol.ts').DirListing | WireError>} */
export async function listDirs(path) { const r = await request({ t: 'fs.dirs', path }); return r.ok ? r.data : r.err; }
/** Optimistic settings patch. @param {Partial<import('../shared/protocol.ts').Settings>} patch */
export function setSettings(patch) {
  if (settings.value) settings.value = { ...settings.value, ...patch };
  void request({ t: 'settings.set', patch }).then((r) => { if (!r.ok) toastError(r.err); });
}
/** @param {ChatId} c @param {string} q */
export async function searchChat(c, q) { const r = await request({ t: 'tx.search', chatId: c, q }); return r.ok ? r.data ?? [] : []; }
/** @param {'warn' | 'error'} level @param {string} msg @param {ChatId} [c] */
export function logClient(level, msg, c) { void request({ t: 'log.client', level, msg: msg.slice(0, 4000), ...(c ? { chatId: c } : {}) }); }
/** @param {number[]} pids */
export async function killOrphans(pids) { orphans.value = null; await call({ t: 'orphans.kill', pids }); }
/** Quit: live chats → confirm app.quit.confirm, then force. */
export async function quitApp() {
  const r = await request({ t: 'app.quit' });
  if (r.ok) return;
  if (r.err.code !== 'busy') { toastError(r.err); return; }
  const n = procs.value?.live ?? [...chats.value.values()].filter((s) => s.state.flags.live).length;
  if (await confirmBox({ body: 'app.quit.confirm', args: { n }, ok: 'shell.quit.ok', danger: true })) await call({ t: 'app.quit', force: true });
}

// ------------------------------------------------------------------ accounts (ux §9)
export const accountCmd = {
  /** @returns {Promise<import('../shared/protocol.ts').AccountCandidate[]>} */
  candidates: async () => { const r = await request({ t: 'account.candidates' }); return r.ok ? r.data ?? [] : []; },
  /** @param {{ configDir: string | null; name: string; color: number; monogram: string }} o */
  add: (o) => call({ t: 'account.add', ...o }),
  /** @param {string} id @param {import('../shared/protocol.ts').AccountPatch} patch */
  update: async (id, patch) => { await call({ t: 'account.update', accountId: id, patch }); },
  /** @param {string} id @param {string} [email] */
  login: async (id, email) => { await call({ t: 'account.login', accountId: id, ...(email ? { email } : {}) }); },
  /** @param {string} id @param {string} code */
  loginCode: async (id, code) => { await call({ t: 'account.loginCode', accountId: id, code: code.trim() }); },
  /** @param {string} id */
  loginCancel: (id) => { void request({ t: 'account.loginCancel', accountId: id }); },
  /** @param {string} id */
  logout: async (id) => {
    const a = accounts.value.find((x) => x.id === id);
    if (!(await confirmBox({ body: 'acc.logout.confirm', args: { compte: a?.name ?? id }, ok: 'shell.logout.ok', danger: true }))) return;
    await call({ t: 'account.logout', accountId: id });
  },
  /** @param {string} id */
  usage: (id) => call({ t: 'account.usage', accountId: id }),
  /** @param {string} id */
  baseline: (id) => call({ t: 'account.baseline', accountId: id }),
};

// ------------------------------------------------------------------ wiring
hooks.loadTail = (c) => { void loadTail(c); };
hooks.resendView = () => { syncView(true); };
hooks.uiChanged = () => { scheduleUiSave(); };
hooks.onRemoved = (ids) => { if (ids.length) forgetChats(ids); };
/** Drafts are ≤ MAX_DRAFT_BYTES on the server (S15): pasted images that do not fit stay in this window only. */
hooks.saveDraft = (c, d) => {
  const fits = (/** @type {import('../shared/protocol.ts').Draft} */ x) => utf8Len(JSON.stringify(x)) <= LIMITS.MAX_DRAFT_BYTES;
  const draft = !d || fits(d) ? d : d.attachments.length && fits({ ...d, attachments: [] }) ? { ...d, attachments: [] } : null;
  if (d && !draft) return;                            // text alone above 1 MB: the server would refuse it every second
  void request({ t: 'draft.save', chatId: c, draft });
};
onEveryHello(() => { syncView(true); });
/** Test seam. */
export function _resetActions() { lastView = ''; paneMru = [0]; if (uiTimer) clearTimeout(uiTimer); uiTimer = null; prespawnAt.clear(); peeking.clear(); }
export { loadTail, send, transmit as _transmit };
