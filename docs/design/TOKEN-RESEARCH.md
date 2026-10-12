# Recherche sur la parité de tokens (référence de conception, en anglais)

> **Référence de conception d’origine.** Mesures réalisées le 2026-10-08, avant l’implémentation, qui ont fondé les règles de parité de SidMultiClaude ; le document est conservé en anglais et cité par la [spécification](SPEC.md) sous la forme « TOKEN-RESEARCH.md §x ». Les mesures de l’application finale sont dans [PARITE-TOKENS.md](../PARITE-TOKENS.md). Les noms de plugins d’organisation sont anonymisés (*plugin A*, *B*, *C*).

# Token parity: SidMultiClaude vs Claude Code

Measured 2026-10-08. Claude Code 2.1.294 (native) and Agent SDK 0.3.293 (bundles CLI 2.1.293). An organisation (Team) profile, model `haiku` (= claude-haiku-5-5).

## 0. Verdict

1. **The SDK matches the CLI token for token.** The Agent SDK call `query()` with `systemPrompt:{type:'preset',preset:'claude_code'}` and `settingSources:['user','project','local']` sends the same context as `claude -p`:
   - Input: **37,152 vs 37,150 tokens**. The +2 comes from SDK-specific tool text.
   - Same 37 tools, 16 MCP servers, 78 skills, 7 plugins, 8 agents and 116 slash commands.
   - Same model and effort resolution, and the same **1 h** cache TTL.
2. **There is one hidden call, in SDK mode only: `generate_session_title`.** It runs on Haiku and costs 1,174 uncached input tokens plus 15 output tokens, on the first user message of every new session.
   - `claude -p` never makes this call. Interactive Claude Code does (seen in the code path).
   - It can be turned off, and both switches were verified: `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` (real run C) or `options.title` (mock run).
   - Nothing else fired. The debug log shows exactly one `/v1/messages` request per turn otherwise.
3. **The cost driver is how long the process lives, not the SDK.**
   - **Turn 2 in the same live process:** 37,154 tokens read from cache, 81 created, $0.00039.
   - **Same session resumed in a new process 2 minutes later:** 19,277 read, **17,913 re-created**, $0.00378. That is **9.7×** the in-process cost.
   - **Why:** the organisation profile's plugins inject different SessionStart hook text early in the prompt each time a process starts (a unique persisted-output path, a random hook order, and text that changes between runs). So every new process, whether a resume or a new chat, re-creates everything after about 19.3K tokens.
   - **Consequence:** the cost of a resume grows with conversation length, about 16× at 100K tokens and about 20× at 500K.
4. **Policy that follows:**
   - Run one long-lived streaming-input process per active chat. Never use one `query()` per message.
   - Kill an idle process only once its cache is already dead, i.e. 60 min or more after its last API request.
   - Cap live processes with an LRU limit of **4** on this 16 GB laptop. Each one measured 0.21–0.25 GB working set and 0.44–0.46 GB private memory.

## 1. Method
- **Model-call budget: 6 of 6 used.** The real calls were A1, A2, B1, B2, C1 and C2. The title call inside B1 is the hidden call being measured. All used a clean env (all `CLAUDE*`/`ANTHROPIC*` vars stripped, including an inherited `CLAUDE_EFFORT=max`), `CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-pro`, the cwd `<scratch>\parity\cwd`, `--model haiku` and the prompt "Reply with exactly: OK".
- **Evidence sources:**
  - **(a)** `result.usage`, `result.modelUsage`, `total_cost_usd` and `system/init`.
  - **(b)** Claude Code's own debug log via `--debug-file` / `debugFile`. It writes exactly one `[API REQUEST] /v1/messages … source=<querySource>` line per model request.
  - **(c)** The structure of the probe's own transcript (types, lengths and sha1 only).
  - **(d) Zero-cost probes, no subscription use:**
    - A local mock of the Messages API (dummy key, mirror config without credentials) that captures full request bodies.
    - Real-profile SDK sessions that never send a prompt, plus `getContextUsage({detail:'summary'})`. These made 0 API requests (verified in the debug log).
  - **(e)** Static reading of the CLI 2.1.294 bundle.
