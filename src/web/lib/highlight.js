// @ts-check
// src/web/lib/highlight.js — lazy highlight.js loader (@highlightjs/cdn-assets ESM core + an allow-list of languages).
// lib/md.js highlights a fence only when hljs.getLanguage(lang) is already registered; this module
// registers languages on demand (import map prefix "hljs/lang/"), so a frozen block is re-rendered once its languages
// are loaded (idle time, blocks in view only; ux §12.2). The server's static allow-list must include LANGS' files.

/** Languages we ship (file names under @highlightjs/cdn-assets/es/languages/, without ".min.js"): the static allow-list's
 * HLJS_LANGS (src/server/http/static.ts), so every language the server serves is used. */
export const LANGS = Object.freeze(['bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'go', 'ini', 'java', 'javascript', 'json',
  'markdown', 'php', 'plaintext', 'powershell', 'python', 'ruby', 'rust', 'shell', 'sql', 'typescript', 'xml', 'yaml']);

/** @type {Readonly<Record<string, string>>} */
const ALIASES = Object.freeze({
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  sh: 'bash', zsh: 'bash', console: 'shell', shellsession: 'shell',
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  py: 'python', cs: 'csharp', 'c#': 'csharp', html: 'xml', htm: 'xml', svg: 'xml', xhtml: 'xml',
  md: 'markdown', yml: 'yaml', toml: 'ini', jsonc: 'json', json5: 'json', patch: 'diff', text: 'plaintext', txt: 'plaintext',
  h: 'c', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', golang: 'go', rs: 'rust', rb: 'ruby',
});

/** Canonical language name, or null when not shipped. @param {string | undefined | null} lang */
export function normalizeLang(lang) {
  if (!lang) return null;
  const l = lang.trim().toLowerCase().replace(/^language-/, '');
  const n = ALIASES[l] ?? l;
  return LANGS.includes(n) ? n : null;
}

/** Distinct fence languages of a markdown text (canonical names only). @param {string} md */
export function langsIn(md) {
  const out = new Set();
  for (const m of md.matchAll(/^ {0,3}(?:`{3,}|~{3,})\s*([\w#+.-]+)/gm)) {
    const n = normalizeLang(m[1]);
    if (n && n !== 'plaintext') out.add(n);
  }
  return [...out];
}

/** @type {Map<string, Promise<boolean>>} */
const loading = new Map();
/** @type {Set<string>} */
const loaded = new Set();

/** @returns {Promise<{ registerLanguage(n: string, f: unknown): void; getLanguage(n: string): unknown; registerAliases(a: string[], o: { languageName: string }): void }>} */
async function core() {
  // @ts-ignore -- import-map name (see lib/md.js); no type declarations ship with @highlightjs/cdn-assets.
  const m = await import('hljs/core');
  return m.default;
}

/**
 * Register a language with the shared hljs core (the instance lib/md.js uses). Resolves true when available.
 * The aliases above are registered too, so md.js finds ```ts / ```ps1 fences.
 * @param {string} lang @returns {Promise<boolean>}
 */
export function ensureLanguage(lang) {
  const n = normalizeLang(lang);
  if (!n) return Promise.resolve(false);
  let p = loading.get(n);
  if (!p) {
    p = (async () => {
      try {
        const hljs = await core();
        if (hljs.getLanguage(n)) { loaded.add(n); return true; }
        const mod = await import(/* @vite-ignore */ `hljs/lang/${n}.min.js`);
        hljs.registerLanguage(n, mod.default);
        const al = Object.entries(ALIASES).filter(([, v]) => v === n).map(([k]) => k);
        if (al.length) hljs.registerAliases(al, { languageName: n });
        loaded.add(n);
        return true;
      } catch { loading.delete(n); return false; }
    })();
    loading.set(n, p);
  }
  return p;
}

/** Shipped languages of a markdown text that are not registered yet (sync). @param {string} md */
export const missingLangs = (md) => langsIn(md).filter((l) => !loaded.has(l));

/** Load the missing languages of a markdown text; true when at least one became available (re-render then).
 * @param {string} md */
export async function loadLangsFor(md) {
  const miss = missingLangs(md);
  if (!miss.length) return false;
  return (await Promise.all(miss.map(ensureLanguage))).some(Boolean);
}
