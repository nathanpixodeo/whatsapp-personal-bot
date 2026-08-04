import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import { chatStore } from '../../wa/chatStore.js';
import type { ChatKind, ChatSummary } from '../../wa/chatStore.js';
import { listGroups } from '../../wa/groups.js';
import { chatListResponse, errorResponse } from '../schemas.js';

const KINDS = ['all', 'dm', 'group', 'broadcast', 'newsletter', 'other'] as const;

const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...KINDS], default: 'all' },
    search: {
      type: 'string',
      maxLength: 100,
      description: 'Case-insensitive substring of the name or the JID.',
    },
    limit: { type: 'integer', minimum: 1, maximum: 10000, description: 'Applied after filtering.' },
    includeArchived: { type: 'string', enum: ['true', 'false'], default: 'true' },
  },
} as const;

type Query = { kind?: (typeof KINDS)[number]; search?: string; limit?: number; includeArchived?: 'true' | 'false' };

/**
 * Every conversation the account can see: 1:1 chats and broadcasts from WhatsApp's
 * history push, merged with `groupFetchAllParticipating()`.
 *
 * The merge is what makes the group side complete. History sync can arrive partial or
 * late, but the group RPC is authoritative and on-demand, so groups are always listed
 * in full even when `historySync.complete` is false.
 */
export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: Query }>(
    '/chats',
    {
      schema: {
        tags: ['chats'],
        summary: 'List conversations',
        description:
          'Groups and 1:1 chats in one list, from two different mechanisms.\n\n**Groups** come from a live RPC and are complete on the first call. **1:1 chats have no fetch-all RPC** - verified against the pinned Baileys build, the socket exposes `chatModify` and nothing that reads a chat list - so they are *pushed* in chunks after linking. One request only sees what has arrived so far, which is what `historySync` reports: poll until `complete` is true.\n\nThe history push carries a `messages` array that is deliberately never retained. Only chat metadata is kept, so this is not a message archive. The store is in-memory and lost on restart.',
        querystring: querySchema,
        response: {
          200: chatListResponse,
          400: errorResponse('Unknown `kind`, or a bad `limit`.', 'bad_request'),
          401: errorResponse('Missing or wrong API key.', 'unauthorized'),
          503: errorResponse('Socket not connected. Read /health.', 'wa_not_connected'),
        },
      },
    },
    async (req, reply) => {
      // Throws WaNotConnected -> 503, same as /groups.
      const groups = await listGroups();

      const merged = new Map<string, ChatSummary>();
      for (const chat of chatStore.snapshot()) merged.set(chat.jid, chat);
      for (const g of groups) {
        const prev = merged.get(g.jid);
        merged.set(g.jid, {
          ...prev,
          jid: g.jid,
          kind: 'group',
          // The live subject wins over whatever history sync recorded.
          name: g.subject,
          participantCount: g.participantCount,
          iAmAdmin: g.iAmAdmin,
          announceOnly: g.announceOnly,
        });
      }

      let chats = [...merged.values()];
      const counts = tally(chats);

      const kind = req.query.kind ?? 'all';
      if (kind !== 'all') chats = chats.filter((c) => c.kind === kind);
      if (req.query.includeArchived === 'false') chats = chats.filter((c) => !c.archived);

      const search = req.query.search?.trim().toLowerCase();
      if (search) {
        chats = chats.filter(
          (c) => c.name?.toLowerCase().includes(search) || c.jid.toLowerCase().includes(search),
        );
      }

      // Most recent first; chats with no reported activity sink to the bottom rather
      // than being dropped, since a quiet chat is still a valid send target.
      chats.sort((a, b) => {
        const at = a.lastActivity ?? '';
        const bt = b.lastActivity ?? '';
        if (at !== bt) return bt.localeCompare(at);
        return (a.name ?? a.jid).localeCompare(b.name ?? b.jid);
      });

      const matched = chats.length;
      const limit = req.query.limit;
      if (limit && chats.length > limit) chats = chats.slice(0, limit);

      const sync = chatStore.syncState();
      return reply.send({
        count: chats.length,
        matched,
        total: merged.size,
        counts,
        historySync: {
          enabled: config.SYNC_HISTORY,
          complete: sync.complete,
          chunks: sync.chunks,
          chatsReceived: sync.chatsReceived,
          progress: sync.progress,
          lastChunkAt: sync.lastChunkAt,
          truncated: sync.truncated,
          note: syncNote(sync.complete),
        },
        chats,
      });
    },
  );
};

function tally(chats: ChatSummary[]): Record<ChatKind, number> {
  const counts: Record<ChatKind, number> = { dm: 0, group: 0, broadcast: 0, newsletter: 0, other: 0 };
  for (const c of chats) counts[c.kind] += 1;
  return counts;
}

function syncNote(complete: boolean): string {
  if (!config.SYNC_HISTORY) {
    return 'SYNC_HISTORY=false, so only groups are listed. WhatsApp offers no RPC to fetch 1:1 chats.';
  }
  return complete
    ? 'History sync finished. Groups come from a live RPC and are always current.'
    : 'History sync still arriving, so the 1:1 chat list may be incomplete - poll again. Groups are already complete.';
}
