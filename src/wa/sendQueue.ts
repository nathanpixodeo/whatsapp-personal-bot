import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Serialises every outbound WhatsApp operation and paces consecutive sends.
 *
 * Two reasons this exists rather than calling `sock.sendMessage` per request:
 * concurrent sends on one session interleave badly, and unpaced bursts are what
 * gets personal accounts rate-limited or banned. FIFO order also means a webhook
 * that fires twice produces messages in the order they arrived.
 */
export class SendQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private lastRunAt = 0;
  private pending = 0;
  private closed = false;

  get depth(): number {
    return this.pending;
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      const err = new Error('Relay is shutting down');
      err.name = 'QueueClosed';
      return Promise.reject(err);
    }

    this.pending += 1;

    const run = this.chain.then(async () => {
      const wait = config.SEND_MIN_INTERVAL_MS - (Date.now() - this.lastRunAt);
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        this.lastRunAt = Date.now();
        this.pending -= 1;
      }
    });

    // The chain must survive a rejected task, otherwise one failed send poisons
    // every queued send behind it. Callers still see the original rejection.
    this.chain = run.then(noop, noop);
    return run;
  }

  /** Stops accepting work and waits for the in-flight chain to settle. */
  async close(timeoutMs = 15_000): Promise<void> {
    this.closed = true;
    if (this.pending === 0) return;

    logger.info({ pending: this.pending }, 'draining send queue');
    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      this.chain.then(() => undefined),
      sleep(timeoutMs).then(() => timedOut),
    ]);

    if (result === timedOut) {
      logger.warn({ pending: this.pending }, 'send queue did not drain before timeout');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function noop(): void {
  /* swallow: rejection is delivered to the enqueue() caller */
}

export const sendQueue = new SendQueue();
