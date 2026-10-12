// test/unit/claude/usage.test.ts — usage rows and the freshest-first merge (SPEC §5.5): live rate_limit_event → Actualiser
// result → cachedUsageUtilization snapshot; the snapshot is stale after 1 h; limits[] preferred when present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventRows, mergeUsage, refreshRows, snapshotRows } from '../../../src/server/claude/usage.ts';
import type { UsageSources } from '../../../src/server/claude/usage.ts';

const H = 3_600_000;
const NOW = Date.parse('2026-10-08T12:00:00Z');
const limit = (kind: string, percent: number, model?: string): Record<string, unknown> => ({
  kind, group: kind === 'session' ? 'session' : 'weekly', percent, severity: 'normal', resets_at: '2026-10-08T15:00:00Z',
  scope: model ? { model: { id: model.toLowerCase(), display_name: model } } : null, is_active: kind === 'session',
});
const windows = { five_hour: { utilization: 11, resets_at: '2026-10-08T15:00:00Z' }, seven_day: { utilization: 3, resets_at: '2026-10-12T00:00:00Z' } };

test('limits[] rows are preferred over the named windows (snapshot and Actualiser result)', () => {
  const snap = snapshotRows({ utilization: { ...windows, limits: [limit('session', 42), limit('weekly_all', 7), limit('weekly_scoped', 9, 'Fable')] } });
  assert.deepEqual(snap.map((r) => [r.key, r.pct, r.label]), [['session', 42, 'Session (5 h)'], ['weekly_all', 7, 'Semaine'], ['weekly_scoped:fable', 9, 'Semaine · Fable']]);
  assert.deepEqual(snapshotRows({ utilization: windows }).map((r) => [r.key, r.pct]), [['session', 11], ['weekly_all', 3]]);
  const fromLimits = refreshRows({ rate_limits: windows, limits: [limit('session', 14), limit('weekly_scoped', 2, 'Fable')] });
  assert.deepEqual(fromLimits.rows.map((r) => [r.key, r.pct]), [['session', 14], ['weekly_scoped:fable', 2]]);
  assert.deepEqual(refreshRows({ rate_limits: windows }).rows.map((r) => [r.key, r.pct]), [['session', 11], ['weekly_all', 3]]);
  assert.equal(refreshRows({ rate_limits_available: false }).na, true);
});

test('live event: fractions and epoch seconds; rejected marks its window critical', () => {
  const e = eventRows({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1_790_000_000 });
  assert.deepEqual(e.rows.map((r) => [r.key, r.pct, r.severity, r.resetsAt]), [['session', 100, 'critical', 1_790_000_000_000]]);
  assert.equal(e.status, 'rejected');
  const w = eventRows({ rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.17 }, seven_day: { utilization: 0.03 } } } });
  assert.deepEqual(w.rows.map((r) => [r.key, r.pct]), [['session', 17], ['weekly_all', 3]]);
});

test('merge, freshest first: the newest full source is the base, a newer live event overlays it', () => {
  const snapshot = { at: NOW - 2 * H, rows: snapshotRows({ utilization: { limits: [limit('session', 42), limit('weekly_scoped', 9, 'Fable')] } }) };
  const refresh = { at: NOW - 30 * 60_000, rows: refreshRows({ rate_limits: windows }).rows, na: false };
  const only: UsageSources = { snapshot };
  const v1 = mergeUsage(only, NOW)!;
  assert.equal(v1.source, 'snapshot');
  assert.equal(v1.stale, true, 'a 2 h old snapshot is stale');
  assert.equal(mergeUsage({ snapshot: { ...snapshot, at: NOW - 59 * 60_000 } }, NOW)!.stale, false);
  const v2 = mergeUsage({ snapshot, refresh }, NOW)!;
  assert.equal(v2.source, 'refresh');
  assert.deepEqual(v2.rows.map((r) => [r.key, r.pct]), [['session', 11], ['weekly_all', 3]]);
  const newerSnap = { ...snapshot, at: NOW - 60_000 };
  assert.equal(mergeUsage({ snapshot: newerSnap, refresh }, NOW)!.source, 'snapshot', 'a snapshot written after the refresh wins');
  const event = { at: NOW - 5 * 60_000, rows: eventRows({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.8 }).rows, status: 'allowed_warning' as const };
  const v3 = mergeUsage({ snapshot, refresh, event }, NOW)!;
  assert.equal(v3.source, 'event');
  assert.equal(v3.status, 'allowed_warning');
  assert.deepEqual(v3.rows.map((r) => [r.key, r.pct]), [['session', 80], ['weekly_all', 3]]);
  assert.equal(v3.rows.filter((r) => r.headline).length, 1);
  const old = { ...event, at: NOW - H };
  const v4 = mergeUsage({ snapshot, refresh, event: old }, NOW)!;
  assert.equal(v4.source, 'refresh', 'an event older than the refresh does not overlay it');
  assert.equal(v4.rows.find((r) => r.key === 'session')?.pct, 11);
  assert.equal(mergeUsage({}, NOW), undefined);
});
