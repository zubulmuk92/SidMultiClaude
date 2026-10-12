// test/integration/engine/host-child.ts — a throwaway engine host for the "host kill" Job Object test (not a test file).
// argv: <jobrun|-> <cfgDir> <cwd> <pidFile> <registryFile>. Prints one JSON line {cli, host, grandchild} then waits to be killed.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { makeEngine } from '../../../src/server/engine/engine.ts';
import { createSpawner } from '../../../src/server/engine/spawner.ts';
import { realClock } from '../../../src/server/util/clock.ts';
import { nullLogger } from '../../../src/server/util/log.ts';
import { recordingSink } from '../../unit/engine/engine-helpers.ts';
import { FAKE } from './real-helpers.ts';

const [jobrun, cfg, cwd, pidFile, registryFile] = process.argv.slice(2) as [string, string, string, string, string];
const sink = recordingSink();
const spawner = createSpawner({ jobrunPath: jobrun === '-' ? null : jobrun, registryFile, log: nullLogger });
const engine = makeEngine({ query, clock: realClock, sink, spawner, log: nullLogger, freeMemBytes: () => 8 * 1024 ** 3, holder: () => null });
const sid = randomUUID();
const chatId = `t:${sid}`;
await engine.ensure({ chatId, sessionId: sid, cwd, account: { id: 't', configDir: cfg, claudeMdExcludes: [] }, mode: 'default', start: { kind: 'new' },
  allowBypass: false, aiTitles: false, exe: FAKE, isolation: jobrun === '-' ? 'plain' : 'job' }, { why: 'send' });
engine.send(chatId, { uuid: randomUUID(), text: 'HOOKS:' + pidFile });
const t0 = Date.now();
while (!sink.log.some((r) => r.k === 'frame' && (r.f as { type?: string }).type === 'result') && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
process.stdout.write(JSON.stringify({ cli: engine.facts(chatId)?.cliPid, host: [...spawner.ownPids()], grandchild }) + '\n');
setInterval(() => {}, 1 << 30);
