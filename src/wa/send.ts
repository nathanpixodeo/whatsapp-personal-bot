import { isJidGroup } from 'baileys';
import { logger, messageDigest } from '../logger.js';
import { waClient } from './client.js';
import { sendQueue } from './sendQueue.js';

export type SendOutcome =
  /** The socket accepted the stanza. This is not a delivery guarantee. */
  | { status: 'accepted'; messageId: string }
  /** The call returned without a message id. We genuinely do not know. */
  | { status: 'unknown'; messageId: null };

export async function sendText(groupJid: string, text: string): Promise<SendOutcome> {
  if (!isJidGroup(groupJid)) {
    const err = new Error(`"${groupJid}" is not a group JID (expected …@g.us)`);
    err.name = 'InvalidGroupJid';
    throw err;
  }

  const sock = waClient.requireSocket();
  const sent = await sendQueue.enqueue(() => sock.sendMessage(groupJid, { text }));
  const messageId = sent?.key.id;

  if (!messageId) {
    // `sendMessage` resolving without a key means the outcome is indeterminate: the
    // message may or may not be on its way. Reporting this as a failure would invite
    // the caller to retry and duplicate it, so it is surfaced as `unknown` instead.
    logger.error({ groupJid, ...messageDigest(text) }, 'send returned no message id');
    return { status: 'unknown', messageId: null };
  }

  logger.info({ groupJid, messageId, ...messageDigest(text) }, 'send accepted');
  return { status: 'accepted', messageId };
}
