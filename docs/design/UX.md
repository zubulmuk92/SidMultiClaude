# Spécification UX (référence détaillée, en anglais)

> **Référence de conception d’origine.** Ce document est la spécification UX rédigée avant l’implémentation de SidMultiClaude ; il est conservé en anglais, les textes d’interface y sont en français. Le code y renvoie sous la forme « ux §x.y » : la numérotation des sections est donc figée. La [spécification d’architecture](SPEC.md) (§9) précise les changements apportés ensuite ; en cas d’écart, le code et les tests font foi.

# SidMultiClaude: UX specification v1.1

**Scope:** a multi-account, multi-chat Claude Code UI that is very interactive and keyboard-friendly, and stays light.
**Date / budget:** 2026-10-08. No model call was used. Sources: web research, the `@anthropic-ai/claude-agent-sdk@0.3.293` type declarations (`sdk.d.ts`, `sdk-tools.d.ts`), `claude --help` / `claude auth --help` (CLI 2.1.294, clean env), and local measurements of the SDK, the on-disk data and the token behaviour.
**Writing convention:** prose is in English for the engineers. **Every UI string is in French, exactly as it should appear.**
**Evidence markers:** *(verified)*: official docs, SDK types, CLI help or a local measurement · *(unverified)*: still to verify (see §17). Unmarked statements are design decisions.
**Revision 1.1 (same day):** cross-checked against the on-disk data research (registry, `oauthAccount`, retention, login), the token measurements ([TOKEN-RESEARCH.md](TOKEN-RESEARCH.md)), the platform probes, the official *Manage sessions* and *cloud sessions* docs, and a WCAG contrast script. Every correction and addition is listed in §18; sections not listed there are unchanged.

---

## 0. Decisions in one page

1. **Layout.** One Edge `--app` window with three zones.
   - A sidebar holding three sections: *À traiter*, *Épinglés*, and a tree of accounts › folders › chats.
   - A tab strip of open chats.
   - A grid of 1 to 4 panes.
   - **A tab is only a view.** Closing a tab never stops Claude. Opening a tab does not start a process either. The process starts when you begin typing in a sleeping chat, which costs 0 tokens and hides the 2–3 s start-up. Otherwise it starts on send. A process that never sent a request is stopped after 10 min, because it has no cache to lose (§4.2).
2. **One state per chat.** It comes from a 9-state machine plus flags (§4). The same glyph and colour show it everywhere: sidebar row, tab, pane header, window title, favicon, OS notification and sound.
3. **"Claude needs you" is the main signal.**
   - The *À traiter* section is always present.
   - `Alt+A` jumps to the oldest pending permission, question or plan, whichever account it belongs to. This is the Agent View pattern.
   - Pending cards are docked above the composer, so they never scroll away.
4. **An account is never shown by colour alone.** It always shows a colour, a monogram and a name, in these places: sidebar, tab, pane header, composer placeholder (« Écrire à Claude (Entreprise)… ») and send button (« Envoyer · E »).
5. **Token transparency costs no tokens.** The UI shows:
   - a context gauge;
   - a prompt-cache clock (1 h TTL on a subscription);
   - a cache-hit line on each turn;
   - a confirmation before actions that break the cache (model switch, effort change on older models, MCP toggles, continuing on another account);
   - a wake-up cost hint on chats that are asleep: about the last context minus the ~19 k prefix that new processes share (§7.8);
   - the CLI's own choice when a chat over 100 k tokens wakes up with an expired cache: *Reprendre depuis un résumé* or *Reprendre tel quel* (§7.8).
6. **The app never calls a model on its own.**
   - Titles are built from the first prompt and passed as `title`.
   - No recaps, no prompt suggestions, no agent progress summaries, and no `/btw`, unless the user enables them explicitly.
   - Context comes from `getContextUsage({detail:'summary'})`.
   - Quota comes from the profile's cached usage snapshot, `rate_limit_event`, the usage endpoint, or a local `/usage`. (verified)
   - Spawning a process makes no API request (verified), so pre-spawning and *Actualiser* cost 0 tokens.
7. **Permissions work like the CLI, with GUI extras.**
   - Choices: *Autoriser*, *Toujours autoriser* (scope defaults to *cette session*), and *Refuser* with an optional message.
   - The card honours `defaultToNo`, `suppressAlwaysAllowRule` and the subagent origin.
   - Edit and Write cards show the diff and can be edited before you accept.
8. **The composer keeps CLI muscle memory.**

   | Key | Action |
   |---|---|
   | `Entrée` | Sends, or queues while Claude is running |
   | `Ctrl+Entrée` | *Envoyer maintenant* |
   | `Échap` | Interrupts |
   | `Échap Échap` | Rewinds (idle chat only; while running, a double tap only interrupts) |
   | `↑` | Takes back queued messages, or recalls history |
   | `/` | Opens the command palette |
   | `@` | Opens the file picker |
   | Image paste | Attaches the image |

9. **The keymap is AZERTY-safe and Edge-safe.**
   - No `Ctrl+N/T/W/Tab/1…9` and no `Ctrl+Alt+…`.
   - No key that needs AltGr.
   - Digit keys are matched with `event.code`.
10. **Performance rules.**
    - Only visible chats stream full detail.
    - The server coalesces deltas every 50 ms, and the client applies them on `requestAnimationFrame`.
    - Settled markdown is frozen; only the tail is parsed again.
    - Transcripts are paged and use `content-visibility:auto`.
    - Tool output and diffs start collapsed and are mounted only when opened.
11. **The app is read-only on Claude profiles.**
    - Identity, plan, cached usage, trusted folders and the model list are read from files Claude already writes, at zero cost (§9).
    - Every write goes through Claude Code itself: titles, forks, deletes, logins and continuing on another account.
    - UI state (drafts, layout, pins) lives in the app's own data folder on the server. `localStorage` is only a cache, because the origin includes the port (§3.4).

### Initial hypotheses: what they mean for the UX

| Hypothesis | UX verdict |
|---|---|
| **H1.** The engine is the SDK with the `claude_code` preset. | **Holds.** The UI must still:<br>• pass an explicit `permissionMode`, because otherwise the session takes the profile's `defaultMode`, else `auto`, which makes classifier calls (verified);<br>• pass `title`;<br>• show its own **trust dialog**, because print/SDK mode skips the workspace trust prompt (verified);<br>• declare `perTaskStopAffordance:true`;<br>• enable `enableFileCheckpointing` for rewind;<br>• enable `includePartialMessages`;<br>• set `promptSuggestions:false` and `agentProgressSummaries:false`;<br>• leave `toolConfig` unset: the preview format already defaults to `'markdown'` (verified), which is CLI parity and safer than `'html'`;<br>• declare no `supportedDialogKinds` in v1. |
| **H2.** One long-lived query per open chat. | **Confirmed by measurement.** Resuming in a new process re-wrote the whole conversation into the cache: 19 k tokens for a tiny chat. Each spawn also re-runs the SessionStart hooks, about 2.7 k tokens of context. (verified)<br>So the UX must separate an *open tab* from a *live process* (*En veille* state), and reap only ≥ 60 min after the last request, when the 1 h cache is gone anyway. A resumed turn costs 9.7× to 20× a live one, depending on context size (E2). |
| **H3.** Chats live in Claude's own transcript store. | **Confirmed.** App sessions are tagged `sdk-ts`, which hides them from the terminal `/resume` picker and from `--continue`. `claude --resume <id>` still opens them (verified), so *Ouvrir dans le terminal* uses the explicit id. The resume browser lists sessions from every origin: terminal, Desktop and app.<br>Two caveats shape the UX:<br>• Claude Code deletes transcripts idle for more than 30 days (`cleanupPeriodDays`), so the app warns before that happens (§9.5).<br>• The app never writes into a profile itself (§0 point 11). |
| **H4.** Local server plus Preact/htm in an Edge `--app` window. | **OK.** The keymap is constrained by the shortcuts Edge reserves and by the French AZERTY layout (§10.3). The platform probe verified the basics in Edge 154 `--app` on `127.0.0.1`: secure context, Notification API, `setAppBadge`, Trusted Types, and no-build ESM. UI state must not depend on a stable origin (§3.4). |

---

## 1. Research: proven patterns and known pitfalls

### 1.1 Landscape (what each tool teaches)

| Product | Pattern worth copying | Pitfall / limit |
|---|---|---|
| **Claude Desktop, Code tab** (Apr 2026 redesign) (verified) | • One sidebar for live and recent sessions; filter by status, project or environment; group by project.<br>• `Ctrl`+click opens a 2nd pane; panes can be dragged.<br>• View modes Normal / Thinking / Verbose (`Ctrl+O`).<br>• Usage ring: context plus plan usage.<br>• Diff stats chip `+12 −1` opens a file list plus diff, with line comments sent in one batch (`Ctrl+Enter`).<br>• Side chat (`Ctrl+;`).<br>• OS notification when a session finishes and you are not viewing it.<br>• Bypass mode needs an explicit setting. | • Single account.<br>• GitHub reports of sessions vanishing from the sidebar after a restart, and of terminal sessions never appearing.<br>• `Shift+Tab` deliberately does **not** cycle modes. |
| **Claude Code on the web** (claude.ai/code, cloud sessions) (verified) | • Sidebar of sessions; archive from a hover icon; deleting is possible only from the archived filter or the session menu, with a confirmation.<br>• Diff chip `+42 −18` → diff view with **inline line comments sent with your next message**.<br>• A queued message has a ✕ that **puts its text back in the input box**.<br>• Mode dropdown both at creation and while running.<br>• *Open in › Terminal* copies a ready-to-paste command.<br>• Picker commands take arguments instead (`/model sonnet`, `/rename x`). | • Cloud only, one claude.ai account per browser session.<br>• `/clear` is not available (start a new session instead).<br>• Background work is lost when the VM expires. |
| **Claude Code CLI session tools** (`--resume`, picker, `/branch`) (verified) | • Picker rows: name or title, age, branch, size. `Space` previews, `Ctrl+R` renames, `Ctrl+A` widens to all projects, `Ctrl+B` filters by branch, `1–9` opens a row.<br>• **Resume from a summary:** when a session idle for more than 1 h is over 100 k tokens, a dialog offers *Resume from summary* (`/compact`), *Resume full session as-is*, or *Don't ask again*.<br>• On resume, the terminal restores the session's permission mode, except bypass (back to the default mode) and auto (only if still allowed).<br>• Forking into a new process drops "allow for this session" grants. | • SDK and `-p` sessions are hidden from the picker and from `--continue`.<br>• Two terminals on one session interleave their messages in one transcript. |
| **VS Code extension** (verified) | • Tab status dot: blue = permission pending, orange = finished while hidden.<br>• Context indicator plus a **prompt-cache clock** that counts down 5 m / 1 h and turns red when expired.<br>• Agent map: subagent tree with status, elapsed time, tokens, stop, read-only transcript.<br>• *Run in background* button after about 2 s.<br>• Focus view: tool calls hidden, but the to-do list and pending question stay visible.<br>• Per-change Accept/Reject in diffs, and the proposal can be edited before accepting (Claude is told).<br>• Permission option labels name where the rule is saved; `←/→` changes the destination.<br>• *"This conversation is still open somewhere else… Open here anyway"*.<br>• Auto-archive after 14 days.<br>• Screen-reader announcements: reply complete, permission, queued. | • Per-change buttons are dropped above 100 changes.<br>• Checkpoint support lagged behind the CLI for a long time. |
| **Agent View** (`claude agents`, May 2026) (verified) | • Groups: Pinned › Ready for review › Needs input › Working › Completed.<br>• Icons: animated = working, yellow = needs input, dimmed = idle, green = done, red = failed, grey = stopped.<br>• `Space` opens a peek panel; you can reply from the list.<br>• Filters `a:` `s:` `n:` `o:`; `s:blocked`.<br>• `Alt+1…9` attaches; `Ctrl+T` pins; `Ctrl+R` renames.<br>• Terminal title `2 awaiting input · claude agents`. | • Row summaries come from a Haiku-class model, which costs tokens: **we use deterministic summaries instead**.<br>• Permission prompts cannot be answered from the peek panel. |
| **Claude Code CLI** (verified) | • `Enter` queues while working; queued messages fold into the running turn after the current tool calls.<br>• `Ctrl+Enter` = send now (moves work to the background, or interrupts).<br>• `↑` takes the queue back; `Esc` interrupts; `Esc Esc` opens the rewind menu.<br>• `Ctrl+B` backgrounds; `Ctrl+T` toggles the task list; `Ctrl+R` searches history; `Ctrl+S` stashes.<br>• `Shift+Tab` cycles modes (`Alt+M` fallback on Windows); `Alt+P` switches model.<br>• `/model` asks for confirmation only while the cache is warm.<br>• Waits for the usage limit to reset, then continues automatically. | The terminal cannot show which session is waiting. |
| **claudecodeui / CloudCLI** (siteboon, v1.37.0, 2026-07-29) (verified) | • Reads `~/.claude/projects` to list sessions.<br>• Responsive layout for phones.<br>• Export MD/HTML/PDF, image lightbox, expandable tool errors.<br>• Tools disabled by default. | • Exposing it over a tunnel is the user's problem.<br>• Resume used the wrong id until a fix landed.<br>• No multi-account support. |
| **opcode** (formerly Claudia) (verified) | • Session timeline with checkpoints and branches.<br>• Usage dashboard by model, project and time. | Stale: last commit 2025-10-13, 332 open issues. |
| **Crystal → Nimbalyst** (verified) | • Worktree per session.<br>• Sidebar of files touched per session (to spot overlaps).<br>• Accept/reject diff blocks.<br>• Alert when each run finishes. | Crystal was discontinued in Feb 2026. |
| **Conductor** (macOS) (verified) | • Workspace = worktree + chat + shell + preview + diff.<br>• Review-to-PR loop. | Mac only; agents run unsandboxed. |
| **Vibe Kanban** (verified) | • Kanban columns To Do / In Progress / Review / Done.<br>• Inline diff comments sent back to the agent. | Its company (bloop) announced its wind-down on 2026-04-10 and closed the hosted tier about a month later. The Apache-2.0 code lives on, maintained by the community. |
| **Windsurf 2.0** (Cascade, Agent Command Center, Apr 2026) (verified) | • Several Cascade runs in split panes and tabs.<br>• One git worktree per parallel task.<br>• The Command Center groups concurrent sessions **by status on a board**, local and cloud together. | • Before 2.0, a single right-hand agent panel.<br>• Reviews mention instability in long sessions.<br>• The product may have been renamed (unconfirmed). |
| **claude-squad** (TUI) (verified) | • Keyboard-first list: `n` new, `N` new with a prompt, `D` delete, `↑↓`/`j k`, `Enter`/`o` attach, `Ctrl+Q` detach. | Uses tmux; no overview of state. |
| **Cursor 3, Agents Window** (verified) | • Side-by-side, grid and tiled layouts.<br>• File-level Review (stage / unstage / revert). | • Diffs show the whole file as new.<br>• The review panel cannot be undocked.<br>• No next-change control. |
| **crystl** (macOS) (verified) | • Floating approval cards, colour-coded per project.<br>• Agent activity panel; split view; token tracking. | Closed source; paid orchestration. |
| **Multi-account CLIs** (ccswitch, clauth, AgentsRoom) (verified) | • One `CLAUDE_CONFIG_DIR` per account.<br>• 5 h / 7 d usage bars. | • Auto-switching when a limit is hit is a policy grey zone (secondary sources).<br>• Isolation gaps, such as the CLAUDE.md leak. |

### 1.2 Cross-cutting lessons → our decisions

| Theme | Proven pattern | Known pitfall | SidMultiClaude decision |
|---|---|---|---|
| Session sidebar and status | Attention-first grouping (Agent View); status filters (VS Code); group by project (Desktop) | LLM-written row summaries cost tokens; missing terminal sessions; lost sessions after a restart | Always-on *À traiter* section; the sidebar is rebuilt from `listSessions` for each account, CLI sessions included; the one-line activity is deterministic |
| Tabs vs split | Desktop second pane; Cursor grid; VS Code tab dots | Stale render when switching sessions under load | Tab strip (working set) plus a 1 to 4 pane grid; a status dot on every tab; background tabs are unmounted |
| Permission prompts | CLI's 3 options plus Tab comment; destination named in the label; edit before accept; Allow once / Always / Deny | Prompts scrolling away (terminal); writes to the user profile; a callback that never settles blocks forever | Card docked above the composer; default scope *session*; a stack of pending cards; wait timer; honour `signal` |
| Tool calls | Collapsed summaries plus view modes; *Called slack 3 times* grouping | Verbose mode freezes the UI; auto-scroll steals position and selection | One-line groups, 3 view modes, lazy expansion, stick-to-bottom only when the user is already at the bottom |
| Diffs | `+a −d` chip → file list → per-file diff; per-change accept | Whole-file-as-new diffs; no next-change control | Unified diff from `structuredPatch` (no library needed); *Modifications* panel per chat; hunk navigation; side-by-side on demand |
| Todo / plan | Task list toggle; plan shown as a document; approve + choose mode; edit the plan | Task tools are off by default on the newest models (verified) | *Tâches* strip (`Alt+T`), hidden when empty; docked plan card with *Modifier le plan* |
| Subagents | Agent map tree; stop per task; background by default | Interrupt kills background tasks unless the host declares a per-task stop (verified) | *Agents & tâches* drawer plus a chip; declare `perTaskStopAffordance:true` |
| Notifications | Notify only when the user is not looking; title counter | Notification spam; approving from a notification | Rules matrix (§11); notifications deduplicated per chat; **never approve from a notification** |
| Queued messages | CLI fold-in semantics; grey until started; take back with `↑` | The interrupt can overtake queued messages (ordering race) (verified) | Queue chips with *Modifier* / *Retirer*; lifecycle shown from `command_lifecycle` |
| Slash palette | `/` menu plus a filterable dialog | About 116 commands and 77 skills on this machine (verified); terminal-only commands | Fuzzy search, groups, a *local* badge, terminal-only commands hidden |
| @ mentions | Fuzzy `@auth`, `folder/`, `@file#5-10` | — | Server-side file index per working folder |
| Image paste | `[Image #N]` chips; lightbox | Many images → the cache is rebuilt in batches (verified) | Chips with a token estimate; warning past 10 images |
| Cost and context | Usage ring; cache clock; `/usage` behaviours (cache_miss, long_context…) | `getContextUsage('full')` calls the count_tokens API (verified) | Context ring + cache clock + per-account headline ring + per-turn cache line |
| Long transcripts | Windowed rendering | Minutes-long loads at 50+ turns; laggy typing with hundreds of messages (bug reports) | Paging + `content-visibility` + frozen markdown (§12) |
| Multi-account identity | Separate config directories | Silent auto-rotation; wrong-account sends | Explicit account on every chat; strong identity cues; *Continuer sur un autre compte* is explicit and its cost is shown |
| Interop | *Open here anyway* guard | App sessions are hidden from the terminal picker (verified) | *Ouvert ailleurs* banner; *Ouvrir dans le terminal* uses the explicit id |
| Waking an old chat | CLI *Resume from summary* dialog (> 1 h idle, > 100 k tokens) | Silent full re-cache of a huge history | Same choice in the wake dialog, with the cost in tokens (§7.8) |
| Live sessions elsewhere | — | Two writers on one transcript interleave messages (verified) | Read Claude's live-session registry `sessions\<pid>.json` (§2 E19): badge, live status and a guard |
| Retention | — | Claude Code deletes transcripts idle for more than 30 days, including app (`sdk-ts`) sessions (verified) | Warning badge from day 25, plus a diagnostic in *Comptes* (§9.5) |
| Adding accounts | One `CLAUDE_CONFIG_DIR` per account | The browser's current claude.ai login decides which account gets authorised | Login dialog recommends an InPrivate window and checks the resulting account (§9.2) |

---

## 2. Engine facts that shape the UX

