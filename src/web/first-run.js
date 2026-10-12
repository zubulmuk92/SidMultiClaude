// @ts-check
// src/web/first-run.js — first-run onboarding (SPEC 5.5 « First run », ux §9.2). When the
// hello (or a later `accounts` frame) leaves the window with ZERO accounts, the « Comptes » panel opens by itself, once
// per window session, in its first-run form (candidates listed, the connected ones pre-selected, suggested names and
// colours). Nothing is added without the user's confirmation. If accounts appear from elsewhere (another window) while
// that untouched welcome is open, it closes.
import { effect } from '@preact/signals-core';
import { accounts, hydrated, overlay } from './store.js';

const KEY = 'smc.firstRunShown';
let shownHere = false;

/**
 * Pure decision. @param {{ hydrated: boolean; accounts: number; overlay: { kind: string; props?: Record<string, any> } | null; shown: boolean }} s
 * @returns {'open' | 'close' | null}
 */
export function firstRunDecision(s) {
  if (!s.hydrated) return null;
  const welcome = s.overlay?.kind === 'accounts' && s.overlay.props?.['firstRun'] === true;
  if (s.accounts > 0) return welcome ? 'close' : null;
  if (s.shown || s.overlay !== null) return null;       // another dialog first (orphans, login…): next frame
  return 'open';
}

function readShown() {
  if (shownHere) return true;
  try { return globalThis.sessionStorage?.getItem(KEY) === '1'; } catch { return false; }
}
function markShown() {
  shownHere = true;
  try { globalThis.sessionStorage?.setItem(KEY, '1'); } catch { /* private mode: memory only */ }
}

/** Wires the decision to the store (main.js). */
export function wireFirstRun() {
  return effect(() => {
    const d = firstRunDecision({ hydrated: hydrated.value, accounts: accounts.value.length, overlay: overlay.value, shown: readShown() });
    if (d === 'open') { markShown(); overlay.value = { kind: 'accounts', props: { firstRun: true } }; }
    else if (d === 'close') overlay.value = null;
  });
}
