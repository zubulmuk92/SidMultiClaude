// src/server/claude/profiles.ts — candidate discovery, login state from stat + oauthAccount (no process).
// The global config is `<home>\.claude.json` for the default profile (CLAUDE_CONFIG_DIR unset) and
// `<cfg>\.claude.json` otherwise (a legacy `<cfg>\.config.json` wins). `.credentials.json` is only ever fs.stat'ed (S10):
// never opened, copied or logged. `claude auth status` is never run.
import fs from 'node:fs';
import type * as P from '../../shared/protocol.ts';
import { profileCandidates, profilePaths } from '../util/paths.ts';

export type OAuthAccount = {
  accountUuid?: string; emailAddress?: string; displayName?: string; fullName?: string;
  organizationUuid?: string; organizationName?: string; organizationType?: string; organizationRole?: string;
  seatTier?: string | null; organizationRateLimitTier?: string; userRateLimitTier?: string | null;
};
export type GlobalConfig = Record<string, unknown> & { oauthAccount?: OAuthAccount };

/** The global config file a profile really uses (legacy `.config.json` first). */
export function globalConfigFile(configDir: string | null, home: string): string {
  const p = profilePaths(configDir, home);
  try { if (fs.statSync(p.legacyGlobalConfig).isFile()) return p.legacyGlobalConfig; } catch { /* absent */ }
  return p.globalConfig;
}
/** Parsed global config, or null (missing / unreadable / torn by a concurrent write). Read-only. */
export function readGlobalConfig(configDir: string | null, home: string): GlobalConfig | null {
  try {
    const o = JSON.parse(fs.readFileSync(globalConfigFile(configDir, home), 'utf8')) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as GlobalConfig) : null;
  } catch { return null; }
}
export function oauthOf(g: GlobalConfig | null): OAuthAccount | null {
  const a = g?.oauthAccount;
  return a && typeof a === 'object' && typeof a.accountUuid === 'string' && a.accountUuid ? a : null;
}
/** stat only: `.credentials.json` exists with size > 0. */
export function hasCredentials(configDir: string | null, home: string): boolean {
  try { const st = fs.statSync(profilePaths(configDir, home).credentials); return st.isFile() && st.size > 0; } catch { return false; }
}
export function credentialsMtime(configDir: string | null, home: string): number {
  try { return fs.statSync(profilePaths(configDir, home).credentials).mtimeMs; } catch { return 0; }
}
export function usesCredman(g: GlobalConfig | null): boolean {
  const f = g?.['cachedGrowthBookFeatures'] as Record<string, unknown> | undefined;
  return f?.['tengu_windows_credman'] === true;
}
/** connected = (credentials file || credman) && accountUuid; disconnected = neither; otherwise incoherent. */
export function loginStateOf(configDir: string | null, home: string, g: GlobalConfig | null = readGlobalConfig(configDir, home)): Exclude<P.LoginState, 'reauth'> {
  const acct = oauthOf(g) !== null;
  const cred = hasCredentials(configDir, home);
  if ((cred || usesCredman(g)) && acct) return 'connected';
  if (!cred && !acct) return 'disconnected';
  return 'incoherent';
}
/** connected | disconnected | incoherent, from fs.stat(.credentials.json) + oauthAccount. Never opens the credentials. */
export function loginState(configDir: string | null, home: string): Exclude<P.LoginState, 'reauth'> {
  return loginStateOf(configDir, home);
}

/** « Max 5x », « Max 20x », « Pro », « Team », « Enterprise »… from organizationType + rate-limit tiers. */
export function planLabel(a: OAuthAccount | null): string {
  if (!a) return '';
  const type = String(a.organizationType ?? '');
  const tiers = `${a.userRateLimitTier ?? ''} ${a.organizationRateLimitTier ?? ''} ${a.seatTier ?? ''}`.toLowerCase();
  const mult = /max_(\d+)x/.exec(tiers);
  switch (type) {
    case 'claude_max': return mult ? `Max ${mult[1]}x` : 'Max';
    case 'claude_pro': return 'Pro';
    case 'claude_team': return 'Team';
    case 'claude_enterprise': return 'Enterprise';
    case '': return '';
    default: return type.replace(/^claude_/, '').replace(/^./, (c) => c.toUpperCase());
  }
}
export function identityOf(a: OAuthAccount | null): P.AccountView['identity'] | undefined {
  if (!a || !a.accountUuid) return undefined;
  return {
    email: a.emailAddress ?? '', accountUuid: a.accountUuid, plan: planLabel(a),
    ...(a.displayName ? { displayName: a.displayName } : {}),
    // Like the candidates, a personal plan's "<email>'s Organization" is not an org to show (ux §9.1 card)
    ...(a.organizationName && teamOrgName(a) ? { org: a.organizationName } : {}),
    ...(a.organizationRole ? { role: a.organizationRole } : {}),
  };
}