- **D (SDK defaults) was not sent to the real API.** The last two calls went to C (native exe) as a 2-turn session, because the in-process turn-2 number is what the keep-alive policy depends on. D is quantified from the mock body diff and a zero-call estimate instead.

## 2. Measured table (real API, organisation profile)
| Run | Binary / entrypoint | init: tools / MCP / skills | input | cache_creation (1h / 5m) | cache_read | output | **total input** | requests in debug log | modelUsage models | cost Δ (list) |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | native 2.1.294, `claude -p --output-format json` (sdk-cli) | 37 / 16 / 78 | 2 | 20,362 (20,362 / 0) | 16,786 | 4 | **37,150** | `sdk` | 1 | $0.0042425 |
| A2 | same, +39 s | 37 / 16 / 78 | 2 | 17,871 (17,871 / 0) | 19,273 | 4 | **37,146** | `sdk` | 1 | $0.0037691 |
| B1 | SDK preset+sources, bundled 2.1.293 (sdk-ts) | 37 / 16 / 78 | 2 (+1,174 title) | 20,360 (20,360 / 0) | 16,790 | 4 (+15 title) | **37,152** | `generate_session_title` + `sdk` | 1 | $0.0043670 (main $0.0042421 + title $0.0001249) |
| B2 | B1 resumed in a **new process** (+2 min) | 37 / 16 / 78 | 2 | 17,913 (17,913 / 0) | 19,277 | 4 | **37,192** | `sdk` | 1 | $0.0037776 |
| C1 | SDK preset+sources, **native 2.1.294** exe, title off, no persist | 37 / 16 / 78 | 2 | 17,877 (17,877 / 0) | 19,277 | 44 | **37,156** | `sdk` | 1 | $0.0037904 |
| C2 | same process, turn 2 | – | 2 | **81** (81 / 0) | **37,154** | 4 | 37,237 | `sdk` | 1 | **$0.0003899** |
| D | SDK defaults (no preset, settingSources omitted) | not sent | – | – | – | – | zero-call estimate 26,879 vs 29,855 for the preset (−2,976 = system prompt 3,117 → 141) | mock: title + sdk | – | – |

