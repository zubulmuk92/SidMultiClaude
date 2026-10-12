// WP-D acceptance 1: the platform's 6 HTTP + 7 WebSocket guard cases, and the S4 header snapshot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BOOT_CODE_TTL_MS } from '../../../src/shared/limits.ts';
import { buildCsp, createGuardedServer, securityHeaders } from '../../../src/server/http/guard.ts';
import { bindFirstFree } from '../../../src/server/platform/win.ts';
import type { GuardedServer } from '../../../src/server/http/guard.ts';
import { connectWs, tryConnect } from '../../helpers/ws-client.ts';

const IMPORT_MAP = '{"imports":{"preact":"/vendor/preact/dist/preact.mjs"}}';
let g: GuardedServer;
let port = 0;
let saved: string | null = null;
const thisFile = fileURLToPath(import.meta.url);

before(async () => {
  g = createGuardedServer({
    indexHtml: '<!doctype html><!-- the map goes in __IMPORTMAP__ --><script type="importmap">__IMPORTMAP__</script>', importMap: IMPORT_MAP,   // M2: a comment occurrence too
    staticFiles: new Map([['/app/main.js', { file: thisFile, type: 'text/javascript; charset=utf-8' }]]),
    deviceToken: null, saveDeviceToken: (t) => { saved = t; },
    onClient: (ws) => { ws.send(JSON.stringify([{ t: 'bye', reason: 'quit' }])); },
  });
  port = await g.listen(0);
});
after(async () => { await g.close(); });

/** Raw HTTP request with full control of Host and method (http.request would normalise them). */
function raw(method: string, pathName: string, host = `127.0.0.1:${port}`): Promise<{ status: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`${method} ${pathName} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => { buf += String(d); });
    s.on('end', () => {
      const [head] = buf.split('\r\n\r\n');
      const lines = (head ?? '').split('\r\n');
      const headers: Record<string, string> = {};
      for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
      resolve({ status: Number(lines[0]?.split(' ')[1]), headers });
    });
    s.on('error', reject);
  });
}

test('HTTP: the 6 guard cases', async () => {
  assert.equal((await raw('GET', '/')).status, 200, 'index');
  assert.equal((await raw('GET', '/app/main.js')).status, 200, 'allow-listed file');
  assert.equal((await raw('GET', '/', `evil.example:${port}`)).status, 421, 'DNS rebinding Host');
  assert.equal((await raw('GET', '/', `localhost:${port}`)).status, 421, 'localhost is another origin');
  assert.equal((await raw('POST', '/')).status, 405, 'POST refused');
  for (const p of ['/vendor/../../x', '/vendor/%2e%2e/%2e%2e/x', '/vendor/..%5c..%5cx', '/app/main.js::$DATA', '/app/../package.json']) {
    assert.equal((await raw('GET', p)).status, 404, `traversal ${p}`);
  }
  for (const m of ['PUT', 'DELETE', 'OPTIONS', 'PATCH']) assert.equal((await raw(m, '/')).status, 405, m);
  assert.equal((await raw('HEAD', '/app/main.js')).status, 200, 'HEAD allowed');
});

test('S4: header snapshot (CSP + Trusted Types, nosniff, no-referrer, COOP/CORP, DENY, no-cache), no CORS, no cookies', async () => {
  const r = await raw('GET', '/');
  const csp = buildCsp(IMPORT_MAP);
  assert.match(csp, /^default-src 'none'; script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types dompurify$/);
  assert.equal(r.headers['content-security-policy'], csp);
  const want = securityHeaders(csp) as Record<string, string>;
  for (const [k, v] of Object.entries(want)) assert.equal(r.headers[k.toLowerCase()], v, k);
  assert.deepEqual(Object.keys(want).sort(), ['Cache-Control', 'Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy',
    'Referrer-Policy', 'X-Content-Type-Options', 'X-Frame-Options']);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.equal(r.headers['set-cookie'], undefined);
  const r2 = await new Promise<http.IncomingMessage>((res) => http.get({ host: '127.0.0.1', port, path: '/' }, res));
  let body = '';
  for await (const c of r2) body += String(c);
  assert.ok(body.includes(IMPORT_MAP) && !body.includes('__IMPORTMAP__'), 'import map inlined');
});

test('WebSocket: the 7 guard cases (boot code → device token, token reuse, refusals)', async () => {
  const code = g.newBootCode();
  const c = await connectWs({ port, boot: code });
  assert.equal(c.protocol, 'smc.v1', 'only smc.v1 is echoed (secrets never come back)');
  await c.next((m) => m.t === 'bye');
  assert.ok(saved && c.deviceToken === saved, 'device token issued and persisted');
  await c.close();
  assert.deepEqual(await tryConnect({ port, boot: code }), { ok: false, status: 403 }, '1 replayed boot code');
  assert.deepEqual(await tryConnect({ port, token: saved!, origin: null }), { ok: false, status: 403 }, '2 no Origin');
  assert.deepEqual(await tryConnect({ port, token: saved!, origin: `http://127.0.0.1:${port + 1}` }), { ok: false, status: 403 }, '3 other port');
  assert.deepEqual(await tryConnect({ port, token: 'A'.repeat(43) }), { ok: false, status: 403 }, '4 wrong token');
  assert.deepEqual(await tryConnect({ port }), { ok: false, status: 403 }, '5 no secret');
  assert.deepEqual(await tryConnect({ port, token: saved!, path: '/other' }), { ok: false, status: 403 }, '6 wrong path');
  assert.deepEqual(await tryConnect({ port, token: saved!, protocols: [`smc.auth.${saved}`] }), { ok: false, status: 403 }, '7 no smc.v1');
  assert.deepEqual(await tryConnect({ port, token: saved!, host: `localhost:${port}` }), { ok: false, status: 403 }, 'foreign Host');
  const ok = await tryConnect({ port, token: saved! });
  assert.equal(ok.ok, true, 'device token accepted');
});

