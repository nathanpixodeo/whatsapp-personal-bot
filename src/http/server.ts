import { createHash } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import { MAX_BODY_BYTES, config } from '../config.js';
import { logger } from '../logger.js';
import { isValidApiKey, requireApiKey } from './auth.js';
import { OPENAPI_OPTIONS, docsUiPlugin } from './openapi.js';
import { chatRoutes } from './routes/chats.js';
import { groupRoutes } from './routes/groups.js';
import { healthRoutes } from './routes/health.js';
import { limitsRoutes } from './routes/limits.js';
import { pairRoutes } from './routes/pair.js';
import { qrRoutes } from './routes/qr.js';
import { sendRoutes } from './routes/send.js';
import { uiRoutes } from './routes/ui.js';

/** Tagged error names thrown by the WhatsApp layer, mapped to HTTP status codes. */
const ERROR_STATUS: Record<string, number> = {
  WaNotConnected: 503,
  QueueClosed: 503,
  PairingUnavailable: 503,
  InvalidParticipant: 400,
  InvalidGroupJid: 400,
  AlreadyLinked: 409,
  // Pacing refusals. 429 for the volume caps, since the caller may retry later; 503 for
  // quiet hours, because the block is a property of the clock rather than of the caller.
  HourlyLimit: 429,
  DailyLimit: 429,
  TargetCooldown: 429,
  QuietHours: 503,
};

/** Routes that must work without an API key: the watchdog probe and the static console. */
const PUBLIC_PATHS = new Set(['/health', '/ui', '/']);

/**
 * Path prefixes exempt from the API key. Only the docs, whose static assets a browser
 * cannot attach a header to. They enforce loopback themselves in openapi.ts - the
 * exemption is from authentication, not from that gate.
 */
const PUBLIC_PREFIXES = ['/docs'];

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Cast: pino v10's `Logger` is narrower than `FastifyBaseLogger` (it requires
    // `msgPrefix`). Without this the instance generic changes and every
    // FastifyPluginAsync stops matching.
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: true,
    disableRequestLogging: false,
    ajv: {
      customOptions: {
        // Fastify defaults to removeAdditional: true, which silently strips unknown
        // properties. For a relay that is a trap: `{"groupJID": "..."}` would be
        // dropped and the message would go to DEFAULT_GROUP_JID instead of the group
        // the caller named. `additionalProperties: false` must actually reject.
        removeAdditional: false,
      },
    },
  });

  // Registered before the route plugins. `await app.register(...)` executes the
  // plugin immediately, and each route captures the error handler that exists at
  // that moment - so setting these afterwards leaves every route on Fastify's
  // default handler, turning tagged 503s into 500s.
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'not_found' }));

  app.setErrorHandler(async (err: FastifyError, req, reply) => {
    const mapped = ERROR_STATUS[err.name];
    if (mapped) {
      req.log.warn({ err: err.message, name: err.name }, 'request rejected');
      return reply.code(mapped).send({ error: snake(err.name), message: err.message });
    }

    // Fastify's own schema/parse failures already carry a 4xx.
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    }

    // Anything else may carry WhatsApp internals or message content, so the client
    // gets a generic body while the detail stays in the log.
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  // Registered before the rate limiter so unauthenticated traffic cannot consume a
  // legitimate key's bucket.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(path)) return;
    if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return;
    await requireApiKey(req, reply);
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    // Bucket per API key, falling back to IP for unauthenticated requests. The key
    // is hashed so it never lands in rate-limit state or an error message.
    keyGenerator: (req) => {
      const provided = req.headers['x-api-key'];
      return isValidApiKey(provided) && typeof provided === 'string'
        ? `key:${createHash('sha256').update(provided).digest('hex').slice(0, 16)}`
        : `ip:${req.ip}`;
    },
  });

  // Before the routes: the plugin builds the OpenAPI document from the schemas of
  // routes registered after it, so anything added earlier would be undocumented.
  if (config.ENABLE_DOCS) await app.register(swagger, OPENAPI_OPTIONS);

  await app.register(healthRoutes);
  await app.register(uiRoutes);
  await app.register(qrRoutes);
  await app.register(pairRoutes);
  await app.register(groupRoutes);
  await app.register(chatRoutes);
  await app.register(sendRoutes);
  await app.register(limitsRoutes);

  // After the routes, so the served document includes every one of them.
  if (config.ENABLE_DOCS) await app.register(docsUiPlugin);

  return app;
}

function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
