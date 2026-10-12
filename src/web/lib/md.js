// @ts-check
// src/web/lib/md.js — the ONLY HTML sink of the app (SPEC §10 S5).
// Verified in headless Edge 154 with 11 XSS payloads under Trusted Types. Since then only comments were added (JSDoc
// types for `checkJs`) and one change (ux 5.3): fenced code carries its language label as data-lang on
// <pre>, only when the fence's first word is a short [A-Za-z0-9_+#.-] name (never free text). The 11 payloads were re-run.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
// @ts-ignore -- 'hljs/core' is an import-map name for @highlightjs/cdn-assets/es/core.min.js, which ships no type declarations.
import hljs from 'hljs/core';
/** @param {string} s */
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/**
 * Language label of a fence: the first word of its info string (ts for « ts title=x »), only a short plain name, else ''.
 * @param {string | undefined} lang @returns {string}
 */
export const fenceLang = (lang) => { const w = String(lang ?? '').trim().split(/\s/)[0] ?? ''; return /^[A-Za-z0-9_+#.-]{1,24}$/.test(w) ? w : ''; };
marked.use({ renderer: {
  html: ({ text }) => esc(text),                                   // raw HTML in model output is shown, not rendered
  code: ({ text, lang }) => `<pre${fenceLang(lang) ? ` data-lang="${esc(fenceLang(lang))}"` : ''}><code class="hljs">${
    lang && hljs.getLanguage(lang) && text.length < 50_000 ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : esc(text)
  }</code></pre>`,
} });
const PURIFY = {
  RETURN_TRUSTED_TYPE: true, USE_PROFILES: { html: true },           // no SVG / MathML
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style', 'srcset', 'ping', 'formaction'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
};
DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A') { n.setAttribute('rel', 'noopener noreferrer'); n.removeAttribute('target'); n.setAttribute('data-ext', ''); }
  if (n.tagName === 'IMG' && !/^(data:|blob:)/i.test(n.getAttribute('src') ?? '')) {
    n.removeAttribute('src'); n.setAttribute('alt', '[image distante bloquée]');
  }
});
/** settled markdown -> TrustedHTML for dangerouslySetInnerHTML
 * @param {string} md */
export const renderMarkdown = (md) => DOMPurify.sanitize(marked.parse(md, { async: false }), PURIFY);
// Links: one delegated listener → ws.send({t:'open-url', url}) → server openExternal() (explorer.exe, http/https only).
// (Note: in the final protocol that message is C2S {t:'open', what:'url', target} — SPEC §4 / §6.3.)
