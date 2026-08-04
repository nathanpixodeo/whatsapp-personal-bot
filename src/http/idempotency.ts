import { LRUCache } from 'lru-cache';
import { IDEMPOTENCY_TTL_MS } from '../config.js';

/**
 * Replays the response of a previously seen `Idempotency-Key` so a webhook that
 * retries does not post the same message twice.
 *
 * MVP grade, deliberately: this lives in memory, so a restart between the original
 * request and its retry can still duplicate. Phase 2 replaces it with a SQLite
 * outbox where the key insert and the queued message share one transaction.
 */
type Entry =
  | { state: 'in_flight' }
  | { state: 'done'; status: number; body: unknown };

export type Claim =
  /** Caller owns this key and must call settle() or release(). */
  | { kind: 'fresh' }
  /** An identical request is still being processed. */
  | { kind: 'in_flight' }
  /** Replay the recorded response. */
  | { kind: 'replay'; status: number; body: unknown };

const cache = new LRUCache<string, Entry>({ max: 10_000, ttl: IDEMPOTENCY_TTL_MS });

export function claim(key: string): Claim {
  const existing = cache.get(key);
  if (!existing) {
    cache.set(key, { state: 'in_flight' });
    return { kind: 'fresh' };
  }
  if (existing.state === 'in_flight') return { kind: 'in_flight' };
  return { kind: 'replay', status: existing.status, body: existing.body };
}

export function settle(key: string, status: number, body: unknown): void {
  cache.set(key, { state: 'done', status, body });
}

/** Drops the reservation so a failed attempt can be retried with the same key. */
export function release(key: string): void {
  if (cache.get(key)?.state === 'in_flight') cache.delete(key);
}
