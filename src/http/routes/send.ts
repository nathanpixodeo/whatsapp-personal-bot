import type { FastifyPluginAsync } from 'fastify';
import { MAX_MESSAGE_LENGTH, config } from '../../config.js';
import { sendText } from '../../wa/send.js';
import { claim, release, settle } from '../idempotency.js';
import { GROUP_JID_PATTERN, errorResponse, sendResponse } from '../schemas.js';

const bodySchema = {
  type: 'object',
  required: ['message'],
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_MESSAGE_LENGTH,
      description: 'Plain text. Never logged - only its length and a SHA-256 prefix are.',
      examples: ['Build #412 failed'],
    },
    groupJid: {
      type: 'string',
      pattern: GROUP_JID_PATTERN,
      description: 'Falls back to `DEFAULT_GROUP_JID` when omitted.',
      examples: ['120363000000000000@g.us'],
    },
  },
} as const;

const headersSchema = {
  type: 'object',
  properties: {
    'idempotency-key': {
      type: 'string',
      description:
        'Optional. A repeated key replays the stored reply with `idempotentReplay: true`; a key still in flight gets 409. In-memory with a 24 h TTL, so it covers webhook retries but not a restart in between.',
    },
  },
} as const;

type SendBody = { message: string; groupJid?: string };

export const sendRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: SendBody }>(
    '/send',
    {
      schema: {
        tags: ['messages'],
        summary: 'Send text to a group',
        description:
          '**202 means the socket accepted the stanza, not that it was delivered.** `status: "unknown"` means Baileys returned no message key - the message may well be on its way, so this is deliberately not a 5xx: a 5xx invites a retry that duplicates it.\n\nSends are serialized through one queue with a jittered minimum gap, and are additionally subject to the pacing limits in `GET /limits` - hence the 429/503 codes below.',
        body: bodySchema,
        headers: headersSchema,
        response: {
          202: sendResponse,
          400: errorResponse(
            'Whitespace-only message, no target, or a malformed JID.',
            'invalid_message',
            'no_target',
            'bad_request',
            'invalid_group_jid',
          ),
          401: errorResponse('Missing or wrong API key.', 'unauthorized'),
          409: errorResponse('Same Idempotency-Key still in flight.', 'in_flight'),
          429: errorResponse(
            'A pacing limit was hit. See GET /limits.',
            'hourly_limit',
            'daily_limit',
            'target_cooldown',
          ),
          503: errorResponse(
            'Not sendable right now.',
            'wa_not_connected',
            'quiet_hours',
            'queue_closed',
          ),
        },
      },
    },
    async (req, reply) => {
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
    },
  );
};
