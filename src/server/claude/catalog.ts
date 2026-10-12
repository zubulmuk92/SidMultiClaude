// src/server/claude/catalog.ts — cache\model-catalog\*.json → ModelOption[] (0 tokens).
// File: `<cfg>\cache\model-catalog\<orgUuid>-<hash>-cc.json` (`-ccd` = Desktop surface, ignored).
// Values are catalog ids (never free text, SPEC §2.2); quick-select models first. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import type * as P from '../../shared/protocol.ts';

const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

type CatalogFile = { fetchedAt: number; models: Record<string, unknown>[] };

function readCatalog(file: string): CatalogFile | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const cat = o['catalog'] as Record<string, unknown> | undefined;
    const cfg = cat?.['config'] as Record<string, unknown> | undefined;
    const models = cfg?.['models'];
    if (!Array.isArray(models)) return null;
    const at = Date.parse(String(o['fetchedAt'] ?? ''));
    return { fetchedAt: Number.isNaN(at) ? 0 : at, models: models.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object') };
  } catch { return null; }
}

/** Newest `-cc` catalog of the profile (of `orgUuid` when given and present). [] when none. */
export function readModelCatalog(configHome: string, orgUuid?: string): P.ModelOption[] {
  const dir = path.join(configHome, 'cache', 'model-catalog');
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => /-cc\.json$/i.test(n)); } catch { return []; }
  const org = orgUuid?.toLowerCase();
  const pool = org && names.some((n) => n.toLowerCase().startsWith(org)) ? names.filter((n) => n.toLowerCase().startsWith(org)) : names;
  let best: CatalogFile | null = null;
  for (const n of pool) {
    const c = readCatalog(path.join(dir, n));
    if (c && (!best || c.fetchedAt > best.fetchedAt)) best = c;
  }
  if (!best) return [];
  const out: (P.ModelOption & { q: boolean })[] = [];
  const seen = new Set<string>();
  for (const m of best.models) {
    const id = m['id'];
    if (typeof id !== 'string' || !/^[\w.\-[\]]{1,80}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const th = m['thinking'] as Record<string, unknown> | undefined;
    const opts = Array.isArray(th?.['effort_options']) ? (th['effort_options'] as Record<string, unknown>[]) : [];
    const efforts = opts.map((x) => String(x?.['id'] ?? '')).filter((e): e is P.Effort => EFFORTS.has(e));
    const label = typeof m['name'] === 'string' && m['name'] ? m['name'] : id;
    out.push({ value: id, label, efforts, q: m['quick_select'] === true });
  }
  out.sort((a, b) => Number(b.q) - Number(a.q));
  return out.map(({ q: _q, ...o }) => o);
}
