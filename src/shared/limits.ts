// src/shared/limits.ts — every numeric constant of SPEC §0.3 / §2 / §5.5 / §6 / §7 / §10 (timeouts, caps, sizes).
// Values only: no logic, no imports (arrays are frozen).
// Server and tests import it. The browser never loads .ts files: web code keeps its own copies where needed
// (e.g. DOUBLE_ESC_MS), with a comment pointing here.

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// ------------------------------------------------------------------ network, ports, single instance (§0.1, §5.5, §10 S1)
export const PORT_DEFAULT = 41731;
export const PORT_FALLBACK_FIRST = 41732;
export const PORT_FALLBACK_LAST = 41750;                  // 41732–41750, the chosen port is persisted
export const LISTEN_TARGET_MS = 400;                      // boot: listening in < 400 ms
export const PIPE_HANDOFF_TARGET_MS = 200;                // second launch: hand-off over the pipe < 200 ms

// ------------------------------------------------------------------ HTTP / WebSocket guard (§6.1, §10 S2/S3/S6/S15)
export const HTTP_HEADERS_TIMEOUT_MS = 10 * SEC;
export const HTTP_REQUEST_TIMEOUT_MS = 30 * SEC;
export const WS_MAX_PAYLOAD_BYTES = 16 * MiB;
export const BOOT_CODE_BYTES = 24;
export const BOOT_CODE_TTL_MS = 60 * SEC;                 // single use
export const DEVICE_TOKEN_BYTES = 32;
export const APP_WINDOW_WIDTH_PX = 1280;                  // msedge --app … --window-size=1280,860 (§6.1)
export const APP_WINDOW_HEIGHT_PX = 860;

// ------------------------------------------------------------------ hub: batching, backpressure (§0.3, §6.2)
export const DELTA_COALESCE_MS = 50;                      // one timer per chat, armed only while parts are pending and viewed
export const DELTA_FRAMES_PER_SEC_MAX = 20;               // = 1000 / DELTA_COALESCE_MS (checked by the server tests)
export const PROGRESS_MIN_INTERVAL_MS = 1 * SEC;          // `progress` ≤ 1/s per block (reducer)
export const SUMMARY_UPSERT_MIN_INTERVAL_MS = 500;         // `chats` upserts ≤ 2/s per chat; phase changes go at once
export const PROCS_PUSH_MIN_INTERVAL_MS = 1 * SEC;        // `procs` ≤ 1/s; Engine.stats() at most once per second
export const BACKPRESSURE_STALE_BYTES = 4 * MiB;          // stop `ev`, mark the connection stale
export const BACKPRESSURE_RESUME_BYTES = 1 * MiB;         // back under → `snap` for each chat of its view
export const BACKPRESSURE_CLOSE_BYTES = 32 * MiB;         // close with WS_CLOSE_SLOW
export const WS_CLOSE_SLOW = 4001;                        // close code `slow`; the client reconnects

// ------------------------------------------------------------------ request validation and resource limits (§2.4, §6.3, §10 S6/S15)
export const MAX_IMAGES_PER_MESSAGE = 8;
export const MAX_IMAGE_BYTES = 5 * MiB;                   // ≤ 5 MB each after base64 (API limit: 5,242,880 bytes)
export const MAX_IMAGES_TOTAL_BYTES = 12 * MiB;           // sum of the base64 of all images of one chat.send, so the frame fits WS_MAX_PAYLOAD_BYTES (16 MiB); above → client re-encodes/downscales, server rejects `too_large`
export const IMAGE_REENCODE_JPEG_QUALITY = 0.9;           // only above the API byte limit: re-encoded as JPEG 0.9 (§2.4)
export const MAX_TEXT_BYTES = 1 * MiB;                    // chat.send text ≤ 1 MB
export const MAX_DRAFT_BYTES = 1 * MiB;                   // drafts ≤ 1 MB
export const MAX_DETAIL_BYTES = 8 * MiB;                  // tx.detail > 8 MB → too_large
export const TX_PAGE_LIMIT_MAX = 50;                      // tx.page `limit` ≤ 50
export const FS_MENTIONS_MAX = 50;                        // fs.mentions ≤ 50 hits
export const FILE_INDEX_MAX = 200;                        // @-mention index: names only, max 200 (platform T11)
export const SEARCH_MAX_HITS = 50;                        // tx.search ≤ 50 hits
export const LOG_CLIENT_PER_MIN = 10;                     // log.client rate limit
export const CONFINE_MAX_REL_LENGTH = 1024;               // confine(): longer relative paths are refused
export const CWD_MAX_LENGTH = 258;                        // a cwd of 259 chars or more is refused (CreateProcess, S9)
export const CWD_TOO_LONG_AT = 259;
export const ACCOUNT_ID_MAX_LENGTH = 24;                  // /^[a-z][a-z0-9-]{0,23}$/

