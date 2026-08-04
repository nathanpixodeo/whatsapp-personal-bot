import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/**
 * Both sides are SHA-256'd before comparison. That gives `timingSafeEqual` the
 * equal-length buffers it requires, and it stops the comparison from leaking the
 * key's length - which a plain `!==` or a length check would.
 */
const expectedDigest = createHash('sha256').update(config.API_KEY, 'utf8').digest();

export function isValidApiKey(provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

/**
 * Registered as `onRequest`, which fires *before* Fastify parses the body. A
 * `preHandler` would authenticate only after unauthenticated input had already
 * been deserialised.
 */
export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isValidApiKey(req.headers['x-api-key'])) return;

  req.log.warn({ route: req.url, ip: req.ip }, 'rejected request with invalid API key');
  await reply.code(401).send({ error: 'unauthorized', message: 'Valid X-API-Key header required' });
}
