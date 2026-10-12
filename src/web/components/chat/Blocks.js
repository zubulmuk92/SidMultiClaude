// @ts-check
// src/web/components/chat/Blocks.js — user messages, assistant text (streaming: settled chunks + tail, ux §12.2),
// thinking. Markdown goes ONLY through lib/md.js (SPEC S5); everything else is a text node.
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { renderMarkdown } from '../../lib/md.js';
import { createSplitter, splitOpenFence } from '../../lib/stream-md.js';
import { ensureLanguage, loadLangsFor, missingLangs } from '../../lib/highlight.js';
import { t, fmtTokens, fmtTime } from './text.js';
import { act, useChatVM } from './env.js';
import { UI } from './consts.js';
import { userLabel } from './model.js';
import { openLightbox } from '../side/Lightbox.js';

/** @typedef {import('../../../shared/protocol.ts').UiBlock} UiBlock */
/** @typedef {import('../../../shared/protocol.ts').ChatId} ChatId */
/** @typedef {Extract<UiBlock, { k: 'text' }>} TextBlock */
/** @typedef {any} Trusted  TrustedHTML from md.js (Preact accepts it in dangerouslySetInnerHTML) */

/** Live view of a block: its own signal when the store has one (deltas touch only this), else the static copy.
 * @template {UiBlock} B @param {ChatId} chatId @param {B} block @returns {B} */
export function useBlock(chatId, block) {
  const sig = useChatVM(chatId).blocks(block.id);
  return /** @type {B} */ (sig ? sig.value : block);
}

/** Settled markdown → TrustedHTML (memoised on the text); fenced code gets « Copier » and its line count (ux §5.3).
 * @param {{ md: string; cls?: string }} p */
export function Markdown({ md, cls }) {
  const ref = useRef(/** @type {{ md: string; out: Trusted } | null} */ (null));
  const box = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [, bump] = useState(0);
  if (!ref.current || ref.current.md !== md) ref.current = { md, out: renderMarkdown(md) };
  useEffect(() => {
    if (!missingLangs(md).length) return;
    let alive = true;
    const idle = window.requestIdleCallback ?? ((/** @type {() => void} */ f) => setTimeout(f, 50));
    loadLangsFor(md).then((more) => {
      if (more && alive) idle(() => { if (alive && ref.current?.md === md) { ref.current = { md, out: renderMarkdown(md) }; bump((x) => x + 1); } });
    });
    return () => { alive = false; };
  }, [md]);
  useCodeCopy(box, ref.current.out);
  return html`<div ref=${box} class=${'md ' + (cls ?? '')} dangerouslySetInnerHTML=${{ __html: ref.current.out }}></div>`;
}

/**
 * Streaming assistant text. While `live`, only the new settled chunk is parsed (once) and the tail is re-parsed at
 * most every 100 ms; inside an open fence the tail is a <pre> filled with textContent. At freeze: one full parse.
 * @param {{ chatId: ChatId; block: TextBlock }} p
 */
export function AssistantText({ chatId, block }) {
  const b = useBlock(chatId, block);
  const st = useRef(/** @type {{ sp: ReturnType<typeof createSplitter>; chunks: { key: number; out: Trusted }[]; n: number; tail: string; tailOut: Trusted | null; tailAt: number; timer: number } | null} */ (null));
  const [, bump] = useState(0);
  useEffect(() => () => { if (st.current?.timer) clearTimeout(st.current.timer); }, []);
  if (!b.live) {
    st.current = null;
    return html`<div class="c-text" data-block=${b.id}>
      <${Markdown} md=${b.md} />
      ${b.aborted ? html`<span class="c-aborted">${t('chat.aborted')}</span>` : null}
      <${ReplyActions} chatId=${chatId} md=${b.md} />
    </div>`;
  }
  if (!st.current) st.current = { sp: createSplitter(), chunks: [], n: 0, tail: '', tailOut: null, tailAt: 0, timer: 0 };
  const s = st.current;
  const r = s.sp.push(b.md);
  if (r.reset) s.chunks = [];
  if (r.chunk) s.chunks.push({ key: s.n++, out: renderMarkdown(r.chunk) });
  if (r.inFence && r.fenceLang) void ensureLanguage(r.fenceLang);
  /** @type {import('preact').ComponentChildren} */ let tail = null;
  if (r.inFence) {
    const f = splitOpenFence(r.tail);
    tail = html`${f.before.trim() ? html`<${Markdown} md=${f.before} />` : null}<pre class="c-livecode"><code>${f.code}</code></pre>`;
  } else if (r.tail) {
    const now = performance.now();
    if (s.tail !== r.tail && (now - s.tailAt >= UI.TAIL_REPARSE_MS || !s.tailOut)) {
      s.tail = r.tail; s.tailOut = renderMarkdown(r.tail); s.tailAt = now;
    } else if (s.tail !== r.tail && !s.timer) {
      s.timer = setTimeout(() => { s.timer = 0; bump((x) => x + 1); }, UI.TAIL_REPARSE_MS);
    }
    tail = html`<div class="md md-tail" dangerouslySetInnerHTML=${{ __html: s.tailOut }}></div>`;
  }
  return html`<div class="c-text c-live" data-block=${b.id} aria-busy="true">
    ${s.chunks.map((c) => html`<div key=${c.key} class="md" dangerouslySetInnerHTML=${{ __html: c.out }}></div>`)}
    ${tail}<span class="c-caret" aria-hidden="true">▍</span>
  </div>`;
}

