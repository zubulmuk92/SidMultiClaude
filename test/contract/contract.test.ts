// test/contract/contract.test.ts — K1–K7 (scripts/contract.ts) on the REAL installed claude.exe, logged-out scratch profiles, 0 tokens.
// SPEC §11, §12.4. Key-set drift (K2) is a warning, not a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runContract } from '../../scripts/contract.ts';
import type { CheckResult } from '../../scripts/contract.ts';
import { installedClaudeExe } from '../../src/server/engine/exe.ts';
import { JOBRUN, REAL_SCRATCH } from '../integration/engine/real-helpers.ts';

const EXE = installedClaudeExe();

test('K1–K8: real claude.exe on logged-out scratch profiles', { skip: EXE ? false : 'claude.exe not installed', timeout: 400_000 }, async (t) => {
  const res = await runContract({ exe: EXE!, jobrun: JOBRUN, dir: REAL_SCRATCH });
  const by = Object.fromEntries(res.map((r) => [r.id, r])) as Record<string, CheckResult>;
  for (const r of res) t.diagnostic(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}${r.skipped ? ` (skipped: ${r.skipped})` : ''}${r.warning ? ` WARNING: ${r.warning}` : ''} ${JSON.stringify(r.detail).slice(0, 400)}`);
  for (const id of ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8']) {
    assert.ok(by[id], `${id} missing`);
    assert.equal(by[id]!.ok, true, `${id}: ${JSON.stringify(by[id]!.detail)}`);
  }
});
