// @ts-check
// src/web/components/chat/consts.js — browser mirror of the src/shared/limits.ts values the chat surface needs.
// No .ts file is ever served to the browser (SPEC §3), so the values are copied here;
// test/unit/web-chat/consts.test.ts fails if any of them drifts from limits.ts.

const KiB = 1024, MiB = 1024 * KiB;

export const LIMITS = Object.freeze({
  MAX_IMAGES_PER_MESSAGE: 8,
  MAX_IMAGE_BYTES: 5 * MiB,
  MAX_IMAGES_TOTAL_BYTES: 12 * MiB,
  IMAGE_REENCODE_JPEG_QUALITY: 0.9,
  MAX_TEXT_BYTES: 1 * MiB,
  MAX_DRAFT_BYTES: 1 * MiB,
  WS_MAX_PAYLOAD_BYTES: 16 * MiB,
  TX_PAGE_LIMIT_MAX: 50,
  DOUBLE_ESC_MS: 600,
  PEEK_EXCHANGES: 3,
  MOUNTED_TURNS_MAX: 150,
  STICK_TO_BOTTOM_PX: 48,
  WAKE_SHARED_SAME_CWD_TOKENS: 19_000,
  AUTO_COMPACT_MARGIN_TOKENS: 33_000,
  WAKE_DIALOG_MIN_CONTEXT: 100_000,
  INTERRUPT_WATCHDOG_MS: 10_000,
  TOOL_OUTPUT_HEAD_BYTES: 4 * KiB,
});

/** UI-only tuning (ux §5, §6, §7, §12); not part of limits.ts. */
export const UI = Object.freeze({
  GROUP_COLLAPSE_MS: 1500,         // a tool group collapses 1.5 s after it ends (ux §5.2)
  CARD_AUTOFOCUS_IDLE_MS: 2000,    // focus moves to a new card only if the user has not typed for 2 s (ux §6.1)
  CANCELLED_FADE_MS: 3000,         // « Demande annulée » fades after 3 s
  TAIL_REPARSE_MS: 100,            // streaming tail re-parsed at most every 100 ms (ux §12.2)
  DIFF_CHUNK_LINES: 200,           // diffs render in chunks of 200 lines
  DIFF_COLLAPSE_LINES: 400,        // diffs over 400 lines start collapsed
  DIFF_LCS_MAX_CELLS: 1_000_000,   // n·m above → block view « n lignes remplacées par m » (ux §6.3)
  WORD_DIFF_MAX_CHARS: 500,        // word-level highlight only on paired lines shorter than 500 chars
  OUTPUT_TAIL_LINES: 8,            // Bash output: tail of 8 lines + « Afficher tout »
  READ_MAX_LINES: 400,
  INITIAL_TURNS: 30,               // last 30 turns first, then pages of 20 (ux §12.3)
  PAGE_TURNS: 20,
  EST_TURN_PX: 400,                // = contain-intrinsic-size of .c-turn (chat.css): height of a never-measured turn
  TRANSCRIPT_NODE_BUDGET: 3200,    // elements of the mounted turns, so a pane stays ≤ 4,000 nodes (SPEC §9.5)
  MIN_MOUNTED_TURNS: 20,           // the adaptive window never mounts fewer turns than this
  WINDOW_EDGE_TOP: 15,             // the window moves when the first visible turn is this close to its first turn…
  WINDOW_EDGE_BOTTOM: 30,          // …or this close to its last one (hysteresis: a move puts it 1/3 down the window)
  DRAFT_DEBOUNCE_MS: 300,
  WAKE_HINT_MIN_TOKENS: 20_000,    // cold chat: hint above 20 k (ux §7.8)
  CACHE_COLD_HINT_MIN_TOKENS: 30_000,
  CONTEXT_FULL_MARGIN: 0.05,       // within 5 % of the window
  CACHE_SOON_MS: 5 * 60_000,       // cache clock amber below 5 min
  BOTTOM_STRIP_MAX_TODOS: 7,
  IMAGE_TOO_MANY: 10,
  HIGHLIGHT_MAX_LINES: 1500,
  HIGHLIGHT_MAX_BYTES: 50_000,
});
