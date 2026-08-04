import type { FastifyReply, FastifyRequest } from 'fastify';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * True only for a caller on this machine that did not arrive through a proxy.
 *
 * `req.ip` respects `trustProxy`, so a request straight to the port carrying
 * `X-Forwarded-For: 127.0.0.1` would read as loopback. Both are checked: the raw peer
 * address cannot be forged by a header, and `req.ip` catches a same-host nginx
 * forwarding a remote client.
 */
export function isLocalOnly(req: FastifyRequest): boolean {
  const peer = req.socket.remoteAddress ?? '';
  return LOOPBACK.has(peer) && LOOPBACK.has(req.ip);
}

/**
 * Rejects non-loopback callers with 403.
 *
 * Used by the routes that can link a device to the WhatsApp account - the test console
 * and the Swagger UI, whose "Try it out" reaches /qr and /pair. Returns true when the
 * reply has been sent, so the caller stops.
 */
export function rejectIfRemote(req: FastifyRequest, reply: FastifyReply, what: string): boolean {
  if (isLocalOnly(req)) return false;
  req.log.warn({ ip: req.ip, peer: req.socket.remoteAddress, what }, 'blocked remote request');
  void reply.code(403).send({
    error: 'local_only',
    message:
      `${what} can link a device to the WhatsApp account, so it is loopback-only. ` +
      'Use: ssh -L 3000:127.0.0.1:3000 user@host',
  });
  return true;
}
