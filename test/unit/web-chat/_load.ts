// test/unit/web-chat/_load.ts — loads the browser modules of the chat surface (plain JS + JSDoc) in Node for the unit
// tests. The browser resolves 'hljs/core' and 'hljs/lang/*' through the import map; Node gets the same
// mapping through a module resolve hook, so modules that import lib/md.js load too; DOMPurify (DOM-only) is stubbed.
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

export const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const HLJS = path.join(ROOT, 'node_modules', '@highlightjs', 'cdn-assets', 'es');

let hooked = false;
function hook(): void {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec === 'hljs/core') return next(pathToFileURL(path.join(HLJS, 'core.min.js')).href, ctx);
      if (spec.startsWith('hljs/lang/')) return next(pathToFileURL(path.join(HLJS, 'languages', spec.slice('hljs/lang/'.length))).href, ctx);
      if (spec === 'dompurify') return next(pathToFileURL(path.join(import.meta.dirname, '_stub-dompurify.mjs')).href, ctx);
      return next(spec, ctx);
    },
  });
}

/** Imports src/web/<rel> (typed loosely: the modules are checked by tsconfig.web.json). */
export async function web(rel: string): Promise<any> {
  hook();
  return import(pathToFileURL(path.join(ROOT, 'src', 'web', rel)).href);
}

/** Reads a protocol fixture script (test/fixtures/protocol/<name>.jsonl) as its list of steps. */
export async function protocolSteps(name: string): Promise<any[]> {
  const fs = await import('node:fs');
  return fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'protocol', `${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}
