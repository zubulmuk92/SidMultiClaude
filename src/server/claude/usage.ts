// src/server/claude/usage.ts — usage rows from the three zero-token sources, merged freshest first (SPEC §5.5, ux §9.3).
// Helper of accounts.ts. Sources: live `rate_limit_event` (fractions, epoch seconds), the *Actualiser*
// result (`usage_EXPERIMENTAL…().rate_limits`, 0–100, ISO), and the `cachedUsageUtilization` snapshot of the global config
// (0–100, ISO; `limits[]` preferred when present; stale after 1 h).
import type * as P from '../../shared/protocol.ts';
import { USAGE_SNAPSHOT_STALE_MS } from '../../shared/limits.ts';

type Row = P.UsageRow;
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isoMs = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== 'string') return undefined;
  const n = Date.parse(v);
  return Number.isNaN(n) ? undefined : n;
};
const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n * 10) / 10));
function severityOf(pct: number, given?: unknown): Row['severity'] {
  if (given === 'critical' || given === 'warning' || given === 'normal') return given;
  if (given === 'high' || given === 'exceeded') return 'critical';
  return pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : 'normal';
}
const WINDOW: Record<string, { key: string; label: string }> = {
  five_hour: { key: 'session', label: 'Session (5 h)' },
  seven_day: { key: 'weekly_all', label: 'Semaine' },
  seven_day_opus: { key: 'weekly_scoped:opus', label: 'Semaine · Opus' },
  seven_day_sonnet: { key: 'weekly_scoped:sonnet', label: 'Semaine · Sonnet' },
};
const ORDER = (k: string): number => (k === 'session' ? 0 : k === 'weekly_all' ? 1 : 2);
function row(key: string, label: string, pct: number, resetsAt: number | undefined, sev?: unknown, headline = false): Row {
  const p = clampPct(pct);
  return { key, label, pct: p, ...(resetsAt !== undefined ? { resetsAt } : {}), severity: severityOf(p, sev), headline };
}
function windowsRows(w: Record<string, unknown>, fraction: boolean): Row[] {
  const out: Row[] = [];
  for (const [name, def] of Object.entries(WINDOW)) {
    const v = rec(w[name]);
    const u = v?.['utilization'];
    if (typeof u !== 'number') continue;
    out.push(row(def.key, def.label, fraction ? u * 100 : u, isoMs(v?.['resets_at'] ?? v?.['resetsAt'])));
  }
  return out;
}
/** `cachedUsageUtilization` → rows (limits[] when present, else the named windows). */
export function snapshotRows(snap: Record<string, unknown>): Row[] {
  const util = rec(snap['utilization']) ?? snap;
  const limits = Array.isArray(util['limits']) ? (util['limits'] as unknown[]).map(rec).filter((x): x is Record<string, unknown> => !!x) : [];
  if (limits.length) {
    return limits.flatMap((l) => {
      const kind = String(l['kind'] ?? '');
      const pct = l['percent'];
      if (!kind || typeof pct !== 'number') return [];
      const model = rec(rec(l['scope'])?.['model']);
      const name = typeof model?.['display_name'] === 'string' ? model['display_name'] : typeof model?.['id'] === 'string' ? model['id'] : '';
      const key = kind === 'weekly_scoped' ? `weekly_scoped:${name.toLowerCase()}` : kind;
      const label = kind === 'session' ? 'Session (5 h)' : kind === 'weekly_all' ? 'Semaine' : kind === 'weekly_scoped' ? `Semaine · ${name}` : kind;
      return [row(key, label, pct, isoMs(l['resets_at']), l['severity'], l['is_active'] === true)];
    });
  }
  return windowsRows(util, false);
}
/** SDKRateLimitInfo (or the whole rate_limit_event frame) → rows: utilization is a fraction, resetsAt epoch seconds. */
export function eventRows(info: Record<string, unknown>): { rows: Row[]; status?: P.UsageView['status'] } {
  const i = rec(info['rate_limit_info']) ?? info;
  const st = i['status'];
  const status = st === 'allowed' || st === 'allowed_warning' || st === 'rejected' ? st : undefined;
  const uw = rec(i['unifiedWindows']);
  let rows = uw ? windowsRows(uw, true) : [];
  const type = typeof i['rateLimitType'] === 'string' ? i['rateLimitType'] : '';
  const def = WINDOW[type];
  if (!rows.length && def && typeof i['utilization'] === 'number') rows = [row(def.key, def.label, i['utilization'] * 100, isoMs(i['resetsAt']))];
  if (def && status === 'rejected') rows = rows.map((r) => (r.key === def.key ? { ...r, severity: 'critical' } : r));
  return { rows, ...(status ? { status } : {}) };
}
/** usage_EXPERIMENTAL…() result → rows (0–100, ISO); its server-defined `limits[]` rows are preferred when present. */
export function refreshRows(data: Record<string, unknown>): { rows: Row[]; na: boolean } {
  const limits = Array.isArray(data['limits']) ? data['limits'] : rec(data['rate_limits'])?.['limits'];
  if (Array.isArray(limits) && limits.length) {
    const rows = snapshotRows({ limits });
    if (rows.length) return { rows, na: false };
  }
  const rl = rec(data['rate_limits']);
  if (!rl) return { rows: [], na: data['rate_limits_available'] === false };
  return { rows: windowsRows(rl, false), na: false };
}

export type UsageSources = {
  snapshot?: { at: number; rows: Row[] };
  refresh?: { at: number; rows: Row[]; na: boolean };
  event?: { at: number; rows: Row[]; status?: P.UsageView['status'] };
};
/** Freshest first: the newest full source is the base, then the live event rows overlay it by key. */
export function mergeUsage(s: UsageSources, now: number): P.UsageView | undefined {
  const full = [s.refresh, s.snapshot].filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.at - a.at)[0];
  if (!full && !s.event) return undefined;
  const rows = new Map<string, Row>();
  for (const r of full?.rows ?? []) rows.set(r.key, { ...r });
  let source: P.UsageView['source'] = full === s.refresh && full ? 'refresh' : 'snapshot';
  let at = full?.at ?? 0;
  if (s.event && (!full || s.event.at >= full.at)) {
    for (const r of s.event.rows) rows.set(r.key, { ...r, headline: rows.get(r.key)?.headline ?? false });
    source = 'event'; at = s.event.at;
  }
  const list = [...rows.values()].sort((a, b) => ORDER(a.key) - ORDER(b.key));
  if (list.length && !list.some((r) => r.headline)) {
    const h = list.find((r) => r.key === 'session') ?? list[0]!;
    h.headline = true;
  }
  const na = s.refresh?.na === true && !list.length;
  return {
    source, at, stale: now - at > USAGE_SNAPSHOT_STALE_MS, rows: list,
    ...(s.event?.status ? { status: s.event.status } : {}), ...(na ? { na: true } : {}),
  };
}
