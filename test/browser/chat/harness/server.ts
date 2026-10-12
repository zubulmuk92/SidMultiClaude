// test/browser/chat/harness/server.ts — component harness for the chat surface (WP-F, M1): a throwaway static server on
// 127.0.0.1:<random> that serves the real browser files (src/web), the vendored libraries through an import map, and
// harness.html + harness.js (a stub store implementing contract.d.ts, fed with protocol frames by the test). The page
// runs under the production CSP (Trusted Types enforced, import map allowed by hash), so XSS checks are meaningful.
// GET only, exact prefixes, no path joined without a containment check.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const HERE = import.meta.dirname;
const NM = path.join(ROOT, 'node_modules');
/** Same names as the app's import map (src/server/http/static.ts). */
const IMPORTS: Record<string, string> = {
  'preact': 'preact/dist/preact.mjs', 'preact/hooks': 'preact/hooks/dist/hooks.mjs', 'htm': 'htm/dist/htm.module.js',
  'htm/preact': 'htm/preact/index.module.js', '@preact/signals': '@preact/signals/dist/signals.module.js',
  '@preact/signals-core': '@preact/signals-core/dist/signals-core.module.js', 'marked': 'marked/lib/marked.esm.js',
  'dompurify': 'dompurify/dist/purify.es.mjs', 'hljs/core': '@highlightjs/cdn-assets/es/core.min.js',
};
const MIME: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function importMap(): string {
  const imports: Record<string, string> = {};
  for (const [k, v] of Object.entries(IMPORTS)) imports[k] = '/vendor/' + v;
  imports['hljs/lang/'] = '/vendor/@highlightjs/cdn-assets/es/languages/';
  return JSON.stringify({ imports });
}

/** Resolves `rel` under `base`, or null when it escapes it. */
function inside(base: string, rel: string): string | null {
  const p = path.resolve(base, decodeURIComponent(rel));
  return p.startsWith(base + path.sep) && fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
}

export type HarnessServer = { url: string; close(): Promise<void> };

export async function startHarness(): Promise<HarnessServer> {
  const map = importMap();
  const hash = crypto.createHash('sha256').update(map).digest('base64');
  const csp = `default-src 'none'; script-src 'self' 'sha256-${hash}'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; ` +
    `connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; ` +
    `require-trusted-types-for 'script'; trusted-types dompurify`;
  const page = fs.readFileSync(path.join(HERE, 'harness.html'), 'utf8').replace('__IMPORTMAP__', map);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let file: string | null = null;
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (url.pathname === '/' ) {
      res.writeHead(200, { 'content-type': MIME['.html']!, 'content-security-policy': csp, 'cache-control': 'no-store' }).end(page);
      return;
    }
    if (url.pathname.startsWith('/app/')) file = inside(path.join(ROOT, 'src', 'web'), url.pathname.slice(5));
    else if (url.pathname.startsWith('/vendor/')) file = inside(NM, url.pathname.slice(8));
    else if (url.pathname.startsWith('/harness/')) file = inside(HERE, url.pathname.slice(9));
    if (!file || !(path.extname(file) in MIME) || file.endsWith('.ts')) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)]!, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
