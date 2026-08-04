import type { FastifyPluginAsync } from 'fastify';
import { sendQueue } from '../../wa/sendQueue.js';
import { waClient } from '../../wa/client.js';
import { healthResponse } from '../schemas.js';

/**
 * Unauthenticated on purpose so a load balancer or systemd watchdog can poll it.
 * It exposes liveness only - no group names, no JIDs beyond the linked account.
 *
 * 200 means "a send issued right now would be attempted". Anything else is 503,
 * including `outgoingBlocked`, where the socket is open but WhatsApp is refusing
 * outbound messages for this account.
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        summary: 'Connection state',
        description:
          '200 only when the state is `connected` **and** WhatsApp is not blocking outbound messages. Everything else is 503, so a watchdog needs no body parsing.',
        // Unauthenticated on purpose, so a load balancer or systemd watchdog can poll it.
        security: [],
        response: { 200: healthResponse, 503: healthResponse },
      },
    },
    async (_req, reply) => {
      const status = waClient.getStatus();
      const healthy = status.state === 'connected' && !status.outgoingBlocked;

      return reply.code(healthy ? 200 : 503).send({
        ...status,
        healthy,
        queueDepth: sendQueue.depth,
        uptimeSeconds: Math.round(process.uptime()),
      });
    },
  );
};