// ------------------------------------------------------------------ engine: pool, cap, reaper (§0.3, §2.8)
export const MAX_LIVE_DEFAULT = 4;                        // default cap of live processes (configurable)
export const MAX_LIVE_MIN = 2;
export const MAX_LIVE_MAX = 8;
export const LOW_MEM_FREE_BYTES = 1.5 * GiB;              // while os.freemem() < 1.5 GB the effective cap is max(2, live)
export const LOW_MEM_MIN_CAP = 2;
export const REAP_MIN_DEFAULT = 60;                       // minutes after lastRequestAt
export const REAP_MIN_CHOICES: readonly (number | null)[] = Object.freeze([15, 30, 60, 120, null]); // null = never
export const REAP_WARN_BELOW_MIN = 60;                    // below 60 min the settings show a warning
export const REAP_5M_CAP_MS = 5 * MIN;                    // last cache write 5-minute only → min(reapMin, 5 min)
export const NEVER_REQUESTED_STOP_MS = 10 * MIN;          // never-requested process stopped at spawnedAt + 10 min
export const CACHE_TTL_1H_MS = 1 * HOUR;                  // main-loop writes are ephemeral_1h
export const CACHE_TTL_5M_MS = 5 * MIN;                   // ttl when the last cache write was ephemeral_5m only
export const RESUME_STABLE_WINDOW_MS = 3 * SEC;           // resumeStable = true when no SessionStart hook frame within 3 s of init
export const PRESPAWN_IDLE_STOP_MS = NEVER_REQUESTED_STOP_MS;
export const SEND_UUID_LRU = 10_000;                      // per-chat LRU of seen send uuids (idempotency)
export const EST_RAM_PER_LIVE_CHAT_MB = 450;              // ProcStats.estRamMB per live chat (440–470 MB private measured, §0.3)
export const STDERR_RING_LINES = 200;                     // redacted stderr ring per chat

// ------------------------------------------------------------------ engine: watchdogs and closing (§0.3, §2.3, §2.7)
export const INIT_WATCHDOG_MS = 45 * SEC;                 // initializationResult()
export const INTERRUPT_WATCHDOG_MS = 10 * SEC;            // → `stuck`
export const CONTROL_CALL_TIMEOUT_MS = 10 * SEC;          // every ctl() call
export const CLOSE_RUNNING_RESULT_WAIT_MS = 10 * SEC;     // step 1: interrupt, wait ≤ 10 s for the result
export const CLOSE_BG_TASKS_WAIT_MS = 5 * SEC;            // step 2: stopTask each, wait ≤ 5 s
export const CLOSE_EXIT_WAIT_MS = 8 * SEC;                // step 3: input.end(), wait ≤ 8 s for the exit (normal: 0.6–1.7 s)
export const CLOSE_OWN_KILL_DELAY_MS = 2 * SEC;           // step 4: q.close(), then our own kill 2 s later
export const CLOSE_KILL_WAIT_MS = 3 * SEC;                // step 4: then up to 3 s more, else `unkillable`
export const SHUTDOWN_DEADLINE_MS = 15 * SEC;             // shutdown: every chat in parallel, global deadline (> 8 + 2 + 3 s close steps)
export const SDK_CLOSE_KILL_MEASURED_MS = 7_400;          // measured: SDK kill lands ≈ 7.4 s after close() (robust P1)