| # | Fact | UX consequence |
|---|---|---|
| E1 | Main-conversation cache TTL: **1 h on a subscription within plan limits**, 5 min on usage credits or an API key; each hit resets it. (verified) | Cache clock per chat; *Cache expiré* hint; reaping at ≥ 60 min is free |
| E2 | Resuming in a new process re-wrote the conversation into the cache (19,173 tokens, versus 2,126 for a live follow-up). Spawning re-runs the SessionStart hooks (about 2.7 k tokens). (verified, measured)<br>**Cause:** an organisation profile's plugin hooks print different text at each start: a unique file path, a random order, and a one-time notice. So every new process re-creates everything after the first ~19.3 k tokens.<br>**Cost:** a resumed turn costs 9.7× a live one at 37 k of context, about 16× at 100 k and about 20× at 500 k (verified). | Keep processes alive while a chat is in use; *En veille* state; when the cap forces an eviction, evict the coldest cache first.<br>Wake-up cost shown as ≈ `max(0, last context − 19 k)` tokens |
| E3 | **Actions that break the cache:** model switch; effort change (except Opus/Sonnet/Haiku 5.5 and Fable 5.1 with an API key or a subscription); first fast-mode enable; MCP added or removed (when tools are not deferred); plugins that carry MCP; denying a whole tool; compaction; many images; CLI upgrade.<br>**Actions that keep it:** permission mode, output style, skills, rewind, subagents, editing files or CLAUDE.md. (verified) | Confirmation dialogs only for the actions that break it, and only while the cache is warm |
| E4 | Cache scope is per organisation and per working folder. Chats in parallel in the same folder share it. (verified) | Moving to another account always means a cold cache |
| E5 | One process ≈ 210–240 MB working set and 445–475 MB private memory, plus one `conhost.exe`. (verified) | Process cap (default 4) and memory shown in the status bar |
| E6 | Hidden model calls:<br>• to avoid by default: AI session title (pass `title`), `promptSuggestions`, `agentProgressSummaries`, `askSideQuestion`, `generateSessionTitle`, `getContextUsage('full')`;<br>• CLI defaults, so parity: the auto-mode classifier, auto-compaction, auto-memory. (verified) | §0 point 6; Auto mode is labelled as using quota |
| E7 | `session_state_changed` was never emitted. `command_lifecycle` (queued → started → completed / cancelled / refused) and `result` are the reliable turn signals. `system:init` arrives on every turn. (verified) | The state machine is driven by those signals (§4) |
| E8 | `rate_limit_event` arrives only on a process's first request and on change. `usage_EXPERIMENTAL…({skipBehaviors:true})` makes one HTTP call and no model call. `/usage` is a local command (`num_turns 0`). (verified) | Usage gauges show their freshness; *Actualiser* never costs tokens |
| E9 | Interrupted requests are not counted in `usage` or `modelUsage`; `total_cost_usd` is a list-price estimate. (verified) | Every cost figure is prefixed with « ≈ » |
| E10 | `canUseTool` can stay pending forever (there is no deadline in SDK mode). Its `signal` fires on interrupt. (verified) | A pending chat is never reaped; show the wait time; withdraw the card when `signal` fires |
| E11 | `updatedPermissions` with destination `userSettings` writes into the account profile. (verified) | Scope defaults to *session*; the *user* scope is flagged |
| E12 | The ancestor CLAUDE.md leak can be fixed with `settings.claudeMdExcludes`. (verified) | Account diagnostic plus a one-click toggle (the app passes a setting; it never edits files) |
| E13 | **AskUserQuestion:**<br>• 1–4 questions × 2–4 options; `multiSelect`; free text;<br>• answers are keyed by the question text; multi-select answers are joined with `", "`;<br>• `annotations.notes`; `response` holds a general free-form reply;<br>• not available inside subagents. (verified) | Interactive form (§6.4) |
| E14 | The ExitPlanMode plan arrives through `canUseTool`. The input field that holds the plan is (unverified). Approve = allow + `setPermissionMode`. (verified) | Plan card (§6.5) |
| E15 | **Rewind:** needs `enableFileCheckpointing`, which is off in the SDK.<br>• CLI menu: *Restore code and conversation / conversation / code / Summarize from here / up to here / Never mind*.<br>• Bash changes and subagent edits are not restored. (verified) | Rewind dialog (§8.4) |
| E16 | `claude auth status --json` → `{loggedIn, authMethod, apiProvider, configDirectory…}`. It creates `.claude.json` on a fresh profile. Log in with `claude auth login --claudeai`; the SDK also has runtime-only OAuth helpers. (verified) | Account panel login flow (§9.2) |
| E17 | `system:init` lists `slash_commands` and `terminal_slash_commands`. `supportedCommands()` returns `{name, description, argumentHint, aliases, builtin}`. (verified) | Slash palette (§7.4) |
| E18 | **Tools in this CLI version:**<br>• there is no `MultiEdit` (Edit has `replace_all`); `Agent` replaces `Task`, and subagents run in the background by default;<br>• tasks use `TaskCreate/TaskUpdate/TaskList` alongside `TodoWrite`;<br>• Bash output carries `gitOperation`, `backgroundTaskId`, `persistedOutputPath`;<br>• Edit/Write output carries `structuredPatch`, `originalFile`, `userModified`. (verified) | Tool renderers (§5.4) |
| E19 | **Live-session registry.**<br>• Every Claude Code process (terminal, `-p`, SDK, Desktop) writes `<configDir>\sessions\<pid>.json` about 1 s after start and deletes it at exit.<br>• It holds `{pid, sessionId, cwd, kind, entrypoint, name, status: busy\|idle\|waiting\|blocked, waitingFor?, updatedAt, procStart}`.<br>• Stale files survive crashes: an entry is live only if the pid is alive and `procStart` matches.<br>• The sibling `<pid>.<sha256>.key` file is a secret: **never read it**. (verified) | *Ouvert ailleurs* detection, live state of terminal chats in the sidebar, and a guard against two writers (§4.1 flag `external`, §8.2) |
| E20 | **Free data in each profile's global config** (`.claude.json`; `~\.claude.json` for the default profile):<br>• `oauthAccount`: email, display name, org name and type, rate-limit tiers, `accountUuid`;<br>• `cachedUsageUtilization`: a usage snapshot written whenever Claude Code fetched usage, stale after 1 h;<br>• `projects[path].hasTrustDialogAccepted`.<br>Each profile also has a model catalog at `cache\model-catalog\*.json`. (verified) | Account cards, login state, usage and the model and effort pickers, all without a process (§8.1, §9) |
| E21 | **Retention sweep.** At most once a day, any Claude Code process deletes the transcripts of its profile whose mtime is older than `cleanupPeriodDays` (default 30). Desktop transcripts are exempt; app (`sdk-ts`) and terminal sessions are not. (verified) | Badge *Supprimé bientôt* from day 25; option to pass a longer `cleanupPeriodDays` to the app's own processes (§9.5) |
| E22 | **Login.**<br>• `claude auth login` is a plain process: it prints a URL and accepts a pasted `code#state` on stdin. It writes `.credentials.json` and `oauthAccount` and prints `Login successful.`. `claude auth logout` reverses it.<br>• **The browser's current claude.ai session decides which account is authorised.**<br>• `claude auth status` takes about 5 s and writes `.claude.json` plus a backup, so **never poll it**. (verified, code) | Login dialog (§9.2) |
| E23 | **Rename while a process is live.** Claude Code re-appends its metadata block, including `custom-title`, after every turn, and the last one wins. A title appended from outside a live process may therefore be overwritten by the next turn. (verified, inferred) | Rename goes through the live process when there is one (§8.3) |
| E24 | **Cross-profile fork.** `--resume <absolute path to A's .jsonl>` plus `--fork-session`, run with profile B, copies the chat into B under a new id and leaves A untouched. The same without `--fork-session` would append to A's file from B's account. (verified) | *Continuer sur un autre compte* (§8.6) |
| E25 | **Resume semantics.**<br>• The terminal restores the session's permission mode, except bypass (back to the default mode), plan (stays plan) and auto (only if still available).<br>• It offers *Resume from summary* when the chat was idle for more than 1 h and is over 100 k tokens (Pro/Max).<br>• A fork in a new process loses "allow for this session" grants. (verified) | Wake and mode rules (§6.7, §7.8, §8.4) |

---

## 3. Information architecture and layout

### 3.1 Main window (two panes)

Legend: `◐` en cours, `!` autorisation, `?` question, `≡` plan, `✓` terminé non lu, `✕` erreur, `⧗` limite, `○` veille. `▌P` / `▌E` = account stripe and monogram (Perso / Entreprise).

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ☰ SidMultiClaude   [ Rechercher ou aller à…            Ctrl+K ]    ! 2 à traiter   ◐ 3 en cours  P◔42 E◔14 ⚙ │
├────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────┤
│ [Filtrer les chats…]     ⋯ │ ◐▌P Refacto auth × │ !▌E Fix CI × │ ✓▌E Spec API × │ ○▌P Idées UI ×        ⌄  + │
│                            ├───────────────────────────────────────┬─────────────────────────────────────────┤
│ À TRAITER (2)              │▌P Refacto auth  SidMultiClaude ⎇ main │▌E Fix CI   api-gateway ⎇ fix/ci         │
│ ! E Fix CI  Bash · npm ci  │ Fable 5.1·haut▾ Manuel▾ ◔42% ◷47m  ■  │ Fable 5.1▾ Modifs auto▾ ◔12% ◷58m  ■    │
│ ? P Blog    Question…      ├───────────────────────────────────────┼─────────────────────────────────────────┤
│                            │ Vous · 14:02                          │ Vous · 13:58                            │
│ ÉPINGLÉS                   │ Ajoute des tests pour le parseur.     │ Le job CI échoue sur windows-latest.    │
│ ◐ P Refacto auth     0:42  │                                       │                                         │
│                            │ Claude                                │ Claude                                  │
│ ▾ P PERSO · Max  ▮▮▮▯▯ 42% │ ▸ 3 lectures, 2 recherches        ✓   │ ▸ A lu .github/workflows/ci.yml   ✓     │
│   ▾ SidMultiClaude         │ Je commence par les cas limites…      │ ┌ ! Autorisation requise · Bash  0:42 ┐ │
│     ◐ Refacto auth   0:42  │ ▾ $ npm test -- parser      ◐ 0:12    │ │ Installer les dépendances           │ │
│     ○ Idées UI       hier  │   12 réussis, 1 échec…                │ │ $ npm ci                            │ │
│   ▸ blog (3)               │                                       │ │ [1 Autoriser] [2 Toujours·session▾] │ │
│ ▾ E ENTREPRISE · Team ▮▯▯▯ 14%│ ┌ Tâches 3/7 · ◐ Écrire les tests   ▸ │ │ [3 Refuser…]   Échap = refus + stop │ │
│   ▾ api-gateway            │ ├─────────────────────────────────────┤ └─────────────────────────────────────┘ │
│     ! Fix CI         0:42  │ │ Écrire à Claude (Perso)…  / @       │ ┌─────────────────────────────────────┐ │
│     ✓ Spec API      2 min  │ │                                     │ │ Écrire à Claude (Entreprise)…          │ │
│ ▸ 2 PERSO 2 · non connecté │ │ + Manuel▾ Fable▾ ⚙2  ■ Arrêter      │ │ + Modifs auto▾ Fable▾  Envoyer · E  │ │
│                            │ └─────────────────────────────────────┘ └─────────────────────────────────────┘ │
│ + Nouveau chat     Alt+N   │                                       │                                         │
│ ⟲ Reprendre…       Alt+R   │                                       │                                         │
├────────────────────────────┴───────────────────────────────────────┴─────────────────────────────────────────┤
│ 3 processus actifs ≈ 0,7 Go (max 4) · serveur local connecté                     Vue : Normal · Thème : Auto │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Regions

| Region | Size | Content | Collapse rule |
|---|---|---|---|
| **Top bar** | 36 px | • `☰` toggles the sidebar (`Alt+B`)<br>• app name<br>• search field that opens the quick switcher (`Ctrl+K`)<br>• global counters *! n à traiter* (click = `Alt+A`) and *◐ n en cours*<br>• one usage ring per logged-in account (monogram + headline %)<br>• Do-not-disturb bell<br>• `⚙` *Réglages* | Below 900 px: counters become icons only and the rings collapse into one ring |
| **Sidebar** | 280 px, resizable 220–420 | §3.3 | Below 1,100 px: shrinks to a 48 px rail of account monograms with attention badges |
| **Tab strip** | 32 px | Open chats (§3.4) | Overflows into `⌄` |
| **Pane grid** | rest | 1 to 4 panes (§3.4) | Minimum pane width 420 px; if the window is too small, fall back to fewer columns |
| **Status bar** | 22 px, can be hidden | *n processus actifs ≈ x Go (max N)* (click: process list with *Mettre en veille* buttons) · server connection · view mode · theme | — |

### 3.3 Sidebar model (`role="tree"`)

1. **Filter box** *Filtrer les chats…* filters as you type, on title, folder, branch and first prompt. The `⋯` menu holds:
   - *Regrouper : par compte › dossier* (default) / *par dossier* / *par état*;
   - *Afficher les archivés*;
   - *Densité*.
2. **À TRAITER (n)**: only shown when it is not empty. It lists chats in `needs_*`, `error`, `rate_limited`, and `idle` with *unread*. It also lists terminal chats whose registry status is `waiting` or `blocked` (E19). Sort order: needs > terminal waiting > error/limit > unread, then oldest first.
   - Row: state glyph · monogram · title · reason line.
   - Example reasons: « Bash · npm ci », « Question : Quelle lib… », « Plan à valider », « Session expirée », « Limite · reprise 15:45 », « Terminé il y a 2 min ».
3. **ÉPINGLÉS**: pinned chats from every account.
4. **Account groups.**
   - Header: colour chip · monogram · upper-case name · plan (« Max », « Team ») · 5-segment bar plus the headline usage % · login state if not connected · `+` for a new chat in this account.
   - Under the header: one folder per working folder (basename; a parent hint when two basenames collide; the full path in a tooltip). Folders are sorted by latest activity.
   - Under each folder: chats, newest first. 5 are shown, then *Afficher plus (n)*.
5. **Footer:** *+ Nouveau chat* (`Alt+N`) and *⟲ Reprendre…* (`Alt+R`).

**Chat row** (28 px; 40 px in the two-line « Confortable » density):

```
▌◐ Refacto auth ……………………… 0:42 ●
 └ stripe in the account colour (3 px) · state glyph · title (ellipsis) · meta (running timer, or age) · unread dot
2nd line (comfortable density): SidMultiClaude ⎇ main · Fable 5.1 · « Bash : npm test »
```

- **Hover:** shows `☆` (pin) and `⋯`.
- **`⋯` menu and right-click menu:** *Ouvrir dans un nouveau volet*, *Ouvrir dans le terminal*, *Renommer*, *Épingler*, *Bifurquer…*, *Continuer sur un autre compte…*, *Mettre en veille*, *Archiver*, *Supprimer définitivement…*, *Copier l'ID de session*.
- **Activity line:** always deterministic, never model-generated. In order of priority:
  1. the pending request summary;
  2. the current tool with its description;
  3. the first line of the last assistant text;
  4. the first line of the first prompt.

### 3.4 Tabs and panes

- **Tabs.**
  - The tab strip is the working set of open chats, at most about 12 visible.
  - A tab shows: state glyph · account colour bar with monogram · title · `×`.
  - The active tab is the one shown in the focused pane. Tabs shown in other panes carry a small pane badge ①②③④.
  - You can drag to reorder, or drop a tab on a pane to show it there. Middle-click closes.
  - Overflow goes into `⌄`, a searchable list.
- **Panes.**
  - Layouts: 1 / 2 (side by side, with a splitter) / 3 (one large left, two stacked right) / 4 (2×2). `Alt+L` cycles them.
  - Each pane shows exactly one open chat.
  - Clicking a tab shows it in the focused pane. **If the chat is already visible in another pane, that pane gets the focus instead (no duplicates).**
  - The focused pane has a 2 px accent outline; `F6` cycles the focus.
  - `Ctrl+Entrée` in the sidebar or quick switcher opens the chat in a new pane, up to 4; beyond that it replaces the least-recently focused pane.
- **What closing does.**
  - Closing a tab (`Alt+W`) only removes the view. A running chat keeps running and stays visible in the sidebar.
  - *Mettre en veille* stops the process.
  - *Arrêter* (`Échap`) interrupts the turn.
  - *Archiver* hides the chat.
- **Persistence.** The layout, the tabs and the scroll position of each pane (anchor turn plus offset) are saved on the server, in the app's data folder (`ui-state.json`), debounced by 1 s.
  - **Why the server:** `localStorage`, notification permission and the service worker are tied to the origin, and the origin includes the port. A port change or a new Edge profile would wipe them.
  - `localStorage` stays as a fast first-paint cache, wrapped in try/catch, and the server copy wins.
  - *(Changed after the platform probes.)* Use a fixed default port, configurable, so that notification permission persists.

### 3.5 Pane header: the per-chat header

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│▌P Refacto auth ✎ │ SidMultiClaude ⎇ main │ Fable 5.1 · haut ▾ │ Manuel ▾ │ ◔ 42 % │ ◷ 47 min │ ≈ 0,84 $ │ ⋯ │ ■ │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Element | Data source (no tokens) | Interaction |
|---|---|---|
| Account badge `▌P` | App account record + `oauthAccount` from the profile's global config (E20), with no process; refreshed by `accountInfo()` when a process is live | Tooltip « Compte Perso · utilisateur@… · Claude Max » |
| Title | `listSessions().summary` order: `customTitle` > `aiTitle` > last prompt > first prompt (E20 / the on-disk data research) | Click or `F2` renames inline. The rename is visible to `claude --resume` (mechanism: §8.3) |
| Folder ⎇ branch | `system:init.cwd`, `gitBranch` | Menu: *Copier le chemin*, *Ouvrir dans l'Explorateur*, *Ouvrir dans VS Code*, *Ouvrir un terminal ici* |
| Model · effort | List: the profile's model catalog (E20), else `supportedModels()` (cached per account). Current values: `init.model`, `init.effort` | Menu `Alt+P`. Only aliases (`opus`, `sonnet`, `fable`, `haiku`) or catalog ids are passed, never free text, because an unknown string triggers a validation model call (verified). While the cache is warm, a model switch asks first (E3); effort asks only when the engine flags a cache break |
| Mode pill | `init.permissionMode` / `system:status.permissionMode` | Menu `Alt+M`, colour per mode (§6.7) |
| Context ring ◔ | Last turn usage `(input + cache_read + cache_creation + output) / modelUsage.contextWindow`; refined with `getContextUsage('summary')` when the popover opens | Popover: breakdown by category, auto-compaction threshold, *Compacter maintenant…* (labelled as a model call) |
| Cache clock ◷ | Last request or response time + TTL (1 h, or 5 min when `isUsingOverage`) | Normal colour while warm; amber below 5 min; grey « expiré » after. Tooltip shows the cost of the next message (copy: `header.cache.*`) |
| Cost ≈ | `result.total_cost_usd` (cumulative list price) | Tooltip: tokens in / out / cache plus « non facturé sur abonnement » |
| `⋯` | — | *Vue*, *Rechercher dans ce chat*, *Revenir à…*, *Bifurquer*, *Continuer sur un autre compte…*, *Ouvrir dans le terminal*, *Exporter en Markdown*, *Infos de session*, *Mettre en veille*, *Désactiver les notifications de ce chat*, *Fermer le volet* |
| ■ Stop | Visible in `running` / `needs_*` | Same as `Échap` |

- **Narrow pane (< 600 px):** folder and branch move into `⋯`, the cost is hidden, and the context ring and cache clock merge into one chip.
- **Banners under the header, stacked:** bypass mode (red, permanent) · *Ouvert ailleurs* · rate limit · auth error · trust request · server reconnecting.

### 3.6 *Infos de session* popover (no tokens)

- Session id (copy) · account · working folder · transcript path (*Ouvrir le dossier*), plus its size.
- CLI version (`claude_code_version`) · resolved model · tool count.
- MCP servers with their status (connected / failed / needs-auth / pending / disabled).
- Skills and plugins counts · output style · permission mode.
- **Instructions chargées:** the memory files from `getContextUsage('summary')`, or, for a sleeping chat, the `instructions.files` list of the transcript's first-turn `attachment` (zero cost, the on-disk data research). ⚠ A file that belongs to another account's profile is flagged (the leak described in E12).
- **Lancé avec un autre compte:** shown when the transcript's `bridge-session.ownerAccountUuid` differs from the profile's `accountUuid`. This happens with Desktop chats in the default profile (the on-disk data research).

---

## 4. Per-chat state machine

### 4.1 States

| Id | FR label | Meaning | Entered on (signal) |
|---|---|---|---|
| `cold` | **En veille** (*Pas encore démarré* for a new chat) | No process. The transcript is read from disk; reading it is free | App start; chat opened from the resume browser; reaped; *Mettre en veille*; *Ouvrir dans le terminal* |
| `starting` | **Démarrage…** | Process spawning / resuming | First keystroke in the composer of a `cold` chat (pre-spawn, 0 tokens); send on a `cold` chat; *Réessayer* |
| `idle` | **Prêt** (+ flag *unread* → **Terminé**) | Process alive, no turn running | `initializationResult()` resolved and nothing queued; `result` with `queued_turn_count = 0` and nothing pending |
| `running` | **En cours** | A turn is active | `command_lifecycle: started`, or `system:status requesting` |
| `needs_permission` | **Autorisation requise** | At least one pending `canUseTool` for an ordinary tool, or a pending MCP elicitation | `canUseTool(name ∉ {AskUserQuestion, ExitPlanMode})`, `onElicitation` |
| `needs_answer` | **Question en attente** | Pending AskUserQuestion | `canUseTool('AskUserQuestion')` |
| `needs_plan` | **Plan à valider** | Pending ExitPlanMode | `canUseTool('ExitPlanMode')` |
| `rate_limited` | **Limite atteinte** | Plan limit hit; `resetsAt` is known | `rate_limit_event.status='rejected'`, assistant `error:'rate_limit'`, or a result error whose text matches `USAGE_LIMIT_ERROR_PREFIXES` |
| `error` | **Erreur** | The chat cannot continue without action | Auth / billing / `model_not_found` / startup failure / process exited unexpectedly / API error after retries |

- **Mapping to the initial list of states:** awaiting-permission = `needs_permission`; awaiting-answer = `needs_answer` + `needs_plan`; offline-reaped = `cold`. `rate_limited` is a specialised `error`, kept separate because it drives the multi-account flow.
- **`running` sub-status**, shown in the pane header and in the sidebar's second line:
  - *Requête…* (`status requesting`, before the first token);
  - *Réflexion…* (`thinking_delta`; token count from `thinking_tokens`);
  - *Rédaction…* (`text_delta`);
  - *Exécute {outil}… (0:12)*: from the `tool_use` block to its `tool_result`, with elapsed time from `tool_progress`;
  - *Compaction…* (`status compacting`);
  - *Nouvelle tentative n/max dans s s* (`api_retry`);
  - *Arrêt…* (from the moment `Échap` is pressed until the `result` arrives).
- **Flags** (combine with any state):
  - `unread`;
  - `bgTasks: n`: non-ambient entries in `background_tasks_changed`. An `idle` chat with `bgTasks > 0` is shown as `◐` in a light tone, labelled *Prêt · n tâches en arrière-plan*;
  - `external`: another live Claude Code process holds this session, according to the registry (E19). That process can be a terminal, Desktop or a `claude agents` background session. The flag carries that process's `status` (`busy` / `idle` / `waiting` / `blocked`), which the sidebar shows read-only as *Terminal · en cours*, *Terminal · attend une réponse*, and so on;
  - `queued: n`;
  - `muted`;
  - `pinned`;
  - `expiring`: the transcript has been idle for 25 days or more and will be deleted by Claude Code's 30-day sweep (E21);
  - `foreignOwner`: the chat was run under another account (§3.6).

### 4.2 Transitions

| From | Event | To | Side effects |
|---|---|---|---|
| `cold` | First keystroke in its composer (pre-spawn) | `starting` | 0 tokens: spawning makes no API request (verified). Skipped when the chat is `external`, or when the process cap would force a warm-cache eviction (see below) |
| `cold` | User sends (or *Réveiller*) | `starting` | Composer shows the wake-up hint before sending (§7.8), and the wake dialog for chats over 100 k tokens with an expired cache. The message is held in the UI queue until the process is ready |
| `starting` | Init OK and a message is queued | `running` | — |
| `starting` | Init OK and nothing queued | `idle` | — |
| `starting` | Spawn, auth or startup failure | `error` | Map `startup_failure_reason` to French copy |
| `idle` | Send (`command_lifecycle started`) | `running` | Clears `unread` |
| `running` | `canUseTool` (ordinary tool) / AskUserQuestion / ExitPlanMode | `needs_permission` / `needs_answer` / `needs_plan` | Card added to the dock. Notification if the user is not looking (§11) |
| `needs_*` | Decision sent; or `signal` aborted (interrupt) | `running` | When several requests are pending, the state follows the oldest one still pending |
| `running` | `Échap` | `running` (*Arrêt…*) | `interrupt()`; queued messages are kept (CLI parity) |
| `running` | `result` (any subtype), queue empty, nothing pending | `idle` | `unread = true` unless the chat is visible in a focused window. If the interrupt was aborted, record *Interrompu par vous* |
| `running` / `idle` | Rate limit rejected | `rate_limited` | Banner (§8.7); optional automatic resume |
| `rate_limited` | Reset time reached and the user chose automatic resume | `running` | Sends the visible message « Continue la tâche là où tu t'es arrêté. », tagged *Reprise automatique programmée par vous* |
| `rate_limited` | Reset time reached, no automatic resume | `idle` | Toast *Limite réinitialisée sur {compte}* |
| any live state | Process exit (unexpected), `authentication_failed`, `billing_error`, `oauth_org_not_allowed`… | `error` | Banner with an action |
| `error` | *Réessayer* / *Se reconnecter* (after login) | `starting` | — |
| `idle` | ≥ *n* min (default 60) since the **last API request**, which is when the 1 h cache expires; also `bgTasks = 0`, nothing pending, not marked *Garder actif* | `cold` | Silent |
| `idle` | Process that **never sent a request** (pre-spawned, abandoned draft), idle for 10 min | `cold` | Silent: there is no cache to lose |
| `idle` | Process cap reached by another chat | `cold` | Victim: the idle, non-visible chat without *Garder actif* whose **last API request is oldest**, i.e. the coldest cache (TOKEN-RESEARCH.md §6). If its cache is already expired: silent, toast `chat.sleep`. If every candidate is still warm: inline choice `cap.choice` in the chat being started (*Mettre en veille « X » (~N k tokens à recréer)* / *Dépasser la limite* / *Annuler*) |
| `idle` / `cold` | *Ouvrir dans le terminal* | `cold` + `external` | Process stopped first; transcript reloaded when the terminal exits |
| `cold` | Registry shows another live process on this session (E19). The app's own child pids are excluded, since SDK children register too | `cold` + `external` | Composer locked (`term.locked`) with *Reprendre ici quand même* |
| `cold` + `external` | That registry entry disappears (or its pid is dead) | `cold` | Transcript tail reloaded; toast `ext.closed` |
| any | `conversation_reset` (`/clear`) | same | Remount under `new_conversation_id`; separator *Conversation effacée* |

**A chat is never reaped** while it is `running`, `needs_*` or `rate_limited` with an automatic resume armed, nor while `bgTasks > 0`.

### 4.3 Diagram

