// src/server/engine/input-queue.ts — AsyncIterable<SDKUserMessage> with push/end (the streaming-input prompt of query()).
// The SDK pulls this iterable through streamInput(); ending it closes the CLI's stdin once the running turn is over.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface InputQueue extends AsyncIterable<SDKUserMessage> {
  push(m: SDKUserMessage): void;
  end(): void;
  readonly ended: boolean;
}

export class InputClosedError extends Error {
  readonly code = 'not_live';
  constructor() { super('chat input already closed'); this.name = 'InputClosedError'; }
}

export function createInputQueue(): InputQueue {
  const buf: SDKUserMessage[] = [];
  const waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  let ended = false;
  const next = (): Promise<IteratorResult<SDKUserMessage>> => {
    const m = buf.shift();
    if (m) return Promise.resolve({ value: m, done: false });
    if (ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => waiters.push(resolve));
  };
  return {
    push(m) {
      if (ended) throw new InputClosedError();
      const w = waiters.shift();
      if (w) w({ value: m, done: false }); else buf.push(m);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    },
    get ended() { return ended; },
    [Symbol.asyncIterator]() {
      return {
        next,
        return: (): Promise<IteratorResult<SDKUserMessage>> => Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}
