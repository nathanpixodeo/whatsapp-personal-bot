import type { FastifyPluginAsync } from 'fastify';
import { MAX_MESSAGE_LENGTH, config } from '../../config.js';
import { sendText } from '../../wa/send.js';
import { claim, release, settle } from '../idempotency.js';

const bodySchema = {
  type: 'object',
  required: ['message'],
  additionalProperties: false,
  properties: {
    message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
    groupJid: { type: 'string', pattern: '^\\d+-?\\d*@g\\.us$' },
  },
} as const;

type SendBody = { message: string; groupJid?: string };

export const sendRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: SendBody }>('/send', { schema: { body: bodySchema } }, async (req, reply) => {
    // `minLength: 1` still admits "   ", which WhatsApp rejects.
    const message = req.body.message.trim();
    if (message.length === 0) {
      return reply
        .code(400)
        .send({ error: 'invalid_message', message: 'message must contain non-whitespace text' });
    }

    const groupJid = req.body.groupJid ?? config.DEFAULT_GROUP_JID;
    if (!groupJid) {
      return reply.code(400).send({
        error: 'no_target',
        message: 'Provide groupJid, or set DEFAULT_GROUP_JID in the environment',
      });
    }

    const idempotencyKey = req.headers['idempotency-key'];
    const key = typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey : undefined;

    if (key) {
      const existing = claim(key);
      if (existing.kind === 'replay') {
        return reply
          .code(existing.status)
          .send({ ...(existing.body as object), idempotentReplay: true });
      }
      if (existing.kind === 'in_flight') {
        // Returning 409 rather than sending again: a duplicate in flight is exactly
        // the case idempotency exists to stop.
        return reply.code(409).send({
          error: 'in_flight',
          message: 'A request with this Idempotency-Key is still being processed',
        });
      }
    }

    try {
      const outcome = await sendText(groupJid, message);
      const body = { groupJid, ...outcome };
      // 202 for both outcomes. `accepted` means the socket took it, not that it was
      // delivered; `unknown` means we cannot tell. Neither is a 2xx-means-delivered
      // promise, and neither should be blindly retried.
      if (key) settle(key, 202, body);
      return reply.code(202).send(body);
    } catch (err) {
      if (key) release(key);
      throw err;
    }
  });
};