```
                   keystroke / send / wake
    ┌────────────┐ ───────────────────────────► ┌────────────┐
    │    cold    │                              │  starting  │ ── fail ──► error
    └────────────┘                              └────────────┘
          ▲                                           │ init ok (→ running directly if a message is queued)
          │ reap ≥ 60 min* · cap · terminal           ▼
          │                                     ┌────────────┐
          └──────────────────────────────────── │    idle    │ ◄───────────────┐
                                                └────────────┘                 │ result
                                                      │ send                   │ (queue empty)
                                                      ▼                        │
    ┌──────────────────┐     canUseTool         ┌────────────┐                 │
    │ needs_permission │ ◄───────────────────── │  running   │ ────────────────┘
    │ needs_answer     │ ─────────────────────► │            │ ── limit hit ──► ┌──────────────┐
    │ needs_plan       │   decided / signal     └────────────┘                  │ rate_limited │
    └──────────────────┘                              │ crash · auth · API      └──────────────┘
                                                      ▼                          reset → idle
                                                ┌────────────┐                   reset + auto-resume → running
                                                │   error    │ ── Réessayer ──► starting
                                                └────────────┘
```

\* 60 min after the last API request; 10 min for a process that never sent one. "cap" means the coldest-cache eviction of §4.2. The `external` flag (another process holds the session) can be set on `cold` only.

### 4.4 How each state is signalled

| State | Glyph (SVG; shape + colour) | Sidebar row | Tab | Pane header | Window title | Favicon | OS notification | Sound |
|---|---|---|---|---|---|---|---|---|
| `cold` | `○` hollow, `--st-cold` | Title in muted text | `○` | *En veille* chip | — | — | — | — |
| `starting` | `◌` dotted, slow spin | Grey spinner | `◌` | *Démarrage…* | — | — | — | — |
| `idle` | none | Normal | none | *Prêt* | — | — | — | — |
| `idle` + unread | `✓` in a pill, `--st-done` | `✓` + **bold** title | `✓` | — | `✓n` | green dot | « Claude a terminé » (if not looking and the turn took ≥ 10 s) | soft tick (optional) |
| `running` | `◐` ring rotating 1 s, `--st-run` | `◐` + timer | `◐` | Sub-status text | — | static blue arc (only if nothing has a higher priority) | — | — |
| `needs_permission` | shield `!`, `--st-needs` | `!` + reason + wait time | `!` (one pulse, then static) | Docked card | `!n` | amber badge with the count | « Autorisation requise » | two-tone chime |
| `needs_answer` | `?` in a circle, `--st-needs` | `?` + start of the question | `?` | Card | `!n` | amber | « Question de Claude » | chime |
| `needs_plan` | `≡` clipboard, `--st-needs` | `≡` *Plan à valider* | `≡` | Card | `!n` | amber | « Plan à valider » | chime |
| `rate_limited` | `⧗` hourglass, `--st-limit` | `⧗` + *reprise 15:45* | `⧗` | Banner | `✕n` | orange | « Limite atteinte » | low tone |
| `error` | `✕` in a circle, `--st-err` | `✕` + short cause | `✕` | Red banner | `✕n` | red | « Erreur » | low tone |

- **Colour is never the only cue.** Every state has its own glyph shape and a text label (tooltip and `aria-label`).
- **Reduced motion:** with `prefers-reduced-motion`, nothing spins or pulses.
- **Flag badges**, small and placed after the title:
  - `external` → `⌨` + *Terminal · {statut}*. When the registry says `waiting` or `blocked`, the chat also enters *À traiter* with the reason *Attend une réponse dans le terminal*. The action *Afficher le terminal* brings that process's window to the front (unverified); if that fails, the row is information only;
  - `expiring` → `⌛` + *Supprimé dans {n} j*;
  - `foreignOwner` → `⇄` + *Lancé avec un autre compte*;
  - `bgTasks` → `⚙{n}`;
  - `queued` → `≡{n}`.

### 4.5 Window-level aggregation

- **Window title:**
  - format: `[!n ][✕n ][✓n ]· SidMultiClaude`, for example `!2 ✓1 · SidMultiClaude`;
  - `!` counts `needs_*`, `✕` counts `error` + `rate_limited`, `✓` counts unread;
  - updated at most once per second.
- **Favicon** (32×32 canvas, drawn by the client):
  - base: a neutral rounded « S »;
  - one badge in the bottom-right corner, highest priority first: amber with a count (`needs_*`, «9+» above 9) › red (error or limit) › green dot (unread) › blue arc (anything running);
  - redrawn at most once per second.
  - (unverified) Whether the Edge `--app` taskbar icon follows the favicon (§17).
- **Order of *À traiter* and of `Alt+A` cycling:** `needs_permission` = `needs_answer` = `needs_plan` (oldest first) › terminal chats `waiting` / `blocked` (no card: `Alt+A` focuses the row) › `error` › `rate_limited` › unread (oldest first).

### 4.6 Process policy as the user sees it  

**Réglages › Performance**

- **Mettre en veille après:** 60 min after the last request by default; choices 15 / 30 / 60 / 120 min / *Jamais*. Below 60 the setting shows a warning (`set.reap.warn`).
- **Démarrer Claude dès la saisie:** on by default. A sleeping chat starts its process on the first keystroke, at 0 tokens and about 240 MB; it is stopped after 10 min if nothing is sent.
- **Processus actifs maximum:** 4 by default, range 2–8 (TOKEN-RESEARCH.md §6). The setting shows the estimate « ≈ 240 Mo chacun », and a process grows with its history. When free RAM drops below 1.5 GB, the effective cap is lowered and the status bar says *max {n} (mémoire faible)*. During the measurements this 16 GB laptop had only 2 GB free.
- **Démarrage instantané:** off by default. When on, one *spare* process is pre-warmed per account with `prewarm()`, at ≈ 250 MB each.
- **Garder actif:** a per-chat pin, so the chat is never put to sleep by the LRU.

---

## 5. Transcript rendering rules

### 5.1 View modes (`Ctrl+O` cycles them; chosen per chat, the default is global)

| Mode | Shows | CLI/Desktop analogue |
|---|---|---|
| **Normal** (default) | Full text replies. Consecutive tool calls grouped into one summary line. Thinking collapsed. System notices visible | Desktop *Normal* |
| **Détaillé** | Every tool call expanded to its summary card. Thinking expanded. Hooks, informational `info` notices, per-turn usage line | Desktop *Verbose* / CLI `Ctrl+O` |
| **Focus** | Your prompts and Claude's final message per turn. Everything else becomes « ▸ n actions ». **The to-do strip and pending cards stay visible** | VS Code *Focus view*; `init.view_mode:'focus'` |

### 5.2 Turn structure

```
── Vous · 14:02 ──────────────────────────────────────────── (hidden h3: « Vous : Ajoute des tests… »)
  Ajoute des tests pour le parseur. [image 1] [@src/parser.ts]
── Claude ───────────────────────────────────────────────────
  ▸ 3 lectures, 2 recherches, 1 commande                     ✓   ← ToolGroup (Normal)
  Texte markdown…                                                ← AssistantText
  ▾ $ npm test -- parser                         ◐ 0:12          ← tool card (expanded because it is running)
  Texte…
  ✓ 1 min 12 s · 34 k entrée (91 % cache) · 1,2 k sortie · ≈ 0,05 $   ← TurnFooter (Détaillé; hover in Normal)
```

- **Grouping.** Contiguous `tool_use` blocks with no text between them form one **ToolGroup**. Its summary counts by kind: « 3 lectures, 2 recherches, 1 commande, 1 modification (+12 −3) ».
  - A group is **expanded automatically** while one of its tools is running, has failed, or is waiting for permission.
  - A group collapses again 1.5 s after it ends, unless the user opened it.
- **User messages are labelled by origin.**

  | Origin | Rendered as |
  |---|---|
  | `kind:'human'` | « Vous » |
  | `peer` | Card *Message de la session « {nom} »*, with a link when `fromSession` is known |
  | `task-notification` | Small row *Tâche d'arrière-plan terminée…* |
  | `auto-continuation` | *Reprise automatique* |
  | Synthetic CLI text `[Request interrupted by user]` | Separator *Interrompu par vous*, **not** a bubble |

- **Interrupted assistant text** (`aborted:true`) ends with a dimmed « … (interrompu) ».
- **Refusal fallback:** messages listed in `supersedes` / `retracted_message_uuids` are removed from the transcript and replaced. A notice *Réponse refusée par X, reprise avec Y* is shown.

### 5.3 Content blocks

