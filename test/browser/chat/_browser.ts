// test/browser/chat/_browser.ts — shared setup of the browser tests of the chat surface (WP-F): the harness server,
// headless Edge through playwright-core, page errors collected, fixture frames with their placeholders filled.
// When Edge cannot be launched the tests skip instead of failing.
import { after, before } from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { protocolSteps } from '../../unit/web-chat/_load.ts';
import { startHarness } from './harness/server.ts';
import type { HarnessServer } from './harness/server.ts';
// Callbacks passed to page.evaluate() run in the browser; this file is compiled without the DOM lib (module-local names).
declare const document: any, window: any, KeyboardEvent: any, InputEvent: any, OffscreenCanvas: any, DataTransfer: any, File: any, ClipboardEvent: any, trustedTypes: any, localStorage: any;

export type Ctx = { page: Page; errors: string[]; available: boolean };

/** Registers before/after hooks for the file and returns the (lazily filled) context. */
export function useHarness(viewport = { width: 1280, height: 900 }): Ctx {
  const ctx = { errors: [] as string[], available: false } as Ctx;
  let server: HarnessServer | null = null;
  let browser: Browser | null = null;
  before(async () => {
    server = await startHarness();
    try { browser = await chromium.launch({ channel: 'msedge', headless: true }); } catch { return; }
    ctx.page = await browser.newPage({ viewport, locale: 'fr-FR' });
    ctx.page.on('pageerror', (e) => ctx.errors.push(e.message));
    ctx.page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) ctx.errors.push(m.text()); });
    ctx.page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) ctx.errors.push(`${r.status()} ${r.url()}`); });
    await ctx.page.goto(server.url);
    await ctx.page.waitForFunction(() => document.title === 'READY', null, { timeout: 15_000 });
    ctx.available = true;
  });
  after(async () => { await browser?.close().catch(() => {}); await server?.close(); });
  return ctx;
}

/** Fixture frames (test/fixtures/protocol/<name>.jsonl) with $X.uuid / $X.text filled, in script order. */
export async function framesOf(name: string, vals: Record<string, string> = {}): Promise<any[][]> {
  const sub = (s: string) => s.replace(/\$([A-Z])\.(uuid|text)/g, (_m, a: string, f: string) =>
    vals[`${a}.${f}`] ?? (f === 'uuid' ? `00000000-0000-4000-8000-0000000000${a.charCodeAt(0)}` : `texte ${a}`));
  const out: any[][] = [];
  for (const s of await protocolSteps(name)) {
    if (s.step === 'send') out.push(JSON.parse(sub(JSON.stringify(s.frame))));
    if (s.step === 'expect' && Array.isArray(s.then) && s.then.length) out.push(JSON.parse(sub(JSON.stringify(s.then))));
  }
  return out;
}

/** Helpers bound to a context. */
export function bind(ctx: Ctx) {
  return {
    apply: (f: any[]) => ctx.page.evaluate((x) => (window as any).__h.apply(x), f),
    calls: (name: string) => ctx.page.evaluate((n) => (window as any).__h.calls(n), name) as Promise<any[]>,
    clear: () => ctx.page.evaluate(() => (window as any).__h.clearCalls()),
    panes: (ids: string[]) => ctx.page.evaluate((x) => (window as any).__h.setPanes(x), ids),
    skip: (t: { skip(m: string): void }) => { if (!ctx.available) { t.skip('Edge not available'); return true; } return false; },
  };
}
