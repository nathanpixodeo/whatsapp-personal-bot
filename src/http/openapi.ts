import swaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';
import type { SwaggerOptions } from '@fastify/swagger';
import { config } from '../config.js';
import { rejectIfRemote } from './localOnly.js';

/**
 * OpenAPI document options. Registered on the root instance *before* the routes, since
 * the plugin builds the document from the schemas of routes added after it.
 */
export const OPENAPI_OPTIONS: SwaggerOptions = {
  openapi: {
    openapi: '3.1.0',
    info: {
      title: 'WhatsApp Personal Group Relay',
      version: '0.1.0',
      description: [
        'Authenticated HTTP relay that posts into WhatsApp groups and creates new ones,',
        'driving a personal account as a linked device via the multi-device protocol.',
        '',
        '### Read before using',
        '',
        '- `GET /qr` and `POST /pair` **grant account takeover**: whoever scans the QR or',
        '  types the code links their own device to this account. They are loopback-gated',
        '  and additionally API-key protected as defence in depth, not as the control.',
        '- `202` from `POST /send` means the socket accepted the stanza. It is not a',
        '  delivery guarantee, and a `unknown` status must not be blindly retried.',
        '- Automating a personal number can get it restricted or banned. Use a dedicated,',
        '  non-critical number and only message people who expect the messages.',
      ].join('\n'),
    },
    servers: [{ url: `http://127.0.0.1:${config.PORT}`, description: 'Loopback (SSH tunnel)' }],
    tags: [
      { name: 'health', description: 'Liveness, for watchdogs and load balancers.' },
      { name: 'linking', description: 'Linking a device. Treat as account credentials.' },
      { name: 'groups', description: 'List and create groups; fetch invite links.' },
      { name: 'chats', description: 'The conversation list.' },
      { name: 'messages', description: 'Sending.' },
      { name: 'ops', description: 'Pacing and volume state.' },
    ],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          name: 'X-API-Key',
          in: 'header',
          description:
            'Shared secret for this relay only - nothing to do with Meta or WhatsApp. Compared in constant time. Generate with `openssl rand -hex 32`.',
        },
      },
    },
    security: [{ apiKey: [] }],
  },
};

/**
 * Swagger UI at /docs.
 *
 * SECURITY: gated to loopback for the same reason the test console is. "Try it out"
 * against `/qr` or `/pair` links a device to the WhatsApp account, so this page is a
 * takeover surface, not documentation. The guard lives in an encapsulated scope so it
 * covers the plugin's static assets too, not just the HTML entry point.
 */
export const docsUiPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    if (rejectIfRemote(req, reply, 'The API docs')) return reply;
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    uiConfig: {
      // Endpoints listed but collapsed: the list is short and the descriptions are long.
      docExpansion: 'list',
      // Left on deliberately. The page is already loopback-only, and the whole point of
      // serving it next to the relay is being able to fire a real request at it.
      tryItOutEnabled: true,
    },
  });
};