/** Hover actions on a finished reply: copy the raw markdown, quote into the draft. @param {{ chatId: ChatId; md: string }} p */
function ReplyActions({ chatId, md }) {
  const vm = useChatVM(chatId);
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(md).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  const quote = () => {
    const q = md.split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
    vm.draft.value = { ...vm.draft.value, text: q + vm.draft.value.text, at: Date.now() };
  };
  return html`<div class="c-reply-actions">
    <button type="button" class="c-mini" onClick=${copy}>${copied ? t('chat.copied') : t('chat.copyReply')}</button>
    <button type="button" class="c-mini" onClick=${quote}>${t('chat.quote')}</button>
  </div>`;
}

/** Collapsed « Réflexion · 1,2 k tokens ▸ »; the text is fetched on expand (heavy stash, `detail`).
 * @param {{ chatId: ChatId; block: Extract<UiBlock, { k: 'thinking' }>; expanded: boolean }} p */
export function ThinkingBlock({ chatId, block, expanded }) {
  const b = useBlock(chatId, block);
  const [open, setOpen] = useState(expanded);
  const [text, setText] = useState(/** @type {string | null} */ (null));
  const [err, setErr] = useState(false);
  useEffect(() => { setOpen(expanded); }, [expanded]);
  useEffect(() => {
    if (!open || b.live || b.redacted || text !== null) return;
    act().detail(chatId, b.id, 'thinking').then((d) => setText(d.text ?? ''), () => setErr(true));
  }, [open, b.live, b.redacted]);
  if (b.redacted) return html`<div class="c-thinking" data-block=${b.id}>${t('chat.thinking.redacted')}</div>`;
  const label = b.live && !b.tokens ? t('chat.thinking.live')
    : b.tokens ? t('chat.thinking', { n: fmtTokens(b.tokens) })
    : b.chars ? t('chat.thinking.chars', { n: fmtTokens(b.chars) })
    : t('chat.thinking.plain');                                     // the CLI sent neither text nor a token estimate
  return html`<div class="c-thinking" data-block=${b.id} aria-label=${t('a11y.thinking')}>
    <button type="button" class="c-disclosure" aria-expanded=${open} disabled=${b.live} onClick=${() => setOpen(!open)}>
      ${label} ${b.live ? '' : open ? '▾' : '▸'}</button>
    ${open && !b.live ? html`<div class="c-thinking-text">${err ? t('tool.detail.error') : text ?? t('chat.loading')}</div>` : null}
  </div>`;
}

/** A user message (« Vous » or its origin), text as a text node, image chips (thumbnail on demand → lightbox).
 * @param {{ chatId: ChatId; msg: import('../../../shared/protocol.ts').UiUserMsg; at?: number; head?: boolean }} p */
export function UserMessage({ chatId, msg, at, head }) {
  const label = userLabel(msg);
  const cls = 'c-user' + (msg.origin === 'human' ? '' : ' c-user-' + msg.origin) + (head ? ' c-user-head' : ' c-user-folded');
  return html`<div class=${cls} data-uuid=${msg.uuid}>
    <div class="c-user-label">${label}${at ? html` · <time>${fmtTime(at)}</time>` : null}</div>
    <div class="c-user-text">${msg.text}</div>
    ${msg.images?.length ? html`<div class="c-user-images">${msg.images.map((im, k) => html`
      <button type="button" class="c-chip c-imgchip" title=${im.approxTokens ? t('composer.image', { n: fmtTokens(im.approxTokens) }) : im.mediaType}
        onClick=${() => openLightbox(chatId, im.ref, im.mediaType)}>🖼 ${t('tool.image', { taille: String(k + 1) })}</button>`)}</div>` : null}
  </div>`;
}

/** Decorates fenced code blocks of a rendered markdown container with a « Copier » button (DOM API, no HTML sink).
 * @param {{ current: HTMLElement | null }} ref @param {unknown} dep */
export function useCodeCopy(ref, dep) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const pre of root.querySelectorAll('.md pre')) {
      if (pre.querySelector(':scope > .c-copy')) continue;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'c-copy'; btn.textContent = t('md.copy').split(' · ')[0] ?? '';
      const n = (pre.querySelector('code')?.textContent ?? '').replace(/\n$/, '').split('\n').length;
      btn.title = t('md.lines', { n });
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code')?.textContent ?? '';
        void navigator.clipboard?.writeText(code).then(() => { btn.textContent = t('md.copy').split(' · ')[1] ?? ''; });
      });
      pre.prepend(btn);
      const lang = /** @type {HTMLElement} */ (pre).dataset['lang'];          // set by lib/md.js (ux 5.3), text only
      if (lang && !pre.querySelector(':scope > .c-lang')) {
        const tag = document.createElement('span');
        tag.className = 'c-lang'; tag.textContent = lang;
        pre.prepend(tag);
      }
    }
  }, [dep]);
}
