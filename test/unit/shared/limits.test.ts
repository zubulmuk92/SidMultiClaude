// src/shared/limits.ts: every value is a plain constant, matches the SPEC number it encodes, and the related values agree
// with each other. A change here is a spec change: update the SPEC reference in the same commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../../../src/shared/limits.ts';

const MiB = 1024 * 1024;
const SEC = 1000;
const MIN = 60 * SEC;

test('every export is a finite, non-negative number or a frozen array of them (values only, no logic)', () => {
  const entries = Object.entries(L);
  assert.ok(entries.length >= 100, `the whole table is exported (${entries.length})`);
  for (const [name, v] of entries) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${name}: SCREAMING_SNAKE_CASE`);
    if (Array.isArray(v)) {
      assert.ok(Object.isFrozen(v), `${name}: frozen array`);
      for (const x of v as unknown[]) assert.ok(x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0), `${name}: ${String(x)}`);
    } else {
      assert.equal(typeof v, 'number', name);
      assert.ok(Number.isFinite(v) && (v as number) >= 0, `${name}: ${String(v)}`);
    }
  }
});

test('SPEC §0.3 engine policy: cap, low memory, reap, watchdogs, crash breaker, supervisor, lifetime', () => {
  assert.equal(L.MAX_LIVE_DEFAULT, 4);                                   // SPEC default
  assert.deepEqual([L.MAX_LIVE_MIN, L.MAX_LIVE_MAX], [2, 8]);
  assert.equal(L.LOW_MEM_FREE_BYTES, 1.5 * 1024 * MiB);
  assert.equal(L.LOW_MEM_MIN_CAP, 2);
  assert.equal(L.REAP_MIN_DEFAULT, 60);
  assert.deepEqual([...L.REAP_MIN_CHOICES], [15, 30, 60, 120, null]);
  assert.equal(L.REAP_5M_CAP_MS, 5 * MIN);
  assert.equal(L.NEVER_REQUESTED_STOP_MS, 10 * MIN);
  assert.deepEqual([L.CACHE_TTL_1H_MS, L.CACHE_TTL_5M_MS], [60 * MIN, 5 * MIN]);
  assert.deepEqual([L.INIT_WATCHDOG_MS, L.INTERRUPT_WATCHDOG_MS, L.CONTROL_CALL_TIMEOUT_MS], [45 * SEC, 10 * SEC, 10 * SEC]);
  assert.deepEqual([L.CLOSE_EXIT_WAIT_MS, L.CLOSE_OWN_KILL_DELAY_MS, L.CLOSE_KILL_WAIT_MS], [8 * SEC, 2 * SEC, 3 * SEC]);
  assert.deepEqual([L.CLOSE_RUNNING_RESULT_WAIT_MS, L.CLOSE_BG_TASKS_WAIT_MS, L.SHUTDOWN_DEADLINE_MS], [10 * SEC, 5 * SEC, 15 * SEC]);
  // the shutdown deadline must cover the close steps 3-5 (8 + 2 + 3 s)
  assert.ok(L.SHUTDOWN_DEADLINE_MS > L.CLOSE_EXIT_WAIT_MS + L.CLOSE_OWN_KILL_DELAY_MS + L.CLOSE_KILL_WAIT_MS);
  // all images of one chat.send must fit in a WebSocket frame
  assert.ok(L.MAX_IMAGES_TOTAL_BYTES < L.WS_MAX_PAYLOAD_BYTES - L.MAX_TEXT_BYTES);
  assert.deepEqual([L.BREAKER_CRASHES, L.BREAKER_WINDOW_MS], [3, 10 * MIN]);
  assert.deepEqual([L.SUPERVISOR_MAX_RESTARTS, L.SUPERVISOR_WINDOW_MS], [3, 60 * SEC]);
  assert.deepEqual([...L.SUPERVISOR_BACKOFF_MS], [500, 2 * SEC, 5 * SEC]);
  assert.deepEqual([L.EXIT_CODE_STOP, L.EXIT_CODE_RESTART], [0, 75]);
  assert.equal(L.SERVER_IDLE_EXIT_MS, 10 * MIN);
  assert.equal(L.DELTA_COALESCE_MS, 50);
  assert.equal(L.PROGRESS_MIN_INTERVAL_MS, SEC);
  assert.equal(L.SUMMARY_UPSERT_MIN_INTERVAL_MS, 500);                   // ≤ 2/s per chat
});

test('SPEC §6 / §10 protocol, guard and resource limits', () => {
  assert.equal(L.PORT_DEFAULT, 41731);
  assert.deepEqual([L.PORT_FALLBACK_FIRST, L.PORT_FALLBACK_LAST], [41732, 41750]);   // +1…+19 (S1)
  assert.deepEqual([L.BOOT_CODE_BYTES, L.BOOT_CODE_TTL_MS, L.DEVICE_TOKEN_BYTES], [24, 60 * SEC, 32]);
  assert.deepEqual([L.HTTP_HEADERS_TIMEOUT_MS, L.HTTP_REQUEST_TIMEOUT_MS, L.WS_MAX_PAYLOAD_BYTES], [10 * SEC, 30 * SEC, 16 * MiB]);
  assert.deepEqual([L.BACKPRESSURE_STALE_BYTES, L.BACKPRESSURE_RESUME_BYTES, L.BACKPRESSURE_CLOSE_BYTES, L.WS_CLOSE_SLOW], [4 * MiB, 1 * MiB, 32 * MiB, 4001]);
  assert.deepEqual([L.MAX_IMAGES_PER_MESSAGE, L.MAX_IMAGE_BYTES, L.MAX_TEXT_BYTES, L.MAX_DRAFT_BYTES, L.MAX_DETAIL_BYTES], [8, 5 * MiB, MiB, MiB, 8 * MiB]);
  assert.deepEqual([L.TX_PAGE_LIMIT_MAX, L.FS_MENTIONS_MAX, L.SEARCH_MAX_HITS, L.LOG_CLIENT_PER_MIN], [50, 50, 50, 10]);
  assert.deepEqual([L.CWD_MAX_LENGTH, L.CWD_TOO_LONG_AT], [258, 259]);
  assert.deepEqual([L.APP_WINDOW_WIDTH_PX, L.APP_WINDOW_HEIGHT_PX], [1280, 860]);
});

test('SPEC §2.12 accounting and wake estimates, §7 storage, §5.5 readers', () => {
  assert.equal(L.AUTO_COMPACT_MARGIN_TOKENS, 33_000);
  assert.deepEqual([L.CACHE_MISS_MIN_RATIO, L.CACHE_MISS_MIN_TOKENS], [0.3, 10_000]);
  assert.deepEqual([L.WAKE_SHARED_SAME_CWD_TOKENS, L.WAKE_SHARED_ACCOUNT_TOKENS], [19_000, 16_800]);
  assert.deepEqual([L.WAKE_DIALOG_IDLE_MS, L.WAKE_DIALOG_MIN_CONTEXT], [60 * MIN, 100_000]);
  assert.deepEqual([L.LOG_MAX_FILES, L.LOG_MAX_FILE_BYTES, L.META_DEBOUNCE_MS], [5, 5 * MiB, SEC]);
  assert.deepEqual([L.HEADTAIL_BYTES, L.TAIL_STEP_BYTES, L.TAIL_MAX_BYTES, L.SEARCH_CHUNK_BYTES], [64 * 1024, 256 * 1024, 2 * MiB, 64 * 1024]);
  assert.deepEqual([L.WATCH_DEBOUNCE_MS, L.MAX_LOOP_BLOCK_MS, L.REGISTRY_FRESH_MS], [300, 8, 60 * SEC]);
  assert.deepEqual([L.TOOL_OUTPUT_HEAD_BYTES, L.TOOL_OUTPUT_TAIL_BYTES, L.HEAVY_STASH_MAX_BYTES], [4 * 1024, 4 * 1024, 8 * MiB]);
  assert.deepEqual([L.CLEANUP_PERIOD_DAYS_DEFAULT, L.CLEANUP_PERIOD_DAYS_ADVISED, L.EXPIRY_FLAG_FROM_DAY, L.EXPIRING_SOON_DAYS], [30, 3650, 25, 5]);
  assert.equal(L.SMOKE_MAX_API_REQUESTS, 8);
});

test('related values agree with each other', () => {
  assert.equal(L.DELTA_FRAMES_PER_SEC_MAX, 1000 / L.DELTA_COALESCE_MS, '≤ 20 delta frames/s per chat follows from the 50 ms coalescing');
  assert.equal(L.PORT_FALLBACK_FIRST, L.PORT_DEFAULT + 1);
  assert.equal(L.PORT_FALLBACK_LAST - L.PORT_DEFAULT, 19);
  assert.equal(L.CWD_TOO_LONG_AT, L.CWD_MAX_LENGTH + 1);
  assert.ok(L.BACKPRESSURE_RESUME_BYTES < L.BACKPRESSURE_STALE_BYTES && L.BACKPRESSURE_STALE_BYTES < L.BACKPRESSURE_CLOSE_BYTES);
  assert.ok(L.MAX_LIVE_MIN <= L.MAX_LIVE_DEFAULT && L.MAX_LIVE_DEFAULT <= L.MAX_LIVE_MAX);
  assert.ok(L.LOW_MEM_MIN_CAP <= L.MAX_LIVE_MIN);
  assert.ok(L.REAP_MIN_CHOICES.includes(L.REAP_MIN_DEFAULT));
  assert.ok(L.REAP_MIN_CHOICES.includes(null), '« jamais » is a choice');
  assert.equal(L.REAP_WARN_BELOW_MIN, L.REAP_MIN_DEFAULT);
  assert.equal(L.REAP_5M_CAP_MS, L.CACHE_TTL_5M_MS);
  assert.equal(L.PRESPAWN_IDLE_STOP_MS, L.NEVER_REQUESTED_STOP_MS);
  assert.equal(L.SUPERVISOR_BACKOFF_MS.length, L.SUPERVISOR_MAX_RESTARTS);
  assert.ok(L.CLOSE_OWN_KILL_DELAY_MS < L.SDK_CLOSE_KILL_MEASURED_MS, 'our own kill lands before the SDK kill (≈ 7.4 s)');
  assert.ok(L.TOOL_OUTPUT_HEAD_BYTES + L.TOOL_OUTPUT_TAIL_BYTES < L.ASK_INPUT_MAX_STRING_BYTES);
  assert.ok(L.MAX_DETAIL_BYTES <= L.WS_MAX_PAYLOAD_BYTES, 'a tx.detail payload fits in one frame');
  assert.ok(L.MAX_IMAGE_BYTES + L.MAX_TEXT_BYTES + L.MAX_DRAFT_BYTES <= L.WS_MAX_PAYLOAD_BYTES, 'one maximal image + text fits in one frame');
  assert.ok(L.TAIL_STEP_BYTES < L.TAIL_MAX_BYTES && L.HEADTAIL_BYTES <= L.TAIL_STEP_BYTES);
  assert.ok(L.EXPIRY_FLAG_FROM_DAY + L.EXPIRING_SOON_DAYS === L.CLEANUP_PERIOD_DAYS_DEFAULT, 'flag from day 25 = 5 days before the 30-day sweep');
  assert.ok(L.IMAGE_REENCODE_JPEG_QUALITY > 0 && L.IMAGE_REENCODE_JPEG_QUALITY <= 1);
  assert.ok(L.WAKE_SHARED_SAME_CWD_TOKENS > L.WAKE_SHARED_ACCOUNT_TOKENS);
  assert.ok(L.CACHE_MISS_MIN_RATIO > 0 && L.CACHE_MISS_MIN_RATIO < 1);
});
