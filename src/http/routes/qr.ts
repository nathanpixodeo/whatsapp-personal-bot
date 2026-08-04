import type { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import { waClient } from '../../wa/client.js';
import { errorResponse, qrResponse } from '../schemas.js';

/**
 * Serves the pairing QR for first-time linking.
 *
 * SECURITY: scanning this QR links a device to the WhatsApp account, which grants
 * full send and read access. It must never be reachable from the internet. Bind the
 * relay to 127.0.0.1 and reach this over an SSH tunnel:
 *   ssh -L 3000:127.0.0.1:3000 user@host
 * The API key here is defence in depth, not the primary control.
 */
export const qrRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/qr',
    {
      schema: {
        tags: ['linking'],
        summary: 'Pairing QR (account takeover surface)',
        description:
          'Only available while `state` is `awaiting_qr`. **Scanning this QR links a device to the WhatsApp account**, granting full send and read access, so it is loopback-only in practice. The payload rotates roughly every 20 seconds.\n\nSend `Accept: image/png` for a 512 px PNG; otherwise JSON with the raw payload and a data URL.',
        produces: ['application/json', 'image/png'],
        response: {
          200: qrResponse,
          409: errorResponse('Already linked; delete AUTH_DIR to re-link.', 'already_linked'),
          503: errorResponse('No QR pending yet. Poll again, or read /health.', 'qr_unavailable'),
        },
      },
    },
    async (req, reply) => {
      const qr = waClient.getQr();
      const status = waClient.getStatus();

      if (!qr) {
        const alreadyLinked = status.state === 'connected' || status.state === 'connecting';
        return reply.code(alreadyLinked ? 409 : 503).send({
          error: alreadyLinked ? 'already_linked' : 'qr_unavailable',
          state: status.state,
          message: alreadyLinked
            ? 'This account is already linked. Delete AUTH_DIR and restart to re-link.'
            : 'No QR available yet. Poll again shortly, or check /health for the reason.',
        });
      }

      if (req.headers.accept?.includes('image/png')) {
        const png = await QRCode.toBuffer(qr.value, { type: 'png', width: 512, margin: 2 });
        // Fastify sends Buffers untouched, so the 200 response schema declared above
        // documents the JSON branch without mangling this one.
        return reply
          .code(200)
          .header('content-type', 'image/png')
          .header('cache-control', 'no-store')
          .send(png);
      }

      return reply.code(200).header('cache-control', 'no-store').send({
        state: status.state,
        generatedAt: new Date(qr.at).toISOString(),
        qr: qr.value,
        dataUrl: await QRCode.toDataURL(qr.value, { width: 512, margin: 2 }),
        instructions: 'WhatsApp > Settings > Linked devices > Link a device',
      });
    },
  );
};