// ------------------------------------------------------------------ crashes, breaker, supervisor (§0.3, §2.9)
export const BREAKER_CRASHES = 3;                         // 3 crashes in 10 min → error{code:'breaker'}
export const BREAKER_WINDOW_MS = 10 * MIN;
export const SUPERVISOR_MAX_RESTARTS = 3;                 // at most 3 restarts in 60 s
export const SUPERVISOR_WINDOW_MS = 60 * SEC;
export const SUPERVISOR_BACKOFF_MS: readonly number[] = Object.freeze([500, 2 * SEC, 5 * SEC]);
export const EXIT_CODE_STOP = 0;
export const EXIT_CODE_RESTART = 75;

// ------------------------------------------------------------------ server lifetime (§0.3, C13)
export const SERVER_IDLE_EXIT_MS = 10 * MIN;              // no window for 10 min AND no live process AND no pending ask
export const RUNTIME_DROP_MS = 5 * MIN;                   // orchestrator per-chat runtime dropped 5 min after neither live nor viewed

// ------------------------------------------------------------------ accounting, cache, wake (§2.12, §2.10)
export const AUTO_COMPACT_MARGIN_TOKENS = 33_000;         // autoCompactAt = contextWindow − 33 000
export const CACHE_MISS_MIN_RATIO = 0.30;                 // cache-miss row: cache_creation > 30 % of input + cache …
export const CACHE_MISS_MIN_TOKENS = 10_000;              // … and > 10 k
export const WAKE_SHARED_SAME_CWD_TOKENS = 19_000;        // shared prefix: same account, same cwd, within the hour
export const WAKE_SHARED_ACCOUNT_TOKENS = 16_800;         // shared prefix: same account only
export const WAKE_SHARED_WINDOW_MS = 1 * HOUR;
export const WAKE_DIALOG_IDLE_MS = 1 * HOUR;              // wake.dialog = idle > 1 h && lastContext > 100 k && !wakeNeverAsk
export const WAKE_DIALOG_MIN_CONTEXT = 100_000;

// ------------------------------------------------------------------ model / heavy data (§5.5 model, §4)
export const TOOL_OUTPUT_HEAD_BYTES = 4 * KiB;            // outputs cut to head + tail of 4 KB
export const TOOL_OUTPUT_TAIL_BYTES = 4 * KiB;
export const HEAVY_STASH_MAX_BYTES = 8 * MiB;             // per chat, LRU by block
export const ASK_INPUT_MAX_STRING_BYTES = 256 * KiB;      // PendingAsk.input: strings > 256 KB cut (Edit/Write keep up to 256 KB)
export const TITLE_MAX_CHARS = 60;                        // deriveTitle: ≤ 60 chars

