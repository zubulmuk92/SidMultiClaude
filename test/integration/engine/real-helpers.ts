// test/integration/engine/real-helpers.ts — the REAL SDK 0.3.293 + test/fakes/fake-claude.mjs behind createEngine (0 tokens).
// Every child gets accountEnv (parent Claude session vars stripped) and a scratch CLAUDE_CONFIG_DIR under the OS temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type * as P from '../../../src/shared/protocol.ts';
import type { SpawnSpec } from '../../../src/server/contracts.ts';
import { makeEngine } from '../../../src/server/engine/engine.ts';
import { createSpawner } from '../../../src/server/engine/spawner.ts';
import { realClock } from '../../../src/server/util/clock.ts';
import { memoryLogger } from '../../../src/server/util/log.ts';
import { recordingSink } from '../../unit/engine/engine-helpers.ts';

export const FAKE = fs.realpathSync.native(path.resolve(import.meta.dirname, '..', '..', 'fakes', 'fake-claude.mjs'));
export const SCRATCH = path.join(os.tmpdir(), 'smc-int');
/** Throwaway folder for real-CLI runs (logged-out scratch profiles): SMC_REAL_SCRATCH, else a folder under the OS temp dir. */
export const REAL_SCRATCH = ((): string => {
  const d = process.env['SMC_REAL_SCRATCH'] || path.join(os.tmpdir(), 'smc-real');
  fs.mkdirSync(d, { recursive: true });
  return fs.realpathSync.native(d);
})();
/** jobrun.exe for the job-isolation tests (SPEC §2.11): SMC_JOBRUN, else launcher/jobrun.exe (built by `npm run install-app`);
 *  null when neither exists, and the job tests then skip. */
export const JOBRUN = ((): string | null => {
  const cands = [process.env['SMC_JOBRUN'], path.resolve(import.meta.dirname, '..', '..', '..', 'launcher', 'jobrun.exe')];
  for (const c of cands) if (c && fs.existsSync(c)) return fs.realpathSync.native(c);
  return null;
})();

export function tmpDirs(label: string): { root: string; cfg: string; cwd: string; dispose(): void } {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(SCRATCH, label + '-')));
  const cfg = path.join(root, 'cfg'); const cwd = path.join(root, 'work');
  fs.mkdirSync(cfg); fs.mkdirSync(cwd);
  return { root, cfg, cwd, dispose: () => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* busy files on Windows */ } } };
}

export function realEngine(label: string, o: { isolation?: 'job' | 'plain'; jobrun?: string | null } = {}) {
  const dirs = tmpDirs(label);
  const sink = recordingSink();
  const log = memoryLogger();
  const spawner = createSpawner({ jobrunPath: o.jobrun === undefined ? JOBRUN : o.jobrun, registryFile: path.join(dirs.root, 'run', 'children.json'), log });
  const engine = makeEngine({ query, clock: realClock, sink, spawner, log, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null });
  let n = 0;
  const spec = (p: Partial<SpawnSpec> = {}): SpawnSpec => {
    const sid = p.sessionId ?? crypto.randomUUID();
    n++;
    return { chatId: `t:${sid}`, sessionId: sid, cwd: dirs.cwd, account: { id: 't', configDir: dirs.cfg, claudeMdExcludes: [] }, mode: 'default',
      start: { kind: 'new' }, allowBypass: false, aiTitles: false, exe: FAKE, isolation: o.isolation ?? 'plain', ...p };
  };
  const dispose = async (): Promise<void> => { await engine.shutdown(15_000); dirs.dispose(); };
  return { engine, sink, log, spawner, dirs, spec, dispose, count: () => n };
}

export async function waitFor(pred: () => boolean, what: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out (${ms} ms) waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
export const frames = (sink: ReturnType<typeof recordingSink>, c?: P.ChatId): Record<string, unknown>[] =>
  sink.log.filter((r) => r.k === 'frame' && (!c || r.c === c)).map((r) => (r as { f: Record<string, unknown> }).f);
export const resultText = (sink: ReturnType<typeof recordingSink>): string[] =>
  frames(sink).filter((f) => f['type'] === 'result').map((f) => String(f['result'] ?? f['subtype']));
