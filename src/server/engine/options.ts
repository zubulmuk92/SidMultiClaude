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
  if (!aiTitles) env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1'; // no generate_session_title call (measured)
  env.CLAUDE_AGENT_SDK_CLIENT_APP = APP_UA;                    // honest client id (User-Agent suffix)
  return env;                                                  // CLAUDE_CODE_ENTRYPOINT left unset -> the SDK stamps 'sdk-ts'
}

export type OptionCallbacks = Required<Pick<Options, 'canUseTool' | 'spawnClaudeCodeProcess' | 'stderr'>> & Pick<Options, 'onElicitation'>;

export function buildOptions(s: SpawnSpec, cb: OptionCallbacks): Options {
  const o: Options = {
    cwd: s.cwd,
    env: accountEnv(s.account.configDir, s.aiTitles),
    pathToClaudeCodeExecutable: s.exe,                         // installed native claude.exe by default; bundled on request
    systemPrompt: { type: 'preset', preset: 'claude_code' },   // MANDATORY: omitted => 141-token prompt instead of 3,122
    settingSources: ['user', 'project', 'local'],              // explicit: the default changed across SDK versions
    permissionMode: s.mode,                                    // explicit: else settings defaultMode or 'auto' (classifier calls)
    includePartialMessages: true,
    perTaskStopAffordance: true,                               // Échap spares background tasks (CLI behaviour) — checked by the T-P3 parity test
    enableFileCheckpointing: true,                             // rewindFiles(); disk only — checked by the T-P3 parity test
    canUseTool: cb.canUseTool,
    spawnClaudeCodeProcess: cb.spawnClaudeCodeProcess,
    stderr: cb.stderr,
  };
  if (cb.onElicitation) o.onElicitation = cb.onElicitation;   // MCP form/URL requests — checked by the T-P3 parity test
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
