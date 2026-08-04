import type { FastifyPluginAsync } from 'fastify';
import { waClient } from '../../wa/client.js';
import { toPhoneDigits } from '../../wa/groups.js';
import { errorResponse, pairResponse } from '../schemas.js';

const bodySchema = {
  type: 'object',
  required: ['phoneNumber'],
  additionalProperties: false,
  properties: {
    // Free-form so "+62 812-3456-789" works; digits are extracted server-side.
    phoneNumber: {
      type: 'string',
      minLength: 8,
      maxLength: 25,
      description:
        'The number of the phone being linked, any format - 8 to 15 digits are extracted. It must be that phone, not a contact: the code is typed into WhatsApp on the device itself.',
      examples: ['+62 812-3456-789'],
    },
  },
} as const;

type PairBody = { phoneNumber: string };

/**
 * Alternative to scanning /qr: WhatsApp shows a field for an 8-character code under
 * "Link a device > Link with phone number instead". Useful when the operator cannot
 * point a camera at the screen (headless server, remote hands, screen reader).
 *
 * SECURITY: same weight as /qr. A code handed to the wrong person links their device
 * to this account. It expires in about a minute and is single-use, which is the only
 * thing limiting the damage.
 */
export const pairRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: PairBody }>(
    '/pair',
    {
      schema: {
        tags: ['linking'],
        summary: 'Pairing code (account takeover surface)',
        description:
          'Camera-free alternative to `/qr`. **A code handed to the wrong person links their device to this account** - it expires in about 60 seconds and is single-use, which is the only thing limiting the damage.\n\nOnly valid while `state` is `awaiting_qr` and before credentials exist.',
        body: bodySchema,
        response: {
          200: pairResponse,
          400: errorResponse('Digits outside the 8-15 range.', 'invalid_participant', 'bad_request'),
          409: errorResponse('Credentials already exist for this account.', 'already_linked'),
          503: errorResponse(
            'Not in `awaiting_qr`, so WhatsApp will not issue a code.',
            'pairing_unavailable',
          ),
        },
      },
    },
    async (req, reply) => {
      const phoneDigits = toPhoneDigits(req.body.phoneNumber);
      const code = await waClient.requestPairingCode(phoneDigits);

      return reply.code(200).header('cache-control', 'no-store').send({
        phoneNumber: phoneDigits,
        code,
        // WhatsApp displays it split in the middle; mirroring that avoids typos.
        display: code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code,
        expiresInSeconds: 60,
        instructions:
          'On the phone: WhatsApp > Linked devices > Link a device > Link with phone number instead',
      });
    },
  );
};