| Block | Rendering rules |
|---|---|
| **Text / markdown** | GFM: headings, lists, tables, task lists, fenced code with a language label, *Copier* button and line count.<br>• Links open outside the app (`rel=noopener`), and the full URL is shown on hover.<br>• A local file path in text or code (`src/x.ts:12`) is clickable; its menu offers *Ouvrir dans VS Code* / *Copier le chemin* / *Afficher dans l'Explorateur*.<br>• **Remote images in markdown are blocked** (exfiltration risk). They are shown as a placeholder *Image distante bloquée* with the domain and the action *Ouvrir dans le navigateur*. They are never displayed inline, because the CSP `img-src` blocks them anyway (verified in the Edge probe: DOMPurify keeps the `<img>` and the CSP refuses the request).<br>• Hover actions on a reply: *Copier la réponse* (raw markdown), *Citer*. |
| **Streaming text** | Incremental: §12.2. A caret ▍ marks the live tail. |
| **Thinking** | Collapsed to one line: *Réflexion · 1,2 k tokens ▸* (`thinking_tokens` while live).<br>• Expanding shows the text in muted italics.<br>• Redacted / omitted thinking shows *Réflexion masquée*.<br>• `Ctrl+O` (Détaillé) expands every thinking block. |
| **Images (user or tool)** | Thumbnail at most 240 px, `loading=lazy`, `decoding=async`; click opens the *lightbox*. Tooltip shows the size and ≈ tokens (`w·h/750` after the model's own resize; the per-model cap is (unverified), so the figure is always prefixed with « ≈ »). The server never inlines base64 in transcript frames: images are served lazily by URL (the on-disk data research item 8). |
| **Documents (PDF)** | Chip *PDF · nom · n pages*. |
| **Local command output** (`/usage`, `/context`) | « Système » bubble.<br>• With `usage_report` → card of usage bars (§9.3).<br>• With `context_usage` → stacked bar by category.<br>• Otherwise, the markdown as is. |

### 5.4 Tools

| Tool | Collapsed line (Normal) | Expanded | Statuses / extras |
|---|---|---|---|
| **Bash** (and PowerShell) | `$ {command}` truncated to 1 line. Label = `input.description` (« Installer les dépendances »). Running: *Exécute… 0:12* | Command in monospace (2 lines, *Afficher tout*). Output with **stderr tinted red**, ANSI codes rendered as minimal spans or stripped. Over 8 lines → **tail** of 8 lines + *Afficher tout (n lignes)*. Over 4 kB → the head and tail come from the server; the rest is fetched on demand (`persistedOutputPath`) | • Exit code (`is_error`) → ✕ *Code de sortie n*.<br>• `interrupted` → *Interrompue*.<br>• `backgroundTaskId` → badge *En arrière-plan* + link to the drawer.<br>• `timedOutAfterMs` → *Passée en arrière-plan après n s*.<br>• `gitOperation` → chips *commit a1b2c3d*, *push main*, *PR #42 créée* (link).<br>• After 2 s running: button *Exécuter en arrière-plan (Ctrl+B)* → `backgroundTasks(toolUseId)` |
| **Read** | *A lu `src/auth.ts` (L1–120)*. Consecutive reads → *A lu n fichiers* | Lazily mounted content with line numbers, at most 400 lines, then *Afficher plus*. Images → thumbnail; PDF → *pages 1–5* | Error → red line *Fichier introuvable* |
| **Edit** | *A modifié `src/auth.ts` (+12 −3)*. Badge `replace_all` when set | **Unified diff from `tool_use_result.structuredPatch`**:<br>• old/new line numbers; hunk header *Lignes 120–134*;<br>• 3 lines of context; word-level highlight on paired −/+ lines shorter than 500 chars;<br>• actions *Côte à côte*, *Ouvrir dans VS Code*, *Copier le chemin*, *Citer dans le message*.<br>Over 400 lines → *Afficher le diff (n lignes)*, rendered in chunks of 200 | `userModified` → badge *Modifié par vous avant acceptation* |
| **Write** | Create: *A créé `x.ts` (n lignes)*. Update: *A réécrit `x.ts` (+a −d)* | Create → the first 20 lines + *Afficher tout*. Update → diff from `structuredPatch` | `staged` → *En attente de revue (non écrit)* |
| **MultiEdit** (old transcripts only) | *A modifié `x` (n remplacements)* | A sequence of diffs | — |
| **NotebookEdit** | *A modifié la cellule n de `nb.ipynb`* | Diff of the cell source | — |
| **Grep** | A cherché « motif » dans `src` (`*.ts`) → 12 fichiers, 34 occurrences | Files grouped, with the matching lines highlighted (first 50, then *Afficher plus*) | `appliedLimit` → *(limité à 250)* |
| **Glob** | A listé `**/*.ts` → 87 fichiers (*tronqué* when `truncated`) | File list, virtualised above 200 | — |
| **WebFetch** | *A lu la page `domaine.com/chemin` — 200 · 34 Ko* | The prompt that was asked, plus the result as markdown (sanitised, remote images blocked) | Non-2xx → amber |
| **WebSearch** | *A cherché sur le web « requête » → 8 résultats* | List of titles, domains and links. **No remote favicons** | — |
| **Agent** (subagent; `Task` in old transcripts) | Card `▌Explore` (type badge) *« Cartographier le module auth »* · model · badge *arrière-plan* · live line *1:12 · 18 k tokens · 9 outils · Read* (`task_progress`) | *Ouvrir la transcription* (read-only, loaded lazily with `getSubagentMessages`, or the live forwarded stream when the drawer is open); prompt (collapsed); final result (markdown, collapsed past 15 lines). Nested subagents are indented by `spawn_depth` | *■ Arrêter* → `stopTask`. Final status ✓ / ✕ / *arrêté*. Permission requests from inside the subagent show *Demandé par le sous-agent « Explore »* |
| **TodoWrite / TaskCreate / TaskUpdate / TaskList** | *Liste de tâches mise à jour (3/7) · +1 terminée* (diff of `oldTodos` → `newTodos`; the full list is **not** repeated in the transcript) | Checklist: ☐ pending · ◐ in progress (shows `activeForm`) · ☑ completed (struck through, muted) · blocked (TaskUpdate `addBlockedBy`) → lock glyph ⊘ | The **latest** list lives in the *Tâches* strip (§7.1) |
| **AskUserQuestion** | While pending → interactive form docked above the composer (§6.4). Afterwards: *Question · « Quelle lib ? » → **date-fns*** | Questions with the chosen answers and notes | — |
| **ExitPlanMode** | While pending → plan card (§6.5). Afterwards: *Plan approuvé · mode Auto* (or *refusé : « … »*) | The plan as a markdown document | `planWasEdited` → *Plan modifié par vous* |
| **EnterPlanMode** | Row *Claude est passé en mode Plan* | — | The mode pill turns to Plan |
| **MCP tools** (`mcp__server__tool`) | Card *{serveur} › {outil}* (server name **escaped**; the source shown as a small tag, e.g. *plugin*, *projet*). Consecutive calls → *A appelé slack 3 fois* | Arguments as a collapsible JSON tree (strings over 200 chars truncated). Result: text content as plain text (as markdown if it starts with `#` or contains a fence), images as thumbnails, `resource_link`s as links. MCP Apps `ui://` → *Widget non pris en charge* (v1) | Error → red line |
| **Skill / SlashCommand** | *A utilisé la skill « nom »* | The injected instructions (collapsed; Détaillé only) | — |
| **Monitor / Cron / ScheduleWakeup / PushNotification** | One-line row (« Surveillance : logs CI », « Réveil programmé à 15:00 ») | Raw input | Monitors show up in the drawer |
| **EnterWorktree / ExitWorktree** | *Passé dans le worktree `x`* | — | The folder chip in the pane header shows the worktree |
| **Workflow** (multi-agent script) | Card `▌Workflow` *« {workflowName} »* · badge *arrière-plan* · live line *phase 2/3 · 5 agents · 3:10* (from `task_started.workflow_name` and `task_progress`) | Phases with their agents (the same rows as the drawer); *Voir le script* (`scriptPath`, read-only); `summary` once done; `warning` / `error` in amber or red | *■ Arrêter* → `stopTask`. `remote_launched` → link *Ouverte dans le cloud* (external). The run also appears in the *Agents & tâches* drawer |
| **ProposeGoal** / goal | Pending with `ask_user` → approval card *Objectif proposé : « {condition} »* (*Accepter* / *Refuser*), through the generic permission card (unverified) for the exact path. Set directly → row *Objectif défini : « … »* | — | While a goal is active, a chip *Objectif* in the pane header, with the condition in a tooltip (`active_goal`) |
| **ToolSearch** | Détaillé only: *A chargé {n} outils* | Tool names | Never counted in the ToolGroup summary |
| **SendMessage / ListAgents** | *Message envoyé à « {nom} »* / *A listé les sessions actives* | Message body (escaped) | Incoming replies render as `peer` user messages (§5.2) |
| **TaskStop / TaskOutput / TaskGet** | *A arrêté la tâche {id}* / *A lu la sortie de {id}* | Raw output, collapsed | Links to the matching drawer row |
| **Other small tools** (Artifact, PushNotification, ReportFindings, RemoteTrigger, DesignSync, ReadNotifications…) | One row: tool name plus the first meaningful input field | JSON tree | Generic renderer; no dedicated component in v1 |
| **Unknown tool** | *{nom}* + summary of the input keys | JSON tree | Never crashes; unknown types are ignored, not thrown |
| **Tool error** (`is_error`) | Red-tinted line *Échec de {outil}* + the first error line | Full error text (collapsible past 6 lines) | Errors keep the ToolGroup expanded |
| **Denied tool** (`toolDenialKind`) | Amber row by kind: *Refusé par vous* (`user-rejected`), *Bloqué par une règle* (`permission-rule`), *Bloqué par le mode Auto* (`automode-blocked`), *Mode Auto indisponible* (`automode-unavailable`), *Interrompu* (`interrupted`) | The denial message | Same text in live sessions and when replaying old transcripts |

**Payload rule (server → UI).** Tool results reach the UI as summaries. Heavy fields are fetched only when the user expands the card: `originalFile` (a whole file, never sent unless *Côte à côte* needs it), base64 images, stdout or stderr over 4 kB, and thinking text. `toolUseResult` makes up 36 % of transcript bytes and base64 images 29 % (the on-disk data research).

### 5.5 System events

| Event | Rendering |
|---|---|
| `compact_boundary` | Full-width separator *Conversation compactée (automatique / manuelle) · 182 k → 24 k tokens · 41 s* + *Voir le résumé*. Turns above it get a slight dim, with the label *Avant la compaction (hors contexte)* |
| `status: compacting` | Pane sub-status *Compaction de la conversation…* + a live region announcement |
| `api_retry` | Temporary inline row *Nouvelle tentative 2/10 dans 8 s (surcharge 529)*. It disappears when the request succeeds |
| `rate_limit_event` `allowed_warning` | One toast per window and account (`acc.warn80`); the gauge turns amber |
| `permission_denied` (auto mode / rule) | Amber row *Action bloquée par le mode Auto : {raison}* + *Réessayer en validant moi-même*. It also lands in *Refusées récemment* in the mode menu |
| `model_refusal_fallback` / `_no_fallback` | Info / red notice (`sys.refusal`); *Modifier et renvoyer* puts the refused prompt back in the composer |
| `informational` | `info` → Détaillé only · `notice` → grey row · `suggestion` / `warning` → amber row |
| `notification` (`priority`) | `low` / `medium` → toast · `high` / `immediate` → toast + live region |
| `hook_started` / `hook_response` | Détaillé only: tiny grey row *Hook SessionStart · ok*; a failure shows its stderr |
| `memory_recall` | Chip *Souvenirs utilisés (3)* that can be expanded (paths; content loaded on demand) |
| `conversation_reset` | Separator *Conversation effacée — nouvelle session* |
| `task_notification` | Row *Tâche terminée : …* (+ a toast if the chat is not visible) |
| `files_persisted`, `mirror_error`, `worker_shutting_down`, `elicitation_complete` | Détaillé only (grey row) |
| **Cache-miss line**   | When a turn's `cache_creation_input_tokens` is more than 30 % of its input and more than 10 k tokens: amber row *Cache manqué : 84 k tokens réécrits (cause probable : changement de modèle / reprise / compaction / expiration)*. The cause is guessed from local events (model switch, resume, compaction, idle > TTL) |
| Turn footer | `✓ durée · in (x % cache) · out · ≈ coût`. Shown in Détaillé, on hover in Normal |

### 5.6 Rendering security (the UI can trigger code execution)

- Markdown → `marked` → **DOMPurify** with a strict allowlist: no `style`, no `on*`, no `iframe`. Tool output is always inserted with `textContent`.
- **CSP:** `default-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types dompurify`.
  - Trusted Types were verified in the Edge probe: raw `innerHTML` throws a `TypeError`, and DOMPurify returns `TrustedHTML`. Every HTML sink must go through the sanitiser.
  - That probe also confirmed that a remote `<img>` kept by DOMPurify is then refused by `img-src` (§5.3).
- No remote fonts, images or favicons.
- Untrusted strings, always escaped: MCP server and tool names, plugin names, hook output, peer session names, file paths.
- AskUserQuestion previews arrive as **markdown** (the default format, `toolConfig` unset) and are rendered in `<pre>`. HTML previews are never rendered, except possibly later in a `sandbox=""` iframe with no scripts.
- Links: only `http`, `https` and `mailto`. A `file:` link becomes an app action (open in the editor / Explorer) after a check. Anything else is blocked.
- **No approval action ever appears in an OS notification or a toast.**

---

## 6. Permissions, questions, plans, modes

### 6.1 Pending dock

- **Placement.** Pending requests appear **above the composer**, in a sticky dock. A small anchor marker also sits in the transcript at the matching `tool_use`.
- **Stacking.**
  - Several requests (parallel tools, subagents) form a stack with the header *1 sur 3*. The keys act on the top card.
  - `Alt+↓` / `Alt+↑` move through the stack while the dock has focus.
- **Focus rules: never steal keystrokes.**
  - Focus moves to a new card automatically only if the pane is focused, the composer is empty, **and** the user has not typed for 2 s.
  - Otherwise the card pulses once, is announced in the live region, and can be reached with `Alt+A` / `Tab`.
- **Timer.** *en attente depuis 3 min* is shown on the card and in the sidebar row.
- **Cancellation.** When `options.signal` aborts (interrupt, or answered by another client), the card collapses to *Demande annulée (tour interrompu)*, which fades after 3 s.
- **Idempotence.** A card is keyed by `requestId`; a re-delivery after `reinitialize()` updates the existing card instead of duplicating it.

### 6.2 Permission card

```
┌ ! Autorisation requise · Bash ─────────────────────────────── 1 sur 2 · en attente 0:42 ┐
│ Claude veut exécuter : Installer les dépendances                                        │
│ ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ $ npm install --save-dev vitest                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────────────────┘ │
│ Dossier : ~\Desktop\SidMultiClaude · Raison : commande non pré-approuvée                │
│ Demandé par le sous-agent « general-purpose »                                           │
│                                                                                         │
│ [1 Autoriser]   [2 Toujours autoriser « npm install … » · pour cette session ◂ ▸]       │
│ [3 Refuser…]    ⋯ Plus : Autoriser et passer en mode Auto                               │
│ Tab : ajouter un commentaire · Échap : refuser et arrêter le tour · V : plein écran     │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**What the card shows** (from the `canUseTool` options; status (verified)):

- *Title line:* `title` is used as is when present (for example « Claude wants to read foo.txt »). If it is in English, the French template `perm.title` + `displayName` is shown and the original goes into the tooltip.
- *Subtitle:* `description`.
- *Raison :* `decisionReason`.
- *Chemin hors du dossier autorisé :* `blockedPath`.
- *Demandé par le sous-agent « … »:* `agentID`, plus the task description.
- MCP: *Serveur MCP « {name} » ({source})*. Trust decisions rely on `source`, never on the name.
- `matchedAskRule` → *Règle « demander » : {toolName(ruleContent)}*. *Autoriser et passer en Auto* is hidden in that case.

**How the options map to `PermissionResult`:**

| Option (FR) | Shown when | Result |
|---|---|---|
| **Autoriser** (`1` / `O`) | Always, but **without a one-key shortcut and without the initial focus when `defaultToNo`** | `{behavior:'allow', updatedInput: input, decisionClassification:'user_temporary'}` |
| **Toujours autoriser … · {portée}** (`2` / `T`; `←` / `→` changes the scope) | Hidden if `suppressAlwaysAllowRule` or if there are no `suggestions` (Edit/Write: see §6.3) | `allow` + `updatedPermissions: suggestions` with `destination` set to the chosen scope, and `'user_permanent'`.<br>Scopes:<br>• *pour cette session* = `session` (**default**);<br>• *pour ce projet (local, non partagé)* = `localSettings`;<br>• *pour ce projet (partagé)* = `projectSettings`;<br>• *pour tous les projets de ce compte* = `userSettings`, labelled ⚠ *écrit dans le profil du compte*.<br>The rule is shown in monospace in the tooltip: `Bash(npm install:*)` |
| **Refuser…** (`3` / `N`) | Always | Opens the field *Que doit faire Claude à la place ? (facultatif)*. `Entrée` → `{behavior:'deny', message: text \|\| 'L\'utilisateur a refusé.', decisionClassification:'user_reject'}`. The turn continues and Claude adapts |
| **Refuser et arrêter** (`Échap`) | Always | `deny` with `interrupt: true` (CLI « No (esc) ») |
| **Autoriser et passer en mode Auto** (⋯ Plus) | Bash, in Manuel or Modifs auto, when auto mode is available and no ask rule matched | `allow` + `setPermissionMode('auto')` (CLI parity, (verified)) |
| **Commentaire** (`Tab`) | Always | On refusal it becomes `message`. On approval it is queued as a `next` message « Note : … » ((unverified) whether to keep it; v1 may hide comments on approval) |

### 6.3 Edit / Write variant

```
┌ ! Autorisation requise · Modifier src/auth.ts ───────────────────────── en attente 0:05 ┐
│ src/auth.ts  (+12 −3)                                        [Côte à côte] [Plein écran]│
│  118 │   const token = req.headers.get('x');                                            │
│  119 │ - if (!token) return null;                                                       │
│  119 │ + if (!token) throw new AuthError('missing');                                    │
│ [1 Autoriser]  [2 Autoriser toutes les modifications (cette session)]  [3 Refuser…]     │
│ [E Modifier avant d'accepter]                                                           │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **The diff before execution** is computed on the client from `old_string` → `new_string`: a small line LCS. When n·m > 1e6 it falls back to a block view *n lignes remplacées par m*. For Write, the diff is against the current file (the server reads it).
- **Option 2** for edits = `allow` + `updatedPermissions:[{type:'setMode', mode:'acceptEdits', destination:'session'}]`. This is the CLI's « allow all edits during this session ».
- **E, *Modifier avant d'accepter*:** opens an editable textarea for `new_string` / `content`. Sent back as `updatedInput`. The card shows *Claude sera informé de votre modification* (unverified) (whether `userModified` is set when the edit goes through the SDK).

### 6.4 AskUserQuestion form

```
┌ ? Claude vous pose 2 questions ──────────────────────────────────────── en attente 1:10 ┐
│ [Librairie] Quelle librairie utiliser pour les dates ?                                  │
│   (•) 1 date-fns      Léger, modulaire                         ┌ Aperçu ─────────────┐  │
│   ( ) 2 Luxon         API riche, fuseaux horaires              │ import { format }   │  │
│   ( ) 3 Day.js        Très petit, API proche de Moment         │ from 'date-fns'     │  │
│   ( ) 4 Autre… [__________________]                            └─────────────────────┘  │
│   + Ajouter une note                                                                    │
│ [Options] Quelles fonctionnalités activer ?  (plusieurs choix)                          │
│   [x] 1 Locales FR    [ ] 2 Fuseaux    [x] 3 Tree-shaking    [ ] 4 Autre…               │
│                                                                                         │
│ [Envoyer les réponses  Ctrl+Entrée]   [Répondre librement]   [Ne pas répondre]          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Keys:**

  | Key | Action |
  |---|---|
  | `↑` / `↓` | Move between options |
  | `Espace` | Toggle (multi-select) / select |
  | `1–4` (`event.code`) | Pick an option |
  | Last number | *Autre…* |
  | `Tab` / `Maj+Tab` | Next / previous question |
  | `Ctrl+Entrée` | Submit (enabled once every question is answered) |

- **Preview:** shown when an option has focus or hover. `preview` markdown goes in `<pre>`.
- **What is sent back:**
  - `{behavior:'allow', updatedInput:{questions: input.questions, answers:{[question]: label | 'a, b' | texteAutre}, annotations?:{[question]:{notes}}}}`;
  - *Répondre librement* → `updatedInput.response = texte`;
  - *Ne pas répondre* → `deny` « L'utilisateur a choisi de ne pas répondre. ».
- **Afterwards** the card collapses to *Question · « … » → réponse*.

### 6.5 Plan approval (ExitPlanMode)

```
┌ ≡ Plan proposé ─────────────────────────────────────── [Modifier le plan] [Plein écran] ┐
│ ## Objectif                                                                             │
│ Remplacer le parseur maison par…                                                        │
│ ## Étapes                                                                               │
│ 1. …                                                       (scrolls, max 50 % of pane)  │
│─────────────────────────────────────────────────────────────────────────────────────────│
│ [1 Oui, et passer en mode Auto]   [2 Oui, valider chaque modification (Manuel)]         │
│ [3 Non, continuer à planifier…  ________________________________________________ ]      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Plan text, in order of preference:**
  1. `input.plan` when it is a string.
  2. Otherwise the plan file the session wrote, read-only by the server (under `<configDir>\plans\`; location (unverified), see §17).
  3. As a last resort, the turn's last assistant text, with the notice *Plan reconstitué depuis la réponse*.
  - The input type is an open record (E14). The output carries `plan`, `filePath` and `planWasEdited`; per the types, a plan edited by the user (web UI or `Ctrl+G` in the CLI) is echoed back to the model (verified).
- **Option 1** becomes *Oui, accepter les modifications automatiquement* when auto mode is unavailable (org setting or model). It becomes *Oui, et passer en mode Contournement* only when bypass is enabled for this chat. Wording mirrors the CLI (verified).
- **Approve** = `allow` with `updatedInput` (the edited plan if *Modifier le plan* was used) + `setPermissionMode(chosen)`.
- **3** = `deny` with the feedback text. The model keeps planning.
- `M` opens the editor. `Ctrl+Entrée` confirms the option that has focus.
- After approval, the transcript keeps a collapsed *Plan approuvé · mode {mode}*. The **title is not regenerated**. The CLI titles a session from its plan (a model call) only when the session has no name (verified), and the app always names its sessions (`title`).

### 6.6 MCP elicitation (`onElicitation`)

- **Form mode:** a generic card with fields built from the requested schema (text, number, boolean, enum). Buttons *Envoyer* / *Refuser*.
- **URL mode:** *Le serveur MCP « x » demande une authentification* + *Ouvrir la page* (external browser) + *J'ai terminé* / *Annuler*.
- The chat state is `needs_permission`.

### 6.7 Permission modes and danger signalling

**Mode menu** (`Alt+M`, then `1–5`; or click the pill):

```
Mode d'autorisation
 1 ‖ Manuel           Demande avant chaque modification ou commande
 2 ✎ Modifs auto      Accepte les modifications de fichiers ; demande pour les commandes
 3 ◇ Plan             Explore et propose un plan, sans rien modifier
 4 ✦ Auto        ⓘ    Un classifieur valide les actions à votre place (consomme un peu de quota)
 5 ⚠ Contournement    Aucune confirmation — environnements isolés uniquement
 ─────────────────
 Refusées récemment (2) ▸
```

| Mode (SDK value) | Pill colour token | Extra signalling |
|---|---|---|
| Manuel (`default`) | `--mode-manual` (neutral grey) | — |
| Modifs auto (`acceptEdits`) | `--mode-edits` (violet) | — |
| Plan (`plan`) | `--mode-plan` (teal) | Composer placeholder `composer.placeholder.plan` |
| Auto (`auto`) | `--mode-auto` (indigo) | ⓘ tooltip: classifier = model calls. Auto pauses after 3 blocks in a row or 20 in total → toast `mode.auto.paused` (verified) |
| Contournement (`bypassPermissions`) | `--mode-bypass` (red, striped) | • **Permanent red banner** `mode.bypass.banner` under the pane header, red composer border, ⚠ in the tab.<br>• Only offered when *Réglages › Autoriser le mode Contournement* is on: new chats then start with `allowDangerouslySkipPermissions` so the switch is possible later.<br>• Each switch needs a typed confirmation (`CONTOURNER`).<br>• Disabled with `mode.bypass.org` when org policy forbids it.<br>• `dontAsk` is not offered in v1 (it is CLI-only in Desktop too) |

- **Changing mode never breaks the cache** (verified), so no warning is shown. The exception is the `opusplan` model setting, where the mode toggle is a model switch.
- **Default mode for a new chat:** the last mode used **in that folder** (Desktop behaviour; Plan is not remembered), else the account's `permissions.defaultMode`, else **Manuel**. The UI always passes the mode explicitly (E6).
  - If that default is `bypassPermissions` and *Autoriser le mode Contournement* is off, the chat starts in **Manuel** with the notice `mode.bypass.downgraded`.
  - If it is `auto`, the pill shows the ⓘ quota hint from the first turn.
- **Mode when a chat wakes up or is resumed** (terminal parity, E25): the mode the chat was last in, taken from app metadata, else from the transcript's last `permission-mode` / `mode` entry. Exceptions:
  - `bypassPermissions` → the new-chat default, plus `mode.bypass.downgraded`, so bypass always needs a fresh typed confirmation;
  - `plan` → stays Plan;
  - `auto` → only if still available, else Manuel.
  - The mode pill flashes once after a wake-up, so the user sees the mode before typing.
- `Maj+Tab` cycling is **off by default**: it is an accessibility trap in a text area. It can be enabled in *Réglages › Clavier*. The cycle order is the CLI's: Manuel → Modifs auto → Plan → (Contournement) → Auto.

---

## 7. Composer

### 7.1 Composer and the strips above it

```
┌ Tâches 3/7 · ◐ Écrire les tests du parseur ────────────────────────────── Alt+T ▸ ┐
├ En file (2) ──────────────────────────────────────────────────────────────────────┤
│  « Utilise vitest, pas jest »             En file · ↑ pour reprendre    [✎] [×]   │
│  « Ensuite mets à jour le README »        En file                       [✎] [×]   │
├───────────────────────────────────────────────────────────────────────────────────┤
│ [img capture.png ≈1,2 k] [@src/parser.ts ×]                                       │
│ Claude travaille — Entrée met votre message en file                               │
│                                                                                   │
├───────────────────────────────────────────────────────────────────────────────────┤
│ +  Manuel ▾  Fable 5.1 · haut ▾   ⚙ 2 agents ●   Mettre en file ⏎   ■ Arrêter     │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- **Tâches strip:** collapsed by default, showing *n/total* + the in-progress `activeForm`. Expanded, it shows up to 7 items. Hidden when the chat has no task list.
- **Agents chip:** `⚙ n agents ●`. The dot is blue while working and amber when one of them waits for permission. Click or `Alt+G` opens the *Agents & tâches* drawer (§7.9).
- **Send button label:**
  - idle → *Envoyer · {monogram}*;
  - running → *Mettre en file*;
  - `Ctrl+Entrée` → *Envoyer maintenant*.
- **Border:** the account colour on the left edge (3 px). The bypass mode turns the whole border red.

### 7.2 Keys and behaviour

| Input | Idle | While running |
|---|---|---|
| `Entrée` | Send. Option: *Envoyer avec Ctrl+Entrée*, where `Entrée` inserts a newline | **Queue.** Delivered after the current tool calls, inside the same turn; slash commands wait for the end of the turn (CLI semantics (verified)) |
| `Maj+Entrée` | Newline | Newline |
| `Ctrl+Entrée` | Send | **Send now**: the queue plus the draft, with `priority:'now'`. Interruptible work moves to the background; otherwise the turn is interrupted (CLI `chat:sendNow`; semantics (unverified), an open item of the SDK research) |
| `Échap` | Close the popup if one is open; otherwise nothing (focus stays, and this press arms `Échap Échap`) | **Interrupt** (`interrupt()`). The queue is kept and sent next (CLI). **Pitfall:** let pending writes go first (`setImmediate`) so the interrupt does not overtake queued messages (verified) |
| `Échap Échap` (< 600 ms) | Draft not empty → clear it, with an 8 s *Brouillon effacé · Annuler* toast. Empty → *Revenir à…* | **Never a rewind.** The first press interrupts, and a second press within 600 ms is swallowed, so double-tapping to stop never opens the rewind dialog. Rewind needs the chat to be idle (or `needs_*`) at the first press |
| `↑` on the first line | Previous prompt (this chat first, then global) | **Takes the queued messages back** into the input, one per line, so they can be edited (`cancelAsyncMessage` for each) (verified) |
| `↓` on the last line | Next prompt | — |
| `Ctrl+R` | Fuzzy search over prompt history (every chat and account; `Entrée` inserts) | Same |
| `Ctrl+S` | Stash the draft (with its attachments) / restore it | Same |
| `Ctrl+G` | Expand the composer to the full pane / shrink it back | Same |
| `/` at the start | Slash palette | Same; local commands run immediately |
| `@` | File / folder picker | Same |
| `Ctrl+V` / drop | Attach images / files | Same |

### 7.3 Queue model

- Each queued item is an `SDKUserMessage` with a client `uuid`. Its chip follows `command_lifecycle`: *En file* → *Pris en compte* (started; the chip moves into the transcript as a normal message) → done.
- `cancelled` / `refused` → chip *Retiré*.
- **Edit (✎) or remove (×)** call `cancelAsyncMessage(uuid)`. If that returns `false` (already taken), the chip shows *Déjà pris en compte*.
- **Interrupt receipt:** the `still_queued` uuids stay as chips; `cancelled` uuids become *Retiré*.
- `result.queued_turn_count > 0` keeps the chat in `running` between the queued turns.
- **Queued messages on a `cold` chat** are held by the UI and sent once the process is ready (`starting` → `running`).

### 7.4 Slash palette

```
┌ /comp ─────────────────────────────────────────────────────────────┐
│ COMMANDES INTÉGRÉES                                                │
│ › /compact [instructions]   Compacter la conversation     ↯ modèle │
│   /context                  Voir l'occupation du contexte  local   │
│ SKILLS                                                             │
│   /code-review [cible]      Revue du diff en cours        ↯ modèle │
│ PLUGINS · MCP …                                                    │
└────────────────────────────────────────────────────────────────────┘
```

- **Sources:** `system:init.slash_commands` plus `supportedCommands()` (`name`, `description`, `argumentHint`, `aliases`, `builtin`), refreshed on `commands_changed`. `terminal_slash_commands` are hidden.
- **Groups:** *Commandes intégrées* (builtin) / *Skills* / *Plugins* / *MCP*. Fuzzy search covers names, aliases and descriptions; descriptions stay in the language their author wrote.
- **Badges:**
  - *local* (no model call) for a static allowlist of local commands: `/usage` (verified (verified)), and candidates still to confirm on this CLI (§17 item 9): `/context`, `/model`, `/effort`, `/status`, `/permissions`, `/mcp`, `/clear`, `/cost`, `/help`, `/rewind` …;
  - *↯ modèle* for everything else.
- **App actions are not slash commands.** They live in the quick switcher (`Ctrl+K`, prefix `>`).
- **Selecting a command** inserts `/name ` plus a ghost `argumentHint`; `Entrée` sends it.
- **Commands that also have UI controls** (`/model`, `/effort`, `/rewind`, `/clear`) are intercepted and open the native dialog instead.
- **`/clear`** asks first: *Effacer la conversation ? Une nouvelle session démarre ; l'ancienne reste dans « Reprendre ».*

### 7.5 @ mentions

- **Index:** built on the server per working folder.
  - `git ls-files --cached --others --exclude-standard` in a git repo.
  - Otherwise a walk that skips `node_modules`, `.git`, `dist`, `build` and `.venv`, capped at 50 k entries.
  - Refreshed every 30 s while the chat is focused. **Costs no tokens.**
- **Popup:** up to 50 fuzzy results (subsequence score, basename bonus), with the matches highlighted, folder/file icons and a relative path.
  - `Tab` / `Entrée` inserts `@chemin/relatif` (folders with a trailing `/`).
  - Typing `#` after a file adds a line range (`@app.ts#5-10`).
- Files outside the working folder can be mentioned by absolute path. They trigger the CLI's own permission flow.

### 7.6 Attachments

| Input | Handling |
|---|---|
| Image paste (`Ctrl+V`) | Chip with a thumbnail and ≈ tokens. **Sent as pasted**, with no client downscale: the CLI and the API apply their own per-model resizing, as they do for a terminal paste, and newer models accept larger images (unverified). Only an image over the API's per-image byte limit is re-encoded (JPEG, quality 0.9), with a notice. Sent as an `image` content block **before** the text |
| Image file drop | Same |
| Other file drop | Inside the working folder → inserts `@chemin`. Outside → inserts the absolute path, with the warning *Hors du dossier : Claude demandera l'autorisation de le lire* |
| Text paste over 2 kB | Stays visible (VS Code behaviour) and is marked as pasted (`pasted_content` / `inline_pastes`) (unverified). Invisible Unicode characters are removed, with the notice `composer.invisible` |

- From 10 images in the conversation: warning `composer.image.tooMany` (E3).
- Clicking a thumbnail opens the lightbox; `×` removes the attachment.

### 7.7 History and drafts

- **Drafts:** saved per chat on the server, in the app's data folder (text plus attachments under 1 MB), debounced by 1 s, and restored when the chat mounts. They are mirrored in `localStorage` under `draft:<chatId>` (debounced by 300 ms, try/catch) so that a crash or reload loses nothing. The newer copy wins (§3.4).
- **Prompt history:**
  - **This chat:** its user messages, taken from the transcript store.
  - **Global:** an app-side index of every prompt sent from SidMultiClaude.
  - **Terminal prompts:** each profile's `history.jsonl`, read-only (verified). Its entries are `{display, pastedContents, timestamp, project, sessionId}`, newest first, filtered by normalised project path and deduplicated on the text. SDK runs never write this file, and the app never writes it either.

### 7.8 Token hints in the composer (no tokens)  

- **Estimate used by every hint:** `N ≈ max(0, last context − 19 k)` tokens to re-cache.
  - Last context = the last turn's `input + cache_read + cache_creation`, read from the transcript tail for a sleeping chat.
  - The ~19 k is the prefix that new processes in the same folder still share within the hour (verified). Without any chat in that folder during the last hour, use the full context.
- **`cold` chat with N over 20 k tokens:** dimmed line under the editor, `composer.wake` (« …remet en cache ~65 k tokens »).
- **Cache expired** (live process, last request older than the TTL) with N over 30 k: `composer.cacheCold`.
- **Wake dialog (CLI parity, E25).** Shown on the first send when the chat was idle for more than 1 h **and** its context is over 100 k tokens. It does not block a pre-spawn.

  ```
  ┌ Reprendre « Refacto auth » ? ─────────────────────────────────────────── Échap ┐
  │ Ce chat est inactif depuis 3 h : son cache a expiré (~182 k tokens).           │
  │ (•) 1 Reprendre tel quel — relit ~163 k tokens une fois, garde tout le détail  │
  │ ( ) 2 Reprendre depuis un résumé — /compact (appel modèle), puis messages      │
  │       plus légers ; certains détails seront perdus                             │
  │ [ ] Ne plus demander                               [Annuler] [Envoyer ⏎]       │
  └────────────────────────────────────────────────────────────────────────────────┘
  ```

  - Option 2 sends `/compact` first, then the user's message (queued).
  - *Ne plus demander* is stored per app, like the CLI's *Don't ask again*.
- **Context close to the auto-compaction threshold** (within 5 % of the window). The threshold is window − 33 k buffer, e.g. 967 k on a 1 M window (TOKEN-RESEARCH.md rule 11), so a fixed 85 % would fire far too early on 1 M models. The hint reads *Contexte presque plein (96 %) : la compaction automatique va se déclencher. Compacter maintenant ?* The link `/compact` is labelled as a model call.
- These hints never block sending. The wake dialog is the only confirmation, and only above 100 k tokens.

### 7.9 *Agents & tâches* drawer (right side of the pane, 360 px)

```
Agents & tâches d'arrière-plan                                   [Tout arrêter]
▾ ◐ Explore — « Cartographier le module auth »     1:12 · 18 k · 9 outils · Read
     ◐ general-purpose — « Vérifier les tests »    0:40 · 6 k · Bash          [■]
  ✓ Plan — « Proposer un plan »                    terminé · 2:03
Commandes
  ◐ npm run dev                                    2:11  [Voir la sortie] [■]
  ◐ Surveillance « logs CI »                       0:30                     [■]
```

- **Data:** `task_started` / `task_progress` / `task_updated` / `task_notification`, with `background_tasks_changed` replacing the whole set each time. Ambient tasks are hidden.
- **Actions:**
  - `■` → `stopTask(taskId)`;
  - *Voir la sortie* → the task output;
  - *Ouvrir la transcription* → subagent messages;
  - *Tout arrêter* → stops each task, with a confirmation (the CLI's `Ctrl+X Ctrl+K`).
- **After `Échap` with background tasks still running:** toast *Tour interrompu. 2 agents continuent en arrière-plan — [Tout arrêter]* (`perTaskStopAffordance:true`).

---

## 8. Chat lifecycle flows

### 8.1 New chat (`Alt+N`)

```
┌ Nouveau chat ─────────────────────────────────────────────────────────────────── Échap ┐
│ Compte   (●) ▌P Perso · Max · 5 h 42 %   ( ) ▌E Entreprise · Team · 5 h 14 %   Alt+1…9    │
│          ( ) ▌2 Perso 2 — non connecté [Se connecter]                                  │
│ Dossier  [%USERPROFILE%\Desktop\SidMultiClaude                ▾] [Parcourir…] │
│          Récents : SidMultiClaude · api-gateway · blog                                 │
│          ⓘ Ce dossier est habituellement utilisé avec Entreprise.                         │
│ Modèle   [Par défaut (Fable 5.1) ▾]   Effort [Par défaut ▾]                            │
│ Mode     [‖ Manuel] [✎ Modifs auto] [◇ Plan] [✦ Auto ⓘ]                                │
│ Nom      [facultatif — sinon tiré de votre premier message]                            │
│ ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Que doit faire Claude ?                                                            │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ ⓘ Chaque chat actif utilise un processus Claude (~240 Mo).                             │
│                                [Créer sans envoyer  Ctrl+Entrée]  [Créer et envoyer ⏎] │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Defaults:**
  - **Account:** the account of the focused chat, else the last one used.
  - **Folder:** the focused chat's folder, else the account's most recent folder.
  - **Model:** *Par défaut (réglages du compte)*, which **omits** the option (token parity: TOKEN-RESEARCH.md rule 3). The list comes from the profile's model catalog (E20), so it works before any process exists for that account.
  - **Effort:** *Par défaut* (omitted) unless chosen; the choices come from the catalog's `effort_options` for that model.
  - **Mode:** §6.7.
- **Recent folders:** the union of `cwd` from `listSessions` across every account (`includeWorktrees:false`), sorted by recency, with an account hint.
- **Picking a folder:**
  - The path field autocompletes from the server's directory listing (`Tab` completes a segment).
  - *Parcourir…* opens a server-rendered folder browser: drives, favourites, subfolders and filter-as-you-type. A browser cannot return paths from a native dialog.
- **Folder warnings:**
  - *Votre dossier personnel entier : déconseillé (beaucoup de fichiers, instructions d'autres profils).*
  - The folder lies inside a Claude profile directory.
  - The folder does not exist.
- **Trust prompt (first use of a folder by this account).** This gives parity with the CLI, which asks interactively; print/SDK mode skips the prompt.
  - Dialog `trust.title` / `trust.body`, buttons *Faire confiance* / *Annuler*.
  - Not shown when the account already trusted the folder in the terminal: `projects[path].hasTrustDialogAccepted` in the profile's global config, read-only, with paths normalised (`\`→`/`, case-insensitive; E20).
  - Folders trusted in the app are stored in the app's metadata, never in the profile.
- **Title.** `Nom` if given; otherwise the first line of the prompt, cleaned of `@mentions` and `/commands` and cut to 60 characters. Always passed as the `title` option, which avoids the CLI's AI title call (E6).
- **Créer sans envoyer:** creates a tab in state *Pas encore démarré*. **No process is spawned until the user types or sends** (§4.2 pre-spawn; no tokens either way). With *Démarrage instantané* on, a spare process is used.
- **Working folder:** passed as `fs.realpathSync.native(path)`. A short 8.3 path or a different letter case would otherwise file the session under another project folder (the on-disk data research).
- **Keys:** `Alt+1…9` selects an account; `Tab` cycles the fields; `Entrée` in the prompt = create and send; `Maj+Entrée` = newline.

### 8.2 Resuming existing sessions (`Alt+R`)

```
┌ Reprendre une session ─────────────────────────────────────────────────────────── Échap ┐
│ [Rechercher (titre, dossier, branche, premier message)…]   Compte [Tous ▾]  [Archivés]  │
│ Origine : [✓ Terminal] [✓ Desktop] [✓ SidMultiClaude] [ Autres (-p, SDK) ]              │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ › ▌E Fix flaky test        api-gateway ⎇ fix/ci     il y a 2 h    1,2 Mo   Terminal     │
│   ▌P Blog : article cache  blog ⎇ main              hier          340 Ko   App          │
│   ▌P Maquette site ⇄       site ⎇ main              il y a 9 j     12 Mo   Desktop      │
│   ▌P Idées UI ⌛ 3 j        SidMultiClaude           il y a 27 j    88 Ko   App          │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ Aperçu (lecture seule) — 3 derniers échanges                                            │
│  Vous : Le test test_retry échoue une fois sur dix…                                     │
│  Claude : Le problème vient du mock d'horloge…                                          │
│ [Ouvrir ⏎]  [Ouvrir dans un nouveau volet  Ctrl+⏎]  [Ouvrir dans le terminal]           │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **List:** `listSessions({limit:200, includeWorktrees:false})` for each account. The SDK session helpers read the process-global `CLAUDE_CONFIG_DIR`, so every call is serialised behind one mutex, or runs in one worker per account (a known SDK pitfall). Paged at 200; search runs on the fetched metadata.
- **Origin**, from the transcript head's `entrypoint`:
  - *Terminal*: `cli`;
  - *Desktop*: `claude-desktop`. 102 of the 103 default-profile transcripts on this machine are Desktop chats (the on-disk data research);
  - *App*: `sdk-ts` sessions, together with the app's own index;
  - *Autres*: `sdk-cli` / `sdk-py`, i.e. `claude -p` and scripts. Hidden by default.
- **Row badges:**
  - `⇄` *Lancé avec un autre compte* (`foreignOwner`, §3.6);
  - `⌛ n j` before Claude Code's 30-day sweep deletes it (E21);
  - `⌨` when a live process holds it (E19).
- **Keys (CLI picker parity):** `↑↓` to move, `Espace` to toggle the preview, `F2` (CLI `Ctrl+R`) to rename, `Entrée` / `Ctrl+Entrée` to open, and `Ctrl+B` to filter by the focused chat's branch (CLI parity; inside this dialog only).
- **Preview:** a tail-first read of the transcript (§12.3) for the last 3 exchanges. It is read-only and spawns nothing.
- ***Ouvrir*** puts the chat in `cold`, with the transcript paged from disk. **The process starts on the first keystroke or send** (§4.2).
- **Opened-elsewhere guard (E19):** the registry `<configDir>\sessions\*.json` lists live processes by `sessionId`. When another live process holds the session, the banner `resume.elsewhere` names it (*Terminal · en cours*, *Desktop*, *Agent en arrière-plan*) and offers *Ouvrir quand même* (read-only until the user confirms). Two writers on one session interleave their messages (verified). The fallback heuristic is a JSONL modified in the last 60 s.
- **Resume uses the recorded working folder.** If that folder no longer exists, the dialog asks for a replacement (the on-disk data research).

### 8.3 Rename, pin, archive, delete

| Action | Mechanism | UX |
|---|---|---|
| Rename (`F2`) | **Sleeping chat:** the standalone `renameSession(id, title)`, which appends a `custom-title` entry that the CLI sees.<br>**Live chat:** through its own process, so that the next turn's metadata re-append does not restore the old title (E23). Use the runtime control `renameSession(title)`, or failing that `/rename {titre}` sent as a local command (unverified) (§17).<br>**`external` chat:** disabled, with the tooltip `rename.external` | Inline editor; `Entrée` validates, `Échap` cancels |
| Pin / unpin | App metadata | Star in the row; *Épinglés* section |
| *Garder actif* | App metadata | The LRU never evicts the chat |
| Archive (`Suppr` in the sidebar) | App metadata only (the transcript is untouched). Archiving does **not** protect against Claude Code's 30-day sweep (E21) | Toast *Chat archivé · Annuler* (8 s) |
| Unarchive | App metadata | *Afficher les archivés* toggle |
| Delete permanently | `deleteSession(id)` | Confirm dialog `chat.delete.confirm`. The chat must be `cold` first |

### 8.4 Rewind and fork (`Échap Échap` on an empty composer, or `⋯ › Revenir à…`)

```
┌ Revenir à un point précédent ─────────────────────────────────────────────── Échap ┐
│ ↑↓ choisir le message · 1–4 choisir l'action · Entrée valider                      │
│ › 14:02  « Ajoute les tests pour le parseur »          3 fichiers modifiés         │
│   13:55  « Corrige le bug de login »                   1 fichier                   │
│   13:40  « Explique l'architecture »                   —                           │
│ ─────────────────────────────────────────────────────────────────────────────────  │
│ (1) Restaurer le code et la conversation                                           │
│ (2) Restaurer la conversation (garder le code actuel)                              │
│ (3) Restaurer le code (garder la conversation)                                     │
│ (4) Bifurquer : nouveau chat depuis ce message (l'original reste intact)           │
│ Simulation : src/parser.ts (+0 −42), tests/parser.test.ts (supprimé)               │
│ ⓘ Les changements faits par des commandes (Bash) et par des sous-agents ne sont    │
│   pas annulés.                                                                     │
│                                                          [Annuler] [Valider ⏎]     │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **Code restore** → `rewindFiles(userMessageId)`. It needs `enableFileCheckpointing:true`, which costs disk, not tokens. The simulation line comes from `{dryRun:true}`. Options 1 and 3 are hidden when the point has no tracked file changes (verified).
- **Conversation restore** → relaunch with `resume` + `resumeSessionAt` (+ `resumeDropsTurn`). On the refusal `Resume rejected by --resume-drops-turn`, fall back to a plain resume and tell the user (verified).
  - Afterwards the original prompt is put back in the composer (CLI parity).
  - The relaunch may re-write the cache for the remaining conversation (E2), so the dialog does **not** claim the rewind is free.
- **Fork** → `forkSession(id, {upToMessageId, title: «{titre} (bifurcation)»})` + open it in a new tab. Forks start without undo history (verified). A fork runs in a new process, so it also loses the "pour cette session" permission grants (verified). The dialog says so (`fork.grants`), and the first send pays the cache cost of E2.
- ***Résumer à partir d'ici*** (a model call) is v2 and would carry a ↯ tag.

### 8.5 *Ouvrir dans le terminal*, and editing from both places

- **What it does.**
  - Stops the chat's process (→ `cold` + `external`).
  - Opens Windows Terminal (`wt -d <cwd>`), falling back to `powershell -NoProfile`, running `claude --resume <id>` in the recorded working folder.
  - Uses a clean environment: `CLAUDE_CONFIG_DIR` is set for a named profile and **removed** for the default profile, because setting it to `~\.claude` switches to the wrong global config (the on-disk data research item 1). The user's profile defines `claude-*` functions, hence `-NoProfile`.
- **While the terminal is open:** the chat shows the badge *Ouvert dans le terminal* with the registry status (E19). The composer is disabled with *Fermez la session du terminal pour continuer ici* + *Reprendre ici quand même*.
- **When the terminal exits** (its registry entry disappears): the transcript is reloaded.
- `claude --resume <id>` opens app (`sdk-ts`) sessions even though the terminal picker hides them (verified): SDK sessions are left out of the picker and `--continue`, but resume by id works.
- **Alternative:** *Copier la commande* copies the same command line for a terminal the user already has open, as the web app's *Open in › Terminal* does.

### 8.6 *Continuer sur un autre compte* (feasible, explicit, costed)

```
┌ Continuer sur un autre compte ──────────────────────────────────────────── Échap ┐
│ « Refacto auth » · Perso · ~84 k tokens de contexte                              │
│ Vers : (●) ▌E Entreprise · 5 h 14 %     ( ) ▌2 Perso 2 — non connecté               │
│ Ce qui va se passer :                                                            │
│  • Une copie du chat est créée sur Entreprise ; l'original reste intact.            │
│  • Le premier message relira ~84 k tokens sans cache sur Entreprise (une fois).     │
│  • Non copiés : annulation, autorisations de session, tâches, file d'attente.    │
│  • Les outils, MCP et skills de Entreprise peuvent différer.                        │
│  • Même dossier de travail : C:\…\Desktop\SidMultiClaude                         │
│                                         [Annuler]  [Continuer sur Entreprise ⏎]     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Mechanism (E24, verified with the CLI on logged-out temporary profiles):** Claude Code makes the copy itself; **the app never writes into a profile.**
  1. The new chat is created as `cold` on the target account. It records only the source transcript's absolute path.
  2. The first send spawns the target account's process with `resume: '<absolute path to the source .jsonl>'` and `forkSession: true` (CLI: `--resume <path> --fork-session`). Claude Code writes the copy under a new id into the target profile, keeps the title, and leaves the source untouched.
  3. The app learns the new session id from `system:init` and links the two chats.
  - Without `forkSession`, the target account would append to the source file in the other profile. The engine must refuse that combination.
  - What the copy does not carry over: undo history (`file-history`), and "pour cette session" grants. `persistedOutputPath` values still point into the source profile, which is fine read-only.
- **Caveat to settle before shipping:**
  - The transcript carries the **system-prompt snapshot** and the source org's attachments (`prompt_snapshot`, `credential_org`). Until the next compaction, the target could keep running with the **source account's instructions and memory paths**.
  - The engine must disable the snapshot on the first resume, or force a fresh prompt (unverified) (§17).
- **Policy:** this is always a deliberate, one-chat action. **The app never switches accounts automatically** because of quota; doing so is a terms grey zone (§1.1).
- **Links between the copies:** both chats get a link chip, *Suite sur Entreprise ↗* and *Copié depuis Perso ↗*.

### 8.7 Rate-limit handling

```
┌ ⧗ Limite de session atteinte sur Perso · réinitialisation à 15:45 (dans 2 h 10) ───────────────┐
│ [Attendre et reprendre automatiquement à 15:45]  [Continuer sur Entreprise…]  [Ignorer]           │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Before the limit:** `allowed_warning` → a toast once per window and account, and the gauge turns amber.
- **Sleeping chats know about limits too.** A transcript tail whose last assistant entry has `error:"rate_limit"` carries `quotaLimits.resetsAt` (the on-disk data research). The row then shows `⧗` *Limite · reprise {heure}* without any process, until that time passes.
- ***Attendre et reprendre automatiquement*** arms a timer and keeps the process alive.
  - At the reset time, the app sends `« Continue la tâche là où tu t'es arrêté. »`, visibly tagged.
  - It re-arms at most twice, which is CLI parity (verified).
  - Banner while armed: *Reprise automatique à 15:45 · Échap pour annuler*.
- ***Continuer sur {compte}…*** opens §8.6.
- **Weekly limits that reset more than 24 h away:** automatic resume is not offered.

### 8.8 Errors and recovery

| Cause (signal) | Banner (FR) | Actions |
|---|---|---|
| `authentication_failed`, `oauth_org_not_allowed` | `err.auth` | *Se reconnecter* (§9.2) |
| `billing_error`, `account_on_hold`, `verification_required` | `err.billing` | *Ouvrir claude.ai* |
| `overloaded` / `server_error` after retries | `err.overloaded` | *Réessayer* |
| `model_not_found` | `err.modelNotFound` | Model menu |
| Unexpected process exit | `err.crash` | *Relancer* · *Voir le journal* (last 200 stderr lines, read-only) |
| `startup_failure_reason` | `err.startup` + a mapped reason (`cwd_unavailable` → *Dossier introuvable*…) | Depends on the reason |
| WebSocket to the local server lost | Top banner `err.ws`, then `err.ws.ok` | Automatic reconnect with backoff; resync by `seq` (§15.4) |

---

## 9. Accounts

### 9.1 *Comptes* panel (`Alt+C`)

```
┌ Comptes ──────────────────────────────────────────────────────────────────────────── Échap ┐
│ ┌─────────────────────────────────────────┐  ┌─────────────────────────────────────────┐   │
│ │ ▌P Perso                    ● Connecté  │  │ ▌E Entreprise                  ● Connecté  │   │
│ │ utilisateur@… · Claude Max                   │  │ prenom.nom@exemple.fr · Team (Entreprise)      │   │
│ │ Profil : ~\.claude (par défaut)         │  │ Profil : ~\.claude-pro                  │   │
│ │ Session (5 h)  ▮▮▮▮▯▯▯▯▯▯ 42 %  ↻ 15:20 │  │ Session (5 h)  ▮▯▯▯▯▯▯▯▯▯ 14 %  ↻ 17:05 │   │
│ │ Semaine        ▮▮▯▯▯▯▯▯▯▯ 18 %  ↻ lun.  │  │ Semaine        ▯▯▯▯▯▯▯▯▯▯  3 %  ↻ jeu.  │   │
│ │ Semaine · Fable ▮▯▯▯▯▯▯▯▯▯ 9 %          │  │ mis à jour à 11:42  [Actualiser]        │   │
│ │ mis à jour il y a 3 min  [Actualiser]   │  │ Chats : 12 · MCP : 1 connecté, 15 à     │   │
│ │ Chats : ◐ 2 · ! 1 · 34 au total         │  │ authentifier                            │   │
│ │ Couleur ■■■■■■■■  Nom [Perso         ]  │  │ ⚠ Charge aussi ~\.claude\CLAUDE.md      │   │
│ │ Par défaut ▸     ⋯ Se déconnecter…      │  │   [Exclure ce fichier (recommandé)]     │   │
│ └─────────────────────────────────────────┘  └─────────────────────────────────────────┘   │
│ ┌─────────────────────────────────────────┐  ┌─────────────────────────────────────────┐   │
│ │ ▌2 Perso 2               ○ Non connecté │  │ + Ajouter un compte                     │   │
│ │ Profil : ~\.claude-perso                │  │   Profils détectés non ajoutés : —      │   │
│ │ [Se connecter]  [Masquer ce profil]     │  │                                         │   │
│ └─────────────────────────────────────────┘  └─────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Detecting and adding accounts

1. **Detection at first run, with no process (E20, the on-disk data research).**
   - Profiles: the default profile (`CLAUDE_CONFIG_DIR` unset → `~\.claude` + `~\.claude.json`) and every `~\.claude-*` folder.
   - Login state:
     - *Connecté* when `<profile>\.credentials.json` **exists** with a size above 0 (existence check only; never opened) **and** the global config has `oauthAccount.accountUuid`;
     - *Non connecté* when neither is present (`.claude-perso` today);
     - *État incohérent* otherwise, for example a token without a profile, with *Se reconnecter*.
     - If the profile uses the Windows Credential Manager backend (`cachedGrowthBookFeatures.tengu_windows_credman`), trust `oauthAccount` alone.
   - **Never run `claude auth status` to detect or poll.** It takes about 5 s and writes `.claude.json` plus a backup into the profile (E16, E22).
   - The card text (email, org, plan label such as « Max 5x » or « Team ») comes from `oauthAccount` at zero cost.
   - The candidates are listed. The user picks which ones become accounts and names them; the name defaults to the org name or « Personnel ».
   - **Expired login** is only known at run time: an assistant `error:"authentication_failed"`, or text matching `/Please run \/login/`. The account then switches to *Reconnexion nécessaire*.
2. **Login (*Se connecter*), E22.**

   ```
   ┌ Se connecter · Perso 2 (~\.claude-perso) ───────────────────────────────── Échap ┐
   │ ⚠ La connexion utilise le compte claude.ai ouvert dans votre navigateur.         │
   │   Pour un autre compte, utilisez une fenêtre InPrivate.                          │
   │ [Ouvrir la page de connexion]  [Ouvrir en InPrivate]  [Copier le lien]           │
   │ Code (si demandé) : [______________________________]  [Valider]                  │
   │ ◌ En attente de la connexion…                                                    │
   └──────────────────────────────────────────────────────────────────────────────────┘
   ```

   - The server spawns `claude auth login` hidden, with piped stdio, a clean env and that profile's `CLAUDE_CONFIG_DIR` (removed for the default profile). It adds `--email` when the user typed one.
   - The dialog shows the URL parsed from the output (`If the browser didn't open, visit: …`). *Coller le code* writes `code#state` to stdin.
   - *Ouvrir en InPrivate* runs `msedge --inprivate <url>`  . Claude Code also opens the default browser by itself; suppressing that is (inferred) and not tested.
   - Success: `Login successful.` with exit code 0, then `.credentials.json` exists and `oauthAccount.accountUuid` appears (watching the global config). The dialog ends on `acc.login.done`, which names the email it got, so a wrong account is visible at once.
   - **Fallback:** a visible PowerShell (`-NoProfile`) running `claude`, then `/login`.
   - **The app never reads, stores or displays a token.**
3. **Duplicate detection.** The same `oauthAccount.accountUuid` in two profiles triggers the warning `acc.dup`.
4. ***Se déconnecter…*** (card `⋯` menu):
   - Confirmation `acc.logout.confirm`.
   - The app first puts that account's live chats to sleep, then runs `claude auth logout` with the same env.
   - Transcripts, history and settings stay on disk (the on-disk data research).
5. ***Masquer ce profil*** hides it in the app only; nothing is deleted.

### 9.3 Usage gauges (no tokens)

| Source | When | Freshness label |
|---|---|---|
| `cachedUsageUtilization` in the profile's global config (E20): `limits[]`, `five_hour`, `seven_day`… | At app start and whenever that file changes (watched). It costs nothing and needs no process. Claude Code rewrites it each time it fetches usage, from the terminal `/usage` too | *instantané de hh:mm*. Past 1 h, greyed with *ancien* (Claude Code itself ignores it after 1 h) |
| `rate_limit_event.rate_limit_info` from any live chat of the account | Passive: first request of each process, and on change | *mis à jour il y a n min* |
| `usage_EXPERIMENTAL…({skipBehaviors:true})` through a live process | *Actualiser*, panel opened, every 10 min while the panel is open | *mis à jour à hh:mm* |
| `/usage` sent as a local command | Fallback if the experimental API disappears | same |

- **No live process for the account:** the snapshot row above is shown first. *Actualiser* starts a short-lived process (no prompt, no model call, about 2–3 s), queries the usage, and closes it. The button is labelled *Actualiser (sans appel modèle)*. That process still runs the profile's SessionStart hooks and leaves their output files on disk (TOKEN-RESEARCH.md §9), so the button is never pressed automatically.
- **Rows:** use the server's `limits[]` when present: `group` / `kind`, labels, `severity` mapped to normal / warning / critical colours, `is_active` = the headline. Otherwise use `five_hour` / `seven_day` / `seven_day_opus|sonnet` / `model_scoped` / `extra_usage`.
- **Headline:** the top-bar ring and the sidebar bar show the `is_active` row, or else 5 h.
- **No plan limits** (API key / third-party provider): `acc.usage.na`, plus session cost only.

### 9.4 Identity system

- **Palette of 8 colours** (§13); the user picks one per account. **Defaults:** default profile → violet, `.claude-pro` → teal, others → the next free colour.
- **Monogram:** 1–2 characters, editable. Default: the initial of the name, or a digit when two names collide.
- **Where identity appears:**
  - sidebar account header and the stripe on every chat row;
  - tab colour bar and monogram;
  - pane header badge and the focused-pane outline tint (10 % of the colour mixed with the accent);
  - composer left border, placeholder and send button;
  - every dialog that names an account.
- **Wrong-account guard:** hint `new.usual` when creating a chat in a folder only ever used with another account. Optional per-folder default account.

### 9.5 Account defaults and diagnostics

- **Defaults:** model, effort and starting mode per account, stored as app metadata. Model and effort start as *Par défaut (réglages du compte)*, which **omits** the option (token parity). Only a value the user picked is passed. The profile files are never written.
- **Diagnostics:**
  - the CLAUDE.md leak (E12) with a toggle, applied as `settings.claudeMdExcludes` for that account's chats. Offered only for **non-default** profiles: on the default profile the same file is that account's own user memory (the on-disk data research);
  - MCP status counts;
  - the default permission mode configured in the profile (read-only display);
  - the CLI version;
  - **retention** (E21): *Claude Code supprime les conversations inactives depuis plus de {n} jours* (`cleanupPeriodDays`, default 30), plus the count of chats that expire within 5 days. The only robust fix is a line in the profile's `settings.json`. The app shows that line with *Copier* but **never writes it**;
  - the **baseline context** of an empty chat for this account (system prompt, tools, skills, MCP, hooks), from a zero-call `getContextUsage('summary')`. Profiles differ a lot, so plugin and skill bloat becomes visible (TOKEN-RESEARCH.md rule 16).

---

## 10. Navigation and keyboard

### 10.1 Quick switcher (`Ctrl+K`)

```
┌ [ fix ci                                                              ] ┐
│ À TRAITER                                                               │
│ › ! ▌E Fix CI                 api-gateway · Bash : npm ci · 3 min       │
│ CHATS                                                                   │
│   ✓ ▌E Fix flaky test         api-gateway · il y a 2 h                  │
│   ○ ▌P Refacto auth (fix)     SidMultiClaude · hier                     │
│ DOSSIERS                                                                │
│   api-gateway (Entreprise)       Alt+⏎ nouveau chat ici                    │
│ ACTIONS                                                                 │
│   > Nouveau chat sur Entreprise                                            │
│ ⏎ ouvrir · Ctrl+⏎ nouveau volet · Maj+⏎ onglet en arrière-plan · Échap  │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Index:** in memory, covering titles, folders, branches, first prompts, accounts and app actions. Matching takes under 5 ms for 5 k items.
- **Ranking:** attention first, then the fuzzy score, then recency.
- **Prefixes:**

  | Prefix | Restricts to |
  |---|---|
  | `>` | Actions (*Nouveau chat sur…*, *Disposition 2 volets*, *Ne pas déranger 1 h*, *Thème sombre*, *Rouvrir l'onglet fermé*, *Tâches d'arrière-plan*, *Tout arrêter*…) |
  | `c:` | Account |
  | `d:` | Folder |
  | `e:` | State: `e:attente`, `e:cours`, `e:erreur`, `e:limite`, `e:veille`, `e:nonlu` |

  Prefixes can be combined (`c:entreprise e:attente`), as in Agent View.

### 10.2 Keyboard map

| Context | Key (FR) | Action | Parity / note |
|---|---|---|---|
| **Global** | `Ctrl+K` | Sélecteur rapide | Common convention |
| | `Alt+N` | Nouveau chat (compte du volet actif) | Desktop Cmd/Ctrl+N; `Ctrl+N` is reserved by Edge |
| | `Alt+R` | Reprendre une session | CLI `--resume` |
| | `Alt+C` | Comptes | — |
| | `Alt+A` | Aller au prochain « À traiter » et focaliser sa carte | Agent View *Needs input* |
| | `Alt+1…9` | Onglet n dans le volet actif (`event.code` Digit/Numpad) | Agent View `Alt+1…9` |
| | `Alt+PgSuiv` / `Alt+PgPréc` | Onglet suivant / précédent | Desktop `Ctrl+Tab` (reserved) |
| | `Alt+W` | Fermer l'onglet (Claude continue) | `Ctrl+W` closes the Edge window |
| | `Alt+Z` | Rouvrir le dernier onglet fermé | VS Code `Ctrl+Maj+T` (reserved) |
| | `Alt+L` | Disposition suivante 1 → 2 → 3 → 4 volets | — |
| | `F6` / `Maj+F6` | Région / volet suivant / précédent | Windows convention |
| | `Alt+B` | Afficher / masquer la barre latérale | — |
| | `Ctrl+,` | Réglages | VS Code (unverified) |
| | `F1`, or `?` outside text fields | Aide des raccourcis | CLI `?`, Desktop `Ctrl+/` |
| **Chat** (focused pane) | `Échap` | Fermer le menu, sinon interrompre le tour (garde la file) | CLI / Desktop |
| | `Échap Échap` | Revenir à… (compositeur vide, chat inactif ; pendant un tour, un double appui ne fait qu'interrompre) | CLI |
| | `Ctrl+O` | Vue suivante : Normal → Détaillé → Focus | CLI / Desktop `Ctrl+O` |
| | `Ctrl+F` | Rechercher dans ce chat (data-backed; finds text in unmounted turns) | — |
| | `Alt+M` | Menu mode d'autorisation, puis `1–5` | CLI `Alt+M` (Windows), Desktop `⌘⇧M` |
| | `Alt+P` | Menu modèle et effort | CLI `Alt+P` |
| | `Alt+T` | Afficher / masquer les tâches | CLI `Ctrl+T` (reserved by Edge) |
| | `Alt+G` | Agents et tâches d'arrière-plan | CLI `/tasks` |
| | `Ctrl+B` | Mettre en arrière-plan la commande / l'agent en cours | CLI `Ctrl+B` |
| | `F2` | Renommer le chat | — |
| | `Alt+↑` / `Alt+↓` (transcript focused) | Message utilisateur précédent / suivant | CLI `{` `}` (those need AltGr on AZERTY) |
| | `Ctrl+Fin` | Aller au dernier message | — |
| **Composer** | `Entrée` / `Maj+Entrée` | Envoyer (ou mettre en file) / nouvelle ligne | CLI |
| | `Ctrl+Entrée` | Envoyer maintenant | CLI `chat:sendNow` |
| | `↑` / `↓` (edge lines) | File d'attente → historique | CLI |
| | `Ctrl+R` | Rechercher dans l'historique des prompts | CLI (if Edge reloads instead, no harm: state lives on the server) |
| | `Ctrl+S` | Mettre de côté / restaurer le brouillon | CLI |
| | `Ctrl+G` | Agrandir le compositeur | CLI (external editor there) |
| | `/`, `@`, `Tab` | Palette, mention, accepter | CLI |
| | `Ctrl+V` | Coller (image comprise) | CLI `Alt+V` on Windows |
| | `Maj+Tab` (option) | Cycler les modes | CLI |
| **Permission card** | `1`/`O` · `2`/`T` · `3`/`N` | Autoriser · Toujours (`←` / `→` scope) · Refuser | CLI 1/2/3; `1` is disabled when `defaultToNo` |
| | `Échap` | Refuser et arrêter | CLI |
| | `Tab` · `V` · `E` | Commentaire · plein écran · modifier avant d'accepter (Edit/Write) | VS Code |
| **Question** | `↑↓` `Espace` `1–4` `Tab` `Ctrl+Entrée` | Naviguer, cocher, choisir, question suivante, envoyer | CLI / VS Code |
| **Plan** | `1` `2` `3` `M` `Ctrl+Entrée` | Approuver + Auto · approuver Manuel · continuer à planifier · modifier · valider | CLI |
| **Sidebar** (`role=tree`) | `↑↓` `→←` `Entrée` `Ctrl+Entrée` `Maj+Entrée` `F2` `Suppr` `Maj+F10` | Naviguer, déplier, ouvrir (volet actif / nouveau volet / arrière-plan), renommer, archiver, menu | Windows tree conventions + type-ahead |
| **Switcher / dialogs** | `Entrée` `Ctrl+Entrée` `Maj+Entrée` `Alt+Entrée` `Échap` | Action principale, nouveau volet, arrière-plan, nouveau chat dans le dossier, fermer | — |
| **Reprendre** (dialog) | `Espace` · `F2` · `Ctrl+B` | Aperçu · renommer · filtrer sur la branche | CLI picker (`Space`, `Ctrl+R`, `Ctrl+B`) |
| **Réveil** (dialog §7.8) | `1` / `2` · `Entrée` · `Échap` | Tel quel / depuis un résumé · envoyer · annuler (le brouillon reste) | CLI *Resume from summary* |

### 10.3 Platform constraints (must be honoured)

- **Reserved by Chromium/Edge.** Pages cannot reliably override them (verified); their behaviour in `--app` windows is (unverified). Never rely on: `Ctrl+N`, `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`, `Ctrl+Maj+Tab`, `Ctrl+PgUp/PgDn`, `Ctrl+Maj+T/N/W`, `Ctrl+1…9`.
- **Also avoid:**
  - `Alt+F` / `Alt+E` (Edge menu);
  - `Alt+←` / `Alt+→` (history navigation);
  - `Alt+D` (address bar);
  - `F12` / `Ctrl+Maj+I/J` (DevTools).
- **AZERTY:**
  - **never bind `Ctrl+Alt+…`** (it is AltGr: `@ # { [ | \ ^ ] } € ~`);
  - never use a key that needs AltGr (`` \ ` [ ] { } | @ # ~ ^ ``);
  - match digits with `event.code` (`Digit1`, `Numpad1`), because unshifted AZERTY digits produce `& é " ' ( - è _ ç à`;
  - match letters with `event.key` (layout-aware).
- **Windows:** `Alt+Maj` (alone) switches the input language, so no `Alt+Maj+…` bindings.
- **Never steal keys:** single-letter keys (`O`, `T`, `N`, `V`, `E`, `M`, `?`) act only when focus is inside a card or dialog, never inside text fields.
- **Test checklist (10 min, manual):** a keydown logger page in an Edge `--app` window, checking that every binding above reaches the page and that `preventDefault` works. Include `F1` (Edge help), `F6` (Edge focus cycling), `Ctrl+R` (reload) and a lone `Alt` tap (menu focus). For any key that cannot be overridden, the fallback is already in the table (`?` for help, `Alt+PgSuiv` for tabs).
- **Already verified in the Edge 154 `--app` probe (platform):** on `http://127.0.0.1:<port>`, `isSecureContext` is true, the Notification API is available (permission `default`), `navigator.setAppBadge` exists, a service worker registers, Trusted Types are enforced, and the vendored ESM libraries load with no build step. Whether the taskbar icon shows the badge without installing the app is still (unverified).

### 10.4 Focus model

- **Regions cycled by `F6`:** top bar → sidebar → pane 1 → pane 2 → … → back to the top bar.
- **Inside a pane, `Tab` order:** header → transcript (as one `role="log"` region; arrow keys scroll) → dock → composer.
- **Remembered focus:** when a pane becomes active, focus returns to its last focused element (default: the composer).
- **Overlays:** dialogs trap focus and restore it on close. Toasts never take focus.

---

## 11. Notifications, sound, badges

| Event | Condition | OS notification (title · body) | Sound | In-app |
|---|---|---|---|---|
| Permission / elicitation needed | Chat not visible in a pane, **or** window unfocused / hidden | `Autorisation requise · {compte} · {titre}` · `{outil} : {résumé}` | Two-tone chime | *À traiter*, `!` badge, title, favicon |
| Question | Same | `Question de Claude · {titre}` · start of the question | Chime | Same |
| Plan | Same | `Plan à valider · {titre}` | Chime | Same |
| Turn finished | Not looking **and** the turn took ≥ 10 s | `Claude a terminé · {titre}` · first 120 chars of `result` | Soft tick (off by default) | `✓` unread |
| Error / limit | Not looking | `Erreur · {titre}` / `Limite atteinte · {compte}` · `Réinitialisation à {heure}` | Low tone | Banner + `✕` |
| Usage warning (`allowed_warning`) | Once per window per account | — | — | Toast `acc.warn80` |
| Background task finished | Chat not visible | — | — | Toast *Tâche terminée : …* |
| Several in under 3 s | — | One grouped notification: `notif.multi` | One sound | — |

- **Implementation.**
  - Web Notifications API on `http://127.0.0.1`, which counts as a secure context; each notification is tagged `chatId:type`, so it replaces the previous one.
  - `silent:true`: the app plays its own sounds with WebAudio oscillators (no audio files), volume set in *Réglages*.
  - Clicking a notification focuses the window and opens the chat in the focused pane.
  - **No action buttons.**
- **Asking for permission.** A non-blocking banner on the **first** relevant event (`notif.enable`), never at load. The permission belongs to the origin, port included, so a port change asks again (§3.4).
- **Terminal chats** (`external`, E19) that become `waiting` or `blocked` get an in-app badge and an *À traiter* row only, never an OS notification: the terminal already signals it.
- **Settings:**
  - *Notifications système*;
  - *Son* plus volume;
  - *Uniquement quand je ne regarde pas* (on);
  - *Ne pas déranger* (1 h / until tomorrow / off), also in the quick switcher and on the top-bar bell;
  - mute per chat and per account.
- **"Looking" means:** `document.visibilityState === 'visible'` **and** `document.hasFocus()` **and** the chat is shown in one of the panes.

---

## 12. Performance

### 12.1 Budgets  

- **Input latency:** under 16 ms with 4 panes streaming.
- **Startup:** first meaningful paint under 300 ms, measured from the local server. The sidebar renders from the app's session index after a stat pass (about 35 ms for 100 files); titles fill in from head/tail reads at 2.5 ms per file (the on-disk data research).
- **Opening a chat:** its last turns are painted within 150 ms, **even for an 80 MB transcript**. A tail-first read of 2 MiB parses in about 14 ms, whereas a full parse of the 82 MB file takes 0.9 s and about 256 MB of heap (the on-disk data research).
- **Initial JS:** about 120 kB gzip. `highlight.js` languages are lazy-loaded.
- **DOM:** under 4,000 nodes per pane.
- **Memory:** client heap under 150 MB with 10 open chats.
- **WebSocket:**
  - at most 20 frames/s per **visible** chat;
  - at most 1 frame/s per hidden chat (state, counters and the activity line only);
  - `tool_progress` heartbeats at most 1/s per tool.

### 12.2 Streaming pipeline

1. **Server**, per chat: buffer `text_delta` / `thinking_delta` and flush every **50 ms** (33–100 adaptive) as one frame `{chat, seq, appends:[{blockId, text}]}`. Every other event is batched within the same tick.
2. **Subscription levels:** `full` for chats shown in a pane, `summary` for the rest. Opening a chat sends `subscribe(full, sinceSeq)`, and the server replays the gap.
3. **Client:** apply frames in `requestAnimationFrame`. Each streaming block holds `settled` (frozen HTML chunks) and `tail`.
   - On each flush, move text up to the last blank line **outside an open code fence** into `settled`. Fence state is tracked incrementally, so only the new text is scanned. Parse only that piece (`marked`) and sanitise it once.
   - The tail is re-parsed at most every 100 ms. **Inside an open fence, the tail is a `<pre>` updated with `textContent`**, which is cheap.
   - At `content_block_stop`, run one full parse of the block and freeze it. Syntax highlighting runs later via `requestIdleCallback`, only for blocks in view (IntersectionObserver), up to 1,500 lines or 50 kB.
4. **Preact + signals:** every block and turn gets its own signal, so a delta updates exactly one node and never re-renders the turn list.

### 12.3 Long transcripts

- **Loading:** the last 30 turns first. A top sentinel loads 20 more each time, preserving the scroll anchor.
  - The server's reader is **tail-first**: it reads backwards in steps of 256 KiB to 2 MiB and rebuilds the `parentUuid` chain of the latest branch (the on-disk data research).
  - `getSessionMessages` (limit / offset) is used only for small transcripts, because it parses the whole file.
  - The median transcript on this machine is 5.2 MB and the largest 82 MB.
- **Branches:** only the chain that leads to the latest leaf is shown. Branches abandoned by retries and rewinds are hidden; 83 of 104 local transcripts have some (the on-disk data research). A branch timeline is v2.
- **Off-screen work:** each turn uses `content-visibility:auto; contain-intrinsic-size:auto 400px`. Beyond 150 mounted turns, the oldest off-screen ones become measured-height placeholders.
- **Lazy mounting:** collapsed groups, outputs, diffs, thinking and subagent transcripts render nothing until expanded.
- **Scrolling:**
  - stick to the bottom only when the user is within 48 px of it;
  - never scroll while text is selected or the user is scrolling;
  - show a pill *↓ Nouveaux messages (n)*.
  - Scroll position is kept per pane and chat (anchor turn id + offset).
- **Ctrl+F** searches the data store, not the DOM, then mounts and highlights the result.
- **Large outputs:** the server sends head and tail of 4 kB each, and the rest on demand.
- **Diffs:** over 400 lines they start collapsed, and they render in chunks of 200.
- **Sidebar:** fixed-height rows, virtualised above 300 rows. The switcher uses its in-memory index.
- **Hidden tabs:** unmounted; their data is kept for 5 min after the tab closes, with a 2 MB cap per chat.
- **Built-in metrics:** quick-switcher action *Afficher les métriques* shows fps, WebSocket frames/s, heap and nodes per pane.

---

## 13. Theme tokens (light / dark)

```css
:root {
  --font-ui: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  --font-mono: "Cascadia Mono", "Cascadia Code", Consolas, monospace;
  --fs-ui: 13px; --fs-chat: 14px; --lh-chat: 1.55; --fs-code: 12.5px;
  --sp-1: 2px; --sp-2: 4px; --sp-3: 6px; --sp-4: 8px; --sp-5: 12px; --sp-6: 16px; --sp-7: 24px;
  --radius-card: 6px; --radius-chip: 4px; --motion: 120ms cubic-bezier(.2,.8,.2,1);

  /* light */
  --bg-app:#F6F7F9; --bg:#FFFFFF; --bg-elev:#FFFFFF; --bg-sunken:#EEF0F3; --bg-hover:#E9ECF1; --bg-active:#DDE3EC;
  --fg:#1B1F24; --fg-muted:#57606A; --fg-subtle:#636C76; --border:#D0D7DE; --border-strong:#AFB8C1;
  --accent:#2F5BD3; --focus:#2F6FED; --on-accent:#FFFFFF;
  --st-run:#1D63D8; --st-needs:#8A5D00; --st-needs-bg:#FFF4D6; --st-done:#177A33; --st-err:#CF222E;
  --st-err-bg:#FFEBE9; --st-limit:#B04600; --st-cold:#7D8590; /* cold = glyph only (≥ 3:1), never text */
  --mode-manual:#57606A; --mode-edits:#8250DF; --mode-plan:#0F766E; --mode-auto:#3F4FB8; --mode-bypass:#CF222E;
  --diff-add-bg:#E6FFEC; --diff-add-fg:#116329; --diff-add-word:#ABF2BC;
  --diff-del-bg:#FFEBE9; --diff-del-fg:#82071E; --diff-del-word:#FFC1C0; --diff-hunk-bg:#DDF4FF;
  --code-bg:#F6F8FA; --code-fg:#1F2328; --selection:#B6D4FE;
  /* account palette (white text ≥ 4.5:1 on each) */
  --acc-1:#7C3AED; --acc-2:#0F766E; --acc-3:#BE185D; --acc-4:#0E7490;
  --acc-5:#4D7C0F; --acc-6:#9A3412; --acc-7:#4338CA; --acc-8:#475569;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* repeat every token of the [data-theme="dark"] rule below */ } }
:root[data-theme="dark"] {
  --bg-app:#0B0D10; --bg:#0F1115; --bg-elev:#161A20; --bg-sunken:#0A0C0F; --bg-hover:#1E242C; --bg-active:#263040;
  --fg:#E6EDF3; --fg-muted:#9DA7B3; --fg-subtle:#8B949E; --border:#2D333B; --border-strong:#444C56;
  --accent:#6C9EFF; --focus:#79A8FF; --on-accent:#0B0D10;
  --st-run:#58A6FF; --st-needs:#E3B341; --st-needs-bg:#3A2E0B; --st-done:#3FB950; --st-err:#F85149;
  --st-err-bg:#3D1414; --st-limit:#F0883E; --st-cold:#6E7681;
  --mode-manual:#9DA7B3; --mode-edits:#A371F7; --mode-plan:#2BB3A3; --mode-auto:#7C8CF8; --mode-bypass:#F85149;
  --diff-add-bg:rgba(46,160,67,.15); --diff-add-fg:#7EE787; --diff-add-word:rgba(46,160,67,.40);
  --diff-del-bg:rgba(248,81,73,.15); --diff-del-fg:#FFA198; --diff-del-word:rgba(248,81,73,.40); --diff-hunk-bg:#0C2D4B;
  --code-bg:#11151A; --code-fg:#E6EDF3; --selection:#264F78;
  --acc-1:#A78BFA; --acc-2:#2DD4BF; --acc-3:#F472B6; --acc-4:#22D3EE;
  --acc-5:#A3E635; --acc-6:#FB923C; --acc-7:#818CF8; --acc-8:#94A3B8;
}
body { background: var(--bg-app); color: var(--fg); font: var(--fs-ui)/1.4 var(--font-ui); }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
@media (forced-colors: active) { /* states keep their glyphs; borders use CanvasText/Highlight */ }
```

- **Contrast, recomputed with the WCAG formula** (a WCAG contrast script). v1.1 corrected `--fg-subtle`, `--st-done`, `--st-limit` and `--st-cold`, because the v1 values failed on some surfaces.
  - White text on all 8 light account colours: 4.99–7.90. Monogram chips always use these darker variants with white text, in both themes. White on the light dark-mode variants would be only 1.5–3.0.
  - **Light text tokens** on `--bg`, `--bg-app`, `--bg-sunken` and `--bg-hover`: `--fg-subtle` ≥ 4.50, `--st-run` ≥ 4.63, `--st-needs` ≥ 4.86, `--st-done` ≥ 4.58, `--st-err` ≥ 4.52, `--st-limit` ≥ 4.76, `--accent` ≥ 4.98.
  - **Dark text tokens** on `--bg`, `--bg-app`, `--bg-elev`, `--bg-sunken` and `--bg-hover`: all ≥ 4.66 (`--st-err` is the lowest, on hover).
  - **Tinted cards:** `--st-needs` on `--st-needs-bg` is 5.26 light and 6.85 dark; `--st-err` on `--st-err-bg` is 4.67 light and 4.79 dark.
  - **Selected rows (`--bg-active`):** state colours drop to 3.9–4.5 in light and 4.0 for red in dark. Text on a selected row therefore uses `--fg` / `--fg-muted` (≥ 4.95). Glyphs keep their state colour (≥ 3:1), except the cold glyph, which turns `--fg-muted`.
  - `--st-cold` is a glyph only: ≥ 3.15 light (on everything except `--bg-active`) and ≥ 3.40 dark.
- **Theme setting:** *Thème : Système / Clair / Sombre*, applied as `data-theme` on `<html>`.
- **Density:** *Compacte* (default: 28 px rows, 13 px UI) / *Confortable* (40 px rows, 14 px).
- **Account colours in dark mode** use the lighter variants for stripes and outlines. Monogram chips keep the dark variant behind white text.

---

## 14. Accessibility

- **Language and formats:** `lang="fr"`; numbers and dates go through `Intl` `fr-FR`: « 84 k », « 0,84 $ », « 15:45 », « il y a 3 min » (`RelativeTimeFormat`).
- **Landmarks:** `nav` (sidebar, `role="tree"` with `treeitem`, `aria-expanded`, roving tabindex), `main` (panes). Each pane is a `region` labelled *Chat : {titre} ({compte})*.
- **Transcript:** a `role="log"` region with `aria-live="off"`. Every turn starts with a visually hidden `h3` (*Vous : …*) for heading navigation. Messages are labelled « Vous », « Claude », « Claude, Bash », « Claude, réflexion » (VS Code pattern).
- **Live announcements:** a separate polite live region, used **only** for:
  - *Claude a terminé de répondre dans {titre}* (once per turn; never during streaming);
  - permission, question and plan requests (with the tool name);
  - start of compaction;
  - *Message mis en file*;
  - errors.
  Restoring a chat announces nothing (VS Code rule).
- **Cards:** `role="group"` + `aria-labelledby`. Options are real `<button>`s whose labels include the scope (« Toujours autoriser npm install pour cette session »).
- **Menus:** `role="menu"` / `menuitemradio`, with arrow keys and type-ahead.
- **Tabs:** `role="tablist"`.
- **Never colour alone:** every state has a glyph and text; contrast is ≥ 4.5:1 for text and ≥ 3:1 for UI components in both themes.
- **Focus:** `:focus-visible` outline of 2 px in `--focus` with a 2 px offset; targets at least 24×24 px.
- **Motion:** `prefers-reduced-motion` removes spinners and pulses; `forced-colors` is supported.
- **Keyboard:** everything works from the keyboard (§10). `Maj+Tab` mode cycling is opt-in, so the text area never traps focus.

---

## 15. Component inventory (Preact + htm, no build step)

### 15.1 Stack

- **Libraries:** `preact` + `preact/hooks` + `@preact/signals` (+ `-core`) + `htm` + `marked` + `DOMPurify`. Optional and lazy: `highlight.js` core plus 8–12 languages.
  - The platform probe also loaded `@speed-highlight/core`, `@leeoniya/ufuzzy` and `diff` (jsdiff) as vendored ESM in Edge 154, with Trusted Types enforced. DOMPurify returned `TrustedHTML` there.
  - The final picks belong to the platform report. The UX needs only four things: a markdown parser, a sanitiser that returns `TrustedHTML`, a lazy highlighter, and a fuzzy matcher for the switcher, the slash palette and `@` (about 50 lines of our own code would also do).
- **Vendored** under `/vendor`, pinned versions, **no CDN at runtime** (offline, privacy, CSP).
- **Imports:** rewrite bare specifiers to relative paths when vendoring, so no import map is needed and `script-src 'self'` stays strict. If an inline import map is kept instead, add its `sha256` hash to the CSP.
- **Diffs:**
  - results: rendered from `structuredPatch`, no library;
  - previews: an LCS line diff of about 80 lines of our own code, plus word-level highlight on paired lines.
- **File layout:**
  - `index.html`, `app.js`, `store.js` (signals), `ws.js`, `keymap.js`, `format.js` (Intl);
  - `md.js` (streaming markdown);
  - `components/*.js`, one file per component group;
  - `styles/tokens.css`, `styles/app.css`.

### 15.2 Components

| Component | Responsibility | Key inputs (signals / props) |
|---|---|---|
| `App` | Shell, theme, global keymap, overlays host | `ui`, `settings` |
| `TopBar` | Toggle, switcher trigger, global counters, account rings, Do-not-disturb, settings | derived `attention`, `accounts` |
| `StatusBar` | Processes, RAM, cap, connection, view, theme | `procStats`, `ws` |
| `ConnectionBanner` | WebSocket reconnect / resync | `ws.state` |
| `Sidebar` / `SidebarRail` | Resizable tree / collapsed rail | `ui.sidebar` |
| `SidebarFilter` | Filter, grouping menu | `ui.sidebar.filter` |
| `AttentionSection`, `PinnedSection` | Derived lists | `attention`, `pinned` |
| `AccountGroup` | Header (usage bar, login, `+`) and folders | `account`, `chatsByFolder` |
| `FolderGroup`, `ChatRow` | Rows, hover actions, context menu | `chat.meta`, `chat.state` |
| `TabStrip`, `Tab`, `TabOverflow` | Working set, drag and drop | `ui.tabs` |
| `PaneGrid`, `Pane` | Layouts, splitters, focus, drop target | `ui.layout`, `ui.panes` |
| `PaneHeader` | Badge, `TitleEditor`, `FolderChip`, `ModelMenu`, `ModeMenu`, `ContextGauge`, `CacheClock`, `CostChip`, `PaneMenu`, `StopButton` | `chat.*` |
| `PaneBanners` | Bypass, elsewhere, limit, auth, trust | `chat.state`, `chat.flags` |
| `Transcript` | Scroller, paging sentinel, stick-to-bottom, `NewMessagesPill`, search highlights | `chat.transcript` |
| `Turn`, `TurnFooter` | Turn wrapper (`content-visibility`), usage line | `turn` |
| `UserMessage` | Variants by origin; attachments | `msg` |
| `AssistantText` | Streaming markdown (settled + tail) | `block` signal |
| `ThinkingBlock`, `ToolGroup` | Collapsible | `block`, `group` |
| `ToolCard` + `BashCard`, `ReadCard`, `EditCard`, `DiffView`, `WriteCard`, `SearchCard`, `WebCard`, `AgentCard`, `WorkflowCard`, `TodoCard`, `QuestionSummary`, `PlanSummary`, `GoalRow`, `McpCard`, `DeniedRow`, `GenericToolCard` | Per-tool rendering (§5.4) | `toolUse`, `toolResult` (summary; heavy fields fetched on expand) |
| `SystemRow` | Compaction, interrupt, clear, retry, notices, cache-miss | `event` |
| `PendingDock`, `PermissionCard`, `QuestionForm`, `PlanApproval`, `ElicitationForm` | §6 | `chat.pending[]` |
| `TodoStrip`, `AgentsChip`, `AgentsDrawer`, `ChangesPanel` | §7.1, §7.9, session diff list | `chat.todos`, `chat.tasks`, `chat.changes` |
| `ContextPopover`, `UsagePopover`, `SessionInfoPopover` | Details (no tokens) | `chat.metrics`, `account.usage` |
| `Composer` + `PromptEditor`, `AttachmentChips`, `QueueList`, `SlashPalette`, `MentionPopup`, `HistorySearch`, `ComposerFooter` | §7 | `chat.composer`, `chat.queue` |
| `QuickSwitcher` | §10.1 | `searchIndex` |
| `NewChatDialog` + `AccountPicker`, `FolderPicker`, `DirBrowser`, `ModelPicker`, `ModePicker`, `TrustDialog` | §8.1 | `accounts`, `recentFolders` |
| `ResumeBrowser` | §8.2 | `sessionsIndex` |
| `AccountsPanel` + `AccountCard`, `UsageMeter`, `LoginFlow`, `AddAccountWizard` | §9 | `accounts` |
| `SettingsPanel` | Performance, notifications, keyboard, appearance, danger zone | `settings` |
| `RewindDialog`, `ContinueOnAccountDialog`, `ModelSwitchConfirm`, `WakeDialog` (§7.8), `LoginDialog` (§9.2), `ConfirmDialog` (incl. typed confirmation), `Lightbox`, `KeymapOverlay` | Overlays | various |
| `CapChoice` (inline, in the composer area), `FlagBadges` (`⌨ ⌛ ⇄ ⚙ ≡`), `GoalChip` | Process-cap choice (§4.2), flag badges (§4.4), active goal (§5.4) | `procStats`, `chat.state.flags`, `chat.meta.goal` |
| `ToastHost` | Toasts with undo actions | `toasts` |
| `NotificationManager`, `FaviconBadger`, `TitleUpdater`, `SoundPlayer`, `PerfOverlay` | Non-visual or debug | derived `attention`, `settings` |

### 15.3 Client store (signals), as a sketch

```js
accounts:  signal([{ id, name, color, monogram, configDir /* null = default */, login:{state,email,org,plan},
                     usage:{rows, headline, updatedAt, source}, defaults:{model,effort,mode}, diag:{…} }])
chats:     Map<chatId, { meta: signal({sessionId, accountId, cwd, title, branch, origin, pinned, archived, keepAlive, createdAt, lastActivity}),
                         state: signal({primary, sub, since, flags:{unread,bgTasks,external /* null | {status,kind,pid} */,queued,muted,expiring /* days left */,foreignOwner}}),
                         pending: signal([{requestId, kind, toolName, input, opts, since}]),
                         metrics: signal({contextTokens, contextWindow, contextPct, cacheWarmUntil, costUsd, lastUsage}),
                         transcript: { turns: signal([...]), hasMore, oldestUuid },
                         todos, tasks, changes, composer:{ draft, attachments }, queue: signal([...]),
                         settings: signal({model, effort, mode, viewMode}) }>
ui:        signal({ tabs:[chatId], layout:1|2|3|4, panes:[{chatId}], focusedPane, sidebar:{width,collapsed,grouping,filter},
                    overlays:[…], theme, density })
derived:   attention, counts, windowTitle, faviconSpec, searchIndex
```

### 15.4 The UX contract with the server (events the UI needs)

- **Server → UI:**
  - `chat.state`: primary, sub, flags, pending summary, `since`;
  - `chat.delta`: `seq`, block appends;
  - `chat.block`: a completed block, or a tool_use / tool_result pair with `tool_use_result`;
  - `chat.pending.add` / `chat.pending.remove`: `requestId`, full payload, cancellation reason;
  - `chat.metrics`: usage, context, cache timestamps;
  - `chat.meta`: title, branch, model, mode;
  - `chat.tasks`: started / progress / updated / notification / changed;
  - `chat.queue`: `command_lifecycle`;
  - `chat.system`: compaction, retry, informational, notifications…;
  - `account.usage` (with `source`: snapshot / event / refresh, and its age), `account.login` (state, plus the login-dialog steps: URL, waiting, done with email, error), `account.identity` (from `oauthAccount`), `proc.stats` (including the `cap.choice` request), `sessions.changed`;
  - `chat.external`: registry status for chats held by another process (E19);
  - `chat.wakeInfo`: last context, the estimate N, idle time and whether the wake dialog applies (§7.8);
  - `ui.state`: the saved layout and drafts at connect time (§3.4).
- **UI → server:**
  - messages: `send{…, wakeChoice?: 'asIs' | 'summary'}`, `sendNow`, `interrupt`, `decide{requestId, result}`, `cancelQueued{uuid}`;
  - `prespawn{chatId}`, sent on the first keystroke in a sleeping chat; the server may answer with `cap.choice`;
  - session settings: `setMode`, `setModel{model, effort}`, `setViewMode`;
  - tasks: `stopTask`, `background{toolUseId}`;
  - history: `rewind{uuid, action, dryRun}`, `fork`, `continueOnAccount{targetAccountId}` (the fork happens on first send, E24);
  - housekeeping: `rename` (the server picks live or standalone, §8.3), `pin`, `archive`, `delete`, `sleep`, `wake`, `openInTerminal`, `copyResumeCommand`;
  - accounts: `login{accountId, email?}`, `loginCode{accountId, code}`, `logout{accountId}`, `refreshUsage{accountId}`;
  - persistence: `saveUiState{…}` and `saveDraft{chatId, draft}`, both debounced;
  - `subscribe{chatIds, level, sinceSeq}`, `listSessions`, `readTranscript{id, before, limit}` (tail-first), `fetchToolDetail{chatId, toolUseId, field}`, `fileIndexQuery{cwd, q}`, `dirList{path}`.
- **Every frame carries a monotonic `seq` per chat.** After a reconnect the client sends `subscribe` with its last `seq`, and the server replays the gap or a snapshot.

---

## 16. French copy table

### Navigation and structure

| Key | French |
|---|---|
| nav.attention | À traiter |
| nav.pinned | Épinglés |
| nav.newChat | Nouveau chat |
| nav.resume | Reprendre une session… |
| nav.accounts | Comptes |
| nav.settings | Réglages |
| nav.filter | Filtrer les chats… |
| nav.showMore | Afficher plus ({n}) |
| nav.showArchived | Afficher les archivés |
| nav.grouping | Regrouper : par compte › dossier · par dossier · par état |
| search.placeholder | Rechercher ou aller à… |
| tabs.close | Fermer l'onglet (Claude continue) |
| tabs.reopen | Rouvrir l'onglet fermé |
| layout.n | 1 volet · 2 volets · 3 volets · 4 volets |
| status.procs | {n} processus actifs ≈ {ram} (max {max}) |
| status.procs.lowMem | {n} processus actifs ≈ {ram} (max {max} — mémoire faible) |
| status.server | Serveur local connecté |

### States

| Key | French |
|---|---|
| state.cold | En veille |
| state.cold.hint | Le prochain message relancera Claude (~2 s). |
| state.new | Pas encore démarré |
| state.starting | Démarrage… |
| state.idle | Prêt |
| state.done | Terminé |
| state.running | En cours |
| state.requesting | Requête… |
| state.thinking | Réflexion… |
| state.writing | Rédaction… |
| state.tool | Exécute {outil}… ({durée}) |
| state.compacting | Compaction de la conversation… |
| state.retry | Nouvelle tentative {n}/{max} dans {s} s ({motif}) |
| state.stopping | Arrêt… |
| state.bg | Prêt · {n} tâches en arrière-plan |
| state.needsPermission | Autorisation requise |
| state.needsAnswer | Question en attente |
| state.needsPlan | Plan à valider |
| state.rateLimited | Limite atteinte |
| state.error | Erreur |
| state.external | Ouvert dans le terminal |
| state.waiting | en attente depuis {durée} |

### Pane header

| Key | French |
|---|---|
| header.rename | Renommer (F2) |
| header.folder.copy | Copier le chemin |
| header.folder.explorer | Ouvrir dans l'Explorateur |
| header.folder.vscode | Ouvrir dans VS Code |
| header.folder.terminal | Ouvrir un terminal ici |
| header.effort | Effort : Bas · Moyen · Haut · Très haut · Max |
| header.context | Contexte : {pct} % ({used} / {max} tokens) |
| header.context.auto | Compaction automatique vers {pct} % |
| header.context.compact | Compacter maintenant… (appel modèle) |
| header.cache.warm | Cache chaud · encore {min} min |
| header.cache.soon | Le cache expire dans {min} min |
| header.cache.cold | Cache expiré : le prochain message relira ~{tokens} tokens sans cache |
| header.cost | ≈ {coût} — coût API estimé, non facturé sur abonnement |
| header.stop | Arrêter (Échap) |
| menu.view | Vue : Normal · Détaillé · Focus |
| menu.search | Rechercher dans ce chat (Ctrl+F) |
| menu.rewind | Revenir à… (Échap Échap) |
| menu.fork | Bifurquer depuis ici |
| menu.continue | Continuer sur un autre compte… |
| menu.terminal | Ouvrir dans le terminal |
| menu.export | Exporter en Markdown |
| menu.info | Infos de session |
| menu.sleep | Mettre en veille |
| menu.keepAlive | Garder actif |
| menu.mute | Désactiver les notifications de ce chat |
| info.instructions | Instructions chargées |
| info.leak | Fichier d'un autre profil : {chemin} |

### Composer

| Key | French |
|---|---|
| composer.placeholder | Écrire à Claude ({compte})… — / commandes · @ fichiers |
| composer.placeholder.plan | Mode Plan : Claude explore et propose un plan, sans rien modifier |
| composer.placeholder.running | Claude travaille — Entrée met votre message en file |
| composer.send | Envoyer · {monogramme} |
| composer.queue | Mettre en file |
| composer.sendNow | Envoyer maintenant (Ctrl+Entrée) |
| composer.stop | Arrêter (Échap) |
| composer.attach | Joindre un fichier ou une image |
| queue.header | En file ({n}) |
| queue.item | En file · ↑ pour reprendre |
| queue.edit / queue.remove | Modifier / Retirer de la file |
| queue.taken | Déjà pris en compte |
| queue.removed | Retiré |
| composer.stash | Brouillon mis de côté (Ctrl+S pour le restaurer) |
| composer.history | Rechercher dans vos prompts… |
| composer.image | ≈ {n} tokens |
| composer.image.tooMany | Beaucoup d'images : les plus anciennes seront retirées du contexte (cache recalculé). |
| composer.outside | Hors du dossier : Claude demandera l'autorisation de le lire |
| composer.wake | Ce chat est en veille : l'envoi relance Claude et remet en cache ~{tokens} tokens. |
| composer.cacheCold | Cache expiré : ce message relira ~{tokens} tokens sans cache. |
| composer.contextFull | Contexte presque plein ({pct} %) : la compaction automatique va se déclencher. |
| composer.invisible | {n} caractères invisibles retirés du texte collé |
| slash.groups | Commandes intégrées · Skills · Plugins · MCP |
| slash.local | local |
| slash.model | ↯ modèle |
| slash.clear.confirm | Effacer la conversation ? Une nouvelle session démarre ; l'ancienne reste dans « Reprendre ». |
| mention.empty | Aucun fichier correspondant |
| tasks.strip | Tâches {fait}/{total} · {activeForm} |
| agents.chip | {n} agents |
| agents.title | Agents & tâches d'arrière-plan |
| agents.stopAll | Tout arrêter |
| agents.output | Voir la sortie |
| agents.transcript | Ouvrir la transcription |
| agents.interrupted | Tour interrompu. {n} agents continuent en arrière-plan. |

### Permissions, questions, plans, modes

| Key | French |
|---|---|
| perm.title | Autorisation requise · {outil} |
| perm.wants | Claude veut {action} : {libellé} |
| perm.subagent | Demandé par le sous-agent « {nom} » |
| perm.allow | Autoriser |
| perm.always | Toujours autoriser |
| perm.scope.session | pour cette session |
| perm.scope.local | pour ce projet (local, non partagé) |
| perm.scope.project | pour ce projet (partagé) |
| perm.scope.user | pour tous les projets de ce compte |
| perm.scope.user.warn | Écrit dans le profil du compte. |
| perm.allEdits | Autoriser toutes les modifications (cette session) |
| perm.deny | Refuser… |
| perm.deny.placeholder | Que doit faire Claude à la place ? (facultatif) |
| perm.deny.default | L'utilisateur a refusé. |
| perm.denyStop | Refuser et arrêter le tour (Échap) |
| perm.editBefore | Modifier avant d'accepter |
| perm.editNote | Claude sera informé de votre modification. |
| perm.switchAuto | Autoriser et passer en mode Auto |
| perm.reason | Raison : {raison} |
| perm.blockedPath | Chemin hors du dossier autorisé : {chemin} |
| perm.askRule | Règle « demander » : {règle} |
| perm.mcp | Serveur MCP « {nom} » ({source}) |
| perm.stack | {i} sur {n} |
| perm.cancelled | Demande annulée (tour interrompu) |
| ask.title | Claude vous pose {n} question(s) |
| ask.multi | (plusieurs choix) |
| ask.other | Autre… |
| ask.note | Ajouter une note |
| ask.submit | Envoyer les réponses (Ctrl+Entrée) |
| ask.free | Répondre librement |
| ask.skip | Ne pas répondre |
| ask.skip.msg | L'utilisateur a choisi de ne pas répondre. |
| ask.done | Question · « {question} » → {réponse} |
| plan.title | Plan proposé |
| plan.yesAuto | Oui, et passer en mode Auto |
| plan.yesEdits | Oui, accepter les modifications automatiquement |
| plan.yesBypass | Oui, et passer en mode Contournement |
| plan.yesManual | Oui, valider chaque modification (Manuel) |
| plan.no | Non, continuer à planifier… |
| plan.no.placeholder | Que faut-il changer dans le plan ? |
| plan.edit | Modifier le plan |
| plan.full | Plein écran |
| plan.approved | Plan approuvé · mode {mode} |
| mode.menu | Mode d'autorisation |
| mode.default | Manuel — Demande avant chaque modification ou commande |
| mode.acceptEdits | Modifs auto — Accepte les modifications de fichiers ; demande pour les commandes |
| mode.plan | Plan — Explore et propose un plan, sans rien modifier |
| mode.auto | Auto — Un classifieur valide les actions à votre place (consomme un peu de quota) |
| mode.bypass | Contournement — Aucune confirmation, environnements isolés uniquement |
| mode.bypass.banner | ⚠ Contournement des autorisations actif : Claude agit sans rien demander. |
| mode.bypass.confirm | Claude exécutera toutes les actions sans demander, y compris supprimer des fichiers et accéder au réseau. À réserver à une VM ou un conteneur isolé. Tapez CONTOURNER pour confirmer. |
| mode.bypass.org | Désactivé par votre organisation |
| mode.recentDenied | Refusées récemment ({n}) |
| mode.auto.blocked | Action bloquée par le mode Auto : {raison} |
| mode.auto.retry | Réessayer en validant moi-même |
| mode.auto.paused | Mode Auto en pause après plusieurs blocages : Claude vous demandera. |
| elicit.url | Le serveur MCP « {nom} » demande une authentification. |
| elicit.done | J'ai terminé |

### Tool summaries and system events

| Key | French |
|---|---|
| tool.read | A lu {fichier}{plage} |
| tool.read.n | A lu {n} fichiers |
| tool.edit | A modifié {fichier} (+{a} −{d}) |
| tool.write.new | A créé {fichier} ({n} lignes) |
| tool.write.upd | A réécrit {fichier} (+{a} −{d}) |
| tool.bash | A exécuté : {description} |
| tool.bash.run | Exécute : {description}… ({durée}) |
| tool.bash.exit | Code de sortie {code} |
| tool.bash.bg | En arrière-plan |
| tool.bash.toBg | Exécuter en arrière-plan (Ctrl+B) |
| tool.bash.timeout | Passée en arrière-plan après {s} s |
| tool.grep | A cherché « {motif} » → {n} fichiers, {m} occurrences |
| tool.glob | A listé « {motif} » → {n} fichiers |
| tool.fetch | A lu la page {domaine} ({code}) |
| tool.search | A cherché sur le web « {requête} » → {n} résultats |
| tool.agent | Sous-agent {type} : {description} |
| tool.agent.done | Sous-agent terminé ({durée}, {tokens} tokens, {n} outils) |
| tool.todo | Liste de tâches mise à jour ({fait}/{total}) |
| tool.mcp | {serveur} › {outil} |
| tool.mcp.n | A appelé {serveur} {n} fois |
| tool.skill | A utilisé la skill « {nom} » |
| tool.group | {n} actions ({détail}) |
| tool.error | Échec de {outil} |
| tool.showAll | Afficher tout ({n} lignes) |
| tool.sideBySide | Côte à côte |
| tool.quote | Citer dans le message |
| tool.userModified | Modifié par vous avant acceptation |
| md.remoteImage | Image distante bloquée ({domaine}) — Ouvrir dans le navigateur |
| md.copy | Copier · Copié ! |
| sys.compacted | Conversation compactée ({auto\|manuelle}) · {avant} → {après} tokens · {durée} |
| sys.summary | Voir le résumé |
| sys.beforeCompact | Avant la compaction (hors contexte) |
| sys.interrupted | Interrompu par vous |
| sys.cleared | Conversation effacée — nouvelle session |
| sys.refusal | Réponse refusée par {m1}, reprise avec {m2} |
| sys.peer | Message de la session « {nom} » |
| sys.taskDone | Tâche d'arrière-plan terminée : {description} |
| sys.cacheMiss | Cache manqué : {n} tokens réécrits (cause probable : {cause}) |
| sys.cause | changement de modèle · reprise · compaction · expiration du cache · images |
| sys.footer | {durée} · {in} entrée ({cache} % cache) · {out} sortie · ≈ {coût} |
| sys.autoResume | Reprise automatique programmée par vous |
| sys.memories | Souvenirs utilisés ({n}) |
| sys.newMessages | ↓ Nouveaux messages ({n}) |

### Accounts and usage

| Key | French |
|---|---|
| acc.connected / acc.notConnected | Connecté / Non connecté |
| acc.authError | Reconnexion nécessaire |
| acc.login / acc.relogin | Se connecter / Se reconnecter |
| acc.add | Ajouter un compte |
| acc.detected | Profils détectés non ajoutés |
| acc.hide | Masquer ce profil |
| acc.profile | Profil : {chemin} |
| acc.profile.default | (par défaut) |
| acc.usage.session | Session (5 h) |
| acc.usage.week | Semaine |
| acc.usage.weekModel | Semaine · {modèle} |
| acc.usage.extra | Crédits supplémentaires |
| acc.usage.resets | réinitialisation {quand} |
| acc.usage.updated | mis à jour {quand} |
| acc.usage.refresh | Actualiser (sans appel modèle) |
| acc.usage.na | Usage indisponible pour ce type de connexion |
| acc.chats | Chats : {détail} |
| acc.color / acc.name / acc.monogram | Couleur / Nom affiché / Monogramme |
| acc.defaults | Par défaut pour les nouveaux chats |
| acc.leak | Ce compte charge aussi {fichier} (instructions d'un autre profil) dans les dossiers sous votre répertoire personnel. |
| acc.leak.fix | Exclure ce fichier (recommandé) |
| acc.mcp | MCP : {ok} connecté(s), {auth} à authentifier |
| acc.dup | Ce profil semble être le même compte que « {nom} ». |
| acc.login.step1 | Une page de connexion Anthropic s'ouvre dans votre navigateur. |
| acc.login.step2 | Si rien ne s'ouvre : Ouvrir le lien · Copier le lien |
| acc.login.code | Coller le code de connexion |
| acc.login.waiting | En attente de la connexion… |
| acc.login.done | Connecté en tant que {email} ({formule}) |
| acc.warn80 | {compte} : {pct} % de la limite de session utilisée (réinitialisation {quand}) |
| limit.banner | Limite {de session\|hebdomadaire} atteinte sur {compte} · réinitialisation à {heure} (dans {durée}) |
| limit.wait | Attendre et reprendre automatiquement à {heure} |
| limit.armed | Reprise automatique à {heure} · Échap pour annuler |
| limit.continue | Continuer sur {compte}… |
| limit.ignore | Ignorer |
| limit.reset | Limite réinitialisée sur {compte} |

### Dialogs

| Key | French |
|---|---|
| new.title | Nouveau chat |
| new.account / new.folder / new.model / new.mode | Compte / Dossier / Modèle / Mode |
| new.browse | Parcourir… |
| new.recent | Récents |
| new.usual | Ce dossier est habituellement utilisé avec {compte}. |
| new.home | Votre dossier personnel entier : déconseillé (beaucoup de fichiers, instructions d'autres profils). |
| new.missing | Ce dossier n'existe pas. |
| new.modelDefault | Par défaut ({modèle}) |
| new.name | Nom (facultatif) — sinon tiré de votre premier message |
| new.prompt | Que doit faire Claude ? |
| new.create | Créer et envoyer |
| new.createEmpty | Créer sans envoyer |
| new.ram | Chaque chat actif utilise un processus Claude (~240 Mo). |
| trust.title | Faire confiance à ce dossier ? |
| trust.body | Claude pourra lire, modifier et exécuter des fichiers dans {chemin}. Les réglages, hooks et serveurs MCP du projet (.claude/, .mcp.json) seront chargés. |
| trust.ok / trust.cancel | Faire confiance / Annuler |
| resume.title | Reprendre une session |
| resume.search | Rechercher (titre, dossier, branche, premier message)… |
| resume.origin | Terminal · Desktop · App · Autres (-p, SDK) |
| resume.preview | Aperçu (lecture seule) |
| resume.open / resume.openPane / resume.openTerm | Ouvrir / Ouvrir dans un nouveau volet / Ouvrir dans le terminal |
| resume.elsewhere | Cette conversation est ouverte ailleurs ({où}). L'utiliser à deux endroits mélange les messages. |
| resume.force | Ouvrir quand même |
| term.locked | Fermez la session du terminal pour continuer ici. |
| term.force | Reprendre ici quand même |
| rewind.title | Revenir à un point précédent |
| rewind.both | Restaurer le code et la conversation |
| rewind.conv | Restaurer la conversation (garder le code actuel) |
| rewind.code | Restaurer le code (garder la conversation) |
| rewind.fork | Bifurquer : nouveau chat depuis ce message (l'original reste intact) |
| rewind.sim | Simulation : {n} fichier(s) restauré(s) (+{a} −{d}) |
| rewind.warn | Les changements faits par des commandes (Bash) et par des sous-agents ne sont pas annulés. |
| rewind.done | Retour effectué. Votre message d'origine est dans le compositeur. |
| rewind.fallback | Retour partiel impossible : la session a été reprise telle quelle. |
| fork.title | {titre} (bifurcation) |
| cont.title | Continuer sur un autre compte |
| cont.to | Vers |
| cont.b1 | Une copie du chat est créée sur {compte} ; l'original reste intact. |
| cont.b2 | Le premier message relira ~{tokens} tokens sans cache sur {compte} (une fois). |
| cont.b3 | Non copiés : historique d'annulation, tâches en arrière-plan, file d'attente. |
| cont.b4 | Les outils, MCP et skills de {compte} peuvent différer. |
| cont.b5 | Même dossier de travail : {chemin} |
| cont.ok | Continuer sur {compte} |
| cont.linkTo / cont.linkFrom | Suite sur {compte} ↗ / Copié depuis {compte} ↗ |
| model.confirm.title | Changer de modèle maintenant ? |
| model.confirm.body | Le cache de ce chat est chaud encore {min} min. Avec {modèle}, le prochain message relira toute la conversation (~{tokens} tokens) sans cache. |
| model.confirm.ok | Changer quand même |
| effort.confirm.body | Sur ce modèle, changer l'effort invalide le cache : ~{tokens} tokens seront relus. |
| chat.pin / chat.unpin | Épingler / Désépingler |
| chat.archive | Archiver |
| chat.archived | Chat archivé · Annuler |
| chat.delete | Supprimer définitivement… |
| chat.delete.confirm | Supprimer la transcription de « {titre} » du disque ? Cette action est irréversible. |
| chat.copyId | Copier l'ID de session |
| chat.sleep | « {titre} » mis en veille pour libérer de la mémoire (max {n} processus) |
| common | Annuler · Valider · Fermer · Réessayer · Plus… · Copié |

### Notifications, errors, settings, announcements

| Key | French |
|---|---|
| notif.perm | Autorisation requise · {compte} · {titre} — {outil} : {résumé} |
| notif.ask | Question de Claude · {titre} |
| notif.plan | Plan à valider · {titre} |
| notif.done | Claude a terminé · {titre} — {extrait} |
| notif.error | Erreur · {titre} |
| notif.limit | Limite atteinte · {compte} — Réinitialisation à {heure} |
| notif.multi | {n} chats ont besoin de vous |
| notif.enable | Activer les notifications de bureau pour savoir quand Claude a besoin de vous ? · Activer · Plus tard |
| notif.dnd | Ne pas déranger · 1 h · Jusqu'à demain · Désactivé |
| err.auth | Session expirée sur {compte} — reconnectez-vous. |
| err.billing | Problème de facturation ou de compte sur {compte}. |
| err.overloaded | Les serveurs d'Anthropic sont surchargés — nouvelle tentative automatique. |
| err.modelNotFound | Modèle indisponible pour ce compte — choisissez-en un autre. |
| err.crash | Le processus Claude s'est arrêté (code {code}). |
| err.startup | Claude n'a pas pu démarrer : {raison} |
| err.cwd | Dossier introuvable |
| err.ws | Connexion au serveur local perdue — reconnexion… |
| err.ws.ok | Reconnecté |
| err.actions | Réessayer · Relancer · Voir le journal · Se reconnecter |
| set.perf | Performance |
| set.reap | Mettre en veille {n} min après la dernière requête |
| set.reap.warn | En dessous de 60 min, réveiller un chat réécrit le cache de la conversation. |
| set.maxProcs | Processus actifs maximum (≈ 240 Mo chacun) |
| set.prewarm | Démarrage instantané (1 processus prêt par compte, ≈ 250 Mo) |
| set.suggestions | Suggestions de prompt (appel modèle léger) |
| set.agentSummaries | Résumés de progression des sous-agents (appel modèle) |
| set.bypass | Autoriser le mode Contournement (dangereux) |
| set.shiftTab | Maj+Tab change le mode (comme le terminal) |
| set.ctrlEnter | Envoyer avec Ctrl+Entrée |
| set.notifs | Notifications système · Son · Volume · Uniquement quand je ne regarde pas |
| set.theme | Thème : Système · Clair · Sombre |
| set.density | Densité : Compacte · Confortable |
| set.view | Vue par défaut : Normal · Détaillé · Focus |
| a11y.done | Claude a terminé de répondre dans {titre}. |
| a11y.perm | Autorisation requise : {outil}, dans {titre}. |
| a11y.ask | Claude pose une question dans {titre}. |
| a11y.plan | Plan à valider dans {titre}. |
| a11y.queued | Message mis en file. |
| a11y.compacting | Compaction de la conversation en cours. |
| a11y.working / a11y.ready | Claude travaille. / Prêt. |
| a11y.you / a11y.claude / a11y.thinking | Vous / Claude / Claude, réflexion |

### Added in v1.1 (sleep and wake, other processes, retention, login, new tools)

| Key | French |
|---|---|
| set.prespawn | Démarrer Claude dès la saisie (0 token, ≈ 240 Mo, arrêté après 10 min sans envoi) |
| cap.choice | {n} chats actifs (maximum). Mettre en veille « {titre} » ? Son cache (~{tokens} tokens) devra être recréé à sa reprise. |
| cap.sleep / cap.exceed / cap.cancel | Mettre en veille « {titre} » / Dépasser la limite (+≈ 240 Mo) / Annuler |
| wake.title | Reprendre « {titre} » ? |
| wake.body | Ce chat est inactif depuis {durée} : son cache a expiré (~{contexte} tokens). |
| wake.asIs | Reprendre tel quel — relit ~{tokens} tokens une fois, garde tout le détail |
| wake.summary | Reprendre depuis un résumé — /compact (appel modèle), puis messages plus légers ; certains détails seront perdus |
| wake.never | Ne plus demander |
| state.external.busy / .idle / .waiting / .blocked | Terminal · en cours / Terminal · prêt / Terminal · attend une réponse / Terminal · bloqué |
| state.external.desktop / .bg | Ouvert dans Claude Desktop / Agent en arrière-plan (claude agents) |
| ext.attention | Attend une réponse dans le terminal |
| ext.show | Afficher le terminal |
| ext.closed | Session du terminal fermée : conversation rechargée. |
| term.copy | Copier la commande |
| rename.external | Renommez depuis le terminal tant que la session y est ouverte. |
| flag.expiring | Supprimé dans {n} j |
| flag.expiring.tip | Claude Code supprime les conversations inactives depuis plus de {jours} jours (réglage cleanupPeriodDays). |
| flag.foreignOwner | Lancé avec un autre compte |
| flag.foreignOwner.tip | Ce chat a été lancé avec un autre compte ; le reprendre ici l'exécutera avec {compte}. |
| chat.archive.note | L'archivage ne protège pas de la suppression automatique après {n} jours. |
| limit.cold | Limite · reprise {heure} |
| draft.cleared | Brouillon effacé · Annuler |
| mode.bypass.downgraded | Le mode Contournement n'est jamais réactivé automatiquement : ce chat reprend en mode {mode}. |
| mode.restored | Mode restauré : {mode} |
| fork.grants | Les autorisations « pour cette session » ne sont pas reprises dans la bifurcation. |
| resume.cwdMissing | Le dossier de travail « {chemin} » n'existe plus. Choisir un autre dossier ? |
| plan.reconstructed | Plan reconstitué depuis la réponse |
| goal.proposed | Objectif proposé : « {condition} » |
| goal.accept / goal.reject | Accepter l'objectif / Refuser |
| goal.set / goal.chip | Objectif défini : « {condition} » / Objectif |
| tool.workflow | Workflow « {nom} » · phase {i}/{n} · {agents} agents |
| tool.workflow.script / tool.workflow.remote | Voir le script / Exécuté dans le cloud ↗ |
| tool.toolsearch | A chargé {n} outils |
| tool.sendMessage | Message envoyé à « {nom} » |
| tool.taskStop / tool.taskOutput | A arrêté la tâche {id} / A lu la sortie de {id} |
| tool.denied.user / .rule / .auto / .autoNa / .interrupted | Refusé par vous / Bloqué par une règle / Bloqué par le mode Auto / Mode Auto indisponible / Interrompu |
| tool.image.reencoded | Image recompressée : trop lourde pour l'API |
| login.title | Se connecter · {compte} ({profil}) |
| login.browserWarn | La connexion utilise le compte claude.ai ouvert dans votre navigateur. Pour un autre compte, utilisez une fenêtre InPrivate. |
| login.open / login.inprivate / login.copy | Ouvrir la page de connexion / Ouvrir en InPrivate / Copier le lien |
| login.code | Code (si demandé) |
| login.wrongAccount | Connecté en tant que {email}. Ce n'est pas le bon compte ? Déconnectez-vous puis recommencez en InPrivate. |
| acc.incoherent | État incohérent — reconnectez-vous |
| acc.logout | Se déconnecter… |
| acc.logout.confirm | Se déconnecter de {compte} ? Ses chats actifs seront mis en veille ; les conversations restent sur le disque. |
| acc.usage.snapshot / acc.usage.stale | instantané de {heure} / ancien |
| acc.retention | Claude Code supprime les conversations inactives depuis plus de {n} jours. {m} chat(s) concerné(s) d'ici 5 jours. |
| acc.retention.fix | Pour les garder plus longtemps, ajoutez cette ligne au fichier settings.json du profil (l'application ne le modifie jamais) : |
| acc.baseline | Contexte de départ d'un chat vide : ~{tokens} tokens |
| info.foreignOwner | Lancé avec le compte {email} |

---

## 17. Open items and non-goals

### To verify before or during implementation

| # | Item | How |
|---|---|---|
| 1 | Which bindings in §10.2 reach the page in an Edge `--app` window (`Ctrl+K/O/R/S/F/G/B`, `Alt+letters`, `F1`, `F6`, a lone `Alt` tap) | 10-min keydown logger test; no tokens |
| 2 | ~~Secure context, Notification API, `setAppBadge` on `127.0.0.1`~~ **verified** by the platform probe (§10.3). Still open: whether the taskbar icon follows the favicon or the badge without installing the app, and how the permission prompt looks | Manual test |
| 3 | Semantics of `priority` `now` / `next` / `later` and the mapping of `Ctrl+Entrée` | Sibling open item 3 (≈ 2 haiku calls) |
| 4 | The ExitPlanMode `plan` input field and the plan-file location (`<configDir>\plans\`?); `suggestions` content for Bash/Edit; whether `userModified` is set when edits come through the SDK | Sibling open item 2 |
| 5 | Continue on another account: the copy mechanism is **verified** with the CLI (E24). Still open: whether SDK `resume` accepts a `.jsonl` path (it maps to `--resume=<value>`, so it should), and whether the **system-prompt snapshot carries the source account's instructions** until the next compaction (§8.6) | 1 haiku call on the WORK profile |
| 6 | ~~`claude --resume <id>` on app sessions~~ **verified** in the official docs (§8.5) | — |
| 7 | ~~`title` suppressing the AI title call~~ **verified**: `options.title` (mock) and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` (real run), TOKEN-RESEARCH.md §4 | — |
| 8 | ~~Opened-elsewhere detection~~ **resolved** by the live-session registry (E19). Still open: bringing a terminal window to the front for *Afficher le terminal* | Small Win32 test |
| 9 | Exact list of zero-model slash commands for the *local* badge | Send each one once to a live process; check `num_turns 0` / `model:"<synthetic>"` |
| 10 | ~~SDK login helpers versus a console~~ **resolved**: piped `claude auth login` (E22). Still open: stopping Claude Code from opening the default browser itself (no-op `BROWSER`, (inferred)) so that *Ouvrir en InPrivate* is the only window | Test on a temporary profile |
| 11 | Renaming a **live** chat: the runtime `renameSession(title)` control versus `/rename` as a local command. Check that neither calls a model and that the next turn keeps the new title (E23) | Idle live process; check `num_turns 0` and the transcript tail |
| 12 | A stable origin (fixed port) so that notification permission and the `localStorage` cache survive restarts (§3.4) | Platform decision |
| 13 | Image parity: what the CLI does with SDK-sent image blocks (resize, recompress) and the per-model size cap behind the « ≈ tokens » estimate (§7.6) | Read the CLI bundle; 0 tokens |
| 14 | How a `ProposeGoal` approval reaches the host (`canUseTool` or `onUserDialog`) | Types plus one plan-mode call |
| 15 | Passing `cleanupPeriodDays` through the app's own `settings` only changes the sweeps that the app's processes run. Is it worth offering, or should the UI only show the profile line (§9.5)? | Design decision |

### Not in v1 (candidates for v2)

- Side questions `/btw` (a model call; would be an explicit opt-in).
- Cloud and remote-control sessions.
- Integrated terminal, browser preview pane and file editor.
- PR / CI monitoring.
- Worktree management UI.
- Line comments on diffs (v1 has *Citer dans le message*).
- *Summarize from here* rewind options.
- Branch timeline for abandoned branches (retries, rewinds), as in opcode.
- A board view of chats grouped by state (Windsurf Command Center, Vibe Kanban). v1's *À traiter* section and the `e:` filters cover the need.
- MCP Apps widgets, voice input, the background `claude agents` supervisor.
- Mobile layout.
- **Never:** automatic account rotation, automatic recaps, or LLM-generated titles and summaries.

---

## 18. Revision log (v1 → v1.1)

**Corrections** (v1 was wrong or unsafe):

| § | v1 said | v1.1 says | Why |
|---|---|---|---|
| 9.2 | Poll `claude auth status` every 2 s during login | Never poll it. Detect success from the login process output, `.credentials.json` and `oauthAccount` | It takes about 5 s and writes `.claude.json` plus a backup into the profile (E22) |
| 8.6 | The app copies the JSONL into the target profile | Claude Code copies it: `resume: <source path>` + `forkSession` under the target account, at first send | The app is read-only on profiles; the CLI mechanism was verified (E24) |
| 7.2 | `Échap Échap` while running also rewinds | A double tap while running only interrupts | Double-tapping to stop would otherwise open the rewind dialog |
| 5.3 | *Image distante bloquée — Afficher* (inline) | *Ouvrir dans le navigateur* | The CSP `img-src` blocks remote images anyway (platform probe) |
| 7.6 | Client downscale to 1,568 px | Send as pasted; re-encode only above the API byte limit | Parity with the CLI; newer models accept larger images |
| 3.4, 7.7 | Layout and drafts only in `localStorage` | Saved on the server; `localStorage` is only a cache | The origin includes the port, so a port change or a new browser profile would wipe them |
| 4.2 | Reap after *n* min idle; evict the least recently used | Reap *n* min after the **last API request**; evict the **coldest cache**; ask when every candidate is warm | Matches the cache TTL and the TOKEN-RESEARCH.md policy |
| 8.3 | Rename always appends with `renameSession(id, title)` | A live chat is renamed through its own process | The next turn's metadata re-append could restore the old title (E23) |
| H1 | Set `previewFormat:'markdown'` | Leave `toolConfig` unset (the default is already `'markdown'`) | Fewer options passed means parity with the CLI |
| 7.8 | "Context full" hint at 85 % | Hint within 5 % of the auto-compaction threshold (window − 33 k) | On 1 M-token windows, compaction starts near 96.7 %, so 85 % fired far too early |
| 5.6 | CSP without Trusted Types | Adds `require-trusted-types-for 'script'` | Verified working with DOMPurify in the Edge probe |
| 13 | `--fg-subtle` #6E7781, `--st-done` #1A7F37, `--st-limit` #BC4C00, `--st-cold` #8C959F (light); `--fg-subtle` #7D8590 (dark) | #636C76, #177A33, #B04600, #7D8590; dark #8B949E | They failed 4.5:1 (text) or 3:1 (glyph) on sunken or hover surfaces; the figures are now recomputed |
| 1.1 | Vibe Kanban "reportedly shut down" | Wind-down announced on 2026-04-10; the hosted tier closed; the open-source code continues | Primary source found |

**Additions:**
- Research rows for Claude Code on the web, the CLI session tools and Windsurf 2.0. New lessons on waking old chats, live sessions held elsewhere, retention and login (§1).
- Engine facts E19–E25: live-session registry, free profile data, retention sweep, login, rename while live, cross-profile fork, resume semantics (§2).
- Pre-spawn on first keystroke, plus stopping a process that never sent a request after 10 min (§0, §4).
- New flags `external` (with the terminal status), `expiring` and `foreignOwner`, with their badges (§4).
- Wake dialog with *Reprendre tel quel / depuis un résumé* (CLI parity), and a wake-cost estimate based on the ~19 k shared prefix (§7.8).
- Mode restored on wake-up, with bypass never restored automatically (§6.7).
- Tool rows for Workflow, ProposeGoal, ToolSearch, SendMessage, Task*, other small tools and denials, plus the payload rule for heavy fields (§5.4).
- Plan-text fallbacks (§6.5); fork loses session grants (§8.4).
- Accounts: identity, plan, usage snapshot, trusted folders and model list from profile files at no cost. InPrivate login guidance, logout, duplicate check by `accountUuid`, retention and baseline-context diagnostics (§9).
- Resume browser: Desktop origin, owner and expiry badges, CLI picker keys, missing-folder handling (§8.2).
- Performance budgets for 80 MB transcripts: tail-first reader; branches hidden (§12).
- New UI → server messages (`prespawn`, `wakeChoice`, `loginCode`, `logout`, `saveUiState`, `saveDraft`, `fetchToolDetail`, `copyResumeCommand`) (§15.4).
- About 50 French strings (§16, *Added in v1.1*).
- Open items updated: 4 resolved, 5 added (§17).

---

## Sources

### Official docs

- Claude Code Desktop, Code tab: <https://code.claude.com/docs/en/desktop.md>
- Desktop redesign blog: <https://claude.com/it/blog/claude-code-desktop-redesign>
- Desktop redesign coverage (FR): <https://pasqualepillitteri.it/fr/news/867/claude-code-desktop-redesign-sessions-paralleles>
- VS Code extension: <https://code.claude.com/docs/en/vs-code>
- Agent View: <https://code.claude.com/docs/en/agent-view.md>
- Interactive mode (shortcuts, queue, /btw, task list, usage-limit wait): <https://code.claude.com/docs/en/interactive-mode>
- Prompt caching: <https://code.claude.com/docs/en/prompt-caching>
- Permission modes: <https://code.claude.com/docs/en/permission-modes>
- Checkpointing: <https://code.claude.com/docs/en/checkpointing>
- Agent SDK, user input: <https://code.claude.com/docs/en/agent-sdk/user-input>
- Manage sessions (resume by id or path, picker keys, *Resume from summary*, permission mode on resume, `/branch`, retention): <https://code.claude.com/docs/en/sessions>
- Cloud sessions / Claude Code on the web (sidebar, diff comments, queued-message ✕, *Open in › Terminal*, teleport): <https://code.claude.com/docs/en/claude-code-on-the-web>

### Tools surveyed

- claudecodeui / CloudCLI: <https://github.com/siteboon/claudecodeui> and <https://newreleases.io/project/github/siteboon/claudecodeui/release/v1.37.0>
- Claude Code GUIs compared (opcode, CloudCLI, terminal, crystl): <https://crystl.dev/compare/claude-code-guis/>
- opcode / Claudia: <https://itsfoss.com/claudia/> and <https://www.sourcepulse.org/projects/6215355>
- Conductor: <https://thenewstack.io/a-hands-on-review-of-conductor-an-ai-parallel-runner-app/> and <https://www.conductor.build/workflows/run-parallel-claude-codes>
- Vibe Kanban: <https://vibekanban.com/docs/getting-started>, <https://virtuslab.com/blog/ai/vibe-kanban/> and the shutdown notice <https://vibekanban.com/blog/shutdown>
- Windsurf 2.0 Agent Command Center (secondary sources): <https://skills-hub.ai/blog/windsurf-2-agent-command-center-2026>, <https://devin.ai/blog/windsurf-wave-13> and <https://similarlabs.com/blog/windsurf-review>
- Claude Code desktop and web redesign coverage: <https://news.bensbites.co/posts/63975-anthropic-redesigns-claude-code-on-desktop-adding-a-sidebar-for-managing-multiple-sessions-a-drag-and-drop-layout-an-integrated-terminal-and-a-file-editor> and <https://onlinemarketing.de/technologie/claude-code-redesign-mehrere-sessions-nebeneinander>
- claude-squad: <https://gittrend.io/repo/smtg-ai/claude-squad> and <https://formulae.brew.sh/formula/claude-squad>
- Nimbalyst / Crystal: <https://nimbalyst.com/parallel-claude-code-sessions/>, <https://www.implicator.ai/nimbalyst-claude-code-codex-mac-windows-linux/> and <https://gittrend.io/repo/stravu/crystal>
- Cursor 3 Agents Window: <https://www.datacamp.com/blog/cursor-3> and <https://forum.cursor.com/t/when-using-agents-window-should-approve-undo-diffs-be-visible-and-actionable-in-the-files-tab-and-other-questions/160526>
- Multi-account tools and policy: <https://agentsroom.dev/blog/how-to-use-multiple-claude-code-accounts>, <https://github.com/GG-Santos/ccswitch>, <https://docs.rs/crate/clauth/0.6.2> and <https://metricnexus.ai/blog/anthropic-banning-multiple-claude-accounts>

### Bug reports and platform notes

- Long-transcript and rendering bug reports: <https://claudeissues.com/issue/51229-bug-ios-app-long-conversations-with-code-blocks-take-minutes-to-load-app-blocks> and <https://claudeissues.com/issue/17964-bug-display-glitches-and-performance-lag-with-large-messages-responses>
- Chromium reserved shortcuts: <https://forum.babylonjs.com/t/how-prevent-default-of-c-w-t-n/44117> and <https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock>

### Local evidence

- `@anthropic-ai/claude-agent-sdk@0.3.293` type declarations (`sdk.d.ts`, `sdk-tools.d.ts`).
- `claude --help` / `claude auth --help` (CLI 2.1.294).
- Local measurements of the SDK behaviour, of the on-disk data (registry, `oauthAccount`, usage snapshot, retention, login, transcript sizes) and of token usage (resume cost model, hidden calls, reaping policy; see [TOKEN-RESEARCH.md](TOKEN-RESEARCH.md)).
- Platform probes: Edge 154 `--app` capabilities, CSP and Trusted Types behaviour, vendored ESM libraries.
- WCAG contrast scripts.
