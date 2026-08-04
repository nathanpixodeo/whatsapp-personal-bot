import type { FastifyPluginAsync } from 'fastify';
import { createGroup, getInviteLink, listGroups } from '../../wa/groups.js';

const createBodySchema = {
  type: 'object',
  required: ['subject', 'participants'],
  additionalProperties: false,
  properties: {
    subject: { type: 'string', minLength: 1, maxLength: 100 },
    participants: {
      type: 'array',
      minItems: 1,
      // WhatsApp's own group cap. Requesting more is a client bug, not a partial success.
      maxItems: 1024,
      items: { type: 'string', minLength: 8, maxLength: 20 },
    },
  },
} as const;

const jidParamsSchema = {
  type: 'object',
  required: ['jid'],
  properties: { jid: { type: 'string', pattern: '^\\d+-?\\d*@g\\.us$' } },
} as const;

type CreateBody = { subject: string; participants: string[] };

export const groupRoutes: FastifyPluginAsync = async (app) => {
  app.get('/groups', async (_req, reply) => {
    const groups = await listGroups();
    return reply.send({ count: groups.length, groups });
  });

  app.post<{ Body: CreateBody }>(
    '/groups',
    { schema: { body: createBodySchema } },
    async (req, reply) => {
      const result = await createGroup(req.body.subject, req.body.participants);
      // 201 even when some participants were left out: the group exists, and the
      // per-participant outcome plus inviteLink are in the body.
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { jid: string } }>(
    '/groups/:jid/invite',
    { schema: { params: jidParamsSchema } },
    async (req, reply) => {
      const inviteLink = await getInviteLink(req.params.jid);
      if (!inviteLink) {
        return reply.code(409).send({
          error: 'invite_unavailable',
          message: 'WhatsApp did not return an invite code. Admin rights are usually required.',
        });
      }
      return reply.send({ groupJid: req.params.jid, inviteLink });
    },
  );
};
