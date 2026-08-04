import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { rejectIfRemote } from '../localOnly.js';
import { UI_PAGE } from '../ui/page.js';

/**
 * Browser test console. Unauthenticated by design - it is a static page holding no
 * secrets, and every call it makes carries the API key the operator pastes in.
 *
 * SECURITY: it renders the pairing QR and requests pairing codes, so it is gated to
 * loopback callers. Reach it with `ssh -L 3000:127.0.0.1:3000 user@host`. Set
 * `ENABLE_UI=false` to remove it entirely.
 */
export const uiRoutes: FastifyPluginAsync = async (app) => {
  if (!config.ENABLE_UI) return;

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (rejectIfRemote(req, reply, 'The test console')) return reply;
    return reply
      .code(200)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      // No inline-script CSP here on purpose: the page is one file with inline JS and
      // no external origins, so `default-src 'none'` plus 'unsafe-inline' is the
      // honest description rather than a badge.
      .header('content-security-policy', "default-src 'none'; img-src blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
      .header('referrer-policy', 'no-referrer')
      .send(UI_PAGE);
  };

  // `hide: true` keeps these out of the OpenAPI document. They serve one HTML page, not
  // an API, and listing them as endpoints with no schema is worse than omitting them.
  // `as const` matters: without it `rateLimit` widens to `boolean`, which the rate-limit
  // plugin's `false | RateLimitOptions` type rejects.
  const opts = { config: { rateLimit: false }, schema: { hide: true } } as const;

  app.get('/ui', opts, handler);
  // Bare / is what an operator types after opening the tunnel.
  app.get('/', opts, handler);
};
