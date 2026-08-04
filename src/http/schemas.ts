/**
 * Shared JSON Schema fragments for the OpenAPI document.
 *
 * Every response schema here sets `additionalProperties: true`, and that is load
 * bearing rather than laziness. Fastify runs replies through fast-json-stringify, which
 * *drops* properties a response schema does not list. Documenting a response would then
 * silently truncate it, so a field added to a handler and forgotten here would vanish
 * from the wire with no error anywhere. Permitting extras keeps the document honest
 * about shape without letting it edit the payload.
 */

type JsonSchema = Record<string, unknown>;

const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;

export const GROUP_JID_PATTERN = '^\\d+-?\\d*@g\\.us$';

/** A tagged error body: `error` is a stable snake_case code, `message` is for humans. */
export function errorResponse(description: string, ...codes: string[]): JsonSchema {
  return {
    description: codes.length ? `${description} \`error\`: ${codes.join(', ')}.` : description,
    type: 'object',
    additionalProperties: true,
    properties: {
      error: { ...str, ...(codes.length ? { enum: codes } : {}) },
      message: str,
    },
  };
}

export const healthResponse: JsonSchema = {
  description: 'Liveness. 200 only when a send would actually be attempted.',
  type: 'object',
  additionalProperties: true,
  properties: {
    state: {
      ...str,
      enum: [
        'starting',
        'awaiting_qr',
        'connecting',
        'connected',
        'needs_relink',
        'replaced',
        'restricted',
        'stopped',
      ],
      description: 'One enum, not a pair of booleans that can disagree.',
    },
    healthy: bool,
    reason: { ...str, description: 'Why the state is not `connected`.' },
    me: {
      type: 'object',
      additionalProperties: true,
      properties: { jid: str, name: str },
    },
    qrAvailable: bool,
    outgoingBlocked: {
      ...bool,
      description: 'WhatsApp is refusing this account\'s outbound messages (reachoutTimeLock).',
    },
    reconnects: int,
    connectedAt: dateTime,
    lastDisconnectAt: dateTime,
    queueDepth: int,
    uptimeSeconds: int,
  },
};

export const qrResponse: JsonSchema = {
  description: 'Pairing payload. Send `Accept: image/png` for a 512 px PNG instead.',
  type: 'object',
  additionalProperties: true,
  properties: {
    qr: { ...str, description: 'Raw QR payload. Anyone who scans it links a device.' },
    dataUrl: { ...str, description: 'PNG data URL, usable directly as an <img> src.' },
    generatedAt: dateTime,
  },
};

export const pairResponse: JsonSchema = {
  description: 'An 8-character code to type into the phone. Valid for about 60 seconds.',
  type: 'object',
  additionalProperties: true,
  properties: {
    phoneNumber: str,
    code: str,
    display: { ...str, description: 'Same code, hyphenated the way the phone shows it.' },
    expiresInSeconds: int,
    instructions: str,
  },
};

const groupSummary: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    jid: { ...str, description: 'Address messages here. Names are mutable; JIDs are not.' },
    subject: str,
    participantCount: int,
    iAmAdmin: bool,
    announceOnly: {
      ...bool,
      description: 'Only admins may post. A send here is accepted then dropped unless iAmAdmin.',
    },
  },
};

export const groupListResponse: JsonSchema = {
  description: 'Groups this account participates in, from a live RPC.',
  type: 'object',
  additionalProperties: true,
  properties: { count: int, groups: { type: 'array', items: groupSummary } },
};

export const groupCreateResponse: JsonSchema = {
  description:
    '201 even when participants were left out - the group exists. Check `notAdded`, not the status code.',
  type: 'object',
  additionalProperties: true,
  properties: {
    groupJid: str,
    subject: str,
    inviteLink: { ...str, description: 'Always fetched, so `notAdded` has a remedy.' },
    requested: int,
    added: { type: 'array', items: str },
    notOnWhatsApp: { type: 'array', items: str },
    notAdded: {
      type: 'array',
      items: str,
      description:
        'In the request but absent from the created group. Usually their "who can add me to groups" privacy setting. Named for what is observable, since WhatsApp reports no per-participant cause.',
    },
    hint: str,
  },
};

export const inviteResponse: JsonSchema = {
  description: 'Invite link for an existing group.',
  type: 'object',
  additionalProperties: true,
  properties: { groupJid: str, inviteLink: str },
};

export const chatListResponse: JsonSchema = {
  description: 'Conversations: history-synced 1:1 chats merged with the live group list.',
  type: 'object',
  additionalProperties: true,
  properties: {
    count: { ...int, description: 'Rows returned after filtering and `limit`.' },
    matched: { ...int, description: 'Rows matching the filter before `limit`.' },
    total: int,
    counts: {
      type: 'object',
      additionalProperties: true,
      properties: { dm: int, group: int, broadcast: int, newsletter: int, other: int },
    },
    historySync: {
      type: 'object',
      additionalProperties: true,
      description:
        'Groups come from an RPC and are always complete. 1:1 chats are *pushed* in chunks - there is no fetch-all-chats RPC - so poll until `complete` instead of treating the first response as final.',
      properties: {
        enabled: bool,
        complete: bool,
        chunks: int,
        chatsReceived: int,
        progress: int,
        lastChunkAt: dateTime,
        truncated: { ...bool, description: 'The 10 000-chat ceiling was hit; nothing was evicted.' },
        note: str,
      },
    },
    chats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          jid: str,
          kind: { ...str, enum: ['dm', 'group', 'broadcast', 'newsletter', 'other'] },
          name: str,
          unreadCount: int,
          lastActivity: dateTime,
          archived: bool,
          pinned: bool,
          readOnly: bool,
          participantCount: int,
          iAmAdmin: bool,
          announceOnly: bool,
        },
      },
    },
  },
};

export const sendResponse: JsonSchema = {
  description:
    '202 means the socket accepted the stanza, not that it was delivered. `unknown` means Baileys returned no message key - genuinely indeterminate, so do not blindly retry.',
  type: 'object',
  additionalProperties: true,
  properties: {
    groupJid: str,
    status: { ...str, enum: ['accepted', 'unknown'] },
    messageId: { type: ['string', 'null'] },
    idempotentReplay: { ...bool, description: 'This is a stored reply to a repeated Idempotency-Key.' },
  },
};

export const limitsResponse: JsonSchema = {
  description:
    'Current pacing and volume state. None of this hides the automation - WhatsApp sees a normally linked device either way. It reduces the behaviour enforcement keys on.',
  type: 'object',
  additionalProperties: true,
  properties: {
    humanize: bool,
    sentLastHour: int,
    sentLastDay: { ...int, description: 'Rolling 24 h window, not calendar day.' },
    hourlyLimit: { type: ['integer', 'null'] },
    dailyLimit: { type: ['integer', 'null'] },
    quietHours: {
      type: ['object', 'null'],
      additionalProperties: true,
      properties: { window: str, timeZone: str, active: bool },
    },
    pacing: {
      type: 'object',
      additionalProperties: true,
      properties: { minIntervalMs: int, jitterMs: int, perTargetMinIntervalMs: int },
    },
    typing: {
      type: 'object',
      additionalProperties: true,
      properties: { enabled: bool, charsPerSecond: int, maxMs: int },
    },
    counterNote: str,
  },
};
