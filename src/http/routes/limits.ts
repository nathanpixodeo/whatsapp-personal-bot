import type { FastifyPluginAsync } from 'fastify';
import { humanizer } from '../../wa/humanizer.js';
import { errorResponse, limitsResponse } from '../schemas.js';

/**
 * Current pacing and volume state.
 *
 * API-key protected rather than public like `/health`: send volume is operational
 * detail about the account, and `/health` is deliberately reachable by any watchdog.
 */
export const limitsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/limits',
    {
      schema: {
        tags: ['ops'],
        summary: 'Pacing and volume counters',
        description:
          'What the relay is currently doing to avoid looking like a bot: jittered gaps, typing simulation, rolling-window caps, quiet hours. Counters are in-memory and reset on restart, so a restart hands back the full budget - do not treat them as an audit trail.',
        response: { 200: limitsResponse, 401: errorResponse('Missing or wrong API key.', 'unauthorized') },
      },
    },
    async (_req, reply) =>
      reply.send({
        ...humanizer.snapshot(),
        counterNote:
          'Rolling windows over in-memory timestamps, reserved when a send is admitted rather than when it leaves. Lost on restart.',
      }),
  );
};
