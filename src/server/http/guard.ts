// src/server/http/guard.ts — verified loopback guard (6 HTTP + 7 WS test cases).
// - binds 127.0.0.1 only (exclusive), exact Host allow-list (DNS rebinding → 421), GET/HEAD only (else 405), no cookies,
//   no CORS headers; static files from an exact-key allow-list Map (never a path join → no traversal);
// - strict CSP + Trusted Types, the inline import map allowed by its sha256;
// - WebSocket: exact Origin, exact path /ws, auth by Sec-WebSocket-Protocol (device token 32 B, constant-time compare, or a
//   one-time boot code 24 B / 60 s); only `smc.v1` is echoed, so secrets never come back.
// Notes: the port is known only after the bind (fallback 41732–41750, or 0 in tests); the
// device-token frame is a JSON array like every S2C frame (SPEC §6.2); timers come from the Clock; boot codes and the
// device token are registered as log secrets.
import http from 'node:http';
import fs from 'node:fs';
import type { Duplex } from 'node:stream';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Clock } from '../contracts.ts';
import { BOOT_CODE_BYTES, BOOT_CODE_TTL_MS, DEVICE_TOKEN_BYTES, HTTP_HEADERS_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS, WS_MAX_PAYLOAD_BYTES } from '../../shared/limits.ts';

export type StaticEntry = { file: string; type: string };
export type GuardOptions = {
  port?: number;                            // default for listen() without an argument; main.ts passes each candidate to listen(p)
  indexHtml: string;                       // contains the literal __IMPORTMAP__
  importMap: string;                        // exact JSON text that is inlined (its sha256 goes in the CSP)
  staticFiles: Map<string, StaticEntry>;    // '/app/main.js' -> { file: 'C:\\...\\main.js', type }
  deviceToken: string | null;               // persisted in <app>\state\device.json (user-private)
  saveDeviceToken: (token: string) => void;
  onClient: (ws: WebSocket, req: http.IncomingMessage) => void;
  clock?: Pick<Clock, 'now'>;
  addSecret?: (s: string) => void;          // logger redaction of boot codes / device token
  onDenied?: (why: string) => void;
};

const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b)); // fixed-length compare

export function buildCsp(importMap: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'sha256-${sha256(importMap).toString('base64')}'`,
    "style-src 'self'",
    "img-src 'self' data: blob:",              // no remote images => no exfiltration via markdown images
    "font-src 'self'",
    "connect-src 'self'",                      // covers ws://127.0.0.1:<port> (measured in Edge 154)
    "manifest-src 'self'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types dompurify',
  ].join('; ');
}
export function securityHeaders(csp: string): http.OutgoingHttpHeaders {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-cache',
  };
}

export function createGuardedServer(o: GuardOptions) {
  const now = (): number => (o.clock ? o.clock.now() : Date.now());
  let port = 0;
  let HOST = '';
  let ORIGIN = '';
  const bootCodes = new Map<string, number>(); // one-time codes -> expiry (ms)
  let deviceToken = o.deviceToken;
  if (deviceToken) o.addSecret?.(deviceToken);
  const base = securityHeaders(buildCsp(o.importMap));
  const html = o.indexHtml.replaceAll('__IMPORTMAP__', () => o.importMap);   // ALL occurrences (a comment one broke the CSP hash)

  const server = http.createServer((req, res) => {
    if (!port || req.headers.host !== HOST) { res.writeHead(421).end(); return; }        // DNS rebinding / foreign Host
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...base, Allow: 'GET, HEAD' }).end(); return; }
    let pathname: string;
    try { pathname = new URL(req.url ?? '/', ORIGIN).pathname; } catch { res.writeHead(400, base).end(); return; } // dot-segments resolved
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { ...base, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    const entry = o.staticFiles.get(pathname);                                       // exact match only
    if (!entry) { res.writeHead(404, base).end(); return; }
    if (req.method === 'HEAD') { res.writeHead(200, { ...base, 'Content-Type': entry.type }).end(); return; }
    const stream = fs.createReadStream(entry.file);
    stream.once('error', () => { if (!res.headersSent) res.writeHead(404, base); res.end(); });
    stream.once('open', () => { res.writeHead(200, { ...base, 'Content-Type': entry.type }); stream.pipe(res); });
  });
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: WS_MAX_PAYLOAD_BYTES,                                                // pasted images; ws default is 100 MiB
    handleProtocols: (protocols) => (protocols.has('smc.v1') ? 'smc.v1' : false),   // never echo the auth protocol
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const deny = (why: string): void => {
      o.onDenied?.(why);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    };
    socket.on('error', () => {});
    if (!port || req.headers.host !== HOST || req.headers.origin !== ORIGIN || req.url !== '/ws' || req.method !== 'GET') { deny('host/origin/path'); return; }
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    if (!offered.includes('smc.v1')) { deny('protocol'); return; }
    const auth = offered.find((p) => p.startsWith('smc.auth.'))?.slice('smc.auth.'.length);
    const boot = offered.find((p) => p.startsWith('smc.boot.'))?.slice('smc.boot.'.length);
    let issue = false;
    if (auth && deviceToken && sameSecret(auth, deviceToken)) {
      // known window / profile
    } else if (boot && consumeBootCode(boot)) {
      if (!deviceToken) {
        deviceToken = randomBytes(DEVICE_TOKEN_BYTES).toString('base64url');
        o.addSecret?.(deviceToken);
        o.saveDeviceToken(deviceToken);
      }
      issue = true;                                                                  // hand the device token to this page
    } else { deny('auth'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (issue && deviceToken) ws.send(JSON.stringify([{ t: 'device-token', token: deviceToken }]));
      o.onClient(ws, req);
    });
  });

  function consumeBootCode(code: string): boolean {
    const t = now();
    for (const [c, exp] of bootCodes) if (exp < t) bootCodes.delete(c);
    for (const [c] of bootCodes) {
      if (c.length === code.length && sameSecret(c, code)) { bootCodes.delete(c); return true; } // single use
    }
    return false;
  }

  /** One-time code for a window we are about to open: `${origin}/#boot=${code}` (fragment: never sent over HTTP). */
  function newBootCode(ttlMs = BOOT_CODE_TTL_MS): string {
    const code = randomBytes(BOOT_CODE_BYTES).toString('base64url');
    o.addSecret?.(code);
    bootCodes.set(code, now() + ttlMs);
    return code;
  }

  /** Binds 127.0.0.1:<p> exclusively; resolves with the bound port (p = 0 picks a free one). */
  function listen(p: number = o.port ?? 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error): void => { reject(e); };
      server.once('error', onError);
      server.listen({ port: p, host: '127.0.0.1', exclusive: true }, () => {
        server.off('error', onError);
        const a = server.address();
        port = typeof a === 'object' && a ? a.port : p;
        HOST = `127.0.0.1:${port}`;
        ORIGIN = `http://${HOST}`;
        resolve(port);
      });
    });
  }

  function close(): Promise<void> {
    for (const c of wss.clients) c.terminate();
    return new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
  }

  return { server, wss, listen, close, newBootCode, get port() { return port; }, get origin() { return ORIGIN; } };
}
export type GuardedServer = ReturnType<typeof createGuardedServer>;
