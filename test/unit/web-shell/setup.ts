// test/unit/web-shell/setup.ts — browser globals for the WP-E store tests (no DOM): a scriptable fake WebSocket,
// location / history / localStorage / crypto. Import it BEFORE any src/web module.
/* eslint-disable @typescript-eslint/no-explicit-any */
export class FakeWS {
  static all: FakeWS[] = [];
  static get last(): FakeWS { const w = FakeWS.all[FakeWS.all.length - 1]; if (!w) throw new Error('no socket'); return w; }
  readyState = 0;
  sent: any[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  url: string;
  protocols: string[];
  constructor(url: string, protocols: string[]) { this.url = url; this.protocols = protocols; FakeWS.all.push(this); }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  recv(frame: unknown[]): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(s: string): void { this.sent.push(JSON.parse(s)); }
  close(code = 1000): void { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
  /** Requests of a type sent on this socket. */
  of(t: string): any[] { return this.sent.filter((m) => m.t === t); }
}
const store = new Map<string, string>();
const g = globalThis as any;
Object.defineProperty(g, 'WebSocket', { value: FakeWS, configurable: true, writable: true });
Object.defineProperty(g, 'localStorage', { configurable: true, writable: true, value: {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); },
} });
export const replaced: string[] = [];
Object.defineProperty(g, 'location', { configurable: true, writable: true, value: { host: '127.0.0.1:45678', hash: '#boot=AbCdEfGhIjKlMnOpQrStUvWx', pathname: '/', search: '' } });
Object.defineProperty(g, 'history', { configurable: true, writable: true, value: { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); g.location.hash = ''; } } });
export const localStore = store;
/** Lets pending promise callbacks run. */
export const tick = async (n = 3): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