test('port fallback on the real guard: a busy port, then the same server listens on the next candidate and serves', async () => {
  const busy = net.createServer();
  await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
  const taken = (busy.address() as net.AddressInfo).port;
  const g3 = createGuardedServer({ indexHtml: '<p>x</p>', importMap: IMPORT_MAP, staticFiles: new Map(), deviceToken: null, saveDeviceToken: () => {}, onClient: () => {} });
  try {
    const got = await bindFirstFree((p) => g3.listen(p), [taken, 0]);
    assert.ok(got > 0 && got !== taken && g3.port === got && g3.origin === `http://127.0.0.1:${got}`);
    const st = await new Promise<number>((res) => http.get({ host: '127.0.0.1', port: got, path: '/' }, (x) => { x.resume(); res(x.statusCode ?? 0); }));
    assert.equal(st, 200, 'Host check uses the port finally bound');
  } finally { await g3.close(); busy.close(); }
});

test('boot codes expire after their TTL', async () => {
  const code = g.newBootCode(1);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await tryConnect({ port, boot: code }), { ok: false, status: 403 });
});

test('boot codes: 24 random bytes, valid for exactly 60 s, single use (fake clock); the CSP hash is the import map\'s', async () => {
  let now = 1_000_000;
  const g2 = createGuardedServer({ indexHtml: '<script type="importmap">__IMPORTMAP__</script>', importMap: IMPORT_MAP, staticFiles: new Map(),
    deviceToken: null, saveDeviceToken: () => {}, onClient: () => {}, clock: { now: () => now } });
  const p2 = await g2.listen(0);
  try {
    const a = g2.newBootCode();
    assert.equal(Buffer.from(a, 'base64url').length, 24);
    assert.notEqual(g2.newBootCode(), a, 'random');
    now += BOOT_CODE_TTL_MS;                                                         // 60 s: still valid
    const first = await tryConnect({ port: p2, boot: a });
    assert.equal(first.ok, true);
    assert.deepEqual(await tryConnect({ port: p2, boot: a }), { ok: false, status: 403 }, 'single use');
    const b = g2.newBootCode();
    now += BOOT_CODE_TTL_MS + 1;
    assert.deepEqual(await tryConnect({ port: p2, boot: b }), { ok: false, status: 403 }, 'expired after 60 s');
  } finally { await g2.close(); }
  assert.equal(BOOT_CODE_TTL_MS, 60_000);
  const want = createHash('sha256').update(IMPORT_MAP, 'utf8').digest('base64');
  assert.ok(buildCsp(IMPORT_MAP).includes(`script-src 'self' 'sha256-${want}';`), 'sha256 of the exact inlined text');
});