- **Prices** implied by `costUSD` (the CLI's list table for claude-haiku-5-5): $0.10/M input, $0.50/M output, $0.20/M for a 1h cache write, $0.01/M for a cache read. A1 reproduces to the 8th decimal.
- **modelUsage includes the title call.** In B1, `modelUsage.inputTokens` = 1,176 while `usage.input_tokens` = 2, and output is 19 vs 4. The d.ts comment says helper calls are excluded, but here they are not.
- **On resume, modelUsage and cost continue from the transcript's `cost-state`** (B2 is cumulative). Per-turn accounting must therefore use the delta between consecutive `result` messages.
- Timings:
  - CLI -p wall time: 4.6 s and 4.0 s.
  - SDK first result 1.0–1.9 s after send. SessionStart hooks finish about 0.4 s after spawn, and the process is ready after about 2–3 s.

### Where the 37.15K tokens go
Breakdown from `getContextUsage` after B1. It sums exactly to the API total.

| Component | Tokens | Notes |
|---|---|---|
| System prompt | 3,117 | |
| Built-in tools (loaded) | 12,304 | 21,767 more are deferred behind ToolSearch and not sent |
| MCP server instructions | 631 | Claude Docs connector |
| MCP tools | 0 sent | 8 tools, 2,615 tokens deferred |
| Custom agents | 291 | 3 `plugin-a:*` |
| Memory files | 134 | `.claude-pro\CLAUDE.md` = 28; `%USERPROFILE%\.claude\CLAUDE.md` loaded as "Project" by ancestor lookup = 106 |
| Skills listing | 9,945 | 76 skills |
| Messages | 10,730 | SessionStart hook context from the plugin A / plugin B (about 6.4K, estimate), env/model/agents/deferred-tools/date attachments, CLAUDE.md and attribution reminders, prompt |

### Memory (working set / private, MB, measured with CIM)
| Process | Idle (initialized, no prompt) | After 1–2 turns |
|---|---|---|
| SDK child, bundled 2.1.293 (B1) | 206 / 442 | 229–233 / 452–459 |
| SDK child, bundled, resumed (B2) | 218 / 451 | 239 / 459 |
| SDK child, native 2.1.294 (C) | 222 / 438 | 240–243 / 448–449 |
| `claude -p` native (A1/A2, mid-run) | – | 244–248 / 459–462 |
| Mock profile (no connectors, plugins or synced skills) | 140–176 / 270–361 | 185–208 / 353–379 |

- Each child also has a `conhost.exe` of about 8 MB.
- **Bundled and native perform the same.** They are the same Bun build, 256,155,808 bytes each.
- Interactive sessions already alive on this machine use 200–630 MB WS and up to 866 MB private, because memory grows with the session.
- Machine: 15.7 GB RAM, i7-1255U. Only 2 GB was free during the test, with 20 claude.exe processes alive.

## 3. Every difference explained (CLI `-p` vs SDK preset vs SDK defaults)
1. **System prompt: identical for `-p` and the SDK preset.**
   - Both send the identity line "You are a Claude agent, built on Anthropic's Claude Agent SDK." plus the 8,728-char Claude Code prompt (mock bodies).
   - Interactive Claude Code uses "You are Claude Code, Anthropic's official CLI for Claude." instead. Its tokens were not measured.
   - SDK defaults (D) keep only the billing header and the identity line (−3.1K tokens). Everything else stays: tools, skills, hooks, CLAUDE.md, env block, MCP.
   - This is because in SDK 0.3.x an omitted `settingSources` means **all** sources (d.ts, plus a zero-call probe showing memory files and hooks loaded). That default changed since 0.1.x, so always pass it explicitly.
2. **Billing header block** (`system[0]`, uncached, 73–74 chars): `cc_version=<ver>.<hash>; cc_entrypoint=sdk-cli|sdk-ts`. It has no cache effect: C1 (2.1.294) read 19,277 tokens cached by B (2.1.293).
3. **Tools: the same 37 in `init`.**
   - The list: Task(=Agent), Bash, PowerShell, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch, Skill, ToolSearch, Workflow, Monitor, Cron×3, Enter/ExitWorktree, DesignSync, ListAgents, SendMessage, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, ShareOnboardingGuide, TaskStop, NotebookEdit, and 8 `mcp__claude_ai_Claude_Docs__*`.
   - **Entrypoint-specific text:**
     - Bash/PowerShell default timeout: SDK (`sdk-ts`) 1,800,000 ms (30 min) vs `-p` 600,000 ms (10 min).
     - Monitor max: 30 min vs 10 min.
     - Cost: +2 tokens.
   - **Cache effect:** the byte prefix differs, so `-p` sessions and SDK sessions keep separate cache entries.
   - **Latched per session:** in the mock (R3), a `-p --resume` of an SDK session kept the SDK text.
   - With an API key and a custom base URL, the mock showed only 26 tools, all inline (79.6K chars). First-party OAuth turns ToolSearch on (`[ToolSearch:optimistic] mode=tst`).
4. **CLAUDE.md: identical.** The SDK needs `'project'` in `settingSources` to load it.
   - Known issue confirmed: the default profile's global CLAUDE.md is injected as Project memory in the other profile (106 tokens per request, and contradictory instructions).
   - App-side fix, verified with a zero-call probe and no config edit: pass `settings:{claudeMdExcludes:['%USERPROFILE%/.claude/CLAUDE.md']}`. Memory files become `User:28` only.
5. **MCP: the same 16 claude.ai connectors in both** (1 connected, 15 needs-auth).
   - They come from the OAuth account, so even `settingSources:[]` keeps them. `ENABLE_CLAUDEAI_MCP_SERVERS=false` removes them.
   - Claude Code already removes plugin MCP servers that duplicate a connector. The debug log says "Lazy dedup: suppressing plugin:<plugin>:<server>".
6. **Skills, plugins, agents, slash commands: identical.**
   - 78 skills: bundled ones, 13 org-synced `anthropic-skills:*`, and 46 from three plugins (33, 7 and 6).
   - 7 plugins: 3 org-synced plus 4 built-in `cc-plugin-*`.
   - 8 agents and 116 slash commands. `/compact`, `/clear`, `/context`, `/usage`, `/effort`, `/model`, `/rename` and `/autocompact` are available to the SDK.
7. **Version 2.1.293 vs 2.1.294:** the request bodies are identical except for the billing header (mock M2 vs M3).
8. **Model and effort: both inherit `settings.json` the same way when `model`/`effort` are omitted.**
   - Mock T1/T3/T4/T5: `claude-opus-5-5`, `output_config.effort:"xhigh"`, thinking adaptive with display "updates", `max_tokens` 128000.
   - With `--model haiku`, both send effort "medium".
   - An inherited `CLAUDE_EFFORT` (for example `=max` in the parent shell) would silently override this. Strip it.
9. **Persistence is token-neutral.** `--no-session-persistence` and `persistSession:false` produce byte-identical bodies (mock M1 vs M5, M2 vs M6).
10. **The hidden title call happens in the SDK only** (section 4).

## 4. Hidden or background model calls
**What the evidence shows:**
- **`claude -p` (A1, A2):** one request per turn with `source=sdk`.
  - In the code, `RFo()` disables titles when `CLAUDE_CODE_ENTRYPOINT==='sdk-cli'` and there is no `CLAUDE_AGENT_SDK_VERSION` (flag `tengu_quizzical_thimble`, default true).
- **SDK with defaults (B1):** `source=generate_session_title`, then `source=sdk`.
  - The title is stored as an `ai-title` transcript entry.
  - When it fires: on the first real user message of 10 characters or more, in a session with no title and no messages yet.
  - It **still fires with `persistSession:false`** (mock M6).
  - It does not fire on resume (B2).
  - Model: the small/fast model, which is Haiku on first-party. With a custom `ANTHROPIC_BASE_URL` the code falls back to the **main** model, and the mock showed an **Opus** title call.
- **Turning it off:**
  - `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`: real C1/C2 showed no title request.
  - `options.title`: mock T2.
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` also disables it (code), but has wider side effects, so it is not recommended.
- **No other model traffic in any real log.**
  - Only `/v1/messages`. No count_tokens, no quota probe, no warmup.
  - Non-model traffic: `/v1/mcp_servers`, mcp-proxy, `/api/event_logging` (telemetry), and `HEAD /api/hello` at start.

**Other background query sources found in the binary, with their gates.** None of them fired in the runs.

| querySource | Gate |
|---|---|
| `prompt_suggestion` | SDK: only with `promptSuggestions:true`. Interactive: on by default (`tengu_prompt_suggestion=true`) |
| `agent_summary` | `agentProgressSummaries:true` |
| `tool_use_summary_generation` | only `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` |
| `model_validation` | `max_tokens:1` "Hi" probe, only for model strings not in the known aliases/list |
| `compact` | auto or manual compaction |
| `auto_mode` / `agent_classifier` | permission mode `auto`: one classifier call per action |
| `web_fetch_apply` | WebFetch tool |
| `side_question` | `askSideQuestion()` |
| `generate_session_title` | also via the `generateSessionTitle()` control |
| `away_summary`, `extract_memories`, `auto_dream`, `memdir_relevance` | REPL and auto-memory features |
| `hook_prompt` / `hook_agent` | prompt-type hooks |

## 5. Prompt cache behavior
**TTL is 1 hour on this subscription.**
- All 6 main-loop requests show `ephemeral_1h_input_tokens` = creation and `ephemeral_5m_input_tokens` = 0.
- The cached flag `tengu_prompt_cache_1h_config.allowlist` = [`repl_main_thread*`, `sdk`, `auto_mode`, `rolling_compact`, `memdir_relevance`, `agent_classifier`, `prompt_suggestion`, `away_summary`, `extract_memories`]. So the interactive main thread and the `-p`/SDK main thread both get 1h.
- The title helper uses `enablePromptCaching:false`, so it is never cached.
- `CLAUDE_CODE_PROMPT_CACHE_TTL` can override the TTL. Do not set it.
- A 1h write costs 2× the input price, which the CLI pays too.

**Reuse layers that were measured:**
- **About 16.8K tokens, independent of cwd.** A1 and B1 got cache hits on their very first call. The likely source (inferred) is earlier calls from sibling probes in other cwds within the hour.
- **About 19.27K tokens, same cwd but a different process.** This held for a new chat (A2), a resume (B2) and a version change (C1).
- **Everything, in the same process.** C2: 37,154 read, 81 created.

**What a restart plus resume keeps byte-identical.** This was checked in the mock with no hook plugins, and the prefix came out identical:
- The system prompt snapshot (`prompt_snapshot` attachment, which the CLI default `--system-prompt-snapshot on` reuses until compaction).
- The env, model, agents, skills and date attachments, replayed from their stored `rendered` text.
- **Git status**: it sits in the first user message as a frozen "snapshot at start". In mock G1/G2 a commit and an untracked file were added between runs, and the prefix stayed identical.
- The tool order and the per-session tool-text variant.
- MCP tools: they are deferred, and changes arrive as appended `*_delta` attachments.
- The date is a stored attachment. A day change appends a new reminder rather than rewriting the prefix (inferred from the attachment design, not observed).

**What breaks it in the organisation profile: its plugins' SessionStart hooks** (startup, resume, clear and compact).
- **(1) A unique file path on every start.** The plugin A hook prints 10,845 bytes. That is over the inline limit, so it is persisted to `.claude-pro\projects\<cwd>\<session>\tool-results\hook-<random-uuid>-stdout.txt` and the context carries that unique path.
  - There are 10 byte-identical outputs (same sha1) under 10 different paths.
  - The B1/B2 session has two of them, from start-up at 11:55:36 and from resume at 11:57:02.
- **(2) Random hook order.** The hooks finish in a different order each time: A1 ran plugin A → plugin B → plugin C, A2 ran plugin B → plugin A → plugin C.
- **(3) Text that changes between runs.** Plugin B prints a one-time statusline notice. With the same plugins, mock sessions H1 and H2 diverge at char 5,265 of the hook block.
- **Why this is expensive.** The block sits right after the first user prompt, so everything after it is re-created on every new process. Without these hooks, the SDK resume in the mock (H4/H5) was byte-identical.
- **Cost model for one turn with context T:**
  - Live process: about 0.1·T + 2·Δ.
  - New process: about 0.1·19.3K + 2·(T − 19.3K).
  - Results: T=37K gives $0.00039 vs $0.00378 (9.7×), T=100K about 16×, T=500K about 20×.
- **Also deliberate breaks, same as in the CLI:** changing model, effort, thinking settings or betas mid-session. Claude Code's own cache-break detector lists `model_changed`, `effort_changed`, `thinking_mode_changed` and `betas_changed`, and the cache is per model.

## 6. Keep-alive and reaping policy
- **Keep each chat's process alive until 60 min after its last API request.**
  - After that the cache is dead, so keeping the process costs the same as resuming it, apart from the re-injected hooks.
  - Check every 60 s. Never kill a process that has a turn in flight, a pending permission, a running background task or a pending queued message.
- **Cap live processes at 4 by default** (configurable from 2 to 8).
  - At start this is about 1 GB working set and 1.8 GB commit, and it grows with history.
  - If free RAM drops below 1.5 GB, lower the effective cap.
- **When over the cap, evict the idle process with the oldest last API request** (the coldest cache, which is cheapest to lose).
  - If all candidates are still warm, warn first, in French: « Reprendre cette conversation recréera ≈ N k tokens de cache ». Use N = context − 19K.
- **Spawn lazily when a chat is opened or focused.** This costs zero tokens (no-prompt probes made 0 requests) and hides the 2–3 s start-up. Never send warm-up or keep-alive pings: they burn tokens, and pinging only to refresh the TTL is still a model call.
- **Use one cwd per account for quick chats.** New chats in the same cwd reuse about 19.3K tokens; across cwds about 16.8K. Caches are per org/account and never shared between accounts.

## 7. Rules the app must follow for parity
1. **Engine:** Agent SDK `query()` in **streaming-input mode** (AsyncIterable), with one live child per active chat. Never a string prompt or a new `query()` per message, which is a resume every turn at ≈10× the cost.
2. Always pass `systemPrompt:{type:'preset',preset:'claude_code'}` and **explicitly** `settingSources:['user','project','local']`.
3. **Omit** `model`, `effort`, `thinking`/`maxThinkingTokens`, `tools`, `allowedTools`/`disallowedTools`, `appendSystemPrompt`, `agents`, `mcpServers`, `plugins`, `skills` and `betas` unless the user chooses them explicitly. Each one changes the request (tokens and cache) compared with the terminal.
4. If a model picker exists, pass CLI aliases (`opus`/`sonnet`/`haiku`/`fable`) or known ids. Unknown strings trigger the `model_validation` probe. Apply model or effort changes at spawn. Mid-chat `setModel`/effort changes rebuild the cache, as `/model` does in the CLI, so warn in the UI.
5. **Clean env per account.** `options.env` *replaces* the whole env. Build it from a whitelist (PATH, SYSTEMROOT, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP/TMP, HOME…) plus `CLAUDE_CONFIG_DIR=<account dir>`.
   - Strip `CLAUDECODE` and `CLAUDE_CODE_*`. An inherited `CLAUDE_CODE_ENTRYPOINT` is kept as-is, because the SDK only sets `sdk-ts` when it is absent.
   - Strip `CLAUDE_EFFORT` (it overrides effort), `CLAUDE_PID`, `CLAUDE_CODE_MESSAGING_*`, and **`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`**. An API key would switch billing away from the subscription, and a base URL changes features.
6. **No model call made by the app itself**: no LLM titles, summaries, warmups, classifiers or "side" `claude -p` runs. A single `claude -p` here costs a full context of about 37K tokens, 20K of them created.
7. **Disable the CLI's AI title by default** with `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, or pass `title` = a local title from the first prompt. This also writes a `custom-title` that `claude --resume` shows. Optional toggle "Titres IA (comme Claude Code)".
8. Keep `promptSuggestions` and `agentProgressSummaries` false (the SDK default). Do not call `generateSessionTitle()`, `askSideQuestion()` or `getContextUsage({detail:'full'})`, which uses the token-count API. Use `detail:'summary'`.
9. Use permission mode `default` with `canUseTool`. `auto` adds a classifier model call per action. Offer it only as an explicit choice, as in the CLI.
10. **Avoid needless process churn.** No restart to apply settings: use the control requests (`setPermissionMode` and so on). No `forkSession`/`resumeSessionAt` except on user request. Never two processes on the same session.
11. **Compaction:** leave auto-compact to the CLI. It is on, with threshold = window − 33K buffer (967K on Haiku 5.5 1M). For manual compaction send `/compact` as a user message. Show `compact_boundary`. Never trigger compaction automatically from the app.
12. **Accounting and quota with no calls:** use `modelUsage` deltas between consecutive `result` messages (cumulative and carried over on resume), `rate_limit_event` messages (already in the stream), and `getContextUsage({detail:'summary'})` for the context gauge.
13. **History and titles come from Claude's JSONL** (`ai-title`, `custom-title`, `cost-state`, `prompt_snapshot`). The app stores only light metadata.
14. **Executable:** default to the user's native install via `pathToClaudeCodeExecutable` (verified in run C). It is the same version as the terminal, needs no 256 MB duplicate, and gives identical requests. Keep the bundled binary as a fallback, and watch for SDK/CLI protocol drift after auto-updates.
15. Never add app MCP servers, hooks that return `additionalContext`, or agents in parity mode. Each adds tokens to every turn.
16. Show each account's baseline context, from the zero-call `getContextUsage` summary, so plugin, skill and connector bloat is visible. Profiles differ a lot.

## 8. Lean mode: optional levers that go below Claude Code
| Lever | How | Saving | Trade-off | Status |
|---|---|---|---|---|
| No AI title | `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` or `title` | 1 request, 1,174 input + 15 output tokens per new chat | No AI titles | **measured** |
| Fix foreign CLAUDE.md | `settings:{claudeMdExcludes:['%USERPROFILE%/.claude/CLAUDE.md']}` | 106 tokens per request, removes contradictory instructions | None (it is a fix) | verified, 0-call |
| Plugin hooks off | `settings:{disableAllHooks:true}` (or disable plugin A/plugin B per plugin, which needs the admin or plugin ids) | about 2.7K–6.4K per start, **plus resume and new chats become cache-stable**, avoiding about 18K+history re-creation | Lose org plugin behavior and **all** user hooks, including any guard hooks | estimate; cache effect inferred from the mock |
| claude.ai connectors off | `ENABLE_CLAUDEAI_MCP_SERVERS=false` | about 1.5K per request, less network traffic | No Docs/Gmail/… tools | estimate |
| Trim skills via plugins | Disable unneeded plugins (plugin A has 33 skills) | Part of the 9.9K skills listing per request | Model can't use them | estimate |
| **Do NOT** use `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` or `skills:[]` | – | **+8.4K (est.)**: the Workflow tool then inlines its 17K-char authoring guide, mock T6 79,625 → 96,580 chars | – | measured in the mock |
| Restrict tools | `disallowedTools`/`tools` (for example Workflow, DesignSync, Monitor, Cron×3, ScheduleWakeup, SendMessage/ListAgents, Worktree×2, PushNotification, ReportFindings, PowerShell or Bash) | Up to several K of the 12.3K loaded; many are already deferred | Fewer capabilities; separate cache from terminal sessions | estimate |
| Earlier auto-compact | `extraArgs:{autocompact:'200k'}` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Caps per-turn cache reads in long chats (window 1M → up to 967K read per turn) | Summary call and lost detail | design |
| Cheaper model or effort per chat | `model`/`effort` at spawn | Usually the biggest lever, on output and thinking tokens | Quality | – |
| SDK defaults (no preset) / `settingSources:[]` | – | −3.1K / about −3K | Loses Claude Code behavior or user config. **Not recommended** | estimate |
| `excludeDynamicSections` | – | 0 tokens; only cross-cwd sharing | Changes the layout compared with the CLI | not useful |

## 9. Side effects and artifacts
- **Files written into the profile by the CLI itself during the probes.** None were deleted, because config dirs are treated as read-only.
  - The probe transcript `projects\<encoded cwd>\<sessionId>.jsonl` (B1+B2).
  - `…\<sessionId>\tool-results\hook-*-stdout.txt` for 11 sessions. These are written even for non-persisted runs and zero-call probes.
  - `session-env\<sessionId>\sessionstart-hook-*.sh`, the `memory\` dir, `.claude.json` bookkeeping, and `cache\model-catalog\…json`.
  - **Note:** the app's "non-persistent" sessions still leave these hook artifacts.
- **Probe material** (not part of this repository): a harness, a zero-call context probe, a mock Messages API with its captured request bodies, and sanitized run logs (no token-like strings found).
