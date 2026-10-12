// src/server/claude/sdk-helpers.ts — SdkHelpers under one mutex (rename, delete, forkUpTo); lazy import() of the SDK.
// The SDK session helpers resolve the profile from process.env.CLAUDE_CONFIG_DIR at call time: it is process-
// global, so every call runs behind ONE promise-chain mutex, with the variable set (non-default account) or deleted
// (default profile: never set it to ~\.claude) and restored afterwards, even on failure. 0 tokens, no spawn.
import type { Account, Logger, SdkHelpers } from '../contracts.ts';
import type * as P from '../../shared/protocol.ts';
import { createMutex } from '../util/mutex.ts';

type Mutation = { dir?: string };
/** The subset of @anthropic-ai/claude-agent-sdk used here (injectable for tests). */
export type SessionSdk = {
  renameSession(id: string, title: string, o?: Mutation): Promise<void>;
  deleteSession(id: string, o?: Mutation): Promise<void>;
  forkSession(id: string, o?: Mutation & { upToMessageId?: string; title?: string }): Promise<{ sessionId: string }>;
};

const ENV_KEY = 'CLAUDE_CONFIG_DIR';

export function createSdkHelpers(d: { log: Logger; load?: () => Promise<SessionSdk> }): SdkHelpers {
  const mutex = createMutex();
  let mod: Promise<SessionSdk> | null = null;
  const sdk = (): Promise<SessionSdk> => {
    mod ??= (d.load ?? (async () => (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SessionSdk))();
    mod.catch(() => { mod = null; });                          // a failed import is retried on the next call
    return mod;
  };

  function withAccount<T>(acc: Account, fn: (s: SessionSdk) => Promise<T>): Promise<T> {
    return mutex.run(async () => {
      const s = await sdk();
      const had = Object.prototype.hasOwnProperty.call(process.env, ENV_KEY);
      const prev = process.env[ENV_KEY];
      if (acc.configDir) process.env[ENV_KEY] = acc.configDir; else delete process.env[ENV_KEY];
      try { return await fn(s); }
      finally { if (had && prev !== undefined) process.env[ENV_KEY] = prev; else delete process.env[ENV_KEY]; }
    });
  }
  const opt = (dir?: string): Mutation => (dir ? { dir } : {});

  return {
    rename(acc, sessionId, title, dir) {
      return withAccount(acc, (s) => s.renameSession(sessionId, title, opt(dir)));
    },
    remove(acc, sessionId, dir) {
      return withAccount(acc, (s) => s.deleteSession(sessionId, opt(dir)));
    },
    forkUpTo(acc, sessionId, upToUuid, title, dir): Promise<P.SessionId> {
      return withAccount(acc, async (s) => {
        const r = await s.forkSession(sessionId, { ...opt(dir), upToMessageId: upToUuid, title });
        if (!r || typeof r.sessionId !== 'string') throw new Error('forkSession returned no session id');
        d.log.info('sdk: forked session', { account: acc.id });
        return r.sessionId;
      });
    },
  };
}
