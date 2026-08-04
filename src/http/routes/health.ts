import type { FastifyPluginAsync } from 'fastify';
import { sendQueue } from '../../wa/sendQueue.js';
import { waClient } from '../../wa/client.js';

/**
 * Unauthenticated on purpose so a load balancer or systemd watchdog can poll it.
 * It exposes liveness only - no group names, no JIDs beyond the linked account.
 *
 * 200 means "a send issued right now would be attempted". Anything else is 503,
 * including `outgoingBlocked`, where the socket is open but WhatsApp is refusing
 * outbound messages for this account.
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const status = waClient.getStatus();
    const healthy = status.state === 'connected' && !status.outgoingBlocked;

    return reply.code(healthy ? 200 : 503).send({
      ...status,
      healthy,
      queueDepth: sendQueue.depth,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });
};
