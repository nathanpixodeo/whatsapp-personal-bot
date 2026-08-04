import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { UI_PAGE } from '../ui/page.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The socket's peer address, which cannot be forged by a header.
 *
 * `req.ip` respects `trustProxy`, so a request straight to the port carrying
 * `X-Forwarded-For: 127.0.0.1` would read as loopback. Both are checked: the raw
 * peer proves nothing was proxied, `req.ip` catches a same-host nginx forwarding a
 * remote client.
 */
function isLocalOnly(req: FastifyRequest): boolean {
  const peer = req.socket.remoteAddress ?? '';
  return LOOPBACK.has(peer) && LOOPBACK.has(req.ip);
}

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
    if (!isLocalOnly(req)) {
      req.log.warn({ ip: req.ip, peer: req.socket.remoteAddress }, 'blocked remote /ui request');
      return reply.code(403).send({
        error: 'local_only',
        message:
          'The test console links devices to the WhatsApp account, so it is loopback-only. ' +
          'Use: ssh -L 3000:127.0.0.1:3000 user@host',
      });
    }
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

  app.get('/ui', { config: { rateLimit: false } }, handler);
  // Bare / is what an operator types after opening the tunnel.
  app.get('/', { config: { rateLimit: false } }, handler);
};
