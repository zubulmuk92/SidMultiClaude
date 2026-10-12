// test/parity/mock-api.ts — minimal mock of the Anthropic Messages API for T-P3 (re-implemented from scratchpad\parity\mock\server.mjs).
// TEST-ONLY. Binds 127.0.0.1 on port 0. Never records auth headers (x-api-key / authorization are dropped). Bodies stay in memory.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockReq = { id: number; at: number; method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null; bytes: number };
const SAFE_HEADERS = ['anthropic-beta', 'anthropic-version', 'user-agent', 'x-app', 'content-type', 'x-claude-code-session-id'];

export async function startMockApi(): Promise<{ url: string; requests: MockReq[]; messages(): MockReq[]; close(): Promise<void> }> {
  const requests: MockReq[] = [];
  let n = 0;
  const sse = (res: http.ServerResponse, ev: string, data: unknown): void => { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const id = ++n;
      const raw = Buffer.concat(chunks);
      let body: Record<string, unknown> | null = null;
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) as Record<string, unknown> : null; } catch { body = { _unparsed_bytes: raw.length }; }
      const headers: Record<string, string> = {};
      for (const h of SAFE_HEADERS) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h] as string;
      const u = new URL(req.url ?? '/', 'http://x');
      requests.push({ id, at: Date.now(), method: req.method ?? '', path: u.pathname, headers, body, bytes: raw.length });
      if (req.method === 'POST' && u.pathname.endsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: Math.round(raw.length / 4) }));
        return;
      }
      if (req.method === 'POST' && u.pathname.endsWith('/v1/messages')) {
        const wantsJson = !!((body?.['output_config'] as Record<string, unknown> | undefined)?.['format'] || body?.['output_format']);
        const text = wantsJson ? '{"title":"Mock title"}' : 'OK';
        const usage = { input_tokens: Math.round(raw.length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
        const msg = { id: `msg_mock_${id}`, type: 'message', role: 'assistant', model: body?.['model'] ?? 'mock', content: [], stop_reason: null, stop_sequence: null, usage };
        if (body?.['stream']) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_mock_${id}` });
          sse(res, 'message_start', { type: 'message_start', message: msg });
          sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
          sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
          sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
          sse(res, 'message_stop', { type: 'message_stop' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_mock_${id}` });
        res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, requests,
    messages: () => requests.filter((r) => r.method === 'POST' && /\/v1\/messages$/.test(r.path)),
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

/** Body normalisation for the app-vs-CLI diff: ids → placeholders; billing header line dropped. */
export function normalizeBody(b: unknown): unknown {
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      return x.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
        .split('\n').filter((l) => !/x-anthropic-billing-header/i.test(l)).join('\n');
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return walk(b);
}
/** Paths where two JSON values differ (for an explicit, reviewable diff). */
export function jsonDiff(a: unknown, b: unknown, p = '$', out: string[] = []): string[] {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) { out.push(p); return out; }
  if (Array.isArray(a)) { const bb = b as unknown[]; if (a.length !== bb.length) out.push(`${p}.length`); for (let i = 0; i < Math.min(a.length, bb.length); i++) jsonDiff(a[i], bb[i], `${p}[${i}]`, out); return out; }
  if (a && typeof a === 'object') {
    const ao = a as Record<string, unknown>; const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) jsonDiff(ao[k], bo[k], `${p}.${k}`, out);
    return out;
  }
  if (a !== b) out.push(p);
  return out;
}