// ---------------------------------------------------------------- suggested identity (first run)
const PERSONAL_TYPES = new Set(['claude_max', 'claude_pro', 'claude_free', 'claude_personal', 'personal', 'free', 'pro', 'max']);
const OWN_ORG = /['’]s\s+Organi[sz]ation\s*$/i;           // "prenom.nom@…'s Organization": the personal org, never a name
/** A team / enterprise organization name worth showing, or null (personal plans and "<email>'s Organization"). */
export function teamOrgName(a: OAuthAccount | null): string | null {
  const org = String(a?.organizationName ?? '').trim();
  const type = String(a?.organizationType ?? '').toLowerCase();
  if (!org || OWN_ORG.test(org) || PERSONAL_TYPES.has(type) || org.includes('@')) return null;
  return org.slice(0, 40);
}
/** `base`, else `base 2`, `base 3`… (case-insensitive against `taken`). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const t = new Set([...taken].map((x) => x.trim().toLowerCase()));
  if (!t.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) { const n = `${base.slice(0, 36)} ${i}`; if (!t.has(n.toLowerCase())) return n; }
}
/** Default account name (ux §9.2): the team / enterprise org name, else « Perso » (« Perso 2 »… when taken). A profile
 *  with no login yet is named after its folder (`.claude-travail` → « Travail »). */
export function suggestedName(a: OAuthAccount | null, configDir: string | null, taken: Iterable<string>): string {
  let base = teamOrgName(a);
  if (!base && !a && configDir !== null) {
    const suffix = (configDir.split(/[\\/]/).filter(Boolean).pop() ?? '').replace(/^\.claude-?/i, '').replace(/[-_]+/g, ' ').trim();
    if (suffix) base = (suffix.charAt(0).toUpperCase() + suffix.slice(1)).slice(0, 40);
  }
  return uniqueName(base || 'Perso', taken);
}
/** Monogram that follows the name: its initial, plus the trailing number when there is one (« Perso 2 » → « P2 »). */
export function monogramOf(name: string): string {
  const n = name.trim();
  const first = ([...n][0] ?? '?').toUpperCase();
  const digit = /\s(\d)\d*$/.exec(n);
  return digit ? `${first}${digit[1]}` : first;
}
/** Default colour: the default profile → 1 (violet), `.claude-pro` → 2 (teal), others the next free one (ux §9.4). */
export const preferredColor = (configDir: string | null): number => (configDir === null ? 1 : /[\\/]\.claude-pro$/i.test(configDir) ? 2 : 0);
export function suggestedColor(configDir: string | null, used: ReadonlySet<number>): number {
  const pref = preferredColor(configDir);
  if (pref && !used.has(pref)) return pref;
  return [1, 2, 3, 4, 5, 6, 7, 8].find((c) => !used.has(c)) ?? 8;
}

export function discoverCandidates(home: string): P.AccountCandidate[] {
  const out: P.AccountCandidate[] = [];
  const list = profileCandidates(home);
  // the default profile also exists with only ~\.claude.json (no data dir yet)
  if (!list.some((c) => c.configDir === null)) {
    try { if (fs.statSync(profilePaths(null, home).globalConfig).isFile()) list.unshift({ configDir: null, dir: profilePaths(null, home).configHome }); } catch { /* none */ }
  }
  for (const c of list) {
    const g = readGlobalConfig(c.configDir, home);
    const a = oauthOf(g);
    const plan = planLabel(a);
    const org = teamOrgName(a);
    out.push({ configDir: c.configDir, login: loginStateOf(c.configDir, home, g), ...(a?.emailAddress ? { email: a.emailAddress } : {}),
      ...(plan ? { plan } : {}), ...(org ? { org } : {}), added: false });
  }
  return out;
}
