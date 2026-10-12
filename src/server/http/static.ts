// src/server/http/static.ts — import map + exact-key static allow-list built at boot (SPEC §10 S2/S16).
// No request path is ever joined onto a directory: the guard serves only the keys of this Map.
// - /app/<rel>    every browser file under src/web (.js .css .svg .png .ico .woff2 .json); never .ts / .d.ts / index.html
// - /vendor/<pkg> the files reachable from each import-map target through relative imports (ESM graph walk)
//                 plus the highlight.js languages of HLJS_LANGS (loaded with import(`hljs/lang/${l}.min.js`))
// - /favicon.svg  assets/favicon.svg
// scripts/vendor-audit.mjs recomputes the graph independently and fails on any drift.
import fs from 'node:fs';
import path from 'node:path';
import type { StaticEntry } from './guard.ts';

/** Import-map name → path inside node_modules (bare specifiers allowed in browser code). */
export const IMPORTS: Readonly<Record<string, string>> = Object.freeze({
  'preact': 'preact/dist/preact.mjs',
  'preact/hooks': 'preact/hooks/dist/hooks.mjs',
  'htm': 'htm/dist/htm.module.js',
  'htm/preact': 'htm/preact/index.module.js',
  '@preact/signals': '@preact/signals/dist/signals.module.js',
  '@preact/signals-core': '@preact/signals-core/dist/signals-core.module.js',
  'marked': 'marked/lib/marked.esm.js',
  'dompurify': 'dompurify/dist/purify.es.mjs',
  'hljs/core': '@highlightjs/cdn-assets/es/core.min.js',
});
/** Prefix mapping for the lazy languages: import(`hljs/lang/${l}.min.js`). */
export const HLJS_LANG_PREFIX = { name: 'hljs/lang/', dir: '@highlightjs/cdn-assets/es/languages/' } as const;
/** The highlight.js languages the app may load lazily (about a dozen, SPEC §0.2). Anything else stays plain text. */
export const HLJS_LANGS: readonly string[] = Object.freeze([
  'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'go', 'ini', 'java', 'javascript', 'json', 'markdown', 'php', 'plaintext',
  'powershell', 'python', 'ruby', 'rust', 'shell', 'sql', 'typescript', 'xml', 'yaml',
]);
export const APP_EXTS = new Set(['.js', '.css', '.svg', '.png', '.ico', '.woff2', '.json']);

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
};
export const mimeOf = (file: string): string => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** Same specifier scan as scripts/vendor-audit.mjs (static and literal dynamic imports, re-exports). */
export const IMPORT_RE = /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** Every file reachable from `entry` through relative specifiers (bare ones are collected in `bare`). */
export function walkEsm(entry: string, seen: Set<string> = new Set(), bare: Set<string> = new Set(), missing: Set<string> = new Set()): { files: Set<string>; bare: Set<string>; missing: Set<string> } {
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    let src: string;
    try { src = fs.readFileSync(file, 'utf8'); } catch { missing.add(file); continue; }
    seen.add(file);
    if (!/\.m?js$/i.test(file)) continue;
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      if (spec.startsWith('.')) stack.push(path.resolve(path.dirname(file), spec));
      else bare.add(spec);
    }
  }
  return { files: seen, bare, missing };
}

function listApp(webRoot: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(webRoot, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listApp(webRoot, r));
    else if (e.isFile() && APP_EXTS.has(path.extname(e.name).toLowerCase()) && !/\.d\.ts$/i.test(e.name)) out.push(r);
  }
  return out;
}

export function vendorUrl(nodeModules: string, file: string): string {
  return '/vendor/' + path.relative(nodeModules, file).split(path.sep).join('/');
}

export function buildStatic(o: { webRoot: string; nodeModules: string; assetsDir?: string }): { importMap: string; files: Map<string, StaticEntry>; indexHtml: string } {
  const files = new Map<string, StaticEntry>();
  const add = (url: string, file: string): void => { files.set(url, { file, type: mimeOf(file) }); };
  for (const r of listApp(o.webRoot)) add(`/app/${r}`, path.join(o.webRoot, ...r.split('/')));
  const imports: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, rel] of Object.entries(IMPORTS)) {
    const target = path.join(o.nodeModules, ...rel.split('/'));
    if (!fs.existsSync(target)) throw new Error(`static: vendor entry missing: ${rel}`);
    imports[name] = vendorUrl(o.nodeModules, target);
    walkEsm(target, seen);
  }
  imports[HLJS_LANG_PREFIX.name] = '/vendor/' + HLJS_LANG_PREFIX.dir;
  for (const l of HLJS_LANGS) {
    const f = path.join(o.nodeModules, ...HLJS_LANG_PREFIX.dir.split('/'), `${l}.min.js`);
    if (fs.existsSync(f)) walkEsm(f, seen);
  }
  for (const f of seen) add(vendorUrl(o.nodeModules, f), f);
  const fav = path.join(o.assetsDir ?? path.join(o.webRoot, '..', '..', 'assets'), 'favicon.svg');
  if (fs.existsSync(fav)) add('/favicon.svg', fav);
  const indexHtml = fs.readFileSync(path.join(o.webRoot, 'index.html'), 'utf8');
  return { importMap: JSON.stringify({ imports }), files, indexHtml };
}
