import type { FastifyPluginAsync } from 'fastify';
import { createGroup, getInviteLink, listGroups } from '../../wa/groups.js';
import {
  GROUP_JID_PATTERN,
  errorResponse,
  groupCreateResponse,
  groupListResponse,
  inviteResponse,
} from '../schemas.js';

const createBodySchema = {
  type: 'object',
  required: ['subject', 'participants'],
  additionalProperties: false,
  properties: {
    subject: { type: 'string', minLength: 1, maxLength: 100, examples: ['Deploy alerts'] },
    participants: {
      type: 'array',
      minItems: 1,
      // WhatsApp's own group cap. Requesting more is a client bug, not a partial success.
      maxItems: 1024,
      items: { type: 'string', minLength: 8, maxLength: 20 },
      description:
        'Phone numbers in any format; 8 to 15 digits are extracted. Numbers with no WhatsApp account are filtered out before the group is created and reported in `notOnWhatsApp`.',
      examples: [['+62 812-3456-789', '628998887777']],
    },
  },
} as const;

const jidParamsSchema = {
  type: 'object',
  required: ['jid'],
  properties: {
    jid: { type: 'string', pattern: GROUP_JID_PATTERN, examples: ['120363000000000000@g.us'] },
  },
} as const;

type CreateBody = { subject: string; participants: string[] };

export const groupRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/groups',
    {
      schema: {
        tags: ['groups'],
        summary: 'List participating groups',
        description:
          'From `groupFetchAllParticipating()` - a real request/response call, so the list is always complete and current. Use the `jid`, never the subject: subjects are mutable and non-unique, and a rename would silently retarget sends.',
        response: {
          200: groupListResponse,
          401: errorResponse('Missing or wrong API key.', 'unauthorized'),
          503: errorResponse('Socket not connected. Read /health.', 'wa_not_connected'),
        },
      },
    },
    async (_req, reply) => {
      const groups = await listGroups();
      return reply.send({ count: groups.length, groups });
    },
  );

  app.post<{ Body: CreateBody }>(
    '/groups',
    {
      schema: {
        tags: ['groups'],
        summary: 'Create a group',
        description:
          'Returns 201 with `added`, `notAdded` and an `inviteLink`. A contact whose *"who can add me to groups"* privacy setting excludes this account is **silently omitted by WhatsApp with no per-participant error**, so the requested list is diffed against the resulting metadata and an invite link is always fetched as the remedy. Check `notAdded`, not the status code.',
        body: createBodySchema,
        response: {
          201: groupCreateResponse,
          400: errorResponse('Malformed subject or number.', 'invalid_participant', 'bad_request'),
          401: errorResponse('Missing or wrong API key.', 'unauthorized'),
          503: errorResponse('Socket not connected. Read /health.', 'wa_not_connected'),
        },
      },
    },
    async (req, reply) => {
      const result = await createGroup(req.body.subject, req.body.participants);
      // 201 even when some participants were left out: the group exists, and the
      // per-participant outcome plus inviteLink are in the body.
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { jid: string } }>(
    '/groups/:jid/invite',
    {
      schema: {
        tags: ['groups'],
        summary: 'Invite link for an existing group',
        description:
          'Usually requires admin rights in that group. A 409 means WhatsApp returned no code rather than that the group is missing.',
        params: jidParamsSchema,
        response: {
          200: inviteResponse,
          400: errorResponse('Not a group JID.', 'bad_request', 'invalid_group_jid'),
          401: errorResponse('Missing or wrong API key.', 'unauthorized'),
          409: errorResponse('No invite code returned; admin rights needed.', 'invite_unavailable'),
          503: errorResponse('Socket not connected. Read /health.', 'wa_not_connected'),
        },
      },
    },
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
