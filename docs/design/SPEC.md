# Spécification d’architecture (référence de conception, en anglais)

> **Référence de conception d’origine.** Ce document est la spécification rédigée avant l’implémentation de SidMultiClaude ; il est conservé en anglais. Le code y renvoie sous la forme « SPEC §x.y » : la numérotation des sections est donc figée. Certaines parties décrivent l’intention de conception plutôt que l’état exact du code ; en cas d’écart, le code et les tests font foi. Vue d’ensemble en français : [ARCHITECTURE.md](../ARCHITECTURE.md).

# SidMultiClaude: architecture specification (v1.0)

Design reference, 2026-10-08. No model call was made to write this spec.

**Type-checked contracts:**
- The TypeScript in §4 and §5 was type-checked with `tsc` 5.9.3 **and** 7.0.2 (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`) against the real SDK 0.3.293 types.
- The browser contract passes a `checkJs` project.
- The implementation starts from these files verbatim: `src/shared/protocol.ts`, `src/server/contracts.ts`, `src/server/engine/options.ts`, `src/web/contract.d.ts`.

**Evidence markers** (in parentheses after a claim):

| Marker | Meaning |
|---|---|
| *measured* | Measured on a real machine |
| *code* | Read in shipped code |
| *SDK types* | SDK type declarations or docs |
| *inferred* | Inference |
| *unverified* | §12 or §13 names the test that settles it |

**Language rule:** UI copy is French and exact. Engineering prose is English. The UX specification ([UX.md](UX.md), cited as “ux §x”) remains the detailed UX reference; this spec states only the essentials and every change to it (§9).

---

## 0. Decisions summary

### 0.1 Shape

- **Server.** One hidden Node 24 server on `127.0.0.1:41731`; it is the only component that drives Claude Code.
- **Window.** An Edge `--app` window with a dedicated profile is a pure view. It talks to the server over one authenticated WebSocket.
- **Launcher.** A GUI-subsystem launcher (`SidMultiClaude.exe`, compiled at install with the Windows `csc.exe`) starts or reuses the server and restarts it after a crash.
- **Engine.** The official Claude Code is driven through the Agent SDK `query()` in streaming-input mode: **one `claude.exe` per *active* chat** (not per tab).
  - Each chat runs inside its own Windows Job Object through `jobrun.exe`, so its whole process tree dies with it.
  - Chats live in Claude's own transcript store. The app keeps only light metadata in `%LOCALAPPDATA%\SidMultiClaude\`.

### 0.2 Stack and exact versions

| Layer | Package / tool | Version | Note |
|---|---|---|---|
| Runtime | Node.js | ≥ 24.16.0 | `.ts` type stripping; `node --test`; recursive `fs.watch` |
| Engine | `@anthropic-ai/claude-agent-sdk` | **0.3.293** | **Root entry only**: it imports Node built-ins only (measured), loaded lazily at the first spawn. `npm ci --omit=optional` (−244 MB) |
| Peers (lockfile only, never imported) | `@anthropic-ai/sdk` · `@modelcontextprotocol/sdk` · `zod` | 0.132.1 · 1.32.1 · 4.6.5 | npm 11 installs peers; types only |
| WebSocket | `ws` | **8.22.0** | 0 deps; `maxPayload` 16 MiB; `perMessageDeflate:false` |
| CLI | the user's native `claude.exe` | 2.1.294 today (auto-updates) | `%USERPROFILE%\.local\bin\claude.exe`. The bundled 2.1.293 is an opt-in fallback (§1.3 C1) |
| UI | `preact` · `htm` · `@preact/signals` · `@preact/signals-core` | **11.0.1** · 3.1.1 · 2.11.3 · 1.14.4 | Preact 11 is required: it clears with `textContent`, which is safe under Trusted Types (measured) |
| UI | `marked` · `dompurify` | **18.1.0** · **3.4.16** | The single HTML sink |
| UI (lazy) | `@highlightjs/cdn-assets` | 11.12.0 | ESM core plus about 10 languages (**not** the CommonJS `highlight.js` package) |
| UI (own code) | `fuzzy.js` (NFD, accents stripped, subsequence score), `diff.js` (line LCS) | — | Replaces `fuzzysort` and `jsdiff` (§1.3 C11) |
| Dev | `typescript` · `@types/node` · `@types/ws` · `playwright-core` | **7.0.2** · 24.19.1 · 8.18.2 · **1.63.0** | TS 7 rejects `baseUrl`. Playwright drives the installed Edge (`channel:'msedge'`), with no browser download (measured) |
| Native helpers | `launcher\SidMultiClaude.cs`, `launcher\jobrun.cs` | C# 5, `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` | SHA-256 recorded at install. A `jobrun.exe` hash mismatch → plain spawn; a blocked launcher → `npm start` |

There is no bundler, transpiler, server framework, test framework, Electron or Tauri. Library payload: about 50 kB gzip, plus highlight.js loaded lazily.

### 0.3 Engine policy, with numbers

| Policy | Value | Evidence |
|---|---|---|
| Options | `systemPrompt` preset `claude_code`; `settingSources ['user','project','local']`; explicit `permissionMode`; `includePartialMessages`; nothing else unless the user chose it (§2.2) | 37,152 vs 37,150 input tokens against `claude -p` (measured) |
| Hidden title call | `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` in the child env, plus `title` whenever it is known, plus a live `renameSession` after the first send otherwise | −1,174 in / −15 out per new chat (measured) |
| When a process exists | Lazily: first keystroke in a cold chat (pre-spawn, 0 tokens (measured)) or send | |
| Cap | **4** live processes (setting 2–8). At spawn time, while `os.freemem()` < **1.5 GB**, the effective cap is `max(2, live)`, so growth needs an eviction | 440–470 MB private per chat (measured); 0.6–2 GB free during tests (measured) |
| Reap | `lastRequestAt + 60 min` (setting 15/30/60/120/never; below 60 a warning). If the last cache write was 5-minute only, `min(reapMin, 5 min)` | Main-loop writes are `ephemeral_1h` (measured); a resume re-creates ≈ 18 k + history (measured) |
| Never-requested process | Stopped at `spawnedAt + 10 min` | No cache to lose |
| Never reaped or evicted | Running · ask pending · background tasks · queued messages · visible in any window · *Garder actif* · closing | |
| Eviction at the cap | (1) never requested and (2) cache expired: silent. Otherwise ask (`cap.choice`), listing `resumeStable` accounts first, then the coldest cache, each with its re-cache estimate | Coldest-first (measured) |
| Watchdogs | Init 45 s · interrupt 10 s → `stuck` · each control call 10 s · close: `input.end()` and up to 8 s for the exit; then `q.close()` and our own kill 2 s later; then up to 3 s more, else `unkillable` | SDK kill lands only 7.4 s after `close()`; `input.end()` does not end a running turn (measured) |
| Crash | No automatic respawn. Messages that never started come back to the composer. Breaker: 3 crashes in 10 min → *Réessayer* required | |
| Delta streaming | Coalesced per chat every **50 ms** (timer armed only while deltas are pending and someone views the chat). Progress ≤ 1/s per block. Sidebar upserts ≤ 2/s per chat; phase changes go at once | |
| Resync | Snapshot only (live turn plus state) and disk pages. **No replay ring.** Stable block ids make merges idempotent | §1.3 C3 |
| Server lifetime | Alive while a process or a pending ask exists. Exits 10 min after the last window closed **and** nothing is live | §1.3 C13 |
| Supervisor | The launcher restarts the server at most 3 times in 60 s (0.5 / 2 / 5 s) | Design (robust). The launcher's console-free start and pipe hand-off are measured (measured) |

---

## 1. Design alternatives and the conflicts this spec resolves

### 1.1 Alternatives considered

Three candidate designs were compared before this spec was written:

- **Lean:** strongest token-parity guarantees and lightness (one options builder, zero-cost parity tests, few dependencies, a single timer).
- **Interactive:** richest UX (Peek, *send after this turn*, hover prefetch, multi-window first-answer-wins) and a pure model package shared by live frames and disk lines.
- **Robust:** strongest failure handling (watchdogs from measured SDK timings, Windows Job Objects, a supervising launcher, a crash breaker, schema validation).

### 1.2 What the final design takes from each

**Base:** lean, because token parity and lightness are the mission's hard constraints.

| Source | What is grafted |
|---|---|
| **Lean** | Parity contract (`buildOptions` + `accountEnv`); app-chosen session ids (`sessionId`); snapshot-only resync; T-P1…T-P5 parity tests; single-timer reaper; root SDK entry; own `fuzzy.js` / `diff.js`; head/tail index and tail-first reader with no global env on the hot path |
| **Interactive** | Pure **model** package (live frames and disk lines → the same `UiTurn` / `UiBlock`); stable block ids; Peek (answer from the sidebar); `Alt+Entrée` = `'later'`; hover prefetch; multi-window first-answer-wins; reopen the window on attention; server lifetime tied to warm processes; `fs-guard`; the web shell ↔ the chat surface contract file; PowerShell `-EncodedCommand` for *Ouvrir dans le terminal* |
| **Robust** | Watchdogs with measured numbers; `jobrun.exe` Job Objects (default, with fallback); supervising launcher; crash breaker; S9 working-folder policy; schema validation that rejects unknown fields; idempotent `send` on uuid plus a client outbox; server-side ask registry delivered in every `hello`; error boundaries per Turn/ToolCard; `fake-claude.mjs` (15/15 vs the real SDK) as the fake-CLI seed; contract checks K1–K7 at 0 tokens; `ctl()` timeouts and feature detection |

### 1.3 Conflicts, resolved

| # | Conflict | Decision | Why |
|---|---|---|---|
| C1 | CLI binary: bundled 2.1.293 (the SDK research, robust) vs installed native (TOKEN-RESEARCH.md §7.14, lean, interactive) | **Installed native `claude.exe` by default.** `Settings.exe = 'bundled'` is opt-in; it needs `npm run fetch-bundled-cli` (unverified). Every spawn logs `claude_code_version` and compares the initialize key set with a stored snapshot (0-cost drift detector). An init or protocol failure shows a banner offering the bundled binary | Same binary as the user's terminal (interop with `claude --resume`); −244 MB; identical request bodies except the billing header, and the cache is shared across versions (measured); every real run in verify/tokens used the native one. The pinned-pair argument is answered by the drift detector plus `npm run test:contract` (0 tokens) |
| C2 | Chat identity: `chatId = sessionId` (lean) vs `s:acc:sid` / `n:uuid` (interactive) vs opaque ids (robust) | **`chatId = "<accountId>:<sessionId>"`.** The app picks the session id of new chats (`options.sessionId`, CLI `--session-id` (measured)) and of forks (`sessionId` + `forkSession` (SDK types)). `/clear` and a CLI that ignores our fork id → **re-key** (`chats.rekey`); the old session simply stays a separate cold chat | Deterministic for every session on disk, with no "pending id" state. The same session id in two profiles cannot collide. The re-key is rare and explicit |
| C3 | Reconnect: replay ring (interactive, robust) vs snapshot only (lean) | **Snapshot only**, with stable block ids. Finished turns come from disk; the live turn is in `snap` | Loopback drops are rare; a reload or a server restart needs a snapshot anyway; server memory stays flat |
| C4 | Early reap after 10 min on hook-free accounts (lean) | **No early time-based reap.** `resumeStable` only orders the eviction candidates offered under the cap | The premise is (inferred) for real profiles. Parity must be guaranteed by default |
| C5 | Auto-resume after a rate limit: user-armed (ux, interactive, robust) vs out (lean) | **Out of v1.** The banner offers *Me prévenir à la réinitialisation* (OS notification only, no prompt sent) and *Continuer sur un autre compte…* | It avoids unattended prompting (Consumer Terms §3(7)) (measured) |
| C6 | Disk access: worker per account (robust) vs in-process readers plus a mutex (lean, interactive) | **In-process own readers** that take the config dir as a parameter. SDK helpers only for rename, delete and fork-up-to, behind **one** promise-chain mutex. Searches and big scans are chunked with yields (never block more than 8 ms) | Lighter (no isolates); the hot paths never touch `process.env` |
| C7 | Process-tree cleanup: `taskkill /T /F` (lean, interactive) vs Job Object (robust) | **`jobrun.exe` by default** when built and hash-checked; plain spawn plus `taskkill /T /F` as an automatic per-chat fallback and a setting. Two checks: smoke S4 with the Bash tool (unverified) and the RAM overhead (unverified) | Verified with the real CLI: a hook grandchild dies under the job and survives without it (measured) |
| C8 | Supervisor: robust yes; others no | **Yes**, built into the launcher (≈ 40 more lines) | A server crash otherwise strands the window. Cheap |
| C9 | `plansDirectory`: the SDK behaviour probes suggest `.plans`; all three designs leave it unset | **Unset** | CLI parity. The plan text comes in the ask input anyway |
| C10 | `DISABLE_AUTOUPDATER=1` (robust) | **Not set** | (inferred); it changes the env compared with the terminal; irrelevant with the installed binary |
| C11 | `fuzzysort` + `jsdiff` vs own code | **Own code** (`fuzzy.js` ≈ 40 lines, `diff.js` ≈ 80 lines), tested against platform's `fuzzy.json` accent cases | Fewer supply-chain deps; Edit/Write results already carry `structuredPatch` (measured) |
| C12 | Titles | `title` at spawn when known (the dialog's *Nom*, or `deriveTitle(first prompt)` when the spawn is caused by a send). Pre-spawned untitled chats → live `q.renameSession(title, sessionId)` at the first `delivered`. `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` always, unless *Titres IA* is on | (measured). The timing of the live rename is (unverified), covered by a fake-CLI test plus smoke S1 |
| C13 | Server lifetime | Exit only when there has been no window for 10 min **and** no live process **and** no pending ask. `reopenWindowOnAttention` (default on): an ask with no window → the server opens one | Closing the window must not throw away warm caches |
| C14 | Cap default 3 or 4 | **4**, with the low-memory freeze | Open to the user (§13 Q2) |
| C15 | Do resumes run SessionStart hooks? the SDK behaviour probes showed the fork ran none; lean and TOKEN-RESEARCH.md say resume does | **Resume (by id or by `.jsonl` path) runs the 4 `SessionStart:resume` hooks** (measured). The CLI **fork** in verify ran none (measured), cause unknown. Wake estimates always assume a re-cache | Both observations hold; they concern different paths |
| C16 | Sleeping a chat with background tasks | *Mettre en veille* asks `sleep.tasks.confirm`, then `stopTask` each, then closes. Reap and eviction never touch such a chat | robust Q2 |
| C17 | `Ctrl+Entrée` = `'now'` | Enabled only when `system:init.capabilities` contains `interrupt_send_now_v1`. Semantics checked by smoke S5 (unverified) | CHANGELOG only (SDK types) |
| C18 | Home folder as cwd: warn (ux) vs refuse (robust) | **Refuse** the home folder itself and anything inside a Claude config dir or the app data dir; **warn** for ancestors (`C:\`, `C:\Users`) | With cwd = home, `~\.claude\settings.json` becomes *project* settings for every profile, and "always allow" could write into it (measured) |
| C19 | Ring-buffer `seq` vs per-connection `seq` | **Per-chat `seq`**, incremented per emitted `ev` after chat-level coalescing; a snapshot carries the current `seq` | One coalescer per chat, identical frames for every subscriber |
| C20 | Elicitation | `onElicitation` wired to an elicitation card, **gated by T-P3** like `perTaskStopAffordance` and `enableFileCheckpointing` | All three are request-neutral only by inference (unverified); T-P3 settles it at 0 tokens |

### 1.4 Initial hypotheses (re-checked)

| Hypothesis | Verdict | Conditions / evidence |
|---|---|---|
| Engine = official Claude Code through the SDK with the `claude_code` preset and the same setting sources | **Confirmed** | Explicit preset (else 141 tokens instead of 3,122 (measured)); explicit sources; rebuilt env (`env` replaces the environment (code)); explicit `permissionMode`; title switch. Remaining (unverified): the interactive TUI identity line differs ("You are Claude Code…" vs "You are a Claude agent…" (measured)); its size was not measured. The app equals the CLI's **host lane** (`--permission-prompt-tool stdio`, measured by parity test T-P3): same tool set as the interactive TUI, i.e. plain `claude -p` plus the 3 deferred interaction tools |
| The app itself never calls a model | **Confirmed** | Listing, history, preview, rename, delete, identity, usage snapshot, registry, pre-spawn, `getContextUsage('summary')`, `/usage`, `usage_EXPERIMENTAL` all cost 0 tokens (measured). Banned: `generateSessionTitle`, `askSideQuestion`, `promptSuggestions`, `agentProgressSummaries`, `getContextUsage('full')`. Model calls happen only on explicit user actions labelled « ↯ modèle » |
| One long-lived streaming query per open chat; idle reaping; LRU; resume by id | **Confirmed, corrected:** per **active** chat, not per tab | Live turn 2: 37,154 read / 81 written; resume: 19,277 / 17,913 (×9.7; ≈ ×16 at 100 k, ≈ ×20 at 500 k) (measured). Reap at the cache death; evict the coldest; ask before killing a warm cache |
| Chats in Claude's store; light app metadata | **Confirmed** | App sessions are `sdk-ts`: hidden from the terminal picker, resumable by id (SDK types, verified), subject to the 30-day sweep (measured). Wiping the app folder never loses a conversation |
| Node 24 server + WebSocket + no-build Preact/htm + Edge `--app` | **Confirmed** | Shell ≈ 223 MB private, server 0 ms CPU idle, CSP + Trusted Types + import map verified (measured). No cookies: a cross-port cookie leak was measured |

### 1.5 Factual claims re-checked against the measurements (anything still open is listed in §13)

| Claim used by this spec | Status |
|---|---|
| Preset + 3 sources = `claude -p` (37,152 vs 37,150); same 37 tools / 78 skills / 16 MCP; 1 h TTL | measured |
| Hidden title call in SDK mode; suppressed by the env var (real run) and by `title` (mock) | measured |
| Resume by id **and** by `.jsonl` path runs 4 `SessionStart:resume` hooks; no-prompt resume appends only `mode` / `cost-state` lines | measured |
| CLI fork via `resume=<abs .jsonl>` + `forkSession`: new id before any prompt; file only at the first prompt, under the new cwd's project dir; uuids kept; no hooks; cheap within the TTL | measured |
| `sessionId` with `resume` requires `forkSession` | (SDK types); with a `.jsonl` path (unverified) (fallback: re-key from the first frame) |
| `canUseTool`: `title` never sent; `requiresUserInteraction` marks AskUserQuestion / ExitPlanMode; plan text in `input.plan`; deny message reaches the model verbatim; interrupt → `signal` abort ≈ 13 ms → return `null` | measured |
| Suggestions: Write → `setMode acceptEdits` (session); Bash → exact-command `addRules` (`localSettings`) | measured |
| Queue: no priority = `'next'` = fold at the next tool boundary (no echo frame); `'later'` = own turn; `cancelAsyncMessage` | (measured); `'now'` (unverified) |
| `session_state_changed` exists on the wire but the SDK drops it | measured, code |
| Live `q.renameSession` → frame + `custom-title` + `agent-name` + sidecar; the CLI adopts external titles | measured |
| `haiku` alias in plan mode runs on Sonnet | (measured); full id `claude-haiku-5-5` avoids it (code, unverified) |
| Images: base64 blocks before the text; stored inline in the transcript and copied to `%TEMP%` | measured |
| `fs.watch` on an 8.3 path aborts Node | measured |
| Live registry `<cfg>\sessions\<pid>.json`, with stale files possible | (measured); never read `*.key` |
| `claude auth status` writes into the profile (≈ 5 s) | (measured) → never polled |
| `claudeMdExcludes` via `settings` removes the leaked `~\.claude\CLAUDE.md`; case-sensitive | measured |
| `close()` kills only at about 7.4 s; `input.end()` does not end a running turn; a crash rejects control calls | measured |
| Job Object kills hook grandchildren, both on exit and on host kill; the real CLI runs inside it | (measured); Bash tool (unverified) |
| Cookies leak across loopback ports; boot code + device token + exact Host/Origin; CSP + TT + import-map hash | measured |
| `spawn` with a cwd ≥ 260 chars fails with a misleading `ENOENT` | measured |
| `node --test` runs `.ts` files; JSDoc `import('../shared/protocol.ts')` resolves | measured |
| `BUN_OPTIONS=--smol` saves no RAM | measured |
| Edge `--app` idle CPU 0.86 % (fresh profile, lean flags) up to 9.5 % (aged profile, default flags) | measured |
| Playwright-core 1.63.0 drives the installed Edge 154 headless with no download | measured |

---

## 2. Engine and lifecycle

### 2.1 Identity and spawn kinds

**Identities.**
- **Chat** = one Claude session of one account: `chatId = "<accountId>:<sessionId>"`.
  - `accountId` is a slug fixed at creation (`perso`, `entreprise`, `perso-2`); renaming an account changes only its display name.
- **At most one live `query()` per chat:** one `jobrun.exe` → one `claude.exe` → one session id.
  - The engine keeps `sessionId → chatId` and refuses a second spawn on the same session.
- **Never two writers.**
  - Before every spawn on an existing session, the engine asks `LiveRegistry.holder()` (`<cfg>\sessions\<pid>.json`; pid alive and `procStart` matching; our own pids excluded).
  - The same check runs again right after init, as a race guard. If a holder appeared, the chat goes back to sleep and shows *Ouvert ailleurs*.

| Spawn kind (`SpawnStart`) | Options (besides §2.2) | Used for | Evidence |
|---|---|---|---|
| `new{title?}` | `sessionId = spec.sessionId`, `title?` | New chat | `--session-id` (measured) |
| `resume` | `resume = sessionId`, recorded cwd | Waking a cold chat, terminal hand-back | measured |
| `fork{fromJsonl, title}` | `resume = <absolute .jsonl>`, `forkSession:true`, `sessionId = <new UUID>`, `title` | *Bifurquer* (whole chat) and *Continuer sur un autre compte* | (measured); `sessionId` combination (unverified) → if the first frame shows another id, `sink.sessionChanged()` re-keys |
| `rewind{atUuid, dropsTurn?}` | `resume = sessionId`, `resumeSessionAt`, `resumeDropsTurn?` | *Restaurer la conversation* | (SDK types) headless lane only. A refusal (`Resume rejected by --resume-drops-turn:`) → plain resume plus `rewind.fallback` |

**Forbidden combination:** `resume = <.jsonl path>` without `forkSession`. It would append to another profile's file (measured). `buildOptions` callers assert against it (the engine unit test).

**Session id timing.**
- The id is known from the first frame (`hook_started.session_id`), about 1.6 s after the spawn (measured).
- A `.jsonl` exists only after the first prompt. Until then the chat is `notStarted` (`size === 0`) and `listSessions` does not show it.
- The app keeps it in `chats.json` (`pendingStart`).

### 2.2 Parity contract

`engine/options.ts` (§5.3, verbatim) is the **only** place that builds `Options`.

**Always passed:**
- `systemPrompt: {type:'preset', preset:'claude_code'}`;
- `settingSources: ['user','project','local']`;
- an explicit `permissionMode`;
- `includePartialMessages: true`;
- `pathToClaudeCodeExecutable`;
- `cwd` = `realpathSync.native` (8.3 names expanded, exact case, < 259 chars);
- `canUseTool`, `spawnClaudeCodeProcess`, `stderr`.

**Passed only under conditions:**

| Option | Condition |
|---|---|
| `perTaskStopAffordance` / `enableFileCheckpointing` / `onElicitation` | Only if T-P3 shows unchanged request bodies (unverified). If T-P3 fails, drop them; the UI then hides rewind-code and elicitation |
| `settings.claudeMdExcludes` | Non-default accounts only: `[H+'/.claude/CLAUDE.md', H+'/.claude/rules/**']`, where `H = realpathSync.native(os.homedir())` with `/` separators and the exact case (matching is case-sensitive (measured)). Toggle on by default; never on the default profile |
| `model` / `effort` | Only values the user picked: aliases `opus` / `sonnet` / `haiku` / `fable` or catalog ids, never free text (an unknown string triggers a validation model call (measured)) |
| `allowDangerouslySkipPermissions` | Only while *Autoriser le mode Contournement* is on |

**Env (`accountEnv`).**
- Blacklist copy of the server's env minus `/^(CLAUDECODE|CLAUDE_.*|ANTHROPIC_.*|AI_AGENT|OTEL_.*|NODE_OPTIONS|NODE_DEBUG|DEBUG|ELECTRON_RUN_AS_NODE)$/i`.
- `CLAUDE_CONFIG_DIR` only for non-default profiles.
- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` unless *Titres IA* is on.
- `CLAUDE_AGENT_SDK_CLIENT_APP=sidmulticlaude/<ver>`.
- `TEMP`/`TMP` are kept in their 8.3 form, for terminal parity (measured).
- **The server also deletes `CLAUDECODE`, `CLAUDE_*` and `ANTHROPIC_*` from its own `process.env` at boot**, so a server launched from a Claude session cannot leak into the SDK helpers.

**Never passed:** `tools`, `allowedTools`, `disallowedTools`, `agents`, `mcpServers`, `plugins`, `hooks`, `skills`, `betas`, `thinking`, `maxThinkingTokens`, `appendSystemPrompt`, `toolConfig`, `plansDirectory`, `promptSuggestions`, `agentProgressSummaries`, `sessionStore` (it copies `.credentials.json` (code)), `persistSession:false`, `continue`, `extraArgs`.

**Live changes.**
- Mode: `setPermissionMode` (measured), echoed by `system:status{status:null, permissionMode}`. Mode changes never break the cache.
- Model: `setModel` (SDK types). It breaks the cache like `/model` in the CLI, so the UI confirms while the cache is warm.
- Effort: `applyFlagSettings({effortLevel})` (SDK types, unverified). Same confirmation.
- The app never respawns a process to apply a setting.

### 2.3 Engine state machine (per chat; `engine/chat-process.ts`)

`phase ∈ spawning | live | closing` (absent = cold). The facts sent to the model are derived as follows:
- **busy** = some delivery is `queued` or `started`, **or** a turn is between `system:status{status:'requesting'}` and a `result` with `queued_turn_count === 0`;
- **pendingAsks** = the number of open `canUseTool` / `onElicitation` callbacks;
- **bgTasks** = non-ambient entries of the latest `background_tasks_changed` (replace semantics);
- **lastRequestAt** = time of the last main-thread `system:status{status:'requesting'}` (measured);
- **ttlMs** = 1 h, or 5 min when the last `result.usage.cache_creation` showed only `ephemeral_5m` writes.

| From | Event | Guard | Action | To |
|---|---|---|---|---|
| cold | `ensure(spec, why)` | account connected · cwd passes S9 · no external holder (unless `force`) · pool grants a slot · breaker closed | `query({prompt: InputQueue, options: buildOptions(spec, cb)})`, pump loop; **init watchdog 45 s** on `initializationResult()` | spawning |
| spawning | `initializationResult()` resolves | — | record `cliPid`, `claude_code_version`, capabilities; check the account (`accountInfo().email` must equal the profile identity, else a warning toast and an *Infos de session* note); re-check the registry | live |
| spawning | watchdog fires / init rejects / exit | — | own kill; `ExitInfo{reason:'init_timeout' or 'spawn_failed'}`; deliveries → `returned` | cold |
| live | `send(m)` | uuid not seen | delivery `pending`; `InputQueue.push(userMessage)` | live |
| live | `interrupt()` | busy or asking | `await setImmediate()` then `q.interrupt()` (ordering race (measured)); **watchdog 10 s** → `stuck` | live |
| live | `canUseTool(...)` | — | register the ask (§2.5) | live |
| live | `result` | — | busy recomputed; `facts` emitted | live |
| live | `close(reason)` | §2.7 | closing algorithm | closing → cold |
| live | process exit without a close request | — | crash path (§2.9) | cold |
| any | `conversation_reset` (`/clear`) | — | `sink.sessionChanged(chatId, new_conversation_id)` → re-key | same |

**Every control call** goes through `ctl(name, fn)`:
- 10 s timeout;
- runtime-only methods (`cancelAsyncMessage`, `renameSession`, `listPermissionRules`, `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) are checked with `typeof q[name] === 'function'` before use; a missing method → `unsupported`;
- every failure becomes a typed error and **never hangs** (measured).

### 2.4 Sending, queue and title

**Message format.**
- Each message is `{type:'user', message:{role:'user', content}, parent_tool_use_id:null, session_id:'', uuid, origin:{kind:'human'}, priority?}`, with `uuid` = the client uuid (idempotency key).
- Images (≤ 8 per message, MIME allow-list, ≤ 5 MB each after base64): `{type:'image', source:{type:'base64', media_type, data}}` blocks **before** the text block (measured). No client downscale except above the API byte limit (re-encoded as JPEG 0.9 with `tool.image.reencoded`).
- Slash commands are plain text; the CLI dispatches them (measured).
- Pushing while `spawning` is safe: the SDK writes user lines only after `initialize` (measured).

**Priorities while the chat is busy** (measured):

| User action | Priority sent | Effect | Chip |
|---|---|---|---|
| `Entrée` | none (`'next'`) | Folded into the running turn at the next tool boundary; no echo frame | `folded` when it appears among the non-first `result.user_message_uuids` |
| `Alt+Entrée` / *Envoyer après ce tour* | `'later'` | Its own turn after the current one | |
| `Ctrl+Entrée` | `'now'` | Only when the capability is present; semantics (unverified) (smoke S5) | |

**Cancel and lifecycle.**
- *Retirer* / `↑`: `await setImmediate()`, then `cancelAsyncMessage(uuid)`. `true` → `cancelled`; `false` → *Déjà pris en compte* (measured).
- `command_lifecycle{command_uuid, state}` drives every delivery: `queued → started → completed`, or `cancelled`. `started` (or a fold) → `sink.delivered()`.

**Wake with a summary.** `wake:'summary'` pushes `/compact` first, then the user message with `'later'`.

**Titles (C12).**
1. `kind:'new'`: if the spawn is caused by a send, `title = meta.title ?? deriveTitle(text)`. If it is a pre-spawn, `title = meta.title` (may be absent).
2. At the first `delivered` of a chat whose title source is still `none`, the server shell calls `engine.rename(chatId, deriveTitle(text))`: live `q.renameSession(title, sessionId)`. On error, it retries after the first `result`, then falls back to the offline rename after sleep.
3. `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` makes a missed rename harmless: no AI title call either way (measured).

### 2.5 Asks (`engine/permissions.ts`; from the SDK behaviour probes)

**Registry.**
- Key: `(chatId, requestId)`.
- The registry is part of `hello.asks`, so reloads, extra windows and reconnects never lose a card.
- A re-delivery of the same `requestId` updates the card.

**First decision wins.**
- `decide()` resolves the callback once; later answers get `not_pending`.
- Every window receives `askEnd{reason:'answered'}`. A window whose own `chat.decide` lost the race gets `not_pending` and shows *Déjà traitée ailleurs*.

**Withdrawal.**
- On `options.signal` abort (interrupt → `control_cancel_request` ≈ 13 ms (measured), or a crash (measured)), the callback **returns `null`** (the SDK then sends nothing (code)) and emits `askEnd{reason:'cancelled' or 'crash'}`.
- **Callbacks never time out** (CLI parity). A chat with an open ask is never reaped.

**Kind:**
- `requiresUserInteraction === true`, or `toolName ∈ {AskUserQuestion, ExitPlanMode}` → `question` / `plan`;
- `onElicitation` → `elicitation`;
- otherwise → `permission`.

**Card text.** `title` is never sent (measured). Compose it from `displayName` + `description` + the input: `command` for Bash/PowerShell, `file_path` for Edit/Write/Read, `blockedPath` when present; `decisionReason` is secondary text.

**Suggestions.**
- Drop every `destination: 'userSettings'`.
- Keep `localSettings` / `projectSettings` only when the chat's cwd passes S9.
- `offerAlways = kind === 'permission' && !suppressAlwaysAllowRule && filtered.length > 0`.
- `alwaysRules` = the monospace rule text (e.g. `Bash(npm ci)`).

**`offerAuto`** = Bash or PowerShell · mode ∈ {default, acceptEdits} · auto available (`ModelInfo.supportsAutoMode` of the current model) · no `matchedAskRule`.

| `UiAnswer` | `PermissionResult` returned to the SDK |
|---|---|
| `allow-once` | `{behavior:'allow', updatedInput: input}` |
| `allow-edited{input}` | `{behavior:'allow', updatedInput: <edited>}` (Edit/Write « Modifier avant d'accepter »; `userModified` (unverified)) |
| `allow-always{scope}` | `{behavior:'allow', updatedInput: input, updatedPermissions: <filtered suggestions, addRules destination := scope>}`. Write/Edit's `setMode acceptEdits` stays `session` |
| `allow-and-auto` | `{behavior:'allow', updatedInput: input, updatedPermissions:[{type:'setMode', mode:'auto', destination:'session'}]}` |
| `deny{message, stopTurn?}` | `{behavior:'deny', message: message \|\| 'L\'utilisateur a refusé.', interrupt?: true}`. The message reaches the model verbatim (measured) |
| `answers{answers, notes?, response?}` | `{behavior:'allow', updatedInput:{...input, answers, annotations?:{[q]:{notes}}, response?}}`. Keys = the exact question text; multi-select joined with `", "`; free text allowed (measured) |
| `skip-question` | `{behavior:'deny', message:'L\'utilisateur a choisi de ne pas répondre.'}` |
| `plan-approve{nextMode, editedPlan?}` | `{behavior:'allow', updatedInput:{...input, plan: editedPlan ?? input.plan}, updatedPermissions:[{type:'setMode', mode: nextMode, destination:'session'}]}`. `bypassPermissions` only when allowed for this chat |
| `plan-reject{feedback}` | `{behavior:'deny', message: feedback}`; the model revises in the same turn (measured) |
| `elicit{action, content?}` | `ElicitationResult {action, content}` |

**Plan and model display.**
- The plan is rendered from `input.plan` / `input.planFilePath`, **never** from the assistant frame copy, which can be stale (measured).
- The model badge is per assistant frame (`message.model`): in plan mode the `haiku` alias runs on Sonnet (measured). The UI shows *planifié avec Sonnet*.

### 2.6 Live controls (0 tokens, no respawn)

| Control | Note |
|---|---|
| `setPermissionMode` · `setModel` · `applyFlagSettings` | §2.2 |
| `renameSession(title, sessionId)` | Live only |
| `cancelAsyncMessage(uuid)` | §2.4 |
| `stopTask(taskId)` · `backgroundTasks(toolUseId?)` | Agents drawer, `Ctrl+B` |
| `getContextUsage({detail:'summary'})` | **Never** `'full'` |
| `listPermissionRules()` | Rules panel, feature-detected |
| `supportedCommands()` + `system:init.slash_commands` | Slash palette; `terminal_slash_commands` hidden |
| `rewindFiles(userUuid, {dryRun})` | Gated by T-P3 |
| `usage_EXPERIMENTAL…({skipBehaviors:true})` | On explicit click or while the Comptes panel is open, at most once per 10 min per account |
| `accountInfo()` / `initializationResult()` | Identity cross-check |

### 2.7 Closing a process (`close(reason)`, `reason ∈ user | reap | evict | logout | terminal | shutdown | rewind | force`)

1. **Running.** `reap` and `evict` never touch a running chat. Other reasons from the UI need a confirmation; then `interrupt()` and wait ≤ 10 s for the `result`. Without this, `input.end()` blocks until the turn ends (measured).
2. **`bgTasks > 0`.** Only with `stopTasks:true` (confirmed by `sleep.tasks.confirm`): `stopTask` each, wait ≤ 5 s.
3. **`input.end()`**, then wait ≤ **8 s** for the process `exit`. A normal exit takes 0.6–1.7 s (measured).
4. **Still alive:** `q.close()`, then **our own kill 2 s later** (`jobrun` kill = whole job, or `taskkill /T /F`), then wait ≤ 3 s.
5. **Still alive:** log `unkillable`, keep it in `procs` with a flag, and offer *Forcer l'arrêt*.

`force` skips steps 1–3. `shutdown` runs every chat in parallel with a 12 s global deadline.

### 2.8 Pool (`engine/pool.ts`)

**Timer.** One `setTimeout`, armed for the earliest deadline and re-armed on every relevant event. **No `setInterval`** anywhere in the server (grep test).

**Deadlines per live chat:**
- infinity while protected (running, ask pending, `bgTasks > 0`, queued > 0, visible in any window, `keepAlive`, closing);
- `spawnedAt + 10 min` while `sentAny === false`;
- `lastRequestAt + reapMs` otherwise, where `reapMs = (ttl < 60 min ? min(reapMin, 5 min) : reapMin)`. `reapMin === null` → never.

**`ensure()` at the cap** (`live >= effectiveMax`). `effectiveMax = max` while free RAM ≥ 1.5 GB; otherwise `max(2, live)`, evaluated at each spawn.

| Class | Candidate (idle, not protected) | Action |
|---|---|---|
| 1 | Never requested | Evicted silently |
| 2 | Cache expired (`now > lastRequestAt + ttl`) | Evicted silently + toast `chat.sleep` |
| 3 | Warm, account `resumeStable === true` | Offered first in `cap.choice` |
| 4 | Warm, others, coldest (oldest `lastRequestAt`) first | Offered in `cap.choice` |

- `cap.choice` is the error `{code:'cap', candidates:[{chatId, title, warmMin, recacheTokens, stable}]}`, where `recacheTokens = WakeEstimate(lastContext, …)` (§2.12).
- The client retries the same `chat.send` (same uuid) with `evict: <chatId>` or `exceed: true`.
- **A pre-spawn never evicts a warm cache:** it silently does nothing when only classes 3 and 4 are available.

**`resumeStable`.** Set to `false` when SessionStart `hook_*` frames are seen during a spawn of that account. Set to `true` when a spawn emits none within 3 s of init. Shown in *Comptes* as a diagnostic (inferred).

### 2.9 Crashes

**CLI crash** (the iterator throws `Claude Code process exited with code N`, or ends without a close request (measured)):
1. Pending asks → `askEnd{reason:'crash'}`; the SDK has already aborted their signals.
2. Deliveries still `pending` or `queued` → `returned` and handed back to the composer as *Non envoyé · Renvoyer*.
3. The live turn gets the system row `sys.crash`.
4. `ExitInfo{reason:'crash', code, stderrTail}` (stderr ring of 200 lines, redacted).
5. Account-level errors win: `authentication_failed` or `/Please run \/login/` → the account becomes `reauth`, with *Se reconnecter* on all its chats. Billing, org and limit errors map as in ux §8.8.
6. **No automatic respawn.** **Breaker:** 3 crashes in 10 min → `error{code:'breaker'}`; *Réessayer* resets it.

**Server crash.**
- The libuv job kills every `jobrun` child, and each job kills its tree (measured).
- The window shows *Connexion perdue…* and reconnects with its device token.
- The supervisor restarts `main.ts --supervised` after 0.5 s, then 2 s, then 5 s, at most 3 times in 60 s; then a MessageBox. Exit codes: 0 = stop, 75 = restart requested.
- On the next boot with `run\crash.marker` present:
  - chats that were live become cold with the row *Interrompu par un redémarrage du serveur*;
  - in `plain` isolation only, the recorded children (pid + creation time) are listed through one CIM query and the `orphans` dialog is shown. The user decides; nothing is killed silently.
- **Not crashing is part of token parity** (a crash costs every live chat a re-cache):
  - one try/catch per handler;
  - `unhandledRejection` / `uncaughtException` are logged and attributed to their chat, never exit;
  - one bad chat never takes the server down.

### 2.10 Resume, wake, fork, continue, rewind, clear

**Wake (`resume`).**
- The cwd is the **recorded** one: the last `relocated.relocatedCwd`, else the head `cwd`.
- A missing folder → `cwd_missing` → `resume.cwdMissing` → `chat.setCwd`. `--resume` finds the file in any project dir of the profile (measured).
- A path of 259 characters or more → `cwd_too_long`.
- **Mode restored** (CLI parity):
  - app metadata, else the transcript's last `permission-mode` entry;
  - `bypassPermissions` → the new-chat default plus `mode.bypass.downgraded`;
  - `plan` stays;
  - `auto` only if still available.

**Wake dialog.** `wake.dialog = idle > 1 h && lastContext > 100 k && !settings.wakeNeverAsk`. It never blocks a pre-spawn.

**Fork (whole chat).**
- `chat.fork{chatId}` creates a cold chat with a new session id S2 and `pendingStart{kind:'fork', fromJsonl}`.
- Its first send spawns `fork` → the CLI copies the history (uuids kept; cheap within the TTL (measured)).

**Fork up to a message.**
- `chat.fork{chatId, upToUuid}` (same account) → `SdkHelpers.forkUpTo()` (SDK `forkSession`, uuids remapped (measured)).
- It ends **before** the selected prompt; that prompt goes into the new chat's draft.
- Its first send is a plain resume, which pays the re-cache.

**Continue on another account.**
- `chat.fork{chatId, accountId: target}` → a cold chat on the target account with `pendingStart{kind:'fork', fromJsonl: <source absolute path>}`.
- First send: `fork` under the target profile → the copy lands in the target profile; the source is untouched (measured).
- `upToUuid` together with another account → `invalid`.
- The first turn re-caches everything (cache is per organisation).
- (unverified) Does the copy replay the source account's `prompt_snapshot` and instructions until the next compaction (§13)?

**Rewind** (`chat.rewind`):

| Action | Mechanism |
|---|---|
| `code` | `rewindFiles(userUuid, {dryRun})` |
| `conv` | `sleep('rewind')` → spawn `rewind{atUuid: last chain entry before the selected prompt, dropsTurn: the selected prompt's uuid}` → the selected prompt goes back into the composer |
| `both` | `code`, then `conv` |

The dialog never claims a rewind is free: the relaunch re-caches.

**`/clear`** → `conversation_reset` → re-key to the new session; the old session stays as a separate cold chat; a separator row reads *Conversation effacée — nouvelle session*.

### 2.11 Spawner and Job Objects (`engine/spawner.ts`, `launcher/jobrun.cs`)

**`spawner(chatId, isolation)(o)`:**
- `spawn(isolation === 'job' ? JOBRUN : o.command, isolation === 'job' ? [o.command, ...o.args] : o.args, {cwd: o.cwd, env: o.env, stdio:['pipe','pipe','pipe'], windowsHide:true})`;
- **no shell, no `signal`**;
- the SDK's forwarded `o.signal` abort is hooked to our kill;
- `child.kill = () => { if (child.exitCode === null) hardKill(); return true }`, where `hardKill` = `TerminateProcess(jobrun)` (the job dies) or `taskkill.exe /PID <pid> /T /F`, with an absolute `%SystemRoot%\System32` path;
- pids (jobrun and CLI) go to `run\children.json` with their creation time; `ownPids()` exposes them;
- a spawn error in `job` mode → that chat retries once in `plain` mode and gets the toast `isolation.fallback`.

**`jobrun.cs`:** taken verbatim from the design probe. One Job Object with `KILL_ON_JOB_CLOSE` and **no breakaway flags**; jobrun assigns itself, then starts the CLI with inherited stdio handles and the raw command-line tail (quoting preserved); it propagates the exit code. Measured: +≈ 40 ms per spawn; the CLI initializes normally; hook grandchildren die on exit and on host kill (measured). Still to measure: private memory per `jobrun.exe` (unverified).

### 2.12 Accounting, cache and wake estimates (pure; `model/accounting.ts`)

**Per turn.**
- Usage = `result.usage` (main loop, this turn).
- Cost = Δ`total_cost_usd` between consecutive `result`s. The value is cumulative and restored from the transcript's `cost-state` on resume (measured); the baseline for a resumed process is the last `cost-state` in the transcript tail.
- `auxTokens` = Δ(Σ over models of `modelUsage` tokens) − the turn's main usage. It is non-zero only for subagents, the auto-mode classifier, compaction or a hidden call. The footer shows it (`sys.footer.aux`). T-P4/T-P5 assert it is **0** on plain turns.
- Interrupted requests are not counted in `usage` (measured); every figure carries « ≈ ».

**Context.**
- `contextTokens` = `input + cache_read + cache_creation` of the **latest** `message_start` usage (live), or of the last assistant entry's `message.usage` (disk).
- `contextWindow` comes from `modelUsage[model].contextWindow`.
- `autoCompactAt = contextWindow − 33 000` (measured).

**Cache.** `cacheWarmUntil = lastRequestAt + ttl`.

**Cache-miss row.** Shown when a turn's `cache_creation` > 30 % of its input + cache **and** > 10 k. The guessed cause comes from local events: model or effort change, resume, compaction, idle > TTL, images.

**Wake estimate.** `WakeEstimate(lastContext, shared)` = `max(0, lastContext − 19 000)` when a process of the same account made a request in the same cwd within the hour; `− 16 800` when only the same account did; else `lastContext`. These are the measured shared prefixes (measured).

### 2.13 Why "never more tokens than Claude Code" holds

| Mechanism | Guarantee |
|---|---|
| Same request bytes | Single options builder + T-P1/T-P2/T-P3 (0 tokens; reference = the CLI's stdio permission lane) + smoke S1 (`\|I_app − I_cli\| ≤ 100` vs plain `claude -p`) |
| No hidden calls | Title switch (env + `title`); the app makes no model call; T-P4 aux sentinel on every turn in production |
| Warm cache kept | One live process per active chat; reaped only after the cache died; a warm cache is never evicted without asking; no process churn for settings |
| No crash re-caches | Watchdogs, supervisor, per-chat isolation, a breaker instead of respawn loops |
| Below the CLI, optional | `claudeMdExcludes` on non-default profiles (−106 tokens per request (measured)). Other levers (`disableAllHooks`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`) are **not in v1** |
| Deliberate costs, labelled « ↯ modèle » | `/compact`, model switch while warm, wake after expiry, a `haiku` plan on Sonnet, auto mode, *Titres IA* |

---

## 3. File tree

Each file below has a single responsibility; the module boundaries match the contracts of §5.

```
package.json · package-lock.json · .npmrc · .gitignore · tsconfig.json · tsconfig.web.json · README.md (FR)
assets/app.ico · assets/favicon.svg                                  launcher icon; favicon base (client draws badges)
launcher/SidMultiClaude.cs     GUI launcher + supervisor: pipe hand-off, start/restart hidden server, MessageBox
launcher/jobrun.cs             per-chat Job Object wrapper (KILL_ON_JOB_CLOSE, no breakaway), from the design probe
scripts/install.ps1            csc build of both exes, SHA-256 manifest (state\helpers.json), Desktop+Start shortcuts
scripts/vendor-audit.mjs       walks the ESM import graph from the import map -> static allow-list; fails on drift
scripts/sanitize-frames.mjs    verify\out recordings -> structure-only fixtures (text replaced, ids kept)
scripts/smoke.ts               budgeted real-model smoke S1–S6 (real profile, haiku, hard cap 8 requests)
scripts/contract.ts            0-token real-CLI checks K1–K7 on a logged-out temporary profile

src/shared/protocol.ts         wire contract (§4) — types only
src/shared/limits.ts           every numeric constant of §0.3/§6/§10 (timeouts, caps, sizes) as `export const`

src/server/main.ts             composition root: args (--open --background --supervised --port --data-dir
                               --fake-engine --profiles-root --print-boot), env scrub, single instance, crash marker,
                               boot order, shutdown order, exit codes 0/75
src/server/contracts.ts        module contracts (§5) — types only
src/server/util/log.ts         redacting rotating JSON-lines logger (5 × 5 MB, no message content)
src/server/util/json-store.ts  atomic versioned JSON (tmp + fsync + rename, .bak), debounced writer
src/server/util/mutex.ts       promise-chain mutex
src/server/util/clock.ts       real Clock + single-deadline scheduler helper
src/server/util/ids.ts         chatId codec, UUID check, boot id, opaque cursor codec (base64url JSON)
src/server/util/paths.ts       app dirs (%LOCALAPPDATA%\SidMultiClaude\…), realpathNative, 8.3 guard /~\d/,
                               profile roots, homeReal
src/server/util/fs-guard.ts    the ONLY fs write API of the app; throws under any Claude profile dir
src/server/util/winproc.ts     verified helpers: treeKill (taskkill /T /F, absolute path), spawnHidden (no shell),
                               creation time lookup

src/server/engine/engine.ts         createEngine(): facade, sessionId→chatId map, sink fan-out
src/server/engine/chat-process.ts   one live query(): InputQueue, pump, facts tracker, watchdogs, close algorithm
src/server/engine/input-queue.ts    AsyncIterable<SDKUserMessage> with push/end
src/server/engine/options.ts        buildOptions + accountEnv (§5.3, verbatim)
src/server/engine/permissions.ts    ask registry, canUseTool/onElicitation bridge, UiAnswer→PermissionResult
src/server/engine/pool.ts           cap, protection, victim classes, single-timer reaper, low-memory rule
src/server/engine/spawner.ts        jobrun/plain spawner, PID registry (run\children.json), hard kill
src/server/engine/ctl.ts            control-call wrapper: 10 s timeout, feature detection, typed errors
src/server/engine/exe.ts            resolve installed claude.exe / bundled binary; version probe from init

src/server/model/live-reducer.ts    SDK frames -> ChatEvent[] + live turn + meta/metrics/tasks/todos + heavy stash
src/server/model/disk-turns.ts      RawEntry chain -> UiTurn[] (+ heavy locations); same ids as live
src/server/model/blocks.ts          shared block builders: ids, ToolInputView, UiToolResult (lite), user origins
src/server/model/tools-lite.ts      per-tool summaries and head/tail cuts (ux §5.4 table), structuredPatch hunks
src/server/model/chat-state.ts      createChatState(): phase/sub/flags/pending/error/limit (ux §4)
src/server/model/accounting.ts      usage deltas, auxTokens, context, TTL, cache-miss rule, wake estimate
src/server/model/derive.ts          deriveTitle, activityLine, slash command grouping/local badge

src/server/claude/accounts.ts       AccountStore: config.json accounts, identity, usage merge, excludes, trust
src/server/claude/profiles.ts       candidate discovery, login state from stat + oauthAccount (no process)
src/server/claude/catalog.ts        cache\model-catalog\*.json -> ModelOption[]
src/server/claude/login.ts          LoginService: `claude.exe auth login|logout` piped, hidden, clean env
src/server/claude/headtail.ts       SDK head/tail 64 KiB metadata algorithm + backwards fallback
src/server/claude/session-index.ts  SessionIndex: cache\index-<acc>.json, stat pass, incremental refresh
src/server/claude/watch.ts          8.3-safe watchers: projects (recursive), sessions, global config parent
src/server/claude/reader.ts         TranscriptReader: tail-first pages, lines, search (chunked), instructions
src/server/claude/chain.ts          parentUuid chain, compaction relink, latest leaf, sidechain filter
src/server/claude/registry.ts       LiveRegistry: sessions\<pid>.json (never *.key), pid+procStart liveness
src/server/claude/sdk-helpers.ts    SdkHelpers under one mutex (rename, delete, forkUpTo)
src/server/claude/history.ts        PromptHistory: app prompts.jsonl + read-only history.jsonl

src/server/http/guard.ts            verified platform guard: Host/Origin/method, CSP+TT, boot codes, device token
src/server/http/static.ts           import map + exact-key static allow-list built at boot
src/server/ws/hub.ts                connections, views, seq, coalescing, backpressure, fan-out
src/server/ws/validate.ts           hand-written validators per C2S type (unknown fields rejected, size caps)
src/server/ws/rpc.ts                dispatch + exactly-one-ack
src/server/app/orchestrator.ts      per-chat runtime (reducer + state + seq), engine sink, index merge, summaries
src/server/app/commands.ts          C2S handlers (business rules of §6)
src/server/app/meta.ts              MetaStore: chats.json, ui.json, drafts\*.json, settings, app-trusted folders
src/server/app/lifetime.ts          server exit rule, reopen-window rule, crash marker, orphan flow
src/server/platform/win.ts          exe lookup, port bind + fallback, pipe lock, openExternal, openPath, freemem
src/server/platform/window.ts       Edge/Chrome --app launch with dedicated profile and lean flags
src/server/platform/terminal.ts     wt -d <cwd> powershell -NoProfile -NoExit -EncodedCommand; copy command
src/server/platform/confine.ts      path jail (platform's 15 cases) + S9 cwd policy
src/server/platform/files.ts        @-mention index (git ls-files or capped walk), folder browser
src/server/platform/orphans.ts      post-crash CIM query and kill

src/web/index.html · main.js        shell with __IMPORTMAP__; boot (theme, store, connect, mount)
src/web/contract.d.ts               the web shell <-> the chat surface contract (§5.4)
src/web/net.js                      WS connect/auth/reconnect/outbox/acks/view
src/web/store.js · apply.js · actions.js · derived.js   signals store, frame application in rAF, Actions, derived
src/web/lib/keymap.js · i18n.js · fmt.js · fuzzy.js · notify.js · favicon.js · sound.js
src/web/lib/md.js                   verified single HTML sink (the platform probes, verbatim)
src/web/lib/stream-md.js · diff.js · highlight.js   streaming markdown, LCS diff, lazy hljs
src/web/i18n/fr.js                  ux §16 table verbatim + §9.4 of this spec
src/web/i18n/fr-shell.js · fr-chat.js   French strings of the shell and of the chat (merged into fr.js)
src/web/components/shell/   App TopBar StatusBar Sidebar ChatRow TabStrip PaneGrid QuickSwitcher Toasts Banners Help
src/web/components/dialogs/ NewChat DirBrowser Trust Resume Accounts Login Settings Confirm Orphans
src/web/components/chat/    Pane PaneHeader PaneBanners Transcript Turn Blocks ToolCard ToolRenderers DiffView
                            SystemRow Peek ErrorBoundary
src/web/components/dock/    PendingDock PermissionCard QuestionForm PlanCard ElicitationCard
src/web/components/composer/ Composer QueueList Attachments SlashPalette MentionPopup HistorySearch WakeHint CapChoice
src/web/components/side/    TodoStrip AgentsDrawer RewindDialog ContinueOnDialog WakeDialog ModelSwitchConfirm
                            Popovers Lightbox
src/web/styles/tokens.css           ux §13 verbatim, dark tokens in both selectors
src/web/styles/shell.css · chat.css                                                                                [the web shell] ·

test/helpers/tmp-profile.ts         throwaway config dirs (.claude.json, transcripts, sessions\), never real ones
test/helpers/fake-clock.ts · scenario.ts · ws-client.ts
test/fakes/fake-claude.mjs          stream-json CLI stand-in driven by the REAL SDK (from the design probe, extended)
test/fakes/fake-query.ts            in-process QueryFn fake (scripted frames + every control method)
test/fakes/fake-engine.ts           Engine fake for server tests
test/fakes/mock-server.mjs          static + WS replay of test/fixtures/protocol for client development
test/fixtures/frames/               sanitized SDK frames (verify main/plan/fork/dry, 538 frames)
test/fixtures/protocol/             golden S2C scripts: stream, permission, question, plan, queue, crash, reconnect, cap
test/fixtures/transcripts/          synthetic JSONL: branches, compaction, 12 MB line, 80 MB file generator
test/unit/engine/** [the engine] · unit/model/** [the model] · unit/claude/** [the Claude-data module] · unit/server/** [the server shell] · unit/web-shell/** [the web shell] · unit/web-chat/**
test/integration/engine/** [the engine] · integration/server/**
test/parity/** [the engine] · test/contract/**
test/e2e/harness.ts · e2e/shell.e2e.ts · e2e/chat.e2e.ts · e2e/security.e2e.ts
```

**Configuration files.**
- `.npmrc`: `omit=optional`, `save-exact=true`, `ignore-scripts=true`.
- `package.json`:
  - `"type":"module"`, `"engines":{"node":">=24.16"}`, exact pins from §0.2.
  - Scripts:
    - `start`: `node src/server/main.ts --open`
    - `dev`: `node --watch src/server/main.ts --open`
    - `check`: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.web.json`
    - `test`: `node --test "test/unit/**/*.test.ts"`
    - `test:int`: `node --test "test/integration/**/*.test.ts"`
    - `test:parity`: `node --test "test/parity/**/*.test.ts"`
    - `test:contract`: `node --test "test/contract/**/*.test.ts"`
    - `test:e2e`: `node --test --test-concurrency=1 "test/e2e/**/*.e2e.ts"`
    - `smoke`: `node scripts/smoke.ts`
    - `install-app`: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1`
    - `fetch-bundled-cli`: `npm install --no-save --ignore-scripts @anthropic-ai/claude-agent-sdk-win32-x64@0.3.293`
    - `vendor-audit`: `node scripts/vendor-audit.mjs`
- `tsconfig.json` (server, shared, tests): as in `spec-contracts\tsconfig.json`. **No `baseUrl`** (TS 7 rejects it).
- `tsconfig.web.json`: `checkJs`, `allowJs`, `allowImportingTsExtensions`, `moduleResolution: bundler`, `lib: [esnext, dom, dom.iterable]`, `include: src/web/**/*.js, src/web/**/*.d.ts`.
- Browser JS types come from the shared `.ts` file through JSDoc `@typedef {import('../shared/protocol.ts').X}` (measured). **No `.ts` file is ever served to the browser.**

---

## 4. Shared types and the full WebSocket protocol (`src/shared/protocol.ts`, verbatim)

**Reading guide.**
- `S2C` is server → client and `C2S` is client → server. Semantics are in §6.
- Server → client frames are **JSON arrays** of `S2C`; client → server frames are single `C2S` objects. Each `C2S` gets exactly one `ack` with the same `id`.
- `AckData` gives the `ack.data` type per request.
- Block ids are identical live and on disk, so a snapshot or a page can be merged idempotently.
- **Stable contract.** Changes are additive only.

```ts
// src/shared/protocol.ts — SidMultiClaude wire contract (browser <-> server). TYPES ONLY (erasable syntax).
// Shared contract: changes are additive only.
// Browser JS consumes it through JSDoc: /** @typedef {import('../shared/protocol.ts').ChatSummary} ChatSummary */

export type Result<T, E> = { ok: true; data: T } | { ok: false; err: E };

// ---------------------------------------------------------------- identifiers
export type AccountId = string; // slug /^[a-z][a-z0-9-]{0,23}$/, never contains ':'
export type SessionId = string; // Claude session UUID (lower-case 8-4-4-4-12)
export type ChatId = string;    // `${AccountId}:${SessionId}`; re-keyed only on /clear or when the CLI picks another fork id
export type Uuid = string;      // client crypto.randomUUID() = SDKUserMessage.uuid = command_lifecycle.command_uuid

// ---------------------------------------------------------------- enums
export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ChatPhase = 'cold' | 'starting' | 'idle' | 'running' | 'needs_permission' | 'needs_answer' | 'needs_plan' | 'rate_limited' | 'error';
export type SubPhase = 'requesting' | 'thinking' | 'writing' | 'tool' | 'compacting' | 'retry' | 'stopping';
export type Origin = 'cli' | 'desktop' | 'app' | 'other';
export type ToolStatus = 'running' | 'asking' | 'ok' | 'error' | 'denied' | 'withdrawn' | 'interrupted';
export type Delivery = 'pending' | 'queued' | 'started' | 'folded' | 'completed' | 'cancelled' | 'refused' | 'returned';
export type AskKind = 'permission' | 'question' | 'plan' | 'elicitation';
export type Priority = 'next' | 'later' | 'now';
export type ViewMode = 'normal' | 'detailed' | 'focus';
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

// ---------------------------------------------------------------- errors
export type ErrorCode =
  | 'invalid' | 'not_found' | 'not_pending' | 'busy' | 'forbidden' | 'unsupported' | 'timeout' | 'internal' | 'too_large'
  | 'cap' | 'cap_busy' | 'external' | 'not_logged_in' | 'untrusted' | 'cwd_missing' | 'cwd_too_long' | 'cwd_refused'
  | 'exe_missing' | 'spawn_failed' | 'breaker_open' | 'not_live';
export type CapCandidate = { chatId: ChatId; title: string; warmMin: number; recacheTokens: number; stable: boolean };
export type ExternalHolder = { pid: number; kind: string; entrypoint: string; status: 'busy' | 'idle' | 'waiting' | 'blocked' };
export type WireError =
  | { code: 'cap'; message?: string; candidates: CapCandidate[] }
  | { code: 'external'; message?: string; holder: ExternalHolder }
  | { code: Exclude<ErrorCode, 'cap' | 'external'>; message?: string };

// ---------------------------------------------------------------- accounts
export type LoginState = 'connected' | 'disconnected' | 'incoherent' | 'reauth';
export type UsageRow = { key: string; label: string; pct: number; resetsAt?: number; severity: 'normal' | 'warning' | 'critical'; headline: boolean };
export type UsageView = { source: 'snapshot' | 'event' | 'refresh'; at: number; stale: boolean; rows: UsageRow[];
  status?: 'allowed' | 'allowed_warning' | 'rejected'; na?: boolean };
export type AccountView = {
  id: AccountId; name: string; color: number /* 1..8 -> --acc-n */; monogram: string;
  configDir: string | null /* null = default profile, CLAUDE_CONFIG_DIR unset */; isDefault: boolean; hidden: boolean; login: LoginState;
  identity?: { email: string; displayName?: string; org?: string; plan: string; role?: string; accountUuid: string };
  usage?: UsageView;
  defaults: { model?: string; effort?: Effort; mode?: PermissionModeId };
  diag: { leakFiles: string[]; leakExcluded: boolean; resumeStable: boolean | null; cleanupDays: number; expiringSoon: number;
          duplicateOf?: AccountId; cliVersion?: string; defaultMode?: string; baselineTokens?: number; mcp?: { ok: number; auth: number } };
};
export type AccountPatch = { name?: string; color?: number; monogram?: string; hidden?: boolean; excludeForeignClaudeMd?: boolean;
  defaults?: { model?: string | null; effort?: Effort | null; mode?: PermissionModeId | null } };
export type AccountCandidate = { configDir: string | null; login: LoginState; email?: string; added: boolean };
export type ModelOption = { value: string /* alias or catalog id, never free text */; label: string; efforts: Effort[]; isDefault?: boolean };
export type LoginStep = { step: 'url'; url: string } | { step: 'waiting' } | { step: 'done'; email: string; plan: string } | { step: 'error'; message: string };

// ---------------------------------------------------------------- chat summary (sidebar, tabs, attention) — every known session
export type ChatStateView = {
  phase: ChatPhase; sub?: SubPhase; subTool?: string; since: number;
  flags: { live: boolean; unread: boolean; bgTasks: number; queued: number; external: ExternalHolder | null; stuck: boolean; notStarted: boolean };
  pending: { count: number; oldestAt?: number; kind?: AskKind };
  error?: { code: 'crash' | 'auth' | 'billing' | 'overloaded' | 'model_not_found' | 'startup' | 'breaker' | 'cwd' | 'exe'; message?: string; exitCode?: number };
  limit?: { resetsAt: number; kind: string };
};
export type ChatSummary = {
  chatId: ChatId; accountId: AccountId; sessionId: SessionId;
  title: string; titleSource: 'custom' | 'ai' | 'lastPrompt' | 'firstPrompt' | 'app' | 'none';
  cwd: string; branch?: string; origin: Origin; firstPrompt?: string;
  createdAt: number; updatedAt: number /* last user/assistant timestamp, NOT mtime */; size: number /* 0 = no .jsonl yet */;
  model?: string; mode?: PermissionModeId;
  pinned: boolean; archived: boolean; muted: boolean; keepAlive: boolean;
  state: ChatStateView; activity: string /* deterministic one-liner, never model-generated */;
  wake?: { lastContext: number; recacheTokens: number; idleMs: number; dialog: boolean };
  expiresInDays: number | null; foreignOwner: boolean; costUsd?: number;
  links?: { forkedFrom?: ChatId; continuedFrom?: ChatId; continuedTo?: ChatId };
};

// ---------------------------------------------------------------- chat detail (panes)
export type SlashCommandView = { name: string; description: string; hint?: string; group: 'builtin' | 'skill' | 'plugin' | 'mcp'; local: boolean; aliases?: string[] };
export type ChatMetaView = { title: string; cwd: string; branch?: string; mode: PermissionModeId; model?: string; effort?: Effort; cliVersion?: string;
  tools?: number; mcp?: { name: string; status: string }[]; commands?: SlashCommandView[]; capabilities?: string[] };
export type ChatMetrics = { contextTokens?: number; contextWindow?: number; autoCompactAt?: number; lastRequestAt?: number;
  cacheTtlMs?: number; cacheWarmUntil?: number; costUsd?: number; lastTurn?: TurnFooter };

// transcript model — block ids are identical live and on disk ("live = reload" invariant)
//   user   `u:${uuid}`                 (queued_command attachment on disk: `u:${commandUuid}` when present, else `u:${entry uuid}`)
//   text / thinking `a:${message.id}:${index}` (live: content_block index; disk: apiBlockIndex, else ordinal among entries of that message.id)
//   tool   `t:${tool_use_id}`          (the tool_result patches the same block)
//   system `x:${uuid}`                 (synthetic rows created by the app: `x:app:${n}`)
export type ImageRef = { ref: string; mediaType: string; bytes?: number; approxTokens?: number };
export type UiUserMsg = { uuid: Uuid; text: string; images?: ImageRef[]; origin: 'human' | 'peer' | 'task' | 'auto' | 'command'; delivery?: Delivery };
export type ToolInputView = { summary: string; fields: Record<string, string | number | boolean>; truncated?: string[] };
export type PatchHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };
export type UiToolResult = { isError: boolean; summary: string; head?: string; tail?: string; totalLines?: number; truncated?: boolean;
  patch?: PatchHunk[]; images?: ImageRef[]; denial?: 'user' | 'rule' | 'auto' | 'autoNa' | 'interrupted' | 'withdrawn';
  data?: Record<string, string | number | boolean> };
export type UiSystemRow = { kind: 'compact' | 'interrupted' | 'retry' | 'notice' | 'error' | 'cleared' | 'hook' | 'refusal' | 'cacheMiss'
  | 'rateLimit' | 'crash' | 'local' | 'task' | 'modeChange'; text?: string; data?: Record<string, string | number | boolean> };
export type UiBlock =
  | { k: 'user'; id: string; msg: UiUserMsg }
  | { k: 'text'; id: string; md: string; model?: string; aborted?: boolean; live?: boolean }
  | { k: 'thinking'; id: string; chars: number; tokens?: number; redacted?: boolean; live?: boolean }
  | { k: 'tool'; id: string; toolUseId: string; name: string; input: ToolInputView; status: ToolStatus; result?: UiToolResult;
      parentToolUseId?: string; agentId?: string; elapsedMs?: number; taskId?: string; askId?: string; model?: string }
  | { k: 'system'; id: string; row: UiSystemRow };
export type TurnFooter = { durationMs?: number; input: number; cacheRead: number; cacheWrite: number; output: number; costUsd?: number;
  auxTokens?: number /* Δ modelUsage(all models) − main usage: parity sentinel, must be 0 */; models: string[]; interrupted?: boolean; terminal?: string };
export type UiTurnHead = { id: string /* id of the opening user block, or `x:` id for system-only turns */; at: number; user: UiUserMsg | null };
export type UiTurn = UiTurnHead & { blocks: UiBlock[]; footer?: TurnFooter; beforeCompaction?: boolean };
export type DeltaPart = [blockId: string, append: string];
export type TranscriptPage = { turns: UiTurn[]; cursor: string | null; hasMore: boolean };
export type DetailField = 'output' | 'input' | 'thinking' | 'image' | 'originalFile' | 'raw';
export type DetailPayload = { text?: string; dataUrl?: string; mediaType?: string; truncated?: boolean };
export type SearchHit = { turnId: string; blockId?: string; snippet: string };

// ---------------------------------------------------------------- asks
export type AskQuestion = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string; preview?: string }[] };
export type PendingAsk = {
  chatId: ChatId; requestId: string; toolUseId: string; kind: AskKind; toolName: string;
  displayName?: string; description?: string; decisionReason?: string; blockedPath?: string; agentId?: string;
  mcpServer?: { name: string; source: string }; matchedAskRule?: string;
  input: Record<string, unknown>;                 // lite: strings > 256 KB cut (Edit/Write keep up to 256 KB for the preview)
  diffBase?: { path: string; text: string } | { unavailable: true }; // Write preview base, read by the server inside the cwd only
  offerAlways: boolean; alwaysRules: string[];    // monospace rule text shown in the tooltip, e.g. Bash(npm ci)
  offerAuto: boolean;                             // « Autoriser et passer en mode Auto »
  defaultToNo: boolean;
  plan?: string; planFilePath?: string;           // ExitPlanMode: from the ask input (fresh), never from the assistant frame
  questions?: AskQuestion[];
  elicitation?: { mode: 'form' | 'url'; server: string; message: string; schema?: Record<string, unknown>; url?: string };
  since: number;
};
export type UiAnswer =
  | { kind: 'allow-once' }
  | { kind: 'allow-edited'; input: Record<string, unknown> }
  | { kind: 'allow-always'; scope: 'session' | 'localSettings' | 'projectSettings' }   // never 'userSettings'
  | { kind: 'allow-and-auto' }
  | { kind: 'deny'; message: string; stopTurn?: boolean }
  | { kind: 'answers'; answers: Record<string, string>; notes?: Record<string, string>; response?: string }
  | { kind: 'skip-question' }
  | { kind: 'plan-approve'; nextMode: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions'; editedPlan?: string }
  | { kind: 'plan-reject'; feedback: string }
  | { kind: 'elicit'; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
export type AskEndReason = 'answered' | 'cancelled' | 'crash';

// ---------------------------------------------------------------- queue, tasks, todos
export type QueueItem = { uuid: Uuid; text: string; images: number; priority?: Priority; delivery: Delivery };
export type TaskView = { id: string; kind: 'agent' | 'bash' | 'workflow' | 'monitor' | 'other'; title: string;
  status: 'running' | 'done' | 'failed' | 'stopped'; startedAt: number; detail?: string; toolUseId?: string;
  tokens?: number; tools?: number; depth?: number; background: boolean };
export type TodoItem = { text: string; status: 'pending' | 'in_progress' | 'completed' | 'blocked'; activeForm?: string };

// ---------------------------------------------------------------- per-chat events (only to windows showing the chat in a pane)
export type ChatEvent =
  | { k: 'state'; state: ChatStateView }
  | { k: 'meta'; meta: Partial<ChatMetaView> }
  | { k: 'metrics'; metrics: ChatMetrics }
  | { k: 'turn.start'; turn: UiTurnHead }
  | { k: 'block'; turnId: string; block: UiBlock }                  // upsert by block.id (full replacement, freezes a live block)
  | { k: 'delta'; parts: DeltaPart[] }                              // text appends to live text blocks, coalesced ≤ every 50 ms
  | { k: 'progress'; blockId: string; elapsedMs?: number; chars?: number; tokens?: number } // ≤ 1/s per block
  | { k: 'tool.result'; turnId: string; toolUseId: string; status: ToolStatus; result: UiToolResult }
  | { k: 'turn.end'; turnId: string; footer: TurnFooter }
  | { k: 'system'; turnId?: string; id: string; row: UiSystemRow }
  | { k: 'queue'; items: QueueItem[] }                              // replace
  | { k: 'tasks'; tasks: TaskView[] }                               // replace
  | { k: 'todos'; todos: TodoItem[] | null }                        // replace
  | { k: 'reset'; reason: 'clear' | 'rewind' | 'resume' };          // drop rendered turns, then tx.page

export type ChatSnapshot = { chatId: ChatId; seq: number; state: ChatStateView; meta: ChatMetaView; metrics: ChatMetrics;
  queue: QueueItem[]; tasks: TaskView[]; todos: TodoItem[] | null; live: UiTurn | null; lastDiskTurnId: string | null };

// ---------------------------------------------------------------- misc payloads
export type ImageInput = { mediaType: ImageMediaType; base64: string };
export type Draft = { text: string; attachments: { name: string; mediaType: ImageMediaType; base64: string }[]; at: number }; // ≤ 1 MB
export type ProcStats = { live: number; max: number; effectiveMax: number; lowMem: boolean; estRamMB: number; isolation: 'job' | 'plain';
  items: { chatId: ChatId; pid?: number; phase: ChatPhase; since: number; lastRequestAt?: number; warmUntil?: number; neverRequested: boolean; protected: boolean }[] };
export type DirListing = { path: string; parent?: string; dirs: string[]; drives?: string[]; warning?: 'home' | 'ancestor' };
export type FileHit = { path: string; dir: boolean };
export type PromptHit = { text: string; at: number; source: 'app' | 'terminal'; chatId?: ChatId };
export type ContextSummary = { total: number; window: number; autoCompactAt: number; categories: { name: string; tokens: number }[]; memoryFiles: string[] };
export type RewindPreview = { files: { path: string; added: number; removed: number; deleted?: boolean }[] };
export type SessionInfo = { sessionId: SessionId; accountId: AccountId; cwd: string; transcriptPath: string; size: number; cliVersion?: string;
  model?: string; tools?: number; mcp?: { name: string; status: string }[]; instructions: { path: string; foreign: boolean }[]; ownerAccountUuid?: string };
export type RuleView = { behavior: 'allow' | 'deny' | 'ask'; source: string; rule: string; editable: boolean };

export type Settings = {
  port: number; browser: 'edge' | 'chrome'; exe: 'installed' | 'bundled'; isolation: 'job' | 'plain';
  maxLive: number /* 2..8, default 4 */; reapMin: number | null /* 15|30|60|120|null=never; default 60 */;
  prespawn: boolean; allowBypass: boolean; aiTitles: boolean;
  notifications: boolean; sound: boolean; volume: number; onlyWhenAway: boolean; dndUntil: number | null; reopenWindowOnAttention: boolean;
  ctrlEnterSends: boolean; shiftTabModes: boolean; showOtherOrigins: boolean; wakeNeverAsk: boolean;
  theme: 'system' | 'light' | 'dark'; density: 'compact' | 'comfortable'; defaultView: ViewMode;
};
export type UiState = {
  layout: 1 | 2 | 3 | 4; tabs: ChatId[]; closed: ChatId[]; panes: (ChatId | null)[]; focusedPane: number;
  sidebar: { width: number; collapsed: boolean; grouping: 'account' | 'folder' | 'state'; showArchived: boolean };
  scroll: Record<ChatId, { turnId: string; offset: number }>; views: Record<ChatId, ViewMode>;
};

// ---------------------------------------------------------------- frames
// Server -> client: every WebSocket frame is a JSON ARRAY of S2C messages (flushed once per tick).
export type S2C =
  | { t: 'hello'; v: 1; boot: string; now: number; settings: Settings; accounts: AccountView[]; chats: ChatSummary[];
      asks: PendingAsk[]; ui: UiState; drafts: Record<ChatId, Draft>; procs: ProcStats }
  | { t: 'device-token'; token: string }
  | { t: 'ack'; id: number; ok: true; data?: unknown }
  | { t: 'ack'; id: number; ok: false; err: WireError }
  | { t: 'accounts'; accounts: AccountView[] }                                    // replace
  | { t: 'chats'; upsert: ChatSummary[]; remove: ChatId[]; rekey?: { from: ChatId; to: ChatId }[] } // all windows, all chats
  | { t: 'ask'; ask: PendingAsk }                                                  // all windows (Peek, À traiter); before the needs_* upsert
  | { t: 'askEnd'; chatId: ChatId; requestId: string; reason: AskEndReason }
  | { t: 'snap'; snap: ChatSnapshot }
  | { t: 'ev'; c: ChatId; s: number; ev: ChatEvent }                               // s = per-chat seq, contiguous after snap.seq
  | { t: 'procs'; procs: ProcStats }
  | { t: 'settings'; settings: Settings }
  | { t: 'login'; accountId: AccountId; step: LoginStep }
  | { t: 'orphans'; items: { pid: number; name: string }[] }
  | { t: 'toast'; level: 'info' | 'warn' | 'error'; key: string; args?: Record<string, string | number>; chatId?: ChatId }
  | { t: 'bye'; reason: 'quit' | 'restart' };

// Client -> server: one object per frame; every request gets exactly one ack with the same id.
export type C2S = { id: number } & (
  | { t: 'view'; full: ChatId[]; focused: ChatId | null; windowFocused: boolean }      // replaces this window's view; server answers snaps
  | { t: 'chat.create'; accountId: AccountId; cwd: string; title?: string; mode: PermissionModeId; model?: string; effort?: Effort; trust?: boolean }
  | { t: 'chat.prespawn'; chatId: ChatId }
  | { t: 'chat.send'; chatId: ChatId; uuid: Uuid; text: string; images?: ImageInput[]; priority?: 'later' | 'now';
      wake?: 'asIs' | 'summary'; evict?: ChatId; exceed?: boolean; force?: boolean }  // idempotent on uuid
  | { t: 'chat.interrupt'; chatId: ChatId }
  | { t: 'chat.cancelQueued'; chatId: ChatId; uuid: Uuid }
  | { t: 'chat.decide'; chatId: ChatId; requestId: string; answer: UiAnswer }
  | { t: 'chat.setMode'; chatId: ChatId; mode: PermissionModeId; typed?: string }     // bypass needs typed === 'CONTOURNER'
  | { t: 'chat.setModel'; chatId: ChatId; model: string | null; effort: Effort | null }
  | { t: 'chat.rename'; chatId: ChatId; title: string }
  | { t: 'chat.flags'; chatId: ChatId; pinned?: boolean; archived?: boolean; keepAlive?: boolean; muted?: boolean }
  | { t: 'chat.setCwd'; chatId: ChatId; cwd: string }                                // cold chats only (recorded folder gone)
  | { t: 'chat.sleep'; chatId: ChatId; stopTasks?: boolean; force?: boolean }             // force = « Forcer l'arrêt » (skips the graceful steps)
  | { t: 'chat.delete'; chatId: ChatId; confirm: true }
  | { t: 'chat.fork'; chatId: ChatId; upToUuid?: Uuid; accountId?: AccountId }
  | { t: 'chat.rewind'; chatId: ChatId; userUuid: Uuid; action: 'both' | 'conv' | 'code'; dryRun: boolean }
  | { t: 'chat.task'; chatId: ChatId; op: 'stop' | 'background' | 'stopAll'; ref?: string }
  | { t: 'chat.info'; chatId: ChatId; what: 'context' | 'rules' | 'session' | 'commands' }
  | { t: 'chat.terminal'; chatId: ChatId; copyOnly: boolean }
  | { t: 'tx.page'; chatId: ChatId; before?: string; limit: number }
  | { t: 'tx.detail'; chatId: ChatId; id: string; field: DetailField }
  | { t: 'tx.search'; chatId: ChatId; q: string }
  | { t: 'prompts.search'; q: string; chatId?: ChatId }
  | { t: 'account.candidates' }
  | { t: 'account.add'; configDir: string | null; name: string; color: number; monogram: string }
  | { t: 'account.update'; accountId: AccountId; patch: AccountPatch }
  | { t: 'account.login'; accountId: AccountId; email?: string }
  | { t: 'account.loginCode'; accountId: AccountId; code: string }
  | { t: 'account.loginCancel'; accountId: AccountId }
  | { t: 'account.logout'; accountId: AccountId }
  | { t: 'account.usage'; accountId: AccountId }
  | { t: 'account.baseline'; accountId: AccountId }
  | { t: 'fs.mentions'; chatId: ChatId; q: string }
  | { t: 'fs.dirs'; path: string | null }
  | { t: 'open'; what: 'url' | 'explorer' | 'vscode'; target: string; chatId?: ChatId }
  | { t: 'ui.save'; ui: UiState }
  | { t: 'draft.save'; chatId: ChatId; draft: Draft | null }
  | { t: 'settings.set'; patch: Partial<Settings> }
  | { t: 'orphans.kill'; pids: number[] }
  | { t: 'app.quit'; force?: boolean }
  | { t: 'log.client'; level: 'warn' | 'error'; msg: string; chatId?: ChatId } );

export type C2SType = C2S['t'];
// ack.data per request type (requests not listed ack with no data)
export type AckData = {
  'chat.create': { chatId: ChatId };
  'chat.fork': { chatId: ChatId };
  'chat.send': { accepted: 'new' | 'duplicate' };
  'chat.interrupt': { stillQueued: Uuid[] };
  'chat.cancelQueued': { cancelled: boolean };
  'chat.rewind': RewindPreview;
  'chat.info': ContextSummary | RuleView[] | SessionInfo | SlashCommandView[];
  'chat.terminal': { command: string };
  'tx.page': TranscriptPage;
  'tx.detail': DetailPayload;
  'tx.search': SearchHit[];
  'prompts.search': PromptHit[];
  'account.candidates': AccountCandidate[];
  'account.add': AccountView;
  'account.usage': UsageView | null;
  'account.baseline': ContextSummary;
  'fs.mentions': FileHit[];
  'fs.dirs': DirListing;
};
```

---

## 5. Module contracts

Each module builds against these interfaces and tests against fakes. The behaviour rules that go with them are in §5.5.

### 5.1 `src/server/contracts.ts` (verbatim)

```ts
// src/server/contracts.ts — server-internal module contracts. TYPES ONLY. Shared contract, additive changes only.
// Every module is built against these interfaces and tested with fakes (test/fakes/*).
import type { query, SDKMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type * as P from '../shared/protocol.ts';

// ============================================================ shared plumbing (src/server/util/*)
export type QueryFn = typeof query;                          // injection point: real SDK | test/fakes/fake-query.ts
export interface Clock { now(): number; timer(ms: number, fn: () => void): { cancel(): void } }
export interface Logger { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void; error(msg: string, f?: Record<string, unknown>): void }
export type SdkFrame = SDKMessage | { type: string; subtype?: string; [k: string]: unknown };  // + runtime-only frames (command_lifecycle…)
export type SleepReason = 'user' | 'reap' | 'evict' | 'logout' | 'terminal' | 'shutdown' | 'rewind' | 'force';

// ============================================================ the Claude-data module: Claude data (src/server/claude/*)
export type Account = {
  id: P.AccountId; name: string; color: number; monogram: string;
  configDir: string | null;              // null = default profile: CLAUDE_CONFIG_DIR UNSET (never set it to ~\.claude)
  hidden: boolean;
  excludeForeignClaudeMd: boolean;       // default true for non-default profiles, forced false for the default one
  resumeStable: boolean | null;          // null unknown; false when SessionStart hook frames are seen on a spawn
  defaults: { model?: string; effort?: P.Effort; mode?: P.PermissionModeId };
};
export type ProfilePaths = { configHome: string; globalConfig: string; projectsDir: string; sessionsDir: string; credentials: string };
export type UsageInput = { kind: 'event'; info: Record<string, unknown> } | { kind: 'refresh'; data: Record<string, unknown> };
export interface AccountStore {
  start(): Promise<void>;                                     // read config.json + profiles; watch global configs; 0 processes
  list(): P.AccountView[];
  get(id: P.AccountId): Account | undefined;
  paths(id: P.AccountId): ProfilePaths;                       // realpathSync.native, long form
  candidates(): Promise<P.AccountCandidate[]>;
  add(a: { configDir: string | null; name: string; color: number; monogram: string }): Promise<P.AccountView>;
  update(id: P.AccountId, patch: P.AccountPatch): Promise<P.AccountView>;
  claudeMdExcludes(id: P.AccountId): string[];                // [] for the default profile
  trustedInCli(id: P.AccountId, cwd: string): boolean;        // projects[path].hasTrustDialogAccepted, normalised
  modelCatalog(id: P.AccountId): P.ModelOption[];             // cache\model-catalog\*.json, 0 tokens
  cleanupDays(id: P.AccountId): number;                       // settings.json cleanupPeriodDays ?? 30 (display only)
  noteUsage(id: P.AccountId, u: UsageInput): void;            // rate_limit_event / usage_EXPERIMENTAL result
  noteAuthError(id: P.AccountId): void;                       // -> login 'reauth'
  noteResumeStable(id: P.AccountId, v: boolean): void;
  onChange(cb: (id: P.AccountId) => void): () => void;
}
export interface LoginService {                                // `claude.exe auth login|logout`, hidden, piped, clean env
  start(id: P.AccountId, email: string | undefined, onStep: (s: P.LoginStep) => void): void;
  code(id: P.AccountId, code: string): void;                  // writes `code#state\n` to stdin
  cancel(id: P.AccountId): void;
  logout(id: P.AccountId): Promise<void>;                     // caller sleeps the account's chats first
}
export type SessionMeta = {
  accountId: P.AccountId; sessionId: P.SessionId; chatId: P.ChatId; path: string /* absolute .jsonl */; cwd: string /* recorded */;
  title: string; titleSource: P.ChatSummary['titleSource']; firstPrompt?: string; branch?: string; origin: P.Origin; entrypoint?: string;
  createdAt: number; updatedAt: number; mtimeMs: number; size: number; model?: string; lastMode?: P.PermissionModeId;
  lastContext?: number; lastRequestAt?: number; costUsd?: number; ownerAccountUuid?: string;
  lastError?: { kind: 'rate_limit' | 'auth' | 'other'; resetsAt?: number };
};
export interface SessionIndex {
  start(): Promise<void>;                                     // cache-assisted stat pass + head/tail of changed files + watchers
  list(accountId?: P.AccountId): SessionMeta[];
  get(chatId: P.ChatId): SessionMeta | undefined;
  reconcile(accountId?: P.AccountId): Promise<void>;          // stat-only, on window focus
  onChange(cb: (upsert: SessionMeta[], removed: P.ChatId[]) => void): () => void;
}
export type RawEntry = { off: number; len: number; e: Record<string, unknown> };   // one parsed JSONL line and its byte range
export type ChainPage = { chain: RawEntry[]; cursor: string | null; hasMore: boolean };
export interface TranscriptReader {                            // tail-first; never parses a whole large file on the main thread
  tail(path: string, turns: number): Promise<ChainPage>;      // latest leaf, compaction relink, 256 KiB→2 MiB backwards steps
  before(path: string, cursor: string, turns: number): Promise<ChainPage>;
  line(path: string, off: number, len: number): Promise<Record<string, unknown> | null>;
  search(path: string, q: string, limit: number, signal: AbortSignal): Promise<{ off: number; len: number; snippet: string }[]>;
  firstInstructions(path: string): Promise<string[]>;         // first-turn attachment{type:'instructions'}.files
  hasUserUuid(path: string, uuid: P.Uuid, maxBytes: number): Promise<boolean>;
}
export interface LiveRegistry {                                // <cfg>\sessions\<pid>.json (never *.key)
  start(): void;
  holder(accountId: P.AccountId, sessionId: P.SessionId): P.ExternalHolder | null;   // pid alive + procStart match + not ours
  setOwnPids(pids: ReadonlySet<number>): void;
  onChange(cb: (accountId: P.AccountId, sessionId: P.SessionId, h: P.ExternalHolder | null) => void): () => void;
}
export interface SdkHelpers {                                  // ONE promise-chain mutex: the helpers read process.env.CLAUDE_CONFIG_DIR
  rename(acc: Account, sessionId: P.SessionId, title: string, dir?: string): Promise<void>;
  remove(acc: Account, sessionId: P.SessionId, dir?: string): Promise<void>;
  forkUpTo(acc: Account, sessionId: P.SessionId, upToUuid: P.Uuid, title: string, dir?: string): Promise<P.SessionId>;
}
export interface PromptHistory {                               // app prompts.jsonl + read-only <cfg>\history.jsonl
  append(chatId: P.ChatId, text: string, at: number): void;
  search(q: string, chatId?: P.ChatId): Promise<P.PromptHit[]>;
}

// ============================================================ the engine: engine (src/server/engine/*)
export type SpawnStart =
  | { kind: 'new'; title?: string }                                 // options.sessionId = spec.sessionId (app-chosen UUID)
  | { kind: 'resume' }                                              // options.resume = spec.sessionId, recorded cwd
  | { kind: 'fork'; fromJsonl: string; title: string }              // resume = absolute .jsonl, forkSession, sessionId = new UUID [U]
  | { kind: 'rewind'; atUuid: P.Uuid; dropsTurn?: P.Uuid };         // resume + resumeSessionAt (+ resumeDropsTurn) [T]
export type SpawnSpec = {
  chatId: P.ChatId; sessionId: P.SessionId;
  cwd: string;                                                      // realpathSync.native, < 259 chars, S9-checked by the caller
  account: { id: P.AccountId; configDir: string | null; claudeMdExcludes: string[] };
  mode: P.PermissionModeId;                                         // ALWAYS explicit
  start: SpawnStart;
  model?: string; effort?: P.Effort;                                // ONLY when the user picked them (aliases / catalog ids)
  allowBypass: boolean; aiTitles: boolean;
  exe: string; isolation: 'job' | 'plain';
};
export type ProcessFacts = {
  chatId: P.ChatId; sessionId: P.SessionId; phase: 'spawning' | 'live' | 'closing';
  busy: boolean;                 // a delivery queued|started, or a turn between status:requesting and its result with queued_turn_count 0
  pendingAsks: number; bgTasks: number; queuedTurns: number;
  queue: P.QueueItem[];          // deliveries not yet completed/cancelled (chips)
  spawnedAt: number; lastRequestAt?: number; sentAny: boolean;
  ttlMs: number;                 // 3_600_000, or 300_000 when the last cache write was ephemeral_5m only
  mode: P.PermissionModeId; model?: string; cliVersion?: string; cliPid?: number; capabilities: string[];
  stuck: boolean;                // interrupt watchdog (10 s) fired
};
export type ExitInfo = { reason: 'closed' | 'crash' | 'killed' | 'spawn_failed' | 'init_timeout'; code: number | null; signal: string | null;
  at: number; stderrTail: string; message?: string };
export interface EngineSink {
  frame(chatId: P.ChatId, f: SdkFrame, at: number): void;             // every SDK message, in order
  facts(chatId: P.ChatId, f: ProcessFacts): void;                     // on change (coalesced per tick)
  ask(a: P.PendingAsk): void;
  askEnd(chatId: P.ChatId, requestId: string, reason: P.AskEndReason): void;
  delivered(chatId: P.ChatId, m: { uuid: P.Uuid; text: string; images: number; folded: boolean; at: number }): void; // lifecycle 'started' / fold
  sessionChanged(chatId: P.ChatId, sessionId: P.SessionId): void;    // conversation_reset (/clear) or CLI-chosen fork id
  exited(chatId: P.ChatId, info: ExitInfo, returned: P.QueueItem[]): void;
}
export type EnsureWhy = 'prespawn' | 'send' | 'wake' | 'usage' | 'rewind';
export type EnsureOpts = { why: EnsureWhy; evict?: P.ChatId; exceed?: boolean; force?: boolean };
export type SendInput = { uuid: P.Uuid; text: string; images?: P.ImageInput[]; priority?: P.Priority };
export interface Engine {
  isLive(chatId: P.ChatId): boolean;
  facts(chatId: P.ChatId): ProcessFacts | null;
  stats(): P.ProcStats;
  ensure(spec: SpawnSpec, o: EnsureOpts): Promise<P.Result<void, P.WireError>>;   // spawn or no-op; cap/external/breaker errors
  send(chatId: P.ChatId, m: SendInput): 'accepted' | 'duplicate' | 'not_live';   // pushes into the InputQueue (works while spawning)
  interrupt(chatId: P.ChatId): Promise<{ stillQueued: P.Uuid[] }>;
  cancelQueued(chatId: P.ChatId, uuid: P.Uuid): Promise<boolean>;
  decide(chatId: P.ChatId, requestId: string, a: P.UiAnswer): 'ok' | 'not_pending';
  setMode(chatId: P.ChatId, m: P.PermissionModeId): Promise<void>;
  setModel(chatId: P.ChatId, model: string | null, effort: P.Effort | null): Promise<void>;
  rename(chatId: P.ChatId, title: string): Promise<void>;                        // live only (q.renameSession)
  task(chatId: P.ChatId, op: 'stop' | 'background' | 'stopAll', ref?: string): Promise<void>;
  contextSummary(chatId: P.ChatId): Promise<P.ContextSummary>;                    // getContextUsage({detail:'summary'}) ONLY
  rules(chatId: P.ChatId): Promise<P.RuleView[]>;                                  // runtime-only listPermissionRules, feature-detected
  commands(chatId: P.ChatId): Promise<P.SlashCommandView[]>;
  usage(chatId: P.ChatId): Promise<Record<string, unknown> | null>;               // usage_EXPERIMENTAL…({skipBehaviors:true}), on click only
  rewindFiles(chatId: P.ChatId, userUuid: P.Uuid, dryRun: boolean): Promise<P.RewindPreview>;
  sleep(chatId: P.ChatId, reason: SleepReason, o?: { stopTasks?: boolean }): Promise<ExitInfo | null>;
  protect(visible: ReadonlySet<P.ChatId>, keepAlive: ReadonlySet<P.ChatId>): void;
  setPolicy(p: { maxLive: number; reapMin: number | null }): void;
  ownPids(): ReadonlySet<number>;                                                  // jobrun + claude.exe pids (registry exclusion)
  shutdown(deadlineMs: number): Promise<void>;
}
export type SpawnerFactory = (chatId: P.ChatId, isolation: 'job' | 'plain') => (o: SpawnOptions) => SpawnedProcess;
export type EngineDeps = {
  query: QueryFn; clock: Clock; sink: EngineSink; spawner: SpawnerFactory; log: Logger;
  freeMemBytes: () => number; holder: (accountId: P.AccountId, sessionId: P.SessionId) => P.ExternalHolder | null;
};
export type CreateEngine = (d: EngineDeps) => Engine;

// ============================================================ the model: model, pure (src/server/model/*)
export type FrameSignals = {
  sub?: P.SubPhase | null; subTool?: string; retry?: { attempt: number; max: number; inMs: number; status?: number };
  rateLimit?: { status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number; kind?: string; info: Record<string, unknown> };
  authError?: boolean; billingError?: boolean; modelNotFound?: boolean; overloaded?: boolean; turnEnded?: boolean;
};
export type ReduceOut = { events: P.ChatEvent[]; urgent: boolean; signals: FrameSignals };
export interface LiveReducer {                                   // one per live chat; pure state machine over SDK frames
  step(f: SdkFrame, at: number): ReduceOut;
  userStarted(m: { uuid: P.Uuid; text: string; images: number; folded: boolean; at: number }): P.ChatEvent[];
  localRow(row: P.UiSystemRow, at: number): P.ChatEvent[];       // crash, notices, cache-miss
  liveTurn(): P.UiTurn | null;
  meta(): P.ChatMetaView; metrics(): P.ChatMetrics; tasks(): P.TaskView[]; todos(): P.TodoItem[] | null;
  detail(id: string, field: P.DetailField): P.DetailPayload | null;   // heavy fields of the live turn (≤ 8 MB per chat)
}
export type CreateLiveReducer = (seed: { chatId: P.ChatId; meta: P.ChatMetaView; metrics: P.ChatMetrics }) => LiveReducer;
export interface ChatStateMachine {                              // returns true when ChatStateView changed
  onFacts(f: ProcessFacts | null, at: number): boolean;
  onSignals(s: FrameSignals, at: number): boolean;
  onAsks(count: number, oldestAt: number | undefined, kind: P.AskKind | undefined): boolean;
  onExternal(h: P.ExternalHolder | null): boolean;
  onExit(info: ExitInfo, at: number): boolean;
  onUser(ev: 'viewed' | 'interrupt' | 'send', at: number): boolean;
  view(): P.ChatStateView;
}
export type CreateChatState = (seed: { notStarted: boolean; limitResetsAt?: number; lastError?: SessionMeta['lastError'] }) => ChatStateMachine;
export type HeavyLoc = { id: string; field: P.DetailField; off: number; len: number };
export type DiskToTurns = (chain: readonly RawEntry[], o: { sessionId: P.SessionId }) => { turns: P.UiTurn[]; heavy: HeavyLoc[] };
export type DeriveTitle = (prompt: string) => string;          // 1st line, no @mentions or /commands, ≤ 60 chars
export type WakeEstimate = (lastContext: number, shared: 'sameCwd' | 'account' | 'none') => number; // max(0, ctx − 19k | 16.8k | 0)
export type ActivityLine = (s: { ask?: P.PendingAsk; tool?: { name: string; description?: string }; lastText?: string; firstPrompt?: string }) => string;

// ============================================================ the server shell: server shell (src/server/app/*, http/*, ws/*, platform/*)
export type ChatMeta = {
  chatId: P.ChatId; accountId: P.AccountId; sessionId: P.SessionId; cwd: string; createdAt: number; title?: string;
  pinned?: boolean; archived?: boolean; keepAlive?: boolean; muted?: boolean;
  mode?: P.PermissionModeId; model?: string; effort?: P.Effort;
  pendingStart?: { kind: 'new' } | { kind: 'fork'; fromChatId: P.ChatId; fromJsonl: string };
  links?: { forkedFrom?: P.ChatId; continuedFrom?: P.ChatId; continuedTo?: P.ChatId };
  lastRequestAt?: number; lastContext?: number; trusted?: boolean;
};
export interface MetaStore {                                   // %LOCALAPPDATA%\SidMultiClaude\state\*.json, atomic + .bak, 1 s debounce
  chat(id: P.ChatId): ChatMeta | undefined; chats(): ChatMeta[];
  upsert(m: ChatMeta): void; patch(id: P.ChatId, p: Partial<ChatMeta>): void; remove(id: P.ChatId): void; rekey(from: P.ChatId, to: P.ChatId): void;
  ui(): P.UiState; saveUi(s: P.UiState): void;
  drafts(): Record<P.ChatId, P.Draft>; saveDraft(id: P.ChatId, d: P.Draft | null): void;
  settings(): P.Settings; saveSettings(p: Partial<P.Settings>): P.Settings;
  appTrusted(accountId: P.AccountId, cwd: string): boolean; trust(accountId: P.AccountId, cwd: string): void;
  flush(): Promise<void>;
}
export type CwdCheck = P.Result<string, 'cwd_missing' | 'cwd_too_long' | 'cwd_refused'>;
export interface Platform {
  claudeExe(pref: 'installed' | 'bundled'): P.Result<string, 'exe_missing'>;
  checkCwd(p: string, configDirs: readonly string[]): CwdCheck;  // realpath.native, < 259, S9 (home itself / inside a profile refused)
  confine(root: string, rel: string): string | null;
  jobrunAvailable(): boolean;                                     // launcher\jobrun.exe present and hash OK
  openExternal(url: string): void;                                // explorer.exe, http/https only
  openPath(p: string, how: 'explorer' | 'vscode'): void;
  terminalCommand(s: { cwd: string; configDir: string | null; sessionId: P.SessionId; exe: string }): P.Result<string, 'cwd_refused'>;
  openTerminal(s: { cwd: string; configDir: string | null; sessionId: P.SessionId; exe: string }): P.Result<void, 'cwd_refused'>;
  fileIndex(cwd: string, q: string, limit: number): Promise<P.FileHit[]>;
  listDirs(p: string | null): Promise<P.DirListing>;
  openAppWindow(port: number, bootCode: string, browser: 'edge' | 'chrome'): number | undefined;
  listOrphans(recorded: { pid: number; createdAt: string }[]): Promise<{ pid: number; name: string }[]>;
  killPids(pids: number[]): Promise<void>;
  freeMemBytes(): number;
}
export interface Hub {                                            // WebSocket fan-out
  push(chatId: P.ChatId | null, msgs: P.S2C[]): void;            // chatId → only connections whose view.full has it; null → all
  visible(): ReadonlySet<P.ChatId>;                              // union of view.full over connections
  looking(chatId: P.ChatId): boolean;                            // shown in a pane of a focused, visible window
  connections(): number;
  onEmpty(cb: () => void): () => void;                           // last window disconnected
}
```

### 5.2 Exported constructors (one per module; names are binding)

| Module | Export |
|---|---|
| `engine/engine.ts` | `export const createEngine: CreateEngine` |
| `engine/spawner.ts` | `export const createSpawner: (o: { jobrunPath: string \| null; registryFile: string; log: Logger }) => SpawnerFactory` |
| `model/live-reducer.ts` | `export const createLiveReducer: CreateLiveReducer` |
| `model/chat-state.ts` | `export const createChatState: CreateChatState` |
| `model/disk-turns.ts` | `export const diskToTurns: DiskToTurns` |
| `model/derive.ts` | `export const deriveTitle: DeriveTitle; export const activityLine: ActivityLine` |
| `model/accounting.ts` | `export const wakeEstimate: WakeEstimate` (plus the pure helpers of §2.12) |
| `claude/accounts.ts` | `export function createAccountStore(d: { appDir: string; homeReal: string; log: Logger; clock: Clock }): AccountStore` |
| `claude/login.ts` | `export function createLoginService(d: { accounts: AccountStore; exe: () => string; log: Logger }): LoginService` |
| `claude/session-index.ts` | `export function createSessionIndex(d: { accounts: AccountStore; cacheDir: string; log: Logger; clock: Clock }): SessionIndex` |
| `claude/reader.ts` | `export function createTranscriptReader(d: { log: Logger }): TranscriptReader` |
| `claude/registry.ts` | `export function createLiveRegistry(d: { accounts: AccountStore; log: Logger }): LiveRegistry` |
| `claude/sdk-helpers.ts` | `export function createSdkHelpers(d: { log: Logger }): SdkHelpers` (lazy `import()` of the SDK) |
| `claude/history.ts` | `export function createPromptHistory(d: { accounts: AccountStore; appDir: string }): PromptHistory` |
| `app/meta.ts` | `export function createMetaStore(d: { appDir: string; log: Logger }): MetaStore` |
| `platform/win.ts` | `export function createPlatform(d: { appDir: string; log: Logger }): Platform` |
| `ws/hub.ts` | `export function createHub(d: { clock: Clock; log: Logger }): Hub & { attach(ws: import('ws').WebSocket): void }` |

### 5.3 `src/server/engine/options.ts` (verbatim; the parity contract)

```ts
// src/server/engine/options.ts — THE parity contract. Any change requires updating test/parity/options.snapshot.json
// and re-running T-P2/T-P3 (0 tokens).
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnSpec } from '../contracts.ts';

export const APP_UA = 'sidmulticlaude/0.1.0';
// Blacklist copy keeps terminal parity for PATH, proxies, TEMP (8.3 form kept on purpose), etc.
// Drops the parent Claude session (CLAUDECODE, CLAUDE_CODE_*, CLAUDE_CONFIG_DIR, CLAUDE_EFFORT, CLAUDE_PID…), API billing
// (ANTHROPIC_API_KEY / _AUTH_TOKEN / _BASE_URL) and debugging hooks. /i because Windows env names are case-insensitive (Path vs PATH).
export const LEAKY_ENV = /^(CLAUDECODE|CLAUDE_.*|ANTHROPIC_.*|AI_AGENT|OTEL_.*|NODE_OPTIONS|NODE_DEBUG|DEBUG|ELECTRON_RUN_AS_NODE)$/i;

export function accountEnv(configDir: string | null, aiTitles: boolean, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !LEAKY_ENV.test(k)) env[k] = v;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;          // default profile: UNSET (=~\.claude would select the phantom global config)
  if (!aiTitles) env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1'; // no generate_session_title call [R TOKEN-RESEARCH.md §4, real run C1/C2]
  env.CLAUDE_AGENT_SDK_CLIENT_APP = APP_UA;                    // honest client id (User-Agent suffix)
  return env;                                                  // CLAUDE_CODE_ENTRYPOINT left unset -> the SDK stamps 'sdk-ts'
}

export type OptionCallbacks = Required<Pick<Options, 'canUseTool' | 'spawnClaudeCodeProcess' | 'stderr'>> & Pick<Options, 'onElicitation'>;

export function buildOptions(s: SpawnSpec, cb: OptionCallbacks): Options {
  const o: Options = {
    cwd: s.cwd,
    env: accountEnv(s.account.configDir, s.aiTitles),
    pathToClaudeCodeExecutable: s.exe,                         // installed native claude.exe by default; bundled on request
    systemPrompt: { type: 'preset', preset: 'claude_code' },   // MANDATORY: omitted => 141-token prompt instead of 3,122 [R]
    settingSources: ['user', 'project', 'local'],              // explicit: the default changed across SDK versions [R]
    permissionMode: s.mode,                                    // explicit: else settings defaultMode or 'auto' (classifier calls) [R]
    includePartialMessages: true,
    perTaskStopAffordance: true,                               // Échap spares background tasks (CLI behaviour) — gated by T-P3 [U]
    enableFileCheckpointing: true,                             // rewindFiles(); disk only — gated by T-P3 [U]
    canUseTool: cb.canUseTool,
    spawnClaudeCodeProcess: cb.spawnClaudeCodeProcess,
    stderr: cb.stderr,
  };
  if (cb.onElicitation) o.onElicitation = cb.onElicitation;   // MCP form/URL requests — gated by T-P3 [U]
  if (s.account.claudeMdExcludes.length) o.settings = { claudeMdExcludes: s.account.claudeMdExcludes }; // never on the default profile
  if (s.model) o.model = s.model;                              // user choice only (alias or catalog id)
  if (s.effort) o.effort = s.effort;                           // user choice only
  if (s.allowBypass) o.allowDangerouslySkipPermissions = true; // only when Réglages › Autoriser le mode Contournement is on
  switch (s.start.kind) {
    case 'new': o.sessionId = s.sessionId; if (s.start.title) o.title = s.start.title; break;
    case 'resume': o.resume = s.sessionId; break;
    case 'fork': o.resume = s.start.fromJsonl; o.forkSession = true; o.sessionId = s.sessionId; o.title = s.start.title; break;
    case 'rewind': o.resume = s.sessionId; o.resumeSessionAt = s.start.atUuid; if (s.start.dropsTurn) o.resumeDropsTurn = s.start.dropsTurn; break;
  }
  // NEVER passed (each changes requests or behaviour vs the terminal): tools, allowedTools, disallowedTools, agents, mcpServers,
  // plugins, hooks, skills, betas, thinking, maxThinkingTokens, appendSystemPrompt, toolConfig, plansDirectory, promptSuggestions,
  // agentProgressSummaries, sessionStore (copies .credentials.json), persistSession:false, continue, extraArgs.
  return o;
}
```

### 5.4 `src/web/contract.d.ts` (verbatim; the web shell ↔ the chat surface)

```ts
// src/web/contract.d.ts — web shell (shell/store) <-> chat surface contract. Types only. Shared contract, additive changes only.
import type { ReadonlySignal, Signal } from '@preact/signals-core';
import type * as P from '../shared/protocol.ts';

export interface ChatVM {
  id: P.ChatId;
  summary: ReadonlySignal<P.ChatSummary>;
  meta: ReadonlySignal<P.ChatMetaView | null>;
  metrics: ReadonlySignal<P.ChatMetrics>;
  turns: ReadonlySignal<{ id: string; sig: Signal<P.UiTurn> }[]>;   // one signal per turn; streaming touches one block only
  blocks: (blockId: string) => Signal<P.UiBlock> | undefined;
  queue: ReadonlySignal<P.QueueItem[]>; tasks: ReadonlySignal<P.TaskView[]>; todos: ReadonlySignal<P.TodoItem[] | null>;
  asks: ReadonlySignal<P.PendingAsk[]>;                               // oldest first
  hasMore: ReadonlySignal<boolean>; loading: ReadonlySignal<boolean>;
  draft: Signal<P.Draft>;
}
export interface Actions {
  send(c: P.ChatId, text: string, o?: { images?: P.ImageInput[]; priority?: 'later' | 'now'; wake?: 'asIs' | 'summary' }): P.Uuid; // optimistic chip
  interrupt(c: P.ChatId): void;
  cancelQueued(c: P.ChatId, uuid: P.Uuid): Promise<boolean>;
  decide(c: P.ChatId, requestId: string, a: P.UiAnswer): Promise<'ok' | 'not_pending'>;
  prespawn(c: P.ChatId): void;
  loadOlder(c: P.ChatId): Promise<void>;
  detail(c: P.ChatId, id: string, f: P.DetailField): Promise<P.DetailPayload>;
  mentions(c: P.ChatId, q: string): Promise<P.FileHit[]>;
  prompts(q: string, c?: P.ChatId): Promise<P.PromptHit[]>;
  setMode(c: P.ChatId, m: P.PermissionModeId, typed?: string): Promise<void>;
  setModel(c: P.ChatId, model: string | null, effort: P.Effort | null): Promise<void>;
  rename(c: P.ChatId, title: string): Promise<void>;
  task(c: P.ChatId, op: 'stop' | 'background' | 'stopAll', ref?: string): Promise<void>;
  rewind(c: P.ChatId, userUuid: P.Uuid, action: 'both' | 'conv' | 'code', dryRun: boolean): Promise<P.RewindPreview>;
  fork(c: P.ChatId, o: { upToUuid?: P.Uuid; accountId?: P.AccountId }): Promise<P.ChatId>;
  info(c: P.ChatId, what: 'context' | 'rules' | 'session' | 'commands'): Promise<unknown>;
  sleep(c: P.ChatId, stopTasks?: boolean): Promise<void>;
  openChat(c: P.ChatId, where?: 'focused' | 'newPane' | 'background'): void;
  openExternal(url: string): void;
  toast(key: string, args?: Record<string, string | number>): void;
}
export declare function useChat(c: P.ChatId): ChatVM;   // the web shell implements; the chat surface consumes
export declare const actions: Actions;                   // the web shell implements; the chat surface consumes
// the chat surface exports (the web shell mounts them): Pane({chatId, pane, focused}), Peek({chatId, onClose}), PendingDock({chatId, compact?}),
// ChatOverlays() (Rewind, ContinueOn, Wake, ModelSwitchConfirm, CapChoice, Lightbox, AgentsDrawer)
```

### 5.5 Behaviour that goes with the contracts

#### the engine: Engine

**Calls.**

| Call | Behaviour | Errors |
|---|---|---|
| `ensure(spec, o)` | No-op if the chat is live (also for a different `why`). Check order: breaker → external holder (`force` skips it) → pool slot → exe exists → spawn | `breaker_open`, `external{holder}`, `cap{candidates}`, `cap_busy` (every candidate protected and no `exceed`), `exe_missing`, `spawn_failed` |
| `send` | `duplicate` if the uuid was already seen for this chat; a per-chat LRU of 10,000 uuids survives respawns within the server's lifetime. `not_live` without a process (callers `ensure` first) | Never throws |
| `interrupt` | Never throws. A timeout sets `stuck` | — |
| `cancelQueued` | `false` when unsupported, too late, or unknown | — |
| `decide` | `not_pending` for an unknown or already resolved `requestId` | — |
| `setMode('bypassPermissions')` | Throws `forbidden` unless the process was spawned with `allowDangerouslySkipPermissions` | `forbidden` |
| `rename` | Live chats only | Throws `not_live`; the caller then uses `SdkHelpers.rename` |
| `sleep` | Runs §2.7 and resolves with `ExitInfo`; `null` if the chat was not live | — |
| `protect` | Called by the server shell whenever views or *Garder actif* change. It re-arms the reaper timer | — |
| `stats` | Cheap; the server shell calls it at most once per second for `procs` | — |

**Ordering guarantees to the sink.**
- `ask()` comes before the `facts` that count it; `askEnd()` before the `facts` that uncount it.
- `frame(command_lifecycle started)` comes before `delivered()`, which comes before any assistant frame of that turn.
- `exited()` comes after the last `frame()`.
- `facts()` is coalesced: at most one per chat per tick.

#### the model: Model (pure, no I/O, no timers; `at` values come from the caller)

`LiveReducer.step(f)` maps each SDK frame as follows. Unknown types or subtypes are ignored and never throw.

| Frame | Effect |
|---|---|
| `stream_event message_start` | Current `message.id`; usage → `metrics.contextTokens` |
| `content_block_start` | Live block `a:<message.id>:<index>` (text / thinking) or `t:<id>` (tool_use) → `block{live:true}` |
| `content_block_delta` (`text_delta`) | `delta` part. Coalescing is the hub's job; the reducer returns every part |
| `content_block_delta` (`thinking_delta`) | Char count only → `progress` (the reducer itself throttles to ≤ 1/s per block). The thinking text goes to the heavy stash |
| `content_block_delta` (`input_json_delta`) | Ignored: tool input is final in the `assistant` frame |
| `assistant` (one per completed block) | Upsert the block with its final content: text `md`; tool `ToolInputView`, status `running`; thinking `chars` / `redacted`. Plus `aborted`, `message.model`, and `error` → signals |
| `user` with `tool_result` | `tool.result{status: ok \| error \| denied \| interrupted}` + lite result. Synthetic `[Request interrupted by user…]` text → system row `interrupted` |
| `system:init` | `meta` (model, cwd, tool count, MCP, `permissionMode`, slash commands, capabilities). With no open turn, it opens a system turn `x:<uuid>` (task notifications, peers) |
| `system:status` | `requesting` / `compacting` → signals `sub`. `status:null` + `permissionMode` → `meta.mode` + a `modeChange` row (Détaillé only) |
| `system:compact_boundary` | `compact` row |
| `system:api_retry` | Signal `retry` + a transient `retry` row |
| `rate_limit_event` | Signal `rateLimit` |
| `result` | `turn.end{footer}` with usage, cost Δ, `auxTokens`, models, `interrupted`, `terminal`; metrics; signal `turnEnded` |
| `system:task_*`, `background_tasks_changed` | `tasks` (replace) |
| `tool_progress` | `progress{elapsedMs}` ≤ 1/s |
| `system:thinking_tokens` | `progress{tokens}` |
| `system:session_title_changed` | `meta.title` |
| `system:conversation_reset` | `reset{clear}` |
| `hook_*` | `hook` rows (Détaillé only) |
| local command output / synthetic `usage_report` | `local` row |
| `model_refusal_*` | `refusal` row |
| `permission_denied` | Notice row |
| `informational` / `notification` | Rows per level |
| TodoWrite / TaskCreate / TaskUpdate tool inputs | `todos` (replace) |

**User messages.** `userStarted({folded:false})` opens `turn.start` with the user message. `folded:true` adds a `user` block inside the current turn.

**Heavy stash.** Tool output beyond head and tail of 4 KB each, `originalFile`, image base64 and thinking text are kept per chat, ≤ 8 MB (LRU by block), and served by `detail()`. After the turn, `HeavyLoc` from disk serves them.

**`diskToTurns(chain)`** renders exactly what the live path renders: same ids, kinds and texts (the **"live = reload" invariant**, a test). Rules from ux §5 and the on-disk data research:
- Hidden: `isMeta` users, `stop_hook_summary`, and attachments except `queued_command`, which becomes a folded user block.
- `api_error` → `retry` rows; `isApiErrorMessage` → `error` rows; `toolDenialKind` → denial; `compact_boundary` → `compact` row.
- `isCompactSummary` → a collapsed summary row; turns before it get `beforeCompaction`.
- Assistant entries are grouped by `message.id`, with block index = `apiBlockIndex` ?? ordinal [U: `apiBlockIndex` coverage]. Tool results attach by `tool_use_id`.

**`createChatState`** implements ux §4.1–4.2 from facts, signals, asks, the external holder, exits and user events.
- `since` changes only when the phase changes.
- `unread` is set by the `turnEnded` signal and cleared by `onUser('viewed')`. the server shell calls `onUser('viewed')` right after a `turnEnded` when `hub.looking(chatId)`, and whenever a connection starts looking.
- `limit` is cleared at `resetsAt`. The caller's timer then calls `onSignals({rateLimit:{status:'allowed'}})`.

#### the Claude-data module: Claude data (read-only on profiles; writes only through `SdkHelpers` and `claude.exe`)

**AccountStore.**
- **Login state** (no process):
  - `connected` = `<cfg>\.credentials.json` exists with size > 0 (`fs.stat` only) **and** `oauthAccount.accountUuid` is present (or `cachedGrowthBookFeatures.tengu_windows_credman === true` and the uuid);
  - `disconnected` = neither;
  - `incoherent` = one of the two;
  - `reauth` = set at run time.
  - **`claude auth status` is never run.**
- **Identity** from `oauthAccount`. Plan label: `claude_max` + `…max_5x` → « Max 5x »; `claude_team` → « Team ».
- **Duplicates:** the same `accountUuid` in two profiles → `duplicateOf`.
- **Usage merge, freshest first:** live `rate_limit_event` → *Actualiser* result → `cachedUsageUtilization` snapshot. The snapshot is `stale` after 1 h. `limits[]` is preferred when present.
- **Watching:** the global config is watched through its parent directory (non-recursive, name filter, 300 ms debounce).
- **First run:** candidates = the default profile + every `~\.claude-*`. The *Comptes* panel opens with the connected ones pre-selected (names from `oauthAccount.organizationName` or « Perso »; colours 1, 2, …). Nothing is added without the user's confirmation.

**LoginService.**
- Runs `claude.exe auth login [--email]` with `accountEnv(configDir, false)`, `windowsHide`, piped stdio. The empty profile folder is created first if the user chose a new `~\.claude-<slug>`.
- Steps:
  - the `visit: <url>` line → `url`;
  - then `waiting`;
  - `Login successful.` + exit 0 + `oauthAccount` appearing (watched) → `done{email, plan}`;
  - `Login failed` or exit ≠ 0 → `error`;
  - 10 min → kill → `error`.
- `code()` writes `code#state\n`. `logout()` runs `claude.exe auth logout`.

**SessionIndex.**
- Per account, a stat pass over `realpathNative(<cfg>\projects)\*\*.jsonl`. The cache is keyed by `(mtimeMs, size, birthtimeMs)`.
- On a change: head/tail 64 KiB (SDK algorithm, the on-disk data research), with the backwards fallback when a giant last line hides the metadata.
- Extra fields:
  - `lastContext` and `lastRequestAt` from the last assistant `usage` / `timestamp`;
  - `lastMode` from `permission-mode`;
  - `lastError` from `quotaLimits` or `authentication_failed`;
  - `costUsd` from `cost-state`;
  - `ownerAccountUuid` from `bridge-session`;
  - `origin` from `entrypoint` (`cli` → cli, `claude-desktop` → desktop, `sdk-ts` → app, others → other);
  - `updatedAt` = the last user/assistant timestamp.
- Sidechain heads and files without messages are skipped.
- Watchers: recursive on `projects` (300 ms debounce per path; a `null` filename → rescan). Reconcile = stat only.
- **Live app chats:** watcher events only refresh `mtimeMs`/`size`. The orchestrator owns live state.

**TranscriptReader.**
- `tail` reads backwards in 256 KiB steps until it has `turns` turns or 2 MiB. Beyond that it scans forward in chunks with `setImmediate` yields.
- Unparsable trailing lines are skipped.
- `chain.ts` rebuilds the latest branch (compaction relink, sidechains dropped).
- Cursors are opaque base64url JSON `{off, leaf}`.
- `search` reads 64 KiB chunks with yields, is abortable, and returns ≤ 50 hits.

**LiveRegistry.**
- Non-recursive watcher on `<cfg>\sessions`. It parses `<pid>.json` and never opens `*.key`.
- A holder is live iff `process.kill(pid, 0)` succeeds **and** `procStart` matches the creation time (cached), **or** `updatedAt` is < 60 s old.
- The engine's `ownPids()` are excluded.

**SdkHelpers.**
- Lazy `import('@anthropic-ai/claude-agent-sdk')`, one mutex.
- Around each call, `CLAUDE_CONFIG_DIR` is set (non-default account) or deleted (default), then restored.
- `rename` → `renameSession(id, title, {dir})`; `remove` → `deleteSession`; `forkUpTo` → `forkSession(id, {upToMessageId, title})` → new id.

**PromptHistory.**
- App `state\prompts.jsonl` (5,000 lines, rotated).
- Plus read-only `<cfg>\history.jsonl`, newest first, filtered by normalised project path and deduplicated on text.

#### the server shell: Server shell

**Boot order (`main.ts`):**
1. Scrub `CLAUDECODE` / `CLAUDE_*` / `ANTHROPIC_*` from `process.env`.
2. App paths and log.
3. Single instance: the pipe `\\.\pipe\SidMultiClaude-<user>`. If it is taken, ask the running instance to open a window and exit 0.
4. Crash-marker check, then write a new marker.
5. MetaStore → AccountStore → SessionIndex (render from the cache; scan in the background) → LiveRegistry → Engine (the SDK is imported at the first spawn).
6. Static map + guard + hub.
7. Bind `127.0.0.1:41731` (fallback 41732–41750, persisted).
8. `run\instance.json`; `--open` → open the window; arm the lifetime rule.

Target: listening in < 400 ms.

**Orchestrator, per chat runtime** = `{reducer?, state, seq, lastSummary, deltas}`, created when a chat is live or viewed, and dropped 5 min after neither.

| Engine event | Orchestrator action |
|---|---|
| `frame` | `reducer.step` → events → hub (+ `seq`); `signals` → `state.onSignals`; `rateLimit` → `accounts.noteUsage`; `authError` → `accounts.noteAuthError` |
| `facts` | `state.onFacts` |
| `ask` / `askEnd` | Global frames + `state.onAsks` |
| `delivered` | `reducer.userStarted`; prompt history; first-message rename (§2.4) |
| `sessionChanged` | Re-key: meta, hub, `chats.rekey`, `reset{clear}` |
| `exited` | `state.onExit`, `reducer.localRow(crash)`, returned queue → a `queue` event + toast |

- **Summary:** `SessionMeta ⊕ ChatMeta ⊕ state ⊕ activity`. A `chats` upsert is sent at most 2 per second per chat, except phase changes, which go at once.
- **Unread:** on `view`, `hub.looking(chatId)` → `state.onUser('viewed')`.
- **Commands:** §6.3.
- **Lifetime rule (C13):** checked on `hub.onEmpty`, on `exited`, on `askEnd`, and on its single timer.

**Hub.**
- `view` replaces the connection's full set. For each newly added chat it sends a `snap`:
  - live chat → `reducer.liveTurn()` + state;
  - cold chat → state + meta from the index, `live:null`, `lastDiskTurnId`.
- `looking(c)` = some connection has `windowFocused` and `full ∋ c`.
- Coalescing, `seq` and backpressure follow §6.2.

**Platform.** As in the contract. `terminalCommand` builds:

```
wt.exe -d "<cwd>" powershell.exe -NoProfile -NoExit -EncodedCommand <base64 UTF-16LE of:
  Remove-Item Env:CLAUDECODE,Env:CLAUDE_CODE_*,Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue;
  [$env:CLAUDE_CONFIG_DIR = '<dir>';]   # only for non-default profiles
  & '<exe>' --resume <uuid>>
```

A cwd containing `;` is refused (`wt` treats it as a separator). The fallback without `wt.exe` is `powershell.exe -NoProfile -NoExit -EncodedCommand …` with `cwd` set in the spawn options.

---

## 6. Protocol semantics

### 6.1 Connection and authentication (the platform probes, verified)

1. **Window launch.** The server creates a boot code (24 random bytes, base64url, 60 s, single use) and launches:
   ```
   msedge.exe --app=http://127.0.0.1:<port>/#boot=<code> --user-data-dir=%LOCALAPPDATA%\SidMultiClaude\edge-profile
     --no-first-run --no-default-browser-check --disable-extensions --disable-sync --disable-default-apps
     --disable-background-networking --disable-component-update --no-pings --window-size=1280,860
   ```
   It uses `detached:true, windowsHide:true` and **never** `--remote-debugging-*`.
2. **Page.** It reads `#boot`, calls `history.replaceState` to drop it, then opens `new WebSocket('ws://127.0.0.1:<port>/ws', ['smc.v1', 'smc.auth.<deviceToken>'?, 'smc.boot.<code>'?])`.
3. **Server.**
   - Checks: exact `Host`, exact `Origin` `http://127.0.0.1:<port>`, path `/ws`.
   - It accepts the device token (32 bytes, constant-time compare) or consumes the boot code.
   - It selects only `smc.v1`, so secrets are never echoed.
   - After a boot-code login it sends `device-token` first; the page stores it in `localStorage['smc.device']` (wrapped in try/catch).
4. **`hello`.** The server then sends `hello`: the full world (settings, accounts, every `ChatSummary`, every pending ask, UI state, drafts, procs).
   - The client keeps `boot`. A different `boot` on reconnect means a server restart: drop every per-chat cache and `seq`, keep drafts and scroll anchors.
5. **No device token and no boot code** → 403. The page shows « Session expirée : relancez SidMultiClaude depuis son raccourci ».

### 6.2 Sequencing, batching, backpressure, resync

**Sequencing.**
- `seq` is per chat, monotonic for the server's lifetime, and incremented for every `ev` actually emitted.
- `snap{seq:N}` always precedes `ev{s:N+1…}` on a connection.
- The client drops `s ≤ last`. On a gap (`s > last + 1`) it re-sends its `view`, and the server answers with a fresh `snap`.

**Batching.**
- Every server → client WebSocket frame is a JSON array of `S2C`, flushed once per tick (`setImmediate`).
- `delta` parts are buffered per chat. **One 50 ms timer per chat is armed only while parts are pending and at least one connection shows the chat.**
- Any other event of that chat flushes the buffered parts first, so order is kept.
- The reducer throttles `progress` to ≤ 1/s per block.
- `chats` upserts: phase changes are sent at once; other summary changes at most 2/s per chat.
- **Urgent** messages flush in the current tick: `ask`, `askEnd`, phase changes, `ack`, `turn.end`.

**Visibility.** `ev` goes only to connections whose `view.full` contains the chat. **Every connection** receives `chats`, `ask`, `askEnd`, `accounts`, `procs` (≤ 1/s), `settings`, `toast`, `login`, `orphans`, `bye`.

**Backpressure, per connection.**
- `bufferedAmount` > 4 MiB → stop sending `ev` to that connection and mark it stale (`chats`, `ask` and `ack` still flow).
- Once it is back under 1 MiB → send a `snap` for each chat in its view.
- Above 32 MiB → close with 4001 `slow`; the client reconnects.

**Resync (no replay ring).**
- **Same `boot`:** the client re-sends `view`. The server sends a `snap` for each chat in the view. If `snap.lastDiskTurnId` differs from the client's last disk turn, the client reloads its tail page with `tx.page`.
- **New `boot`:** the same, after dropping its caches.
- Merges are idempotent because block ids are stable (§4).

**Several windows.**
- Each window has its own view; the hub keeps the union for `visible()`.
- `chat.decide` is first-answer-wins: the later ones get `not_pending`, and every window receives `askEnd`.
- Drafts are shared through the server (`draft.save`, last write wins by `at`).

**Outbox (client).**
- An unacknowledged `chat.send` is re-sent with the **same uuid** after a reconnect **only if `boot` is unchanged**. The server answers `accepted:'duplicate'` when it already has the uuid.
- After a server restart (new `boot`), unacknowledged sends are **not** re-sent: they return to the composer with `send.serverRestarted`. No unattended re-sending.

### 6.3 Command semantics

**Chat commands.**

| `C2S` | Server behaviour | `ack.data` / errors | Side effects |
|---|---|---|---|
| `view` | Replace this connection's view; `snap` for each new full chat; `looking` → `onUser('viewed')`; `engine.protect(visible)` | — | Unread cleared |
| `chat.create` | Validate the account (`not_logged_in`), `checkCwd` (S9: `cwd_missing` / `cwd_too_long` / `cwd_refused`), trust: `trustedInCli ∨ appTrusted ∨ trust:true`, else `untrusted`. New `sessionId = randomUUID()`; `ChatMeta{pendingStart:{kind:'new'}}`. `trust:true` → `meta.trust()` | `{chatId}` | `chats` upsert (`notStarted`) |
| `chat.prespawn` | Only when `settings.prespawn`, the chat is cold, not external, a slot exists without a warm eviction, and the breaker is closed. `ensure(why:'prespawn')`, best effort | always `ok` (errors swallowed) | Spawn |
| `chat.send` | Validate (≤ 8 images, sizes, text ≤ 1 MB). Then: cwd check; `ensure(why: cold ? 'wake' : 'send', evict / exceed / force)`; `wake:'summary'` → push `/compact` first; `engine.send` | `{accepted:'new' \| 'duplicate'}`; `cap{candidates}`, `cap_busy`, `external{holder}`, `breaker_open`, `not_logged_in`, `cwd_*`, `exe_missing`, `spawn_failed` | Queue chip; first-message title rename |
| `chat.interrupt` | `engine.interrupt` | `{stillQueued}` | `stopping` sub-phase |
| `chat.cancelQueued` | `engine.cancelQueued` | `{cancelled}` | `queue` event |
| `chat.decide` | `engine.decide` | `not_pending` | `askEnd` to all windows |
| `chat.setMode` | `bypassPermissions` requires `settings.allowBypass` **and** `typed === 'CONTOURNER'`, else `forbidden`. Live → `setPermissionMode`; cold → stored for the next spawn | `forbidden`, `timeout` | `meta.mode` |
| `chat.setModel` | Live → `setModel` + `applyFlagSettings({effortLevel})`; cold → stored. The client confirms first when the cache is warm (`model.confirm.*`) | `timeout`, `unsupported` | `meta` |
| `chat.rename` | Live → `engine.rename`; cold → `SdkHelpers.rename`; `external` → `forbidden` | `forbidden` | `chats` upsert |
| `chat.flags` | Meta only (`keepAlive` → `engine.protect`) | — | `chats` upsert |
| `chat.setCwd` | Cold only; `checkCwd`; stored as the resume cwd | `busy`, `cwd_*` | — |
| `chat.sleep` | `engine.sleep(force ? 'force' : 'user', {stopTasks})`. Running → the client confirmed first; `force` (*Forcer l'arrêt*) skips the graceful steps | `busy` (bg tasks without `stopTasks`) | Phase `cold` |
| `chat.delete` | Cold only, `confirm:true`; `SdkHelpers.remove`; meta removed | `busy`, `forbidden` | `chats.remove` |
| `chat.fork` | §2.10: same account without `upToUuid` → new cold chat `pendingStart:fork`; with `upToUuid` → `SdkHelpers.forkUpTo` (cold); other account → `pendingStart:fork` on the target, `upToUuid` refused | `{chatId}`; `invalid`, `not_logged_in` | `chats` upsert, links |
| `chat.rewind` | §2.10. `dryRun` → `rewindFiles` preview only | `RewindPreview`; `unsupported` (checkpointing off) | Composer gets the prompt back (client) |
| `chat.task` | `stopTask` / `backgroundTasks` / stop all | `not_live`, `timeout` | `tasks` |
| `chat.info` | `context` → `contextSummary`; `rules` → `listPermissionRules`; `commands` → `supportedCommands`; `session` → `SessionInfo` (index + `firstInstructions`, foreign files flagged) | per `AckData`; `not_live` for live-only queries | — |
| `chat.terminal` | `copyOnly` → command text. Otherwise `sleep('terminal')` then `openTerminal`; the chat becomes cold + external once the registry shows the terminal | `{command}`; `cwd_refused` | — |

**Transcript and history.**

| `C2S` | Server behaviour | `ack.data` / errors | Side effects |
|---|---|---|---|
| `tx.page` | `reader.tail` / `before` → `diskToTurns`; `limit` ≤ 50 | `TranscriptPage` | — |
| `tx.detail` | Live stash, else `HeavyLoc` + `reader.line` | `DetailPayload` (`too_large` > 8 MB) | — |
| `tx.search` | `reader.search` (aborted when a new search arrives) | `SearchHit[]` | — |
| `prompts.search` | `PromptHistory.search` | `PromptHit[]` | — |

**Accounts.**

| `C2S` | Server behaviour | `ack.data` / errors | Side effects |
|---|---|---|---|
| `account.candidates` / `add` / `update` | AccountStore | per `AckData` | `accounts` |
| `account.login` / `loginCode` / `loginCancel` / `logout` | LoginService. Logout first sleeps the account's chats (`logout` reason) | `busy` | `login` steps; `accounts` |
| `account.usage` | `usage_EXPERIMENTAL` through a live chat of the account. Without one: a transient no-prompt process in `%LOCALAPPDATA%\SidMultiClaude\probe-cwd` (it runs the hooks; explicit click only; closed right after) | `UsageView \| null` | `accounts` |
| `account.baseline` | Same transient process → `getContextUsage('summary')` | `ContextSummary` | `diag.baselineTokens` |

**Miscellaneous.**

| `C2S` | Server behaviour | `ack.data` / errors | Side effects |
|---|---|---|---|
| `fs.mentions` | `files.fileIndex(confine(cwd))`; ≤ 50 hits | `FileHit[]` | — |
| `fs.dirs` | `listDirs` (drives when `null`), with `warning` for home/ancestors | `DirListing` | — |
| `open` | `url`: http/https only → `explorer.exe <url>` (default browser, never the app profile); `explorer` / `vscode`: confined path | `invalid` | — |
| `ui.save` / `draft.save` / `settings.set` | MetaStore (debounced 1 s); `settings` broadcast; `maxLive` / `reapMin` → `engine.setPolicy` | — | `settings` |
| `orphans.kill` | `platform.killPids` (only pids from the last `orphans` list) | `invalid` | — |
| `app.quit` | If live chats exist and `!force` → `busy` (the client confirms with `app.quit.confirm`). Otherwise shutdown: engine 12 s → `bye{quit}` → close windows → exit 0 | `busy` | — |
| `log.client` | Rate-limited to 10/min, redacted | — | — |

### 6.4 Error code → French copy

| Code | Key (ux §16 or §9.4 below) |
|---|---|
| `cap` | `cap.choice` (+ `cap.sleep` / `cap.exceed` / `cap.cancel`) |
| `cap_busy` | `cap.busy` |
| `external` | `resume.elsewhere` / `term.locked` |
| `not_logged_in` | `acc.notConnected` + *Se connecter* |
| `untrusted` | `trust.title` / `trust.body` |
| `cwd_missing` | `resume.cwdMissing` |
| `cwd_too_long` | `new.tooLong` |
| `cwd_refused` | `new.homeRefused` / `new.profileRefused` |
| `exe_missing` | `exe.missing` / `exe.bundledMissing` |
| `spawn_failed` | `err.startup` |
| `breaker_open` | `err.breaker` |
| `forbidden` (bypass) | `mode.bypass.confirm` / `mode.bypass.org` |
| `not_pending` | `perm.elsewhere` |
| `timeout` | `err.timeout` |
| `unsupported` | `err.unsupported` |

---

## 7. Data

### 7.1 Owned by the app: `%LOCALAPPDATA%\SidMultiClaude\` (long path, user-only ACL)

Every write goes through `util/fs-guard.ts` → `json-store.ts`: atomic (tmp + `fsync` + rename), a `.bak` of the previous version, writes debounced 1 s and flushed at shutdown.

| Path | Content | Recovery |
|---|---|---|
| `config.json` (`v:1`) | `port`, `Settings`, `accounts[]` (`Account` minus runtime fields) | `.bak`, else re-detection (§5.5) |
| `state\device.json` | WebSocket device token | A new boot code from the launcher |
| `state\chats.json` (`v:1`) | `ChatMeta` per chatId (≈ 200 B each). **Flushed immediately** on create, fork and re-key | Rebuilt from the index; pins and links are lost |
| `state\ui.json` | `UiState` | Defaults; the `localStorage` mirror |
| `state\drafts\<chatId>.json` | `Draft` (≤ 1 MB) | `localStorage` mirror (`draft:<chatId>`) |
| `state\prompts.jsonl` | Prompts sent from the app (5,000 lines, rotated) | — |
| `state\helpers.json` | SHA-256 of `jobrun.exe` / `SidMultiClaude.exe` | Re-run the install |
| `cache\index-<accountId>.json` | `SessionMeta` keyed by path, plus `mtimeMs` / `size` / `birthtimeMs`; titles and prompts cut to 200 chars | Rescan (≈ 0.3 s / 100 files (measured)) |
| `run\instance.json` · `run\children.json` · `run\crash.marker` | `{pid, port, startedAt}`; child pids with creation time; crash flag | — |
| `logs\server-YYYYMMDD.log` | Redacted JSON lines, 5 × 5 MB, no message content | — |
| `edge-profile\` | Dedicated browser profile | Delete it: the device token re-bootstraps |
| `probe-cwd\` | cwd of the transient no-prompt usage/baseline processes | — |

**Invariant: conversation content lives only in Claude's JSONL. Deleting the app folder never loses a conversation.**

### 7.2 Read from Claude (read-only, 0 tokens)

| Source | Use | Rule |
|---|---|---|
| `<cfg>\projects\<key>\<sid>.jsonl`, `<sid>\custom-title.json`, `<sid>\subagents\*.jsonl` | Index, pages, details, search, subagent transcripts | Head/tail and tail-first only; never parse a whole large file on the main thread |
| Global config (`~\.claude.json` for the default profile, `<cfg>\.claude.json` otherwise) | `oauthAccount`, `cachedUsageUtilization`, `projects[path].hasTrustDialogAccepted`, `cachedGrowthBookFeatures.tengu_windows_credman` | Watched through the parent folder, re-parsed on change |
| `<cfg>\.credentials.json` | Login state | **`fs.stat` only.** Never opened, copied or logged |
| `<cfg>\settings.json` | `permissions.defaultMode`, `model`, `cleanupPeriodDays` | Display only |
| `<cfg>\cache\model-catalog\*.json` | Model and effort pickers | — |
| `<cfg>\sessions\<pid>.json` | Live holders | **Never** `*.key` |
| `<cfg>\history.jsonl` | `Ctrl+R` history | Read-only |

**Writes into Claude's world** go only through Claude Code itself:
- the CLI's own writes (transcripts, sidecars, `<cwd>\.claude\settings.local.json` when the user picks *pour ce projet*);
- SDK helpers (`renameSession`, `deleteSession`, `forkSession`);
- the live `renameSession` control;
- `claude.exe auth login|logout`.

The app creates only the empty folder of a new profile the user asked for. `fs-guard` throws on any other app write under a profile dir (tested).

### 7.3 Watching rules (0 CPU while idle)

- One recursive `fs.watch(realpathNative(<cfg>\projects))` per account, debounced 300 ms per path; a `null` filename → rescan.
- `<cfg>\sessions`: non-recursive.
- The global config: its parent folder, filtered by name.
- **Assert `!/~\d/.test(path)` before every `fs.watch`:** libuv aborts the whole process on an 8.3 path (measured).
- A stat-only reconcile on window focus. **No periodic timers.** Close a watcher before deleting anything under it.

---

## 8. Accounts (essentials; details in ux §9 and §5.5)

- **Account = profile.** The default profile is `configDir:null` (variable unset); others are `~\.claude-*` or folders the user adds. Example: Perso (default, Max), Pro (`.claude-pro`, Team), Perso 2 (`.claude-perso`, not connected).
- **Identity is never shown by colour alone.** Each account has a colour (8 tokens; default profile violet `--acc-1`, `.claude-pro` teal `--acc-2`), a monogram and a name. They appear in the sidebar header and row stripes, tab, pane badge and focus tint, composer border, placeholder « Écrire à Claude (Entreprise)… », send button « Envoyer · W », and every dialog.
- **CLAUDE.md leak.** `excludeForeignClaudeMd` is on by default for non-default accounts and impossible on the default one. The *Comptes* card shows the leaked file, the toggle, and the `settings.json` line with *Copier* (the app never writes it).
- **Retention.**
  - `cleanupPeriodDays` (default 30) deletes idle `sdk-ts` and CLI transcripts (measured).
  - Rows show `⌛ Supprimé dans n j` from day 25.
  - *Comptes* shows the count expiring within 5 days, and the line `"cleanupPeriodDays": 3650` with *Copier*. The app never writes it.
- **Login.** Through `claude.exe auth login` only (§5.5), with the InPrivate advice and a check of the account it got (`acc.login.done` / `login.wrongAccount`).
- **The app never reads, stores or shows a token.** API-key accounts are profiles logged in with Claude's own `/login`.
- **Expired login** is known only at run time (`authentication_failed`, `/Please run \/login/`) → `reauth` → *Se reconnecter*.

---

## 9. UX essentials (UX.md v1.1 is the detailed reference)

### 9.1 What stays exactly as in UX.md

| Area | UX.md section |
|---|---|
| Layout: top bar 36 px · sidebar 280 px (220–420) with *À traiter*, *Épinglés*, Account › Folder › Chat · tab strip · 1–4 pane grid (min pane 420 px) · status bar | §3 |
| A tab is only a view: closing it never stops Claude; *Mettre en veille* stops the process; *Arrêter* interrupts | §3.4 |
| The 9-state machine, its flags and the glyph / colour / text per state on every surface | §4 |
| Window title `!n ✕n ✓n · SidMultiClaude` and the canvas favicon badge, both ≤ 1/s | §4.5 |
| Rendering: view modes Normal / Détaillé / Focus (`Ctrl+O`); turn structure; tool grouping; per-tool rows; system events; cache-miss row; rendering security | §5 |
| Permission card, Edit/Write diff card, question form, plan card, elicitation card, mode menu and danger signalling | §6 |
| Composer: strips, queue chips, slash palette, `@` mentions, attachments, drafts, token hints | §7 |
| New chat, resume browser, rename / pin / archive / delete, rewind, *Ouvrir dans le terminal*, *Continuer sur un autre compte*, error banners | §8 |
| Accounts panel, login, usage gauges, identity, diagnostics | §9 |
| Quick switcher, keyboard map, platform key constraints, focus model | §10 |
| Notifications (only when not looking; tags `chatId:kind`; never an approve button) | §11 |
| Performance budgets and the streaming pipeline | §12 |
| Theme tokens | §13 |
| Accessibility | §14 |
| Components | §15 |
| French copy | §16 |

### 9.2 Changes and additions to UX.md (binding)

1. **Peek** (interactive).
   - `Espace` on a sidebar row (or an *À traiter* row) opens a floating panel with the last 3 exchanges (`tx.page`, cached) and, when present, the chat's top pending card. The card keeps its own keys (`1` / `2` / `3` / `Échap`).
   - `Entrée` opens the chat; `Échap` closes the panel.
   - Hover or arrow focus on a row prefetches its `tx.page` after a 150 ms debounce.
   - Peek **never** spawns a process.
2. **`Alt+Entrée` = *Envoyer après ce tour*** (`priority:'later'`) while running (measured). The composer footer also has a split button (*Mettre en file ▾ · Après ce tour*). Reachability in Edge `--app` is (unverified) (keydown test).
3. **`Ctrl+Entrée` = *Envoyer maintenant*** only when the chat's `meta.capabilities` contains `interrupt_send_now_v1`; otherwise the binding does the same as `Entrée` and the tooltip says so.
4. **Automatic resume after a rate limit is removed from v1.** The limit banner offers *Me prévenir à la réinitialisation* (an OS notification at `resetsAt`, no prompt) · *Continuer sur {compte}…* · *Ignorer*.
5. **Working-folder policy (S9).** The new-chat dialog and the folder browser **refuse** the home folder itself and folders inside a Claude profile or the app data folder (`new.homeRefused`, `new.profileRefused`), and **warn** for `C:\` and `C:\Users` (`new.ancestorWarn`).
6. **Queue chips.** New state `returned`: *Non envoyé · Renvoyer*, after a crash or a server restart. *Renvoyer* re-sends with a **new** uuid.
7. **Stuck interrupt.** After 10 s without an acknowledgement, the pane header shows `state.stuck` with *Forcer l'arrêt* (`chat.sleep` with `force`).
8. **Error boundaries.** Every `Turn` and every `ToolCard` renders *Bloc illisible* on a render error and sends `log.client`. A bad block never blanks the transcript.
9. **Server-held asks.** Cards come from `hello.asks` / `ask` frames, so they survive reloads and appear in every window. A click disables the card until its `ack`; `not_pending` → *Déjà traitée ailleurs*.
10. **Turn footer.** Adds `sys.footer.aux` when `auxTokens > 0`.
11. **Plan card.** Shows `plan.modelBadge` when the planning requests ran on another model than the chat's (the `haiku` alias case).
12. **Orphans dialog** (after a crash, `plain` isolation only); **quit confirmation** (`app.quit.confirm`).
13. **Settings additions:** *Binaire Claude* (`installed` / `bundled`), *Isolation des processus* (`job` / `plain`), *Rouvrir la fenêtre quand Claude a besoin de vous*.

### 9.3 Keyboard map (complete; AZERTY- and Edge-safe; digits matched on `event.code`, letters on `event.key`)

| Context | Key | Action |
|---|---|---|
| Global | `Ctrl+K` | Sélecteur rapide (prefixes `>` `c:` `d:` `e:`) |
| | `Alt+N` / `Alt+R` / `Alt+C` | Nouveau chat / Reprendre / Comptes |
| | `Alt+A` | Prochain « À traiter » (oldest needs first) |
| | `Alt+1…9` · `Alt+PgSuiv` / `Alt+PgPréc` | Onglet n · suivant / précédent |
| | `Alt+W` · `Alt+Z` · `Alt+L` · `Alt+B` | Fermer l'onglet · rouvrir · disposition · barre latérale |
| | `F6` / `Maj+F6` · `F1` or `?` (outside text) · `Ctrl+,` | Régions · aide · réglages |
| Chat | `Échap` · `Échap Échap` (< 600 ms, idle only) | Interrompre (garde la file) · Revenir à… |
| | `Ctrl+O` · `Ctrl+F` · `F2` · `Ctrl+B` | Vue · rechercher · renommer · mettre en arrière-plan |
| | `Alt+M` (then `1–5`) · `Alt+P` · `Alt+T` · `Alt+G` · `Alt+↑` / `Alt+↓` · `Ctrl+Fin` | Mode · modèle et effort · tâches · agents · message précédent / suivant · bas |
| Composer | `Entrée` · `Maj+Entrée` | Envoyer, or fold while running · nouvelle ligne |
| | **`Alt+Entrée`** · `Ctrl+Entrée` | **Après ce tour** · maintenant (capability-gated) |
| | `↑` / `↓` (edge lines) · `Ctrl+R` · `Ctrl+S` · `Ctrl+G` · `/` · `@` · `Ctrl+V` · `Maj+Tab` (opt-in) | Reprendre la file → historique · recherche · brouillon · agrandir · palette · mention · coller · modes |
| Cards | `1`/`O` · `2`/`T` (`←`/`→` scope) · `3`/`N` · `Échap` · `Tab` · `E` · `V` | Autoriser · Toujours · Refuser… · refuser et arrêter · commentaire · modifier · plein écran (`1` disabled when `defaultToNo`) |
| Question / Plan | `↑↓ Espace 1–4 Tab Ctrl+Entrée` / `1 2 3 M Ctrl+Entrée` | ux §6.4 / §6.5 |
| Sidebar | `↑↓→←` · `Entrée` · `Ctrl+Entrée` · `Maj+Entrée` · **`Espace`** · `F2` · `Suppr` · `Maj+F10` | Naviguer · ouvrir · nouveau volet · arrière-plan · **Peek** · renommer · archiver · menu |

**Never bound:** `Ctrl+N/T/W/Tab/PgUp/PgDn/1…9`, `Ctrl+Maj+T/N/W`, `Ctrl+Alt+…` (AltGr), `Alt+Maj+…`, `Alt+F/E/D/←/→`, `F12`. Single letters act only inside cards and dialogs, never in text fields.

### 9.4 French strings added to ux §16 (in `fr.js`)

| Key | French |
|---|---|
| peek.title | Aperçu · {titre} |
| peek.hint | Espace : aperçu · Entrée : ouvrir · Échap : fermer |
| composer.later | Envoyer après ce tour (Alt+Entrée) |
| queue.later | Après ce tour |
| queue.returned | Non envoyé · Renvoyer |
| send.serverRestarted | Le serveur a redémarré : ce message n'a pas été envoyé. Renvoyer ? |
| sendNow.unavailable | « Envoyer maintenant » n'est pas pris en charge par cette version de Claude Code : le message est mis en file. |
| state.stuck | L'arrêt ne répond pas |
| action.forceStop | Forcer l'arrêt |
| sys.crash | Interrompu (le processus Claude s'est arrêté) |
| sys.serverRestart | Interrompu par un redémarrage du serveur |
| sys.footer.aux | dont ≈ {n} tokens hors boucle principale (sous-agents, outils) |
| err.breaker | Trop d'arrêts inattendus : relance automatique suspendue. Réessayer ? |
| err.timeout | Claude Code ne répond pas (délai dépassé). |
| err.unsupported | Fonction non disponible avec cette version de Claude Code. |
| perm.elsewhere | Déjà traitée ailleurs |
| cap.busy | Tous les chats actifs sont occupés : impossible d'en mettre un en veille maintenant. |
| new.homeRefused | Votre dossier personnel entier ne peut pas servir de dossier de travail : les réglages d'un autre profil y seraient chargés. Choisissez un sous-dossier. |
| new.profileRefused | Ce dossier appartient à un profil Claude ou à l'application ({chemin}) : choisissez un dossier de projet. |
| new.ancestorWarn | Dossier très large ({chemin}) : Claude pourra lire beaucoup de fichiers. |
| new.tooLong | Chemin trop long pour Windows (258 caractères maximum). |
| limit.notifyMe | Me prévenir à la réinitialisation |
| notif.limitReset | Limite réinitialisée · {compte} |
| plan.modelBadge | planifié avec {modèle} |
| warn.haikuPlan | En mode Plan, l'alias haiku planifie avec Sonnet (comme le terminal). |
| sleep.tasks.confirm | {n} tâche(s) d'arrière-plan tournent encore. Les arrêter et mettre en veille ? |
| app.quit.confirm | {n} chat(s) actif(s). Quitter les arrêtera ; leur cache devra être recréé. |
| orphans.title | Des processus lancés par Claude tournent encore ({noms}). Les arrêter ? |
| orphans.kill / orphans.keep | Arrêter / Laisser tourner |
| server.restarted | Serveur relancé après un arrêt inattendu. |
| isolation.fallback | Isolation indisponible pour ce chat : arrêt par arbre de processus. |
| exe.missing | claude.exe introuvable. Installez Claude Code ou choisissez le binaire embarqué. |
| exe.bundledMissing | Binaire embarqué absent : lancez « npm run fetch-bundled-cli ». |
| info.drift | Version de Claude Code non testée avec cette application ({version}). |
| set.exe | Binaire Claude : installé (comme le terminal) · embarqué (SDK) |
| set.isolation | Isolation des processus : Job Windows (recommandé) · Simple |
| set.reopen | Rouvrir la fenêtre quand Claude a besoin de vous |
| set.aiTitles | Titres IA (comme Claude Code ; appel modèle léger) |

**Removed keys** (no auto-resume in v1): `limit.wait`, `limit.armed`, `sys.autoResume`.

### 9.5 Performance budgets (E2E-checked)

| Budget | Target |
|---|---|
| Input latency | < 16 ms with 4 panes streaming; no long task > 50 ms |
| First meaningful paint | < 300 ms with 200 sessions |
| Chat open | Last turns painted < 150 ms even for an 80 MB transcript (tail-first ≈ 14 ms for 2 MiB (measured)) |
| DOM | ≤ 4,000 nodes per pane; ≤ 150 mounted turns |
| Client heap | < 150 MB with 10 open chats |
| Server idle | 0 ms CPU over 30 s; RSS < 120 MB with 0 live chats |
| Edge idle | ≤ 1 % on a fresh dedicated profile with the lean flags (measured) |

---

## 10. Security requirements checklist (every item has a test)

| # | Requirement | Test |
|---|---|---|
| S1 | Bind `127.0.0.1` only (`exclusive:true`), port 41731 (+1…+19 persisted); never `localhost` in URLs | e2e/security: `::1` and LAN refused |
| S2 | HTTP: `GET`/`HEAD` only (else 405); exact `Host` `127.0.0.1:<port>` (else 421); static files from an exact-key allow-list Map built at boot (never `path.join(root, url)`); no CORS headers; **no cookies** | Platform's 6 HTTP guard cases + traversal payloads |
| S3 | WebSocket: exact `Origin`, path `/ws`, sub-protocol `smc.v1` plus a device token (32 B, constant-time) or a boot code (24 B, 60 s, single use, in the URL fragment, removed by `replaceState`); the server echoes only `smc.v1` | Platform's 7 WS cases (no Origin, other port, replayed code, wrong token…) |
| S4 | Headers: CSP `default-src 'none'; script-src 'self' 'sha256-<importmap>'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types dompurify` + `nosniff`, `no-referrer`, COOP/CORP `same-origin`, `X-Frame-Options: DENY`, `Cache-Control: no-cache` | Header snapshot test |
| S5 | One HTML sink: `lib/md.js` (marked with raw HTML escaped → DOMPurify `RETURN_TRUSTED_TYPE`, forbidden tags/attrs, `https?:|mailto:|#` only, remote `<img>` stripped). Everything else is text nodes; tool output is never HTML | 11 XSS payloads inert in Edge under Trusted Types |
| S6 | Every `C2S` is validated (type, required fields, **unknown fields rejected**, string and array caps, UUID / chatId / accountId format, existence checks). `maxPayload` 16 MiB; deflate off; `headersTimeout` 10 s, `requestTimeout` 30 s | 10,000-message fuzz: never throws, always acks |
| S7 | Dangerous actions need proof: bypass = setting + `typed:'CONTOURNER'` (never restored on wake); delete = cold + `confirm:true`; `userSettings` scope never emitted; approvals never in notifications or toasts | Unit + e2e |
| S8 | No shell, ever: `spawn` / `execFile` with argument arrays, absolute `%SystemRoot%\System32` paths, `windowsHide:true`, `.exe` targets only. Terminal: `-EncodedCommand`; a `;` in the cwd is refused. URLs: http/https only, through `explorer.exe` | grep test (`shell:` absent); unit |
| S9 | Working-folder policy on create, `setCwd`, resume and every spawn (realpath, case-insensitive): refuse missing paths, paths ≥ 259 chars, the home folder itself, anything inside a Claude config dir (`~\.claude`, `~\.claude-*`, any configured `configDir`) or the app data folder; warn for ancestors of home. `localSettings` / `projectSettings` suggestions only inside an S9-valid cwd. The internal `probe-cwd` of the usage/baseline processes is the only exemption | Unit table |
| S10 | Secrets: `.credentials.json` stat only; never read `*.key`; `process.env` never reaches the page; logs redact API keys, bearer tokens, OAuth access tokens, boot codes, device tokens; no message content in logs by default | A read spy on `.credentials.json` / `*.key` stays at 0; log scan |
| S11 | App writes are confined to the app folder (`fs-guard`); profile writes go only through Claude Code | fs spy: no app write under any profile dir |
| S12 | Child env: the blacklist strips `CLAUDE*` / `ANTHROPIC*` / `OTEL*` / `NODE_OPTIONS…`, exactly one `Path` key; `CLAUDE_CONFIG_DIR` unset for the default profile | T-P2 + unit |
| S13 | Browser isolation: dedicated `--user-data-dir`, `--disable-extensions`, never `--remote-debugging-*`; external links open in the user's default browser, never in the app profile | Launch-args unit test |
| S14 | Path jail `confine()` for mentions, previews and open: NUL, UNC / device (`\\?\`, `\\.\`, `//`), drive-relative, ADS `:`, reserved names (`CON`, `NUL`, `AUX`, `COM1`…, also with trailing dots or spaces), lexical `..`, then `realpathSync.native` re-check (junctions); case-insensitive | Platform's 15 cases |
| S15 | Resource limits: ≤ 8 images per message, ≤ 5 MB each; text ≤ 1 MB; drafts ≤ 1 MB; `tx.detail` ≤ 8 MB; backpressure closes at 32 MiB | Unit |
| S16 | Supply chain: exact pins, lockfile, `npm ci --ignore-scripts --omit=optional`; `vendor-audit` checks the static allow-list against the import graph; helper `.exe` files built from repo sources with hashes checked at launch | CI scripts |
| S17 | Notifications carry minimal text (« Autorisation requise · E · Fix CI »), no prompt content, no buttons | Unit |
| S18 | Single-instance pipe carries no secret and has one verb ("open a window"); the launcher never builds URLs | Unit |
| S19 | Terms: unmodified `claude.exe`, Anthropic's own login, honest client id, no unattended prompting (no auto-resume, no warm-up pings, no scheduled sends) | Review checklist |
| S20 | Crash hygiene: the server never exits on an unhandled rejection; one failing chat cannot take others down | Fault-injection integration test |

---

## 11. Modules and acceptance criteria

Each module below lists its files, the acceptance criteria it was built against, and the command that verifies it. In code comments, “SPEC §11.A item 6” means item 6 of the engine’s acceptance list.

**Rules.**
- `src/shared/*`, `src/server/contracts.ts`, `src/web/contract.d.ts`, `lib/md.js`, `i18n/fr.js` and `styles/tokens.css` are the shared contracts; changes to them are additive only.
- Every module is developed and tested against fakes: `fake-query.ts`, `fake-claude.mjs`, `tmp-profile`, `fake-engine.ts`, `mock-server.mjs`, a stub store.
- **No automated test makes a model call.** Only the manual smoke run (§12.5) does, within its budget.
- **Tests never touch a real Claude profile:** `tmp-profile` only. The contract script uses a logged-out temporary profile; the smoke run uses a real profile, on explicit request only.
- Common commands: `npm ci --omit=optional --ignore-scripts`; `npm run check` (both `tsc` projects, 0 errors).

### 11.0 Foundations

**Files:** config files, `src/shared/*`, `src/server/contracts.ts`, `src/server/util/*`, `src/web/contract.d.ts`, `src/web/lib/md.js`, `src/web/i18n/fr.js`, `src/web/styles/tokens.css`, `scripts/sanitize-frames.mjs`, `test/helpers/*`, the seeds of `test/fakes/fake-claude.mjs`, `test/fixtures/{frames,pairs,protocol}/`, `test/e2e/harness.ts`. Also typed **stubs for every other file** in §3.

**Starting material:**
- the type-checked contracts of §4 and §5;
- the HTTP guard, the process-tree helpers (`util/winproc.ts`), the single HTML sink (`lib/md.js`), the Job Object helper (`launcher/jobrun.cs`) and the fake CLI (`test/fakes/fake-claude.mjs`), all validated by the design probes;
- ux §13 → `tokens.css`, with the dark tokens in both selectors;
- ux §16 + §9.4 → `fr.js`.

**Fixtures.** `sanitize-frames.mjs` turns recorded SDK frame captures (`main`, `plan`, `fork`, `dry`) and the matching transcripts into **structure-only** fixtures:
- every free-text string is replaced by a synthetic one of a similar length;
- ids, uuids, enums, model names and numbers are kept;
- hook stdout, `prompt_snapshot`, CLAUDE.md and environment attachments are replaced by placeholders.

Result: `test/fixtures/frames/*.jsonl` and `test/fixtures/pairs/<name>/{frames.jsonl, transcript.jsonl}`, plus 8 golden protocol scripts (`stream`, `permission`, `question`, `plan`, `queue`, `crash`, `reconnect`, `cap`).

**Acceptance:**
1. `npm ci --omit=optional --ignore-scripts && npm run check` → 0 errors with every stub in place.
2. `npm test` is green on:
   - `json-store`: kill mid-write → the previous version and `.bak` are valid;
   - `fs-guard` throws under `~\.claude`, `~\.claude-pro`, `~\.claude-perso` and a configured dir;
   - 8.3 guard; `realpathNative`; `ids` codec; mutex ordering;
   - the spec-contracts selfcheck ported as `test/unit/shared/contracts.test.ts`.
3. A grep proves no fixture contains a string from the real transcripts (spot list: the user's email, CLAUDE.md lines, hook text).
4. A lifecycle probe, run once against the fake CLI under the real SDK: 15/15.

**Verify:** `npm ci --omit=optional --ignore-scripts && npm run check && npm test`

### 11.A Engine

**Files:** `src/server/engine/*`, `launcher/jobrun.cs`, `scripts/smoke.ts`, `scripts/contract.ts`, `test/fakes/{fake-claude.mjs, fake-query.ts}`, `test/unit/engine/**`, `test/integration/engine/**`, `test/parity/**`, `test/contract/**`.

**Acceptance:**
1. **T-P1:** an options snapshot for {new, resume, fork, rewind} × {default, non-default profile} × {bypass off, on} equals `test/parity/options.snapshot.json`.
2. **T-P2:** `fake-claude.mjs` behind the **real SDK** records argv, env **names** and `initialize`. It asserts:
   - flags `--setting-sources=user,project,local`, `--permission-mode <m>`, `--permission-prompt-tool stdio`, `--include-partial-messages`;
   - `--settings` only for non-default profiles; no `--model` / `--effort` unless chosen;
   - `--session-id` for new chats; `--resume=<path> --fork-session` for forks;
   - no leaked env names, exactly one `Path`, `CLAUDE_CONFIG_DIR` absent for the default profile, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`.
3. **Integration (real SDK + fake CLI):**
   - allow / deny (verbatim message);
   - interrupt during an ask (the callback returns `null`, `askEnd cancelled`, `aborted_tools`) and during streaming;
   - fold / `'later'` / cancel → delivery states (`folded` from `user_message_uuids`);
   - live rename frame; mode echo;
   - crash with a pending ask (`askEnd crash`, deliveries `returned`);
   - init timeout; `close()` on a CLI that ignores EOF (process gone ≤ 3 s after `q.close()`);
   - crash breaker; first-decision-wins; external holder blocks unless `force`;
   - `conversation_reset` → `sessionChanged`; a CLI-chosen fork id → `sessionChanged`;
   - `send` duplicate uuid.
4. **Pool (fake clock):**
   - eviction classes 1–4 in order; `recacheTokens`;
   - the protected set is never reaped or evicted; a pre-spawn never evicts a warm cache;
   - the low-memory freeze;
   - **at most one timer armed**; `grep -r setInterval src/server` is empty.
5. **Spawner:**
   - in `job` mode a fake-CLI-launched `bash -c "node -e 'setInterval(()=>{},1e9)' &"` grandchild dies on sleep and on host kill;
   - in `plain` mode `taskkill /T` kills it while the tree is linked;
   - a jobrun spawn error falls back to `plain`;
   - `run\children.json` is correct; `ownPids()` includes both pids;
   - **`jobrun.exe` private memory measured** (≤ 15 MB, else the default becomes `plain`).
6. **Contract K1–K7** (`npm run test:contract`, real `claude.exe`, logged-out temporary profile, **0 tokens**):
   - K1 our exact flags initialize;
   - K2 the `initializationResult` / `system:init` key sets match a stored snapshot (drift → warning);
   - K3 a hook grandchild dies under `jobrun`;
   - K4 a logged-out prompt maps to the auth signal;
   - K5 registry entries appear and disappear, and our pids are excluded;
   - K6 the CLI exits on `input.end()` within 8 s;
   - K7 K1–K6 also pass with the bundled binary when present.
7. **T-P3** (0 subscription tokens): a mock Messages API (re-implemented from the parity probe), a temporary config without credentials, and test-only env injection **inside the test** (never reachable from production code).
   - **(Decided after the first real measurement.)** The parity reference is Claude Code acting as a host that answers permission prompts: the interactive TUI, or `claude.exe -p --output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio`. The app body must equal that lane's body in the same cwd, except the billing header line and the known Bash/PowerShell/Monitor timeout text. Versus plain headless `claude -p` the app adds exactly the 3 interaction tools (AskUserQuestion, EnterPlanMode, ExitPlanMode; deferred behind ToolSearch under OAuth) and `thinking.display: updates`; the test asserts exactly this delta set and nothing else.
   - Exactly **one** `/v1/messages` per app turn.
   - The same with and without `perTaskStopAffordance` / `enableFileCheckpointing` / `onElicitation`. If a body differs, drop that option and update T-P1 (§2.2).
8. **T-P4:** the `auxTokens` sentinel flags a recorded B1-style title call and is 0 on plain fixtures.
9. **Smoke** (manual, budget §12.5): S1–S5 pass.

**Verify:** `npm run check && node --test "test/unit/engine/**/*.test.ts" && node --test "test/integration/engine/**/*.test.ts" && npm run test:parity && npm run test:contract`; smoke (PowerShell): `$env:SMC_SMOKE='1'; npm run smoke`

### 11.B Model (pure)

**Files:** `src/server/model/*`, `test/unit/model/**`.

**Acceptance:**
1. **Golden replays:**
   - main fixture → A `completed`, B `folded`, C `completed`, D `cancelled`; mode trail `default › acceptEdits › default`; title `LIVE-TITLE`;
   - plan fixture → plan card text from `input.plan` (not the stale assistant copy); `plan.modelBadge` on Sonnet blocks;
   - fork fixture → a session-id change.
2. **"Live = reload":** for every `pairs/<name>`, the turns built from the live frames equal `diskToTurns(transcript)` on ids, kinds, texts, statuses and tool summaries.
3. No `originalFile`, base64 or thinking text appears in any emitted event or page; outputs are cut to head + tail of 4 KB.
4. A random-frame fuzz (10⁴ frames, unknown types and subtypes) never throws.
5. `chat-state` covers every row of ux §4.2, table-driven.
6. **Accounting:**
   - `auxTokens` is 0 on plain fixtures;
   - cost Δ with the `cost-state` baseline;
   - context from `message_start`; TTL detection 5 min / 1 h;
   - cache-miss rule; `wakeEstimate` table.
7. `deriveTitle` / `activityLine` tables, including `@mentions`, `/commands`, 60-char cut and French ellipsis.
8. `step()` takes < 50 µs per delta frame (bench).

**Verify:** `npm run check && node --test "test/unit/model/**/*.test.ts"`

### 11.C Claude data

**Files:** `src/server/claude/*`, `test/fixtures/transcripts/**`, `test/unit/claude/**`.

**Acceptance:**
1. **`tmp-profile` matrix:** connected / disconnected / incoherent / credman / phantom `~\.claude\.claude.json`; plan labels; duplicates; excludes with the exact case and `/`, never on the default profile; `trustedInCli` normalisation (`\` vs `/`, case).
2. **Oracle (opt-in):** the index equals SDK `listSessions` / `getSessionInfo` on the fixture profiles (summary, customTitle, firstPrompt, cwd, createdAt, gitBranch).
3. **Index speed:** 110 files in < 400 ms cold, < 60 ms from the cache. `updatedAt` ignores trailing metadata lines.
4. **Reader:**
   - synthetic 80 MB file: last 30 turns in < 150 ms;
   - a 12 MB last line; branches → latest leaf; compaction relink; a truncated last line is tolerated;
   - `search` never blocks the loop more than 8 ms and is abortable.
5. **Watchers:** react in < 500 ms; an 8.3 path throws **before** `fs.watch`; a `null` filename → rescan.
6. **Registry:** a stale file with a dead pid is ignored; own pids are excluded; an fs spy proves `*.key` is never opened.
7. **SdkHelpers:** 20 interleaved cross-account renames → 0 mix-ups; `process.env` restored.
8. **LoginService** against a fake `claude.mjs auth login` (prints the URL, waits for a code, prints `Login successful.`): `url → waiting → done`; the error path; `cancel` kills it.
9. **fs spy:** no app write under any profile dir; no content read of `.credentials.json`.

**Verify:** `npm run check && node --test "test/unit/claude/**/*.test.ts"`

### 11.D Server shell, security and platform (integrates 11.A, 11.B and 11.C through their contracts)

**Files:** `src/server/main.ts`, `http/*`, `ws/*`, `app/*`, `platform/*`, `launcher/SidMultiClaude.cs`, `scripts/{install.ps1, vendor-audit.mjs}`, `assets/*`, `test/fakes/fake-engine.ts`, `test/unit/server/**`, `test/integration/server/**`, `test/e2e/security.e2e.ts`.

**Acceptance:**
1. **Guard:** platform's 6 HTTP + 7 WebSocket cases; header snapshot (S4).
2. **Hub:**
   - contiguous `seq`, `snap` before `ev`;
   - ≤ 20 `delta`-carrying frames per second per chat, sent only to viewers;
   - backpressure → stale → `snap`; close at 32 MiB.
3. **Validators:** a 10⁴-message fuzz never throws and gives exactly one ack per id; unknown fields are rejected.
4. **Commands** (fake engine, fake stores): every row of §6.3, including:
   - the cap retry with `evict` / `exceed`;
   - `untrusted`, the S9 errors, first-wins decide;
   - the re-key flow, outbox `duplicate`, and the title rename on the first `delivered`.
5. **MetaStore:** kill mid-write → previous file valid.
6. **Lifetime (fake clock):** exits only under C13; reopens the window on an ask with no connection.
7. **Boot and idle:** listening in < 400 ms (fake engine); 30 s idle < 5 ms CPU; no `setInterval`; no `shell:` option anywhere (grep).
8. **Platform:**
   - `confine` 15 cases; the S9 table;
   - `terminalCommand`: `-EncodedCommand` round-trip; no `CLAUDE_CONFIG_DIR` for the default profile; `;` refused;
   - `openExternal` scheme check; port fallback; pipe hand-off < 200 ms.
9. **Launcher and supervisor:** 0 console windows; restarts ≤ 3 per 60 s; exit code 0 stops it.
10. **`vendor-audit`:** the static allow-list equals the import graph.

**Verify:** `npm run check && node --test "test/unit/server/**/*.test.ts" && node --test "test/integration/server/**/*.test.ts" && npm run vendor-audit && node --test test/e2e/security.e2e.ts`

### 11.E Web shell and store (uses `mock-server.mjs`)

**Files:** `src/web/{index.html, main.js, net.js, store.js, apply.js, actions.js, derived.js}`, `lib/{keymap, i18n, fmt, fuzzy, notify, favicon, sound}.js`, `i18n/fr-shell.js`, `components/{shell, dialogs}/*`, `styles/shell.css`, `test/fakes/mock-server.mjs`, `test/unit/web-shell/**`, `test/e2e/shell.e2e.ts`.

**Acceptance:**
1. Web `tsc` clean; `apply`, `derived`, `fuzzy` and `keymap` unit-tested in Node.
2. `hello` → paint < 300 ms with 200 chats; 1,000 sidebar rows < 50 ms; virtualisation above 300.
3. *À traiter* ordering and `Alt+A`; `Ctrl+K` prefixes; tabs and layouts; `Alt+1…9` on `event.code` with AZERTY `key` values; Peek (`Espace`) with hover prefetch.
4. Reconnect: same `boot` → `view` + snaps with no duplicates; new `boot` → caches dropped, unacknowledged sends returned to the composer.
5. Notification rules (looking matrix, tags, DND), window title and favicon ≤ 1/s.
6. Dialogs: NewChat (S9 errors, trust), Resume, Accounts + Login steps, Settings, Orphans, Quit.
7. `fuzzy.js` passes platform's accent cases; every string comes from `i18n`.

**Verify:** `npm run check && node --test "test/unit/web-shell/**/*.test.ts" && node --test test/e2e/shell.e2e.ts`

### 11.F Chat surface (uses a stub store that implements `contract.d.ts`, plus the protocol fixtures)

**Files:** `components/{chat, dock, composer, side}/*`, `lib/{stream-md, diff, highlight}.js`, `i18n/fr-chat.js`, `styles/chat.css`, `test/unit/web-chat/**`, `test/e2e/chat.e2e.ts`.

**Acceptance:**
1. **Streaming:** settled + tail with no visual jump; 4 panes at 20 frames/s each → input latency < 16 ms, no long task > 50 ms.
2. **Dock:**
   - permission keys, including `defaultToNo` and the `←`/`→` scope;
   - Edit/Write LCS diff + *Modifier avant d'accepter*;
   - question form (multi-select, *Autre*, free text, skip);
   - plan card from `ask.plan` + model badge; elicitation card;
   - withdrawal (*Demande annulée*); `not_pending`.
3. **Queue chips** follow delivery states, including `folded` and `returned`; `↑` take-back; `Alt+Entrée`; `Ctrl+Entrée` capability gating.
4. **Tool cards** from lite results; `structuredPatch` diffs; lazy `detail`; error boundaries.
5. **Transcript:** paging and anchors; the 150-turn mount cap; stick to the bottom within 48 px; `Ctrl+F` through `tx.search`.
6. **Composer:** slash palette from `meta.commands` (local badges, terminal-only commands hidden); `@` mentions; image paste chips.
7. **Dialogs:** Rewind, ContinueOn, Wake, ModelSwitchConfirm, CapChoice.
8. The 11 XSS payloads are inert through `md.js` and `stream-md.js`.

**Verify:** `npm run check && node --test "test/unit/web-chat/**/*.test.ts" && node --test test/e2e/chat.e2e.ts`

### Release checks

Beyond the automated suites, a release candidate passes:
- T-P3 on the installed `claude.exe` and `npm run test:contract`;
- the budgeted smoke run (≤ 8 requests, §12.5);
- a 10-minute manual Edge checklist: every binding of §9.3 including `Alt+Entrée`, `Alt+A`, `F6`, `F1`, `Ctrl+R`; the notification prompt; the taskbar badge; no console flash from the launcher.

---

## 12. Test plan

### 12.1 Unit (`node --test`, fake `Clock`, < 10 s total)

| Area | Covered |
|---|---|
| Options and parity | Options / env builders |
| Model | Normalisers (golden), chat state, accounting |
| Engine | Pool policy, permission mapping (including the `userSettings` filter) |
| Claude data | Head/tail, chain, reader, index cache |
| Server | Validators, guard, `confine`, S9, `ids`, `json-store`, `fs-guard` |
| Web | Apply/reducers, `fuzzy`, `keymap`, `fmt` (`Intl fr-FR`), `diff` LCS, `stream-md` settling |

### 12.2 Integration (0 tokens)

**(a) In-process `fake-query.ts`.** A `QueryFn` that replays scripted frames and implements every control method (including the runtime-only ones), used for engine + model + hub wiring (the engine, the server shell).

**(b) Real SDK 0.3.293 + `fake-claude.mjs`** (`pathToClaudeCodeExecutable` = the `.mjs` file; the SDK runs it with node (code)). It answers `initialize`, `interrupt`, `can_use_tool`, `cancel_async_message`, `rename_session`, `set_permission_mode`, `get_context_usage` (summary), `stop_task`. Magic prompts:

| Prompt | Behaviour |
|---|---|
| `ECHO:` | Stream the text |
| `ASK:` | Bash ask |
| `WRITE:` | Write ask with `setMode` suggestion |
| `QUESTION:` | AskUserQuestion |
| `PLAN:` | ExitPlanMode with `input.plan` |
| `SLOW:n` | n slow deltas |
| `SLEEP:n` | Background task frames |
| `FOLD` | Exercises fold / `'later'` |
| `ASKCRASH:c` / `CRASH:c` | Crash with or without a pending ask |
| `HANG` / `HANGINIT` | Never ends the turn / never answers `initialize` |
| `RESET` | `conversation_reset` |
| `TITLE` | `session_title_changed` |
| `HOOKS` | Hook frames, plus a hook grandchild for the Job Object tests |

It can append a structure-faithful JSONL to the temp profile, so the "live = reload" check also runs end to end.

**(c) Server integration.** Real hub + validators + orchestrator with `fake-engine.ts` or with (b), WebSocket clients from `test/helpers/ws-client.ts`, and a fault injection test (a throwing handler and a crashing chat never stop the server).

### 12.3 Parity (the engine; 0 subscription tokens)

| Id | Test |
|---|---|
| T-P1 | Options snapshot (§11.A item 1) |
| T-P2 | argv / env / initialize capture through `fake-claude` behind the real SDK |
| T-P3 | Mock Messages API request-body diff, app vs `claude -p`; one request per turn; gates the three (unverified) options |
| T-P4 | `auxTokens` sentinel on recorded frames |

### 12.4 Contract (the engine; real `claude.exe`, logged-out temporary profile, 0 tokens)

K1–K7 as in §11.A item 6. Run them after every Claude Code auto-update; `npm run test:contract` takes ≈ 30 s.

### 12.5 Smoke (manual; real profile; model `haiku`; `scripts/smoke.ts`)

A budget file aborts the run beyond **8 API requests**. Smoke cwds live in a temporary folder, never the project.

| # | Scenario | Requests |
|---|---|---|
| S1 | New chat (no title request in `--debug-file`), live turn 2 (`cache_creation` < 1,500, `cache_read` > 30 k), one `claude -p` in the same cwd: `\|I_app − I_cli\| ≤ 100` (tolerance covers the 3 deferred interaction tools; the measured delta is reported), `auxTokens = 0`, live rename applied | 3 |
| S2 | Interrupt mid-stream: usage 0, process alive | 1 |
| S3 | Write ask allowed with *pour cette session* → `status` frame `acceptEdits`; nothing written to the profile | 1 |
| S4 | Under `jobrun`: Bash with `run_in_background` (`node -e "setInterval(()=>{},1e9)"`), then *Mettre en veille* → the background node process is gone; settles U4 | 1 |
| S5 | `priority:'now'` while streaming → record what happens (settles C17) | 2 |
| S6 (opt-in, +1–2, may bill Sonnet) | Plan approval with the full id `claude-haiku-5-5` → confirms whether it avoids the Sonnet upgrade | — |
| — | `/usage` (local, `num_turns 0`) | 0 |

### 12.6 E2E (`playwright-core@1.63.0`, `chromium.launch({channel:'msedge'})`, headless, temporary user-data dir, `grantPermissions(['notifications'])`)

**Harness (`test/e2e/harness.ts`):** starts the server with `SMC_TEST=1 --data-dir <tmp> --profiles-root <tmp> --print-boot`, reads the boot code from stdout, opens `http://127.0.0.1:<port>/#boot=<code>`.

| Suite | Flows |
|---|---|
| `shell.e2e.ts` | Boot and device-token reload · sidebar, *À traiter*, `Alt+A` · Peek · `Ctrl+K` · tabs and layouts · new chat (S9 refusal, trust) · resume browser · rename · accounts + fake login · settings · reconnect (same boot / new boot) · notification rules |
| `chat.e2e.ts` | Stream · allow / always / deny · question · plan · `Échap` · queue + `↑` + `Alt+Entrée` · 2 panes streaming · sleep and wake · 5th chat → `cap.choice` · crash → *Non envoyé · Renvoyer* · kill the server → supervisor restart → resync, the pending ask reappears · 4-pane performance trace against §9.5 |
| `security.e2e.ts` | Guard cases from a second origin (`127.0.0.1:<port+1>` page): cross-port WebSocket refused, POST refused · XSS payloads · links open through `open` |

### 12.7 Non-functional

| Check | Target |
|---|---|
| Soak: 8 fake chats streaming for 1 h | Server RSS grows < 50 MB; 0 orphans; no leaked timers (`process.getActiveResourcesInfo()`) |
| Idle CPU | Server 0 ms / 30 s; Edge ≤ 1 % on a fresh profile with the lean flags |
| Startup | First paint < 300 ms |
| Large transcript | An 82 MB transcript tail opens in < 150 ms |

---

## 13. Known limitations, follow-ups and open questions

### 13.1 Unverified items in this spec, with the test that settles them

| # | Item | Settled by |
|---|---|---|
| U1 | `perTaskStopAffordance` / `enableFileCheckpointing` / `onElicitation` leave request bodies unchanged | T-P3 (0 tokens) |
| U2 | `sessionId` together with `resume=<.jsonl path>` + `forkSession`; fallback = re-key | the engine fake + contract K1 (flags accepted), then the first real fork |
| U3 | `'now'` priority semantics | Smoke S5 |
| U4 | `jobrun` with the Bash tool's background processes; `jobrun.exe` memory | Smoke S4; the engine measurement |
| U5 | Live-rename timing at the first `delivered` | Fake test + smoke S1 |
| U6 | `apiBlockIndex` coverage for disk block ids (fallback: ordinal) | the model "live = reload" on real-shaped pairs |
| U7 | Folded messages on disk (`attachment:queued_command`) carry the command uuid | the model pairs |
| U8 | Live effort change through `applyFlagSettings({effortLevel})` | 1 haiku call (not budgeted; the UI otherwise applies effort at the next spawn) |
| U9 | `/clear` → `conversation_reset` → new id, and no AI title afterwards | 1 haiku call (not budgeted) |
| U10 | **Continue on another account** replays the source account's `prompt_snapshot` / instructions until the next compaction | Needs two logged-in accounts; the dialog shows a warning until it is verified |
| U11 | `resumeStable` premise for hook-free real profiles | Observation only; it only orders eviction candidates |
| U12 | Edge `--app` reachability of `Alt+Entrée`, `Alt+A`, `F6`, `F1`, `Ctrl+R`, a lone `Alt` tap | Manual keydown checklist (10 min) |
| U13 | `npm install --no-save` of the bundled binary survives later `npm ci` (it probably does not) | `fetch-bundled-cli` re-run on demand; documented |
| U14 | No-op `BROWSER` to stop the CLI opening its own browser during login | Temporary-profile test (0 tokens) |
| U15 | `ExitPlanMode` approve with `editedPlan` is honoured by the CLI | Fake test only; smoke S6 optional |

### 13.2 Known limitations of v1

- **Size of the interactive TUI prompt.** The app equals `claude -p` / SDK requests, not the interactive TUI. The TUI identity line differs, and the TUI makes **more** hidden calls (prompt suggestions, AI titles) (measured).
- **Resume re-caches on profiles whose SessionStart hooks inject run-varying text** (for example organisation plugins), so every new process re-creates ≈ 18 k + history (measured). The terminal pays the same. Only keep-alive avoids it. Lean levers (`disableAllHooks`, connectors off) are deferred to v2 as an explicit *mode économe*.
- **RAM.** ≈ 450 MB private per live chat (measured); with 0.6–2 GB free the cap often freezes, so warm evictions need consent.
- **30-day sweep** of app sessions; the app warns but never writes `cleanupPeriodDays`.
- **App sessions are `sdk-ts`:** hidden from the terminal `/resume` picker, but resumable by id (*Copier la commande*).
- **Two writers:** the app detects terminals and Desktop through the registry; a terminal opened on a live app session while the app is mid-turn can only be detected, not prevented.
- **Runtime-only SDK APIs** (`cancelAsyncMessage`, live `renameSession`, `listPermissionRules`, `usage_EXPERIMENTAL`) are feature-detected with fallbacks: no *Retirer*, offline rename after sleep, no rules panel, usage from the snapshot.
- **Self-compiled `.exe` files** may be blocked by AV or AppLocker on managed machines. Fallbacks: `isolation:'plain'` and `npm start`.
- **Edge idle CPU** on an aged dedicated profile (3.7–9.5 % (measured)). Mitigations: lean flags, Chrome option, reset of `edge-profile`.
- **Not in v1:** automatic resume after a limit; `/btw`; cloud/remote sessions; integrated terminal, editor or preview; worktree UI; diff line comments; branch timeline; board view; MCP Apps widgets; mobile; PWA install; auto-start at logon; *Résumer à partir d'ici*.
- **Never:** automatic account rotation, automatic recaps, LLM-generated titles or summaries made by the app.

### 13.3 Decisions taken on the open questions

1. **Cross-account continuation (U10).** *Continuer sur un autre compte* ships with a warning in its dialog until the replay of the source account's instructions is verified.
2. **Process cap default:** 4 (range 2–8), with the low-memory freeze (§2.8).
3. **Install-time compilation** of `jobrun.exe` and the launcher with the Windows `csc.exe` is optional; without it the app falls back to `isolation:'plain'` and `npm start`.
4. **Organisation accounts:** driving a Team seat from a personal UI is the user's responsibility; they should check with the organisation's administrator (managed settings such as `forceLoginOrgUUID` may apply).