// ------------------------------------------------------------------ Claude data: index, reader, watchers (§5.5 Claude data, §7)
export const HEADTAIL_BYTES = 64 * KiB;                   // SDK head/tail metadata algorithm
export const TAIL_STEP_BYTES = 256 * KiB;                 // tail-first reader: backwards steps …
export const TAIL_MAX_BYTES = 2 * MiB;                    // … up to 2 MiB, then forward chunks with yields
export const SEARCH_CHUNK_BYTES = 64 * KiB;
export const MAX_LOOP_BLOCK_MS = 8;                       // searches and big scans never block the loop more than 8 ms
export const WATCH_DEBOUNCE_MS = 300;                     // per path
export const REGISTRY_FRESH_MS = 60 * SEC;                // a holder is live if updatedAt is < 60 s old (or pid + procStart match)
export const USAGE_SNAPSHOT_STALE_MS = 1 * HOUR;          // cachedUsageUtilization is stale after 1 h
export const USAGE_REFRESH_MIN_INTERVAL_MS = 10 * MIN;    // usage_EXPERIMENTAL at most once per 10 min per account
export const LOGIN_TIMEOUT_MS = 10 * MIN;                 // `claude.exe auth login` killed after 10 min
export const CLEANUP_PERIOD_DAYS_DEFAULT = 30;            // CLI retention sweep default
export const CLEANUP_PERIOD_DAYS_ADVISED = 3650;          // the `"cleanupPeriodDays": 3650` line Comptes offers to copy (never written, §8)
export const EXPIRY_FLAG_FROM_DAY = 25;                   // rows show « Supprimé dans n j » from day 25
export const EXPIRING_SOON_DAYS = 5;                      // Comptes: count expiring within 5 days
export const INDEX_TEXT_MAX_CHARS = 200;                  // titles and prompts cut to 200 chars in cache\index-*.json
export const PROMPTS_MAX_LINES = 5_000;                   // state\prompts.jsonl, rotated

// ------------------------------------------------------------------ app storage and logs (§7.1)
export const META_DEBOUNCE_MS = 1 * SEC;                  // json-store writes debounced 1 s, flushed at shutdown
export const LOG_MAX_FILES = 5;                           // 5 × 5 MB
export const LOG_MAX_FILE_BYTES = 5 * MiB;
export const LOG_FIELD_MAX_CHARS = 2_000;                 // one log field is cut beyond this

// ------------------------------------------------------------------ UI budgets and timings (§9.2, §9.3, §9.5)
export const DOUBLE_ESC_MS = 600;                         // `Échap Échap` (< 600 ms, idle only)
export const PREFETCH_DEBOUNCE_MS = 150;                  // hover / arrow focus prefetch of tx.page
export const PEEK_EXCHANGES = 3;                          // Peek shows the last 3 exchanges
export const TITLE_BADGE_MIN_INTERVAL_MS = 1 * SEC;       // window title and favicon badge ≤ 1/s
export const MOUNTED_TURNS_MAX = 150;
export const PANE_DOM_NODES_MAX = 4_000;
export const STICK_TO_BOTTOM_PX = 48;
export const PANE_MIN_WIDTH_PX = 420;
export const SIDEBAR_WIDTH_DEFAULT_PX = 280;
export const SIDEBAR_WIDTH_MIN_PX = 220;
export const SIDEBAR_WIDTH_MAX_PX = 420;
export const SIDEBAR_VIRTUALISE_ABOVE = 300;
export const INPUT_LATENCY_BUDGET_MS = 16;
export const LONG_TASK_BUDGET_MS = 50;
export const FIRST_PAINT_BUDGET_MS = 300;
export const CHAT_OPEN_BUDGET_MS = 150;
export const CLIENT_HEAP_BUDGET_BYTES = 150 * 1000 * 1000;
export const SERVER_IDLE_RSS_BUDGET_BYTES = 120 * 1000 * 1000;
export const SERVER_IDLE_CPU_WINDOW_MS = 30 * SEC;        // server idle: 0 ms CPU over 30 s (test bound: < 5 ms)
export const SERVER_IDLE_CPU_BUDGET_MS = 5;
export const EDGE_IDLE_CPU_BUDGET_PCT = 1;                // fresh dedicated profile with the lean flags (measured 0.86 %)

// ------------------------------------------------------------------ real-model smoke (§12.5)
export const SMOKE_MAX_API_REQUESTS = 8;                  // the budget file aborts the smoke run beyond 8 API requests

// ------------------------------------------------------------------ helpers (§2.11)
export const JOBRUN_PRIVATE_MEM_BUDGET_BYTES = 15 * 1000 * 1000; // else the default isolation becomes `plain`
