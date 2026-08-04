import { jidDecode } from 'baileys';
import type { GroupMetadata } from 'baileys';
import { logger } from '../logger.js';
import { waClient } from './client.js';
import { sendQueue } from './sendQueue.js';

export type GroupSummary = {
  jid: string;
  subject: string;
  participantCount: number;
  iAmAdmin: boolean;
  /** Only admins can post when true. */
  announceOnly: boolean;
  isCommunity: boolean;
};

export type CreateGroupResult = {
  groupJid: string;
  subject: string;
  /** undefined when WhatsApp declined to issue an invite code. */
  inviteLink?: string;
  requested: number;
  added: string[];
  notOnWhatsApp: string[];
  notAdded: string[];
  hint?: string;
};

const INVITE_BASE = 'https://chat.whatsapp.com/';

/** Strips +, spaces and dashes, then checks the E.164 digit count. */
export function toPhoneDigits(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    const err = new Error(
      `"${input}" is not a valid E.164 phone number (8-15 digits including country code)`,
    );
    err.name = 'InvalidParticipant';
    throw err;
  }
  return digits;
}

/** Normalises a phone number to a WhatsApp user JID. Accepts +, spaces, dashes. */
export function toUserJid(input: string): string {
  return `${toPhoneDigits(input)}@s.whatsapp.net`;
}

export async function listGroups(): Promise<GroupSummary[]> {
  const sock = waClient.requireSocket();
  const meUser = jidDecode(sock.user?.id)?.user;
  const all = await sock.groupFetchAllParticipating();

  return Object.values(all)
    .map((metadata) => {
      waClient.cacheGroup(metadata);
      return {
        jid: metadata.id,
        subject: metadata.subject,
        participantCount: metadata.size ?? metadata.participants.length,
        iAmAdmin: metadata.participants.some(
          (p) => isSameUser(p.id, meUser) && (p.isAdmin === true || p.admin != null),
        ),
        announceOnly: metadata.announce === true,
        isCommunity: metadata.isCommunity === true,
      };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

export async function getGroup(jid: string): Promise<GroupMetadata> {
  const sock = waClient.requireSocket();
  const metadata = await sock.groupMetadata(jid);
  waClient.cacheGroup(metadata);
  return metadata;
}

/**
 * Creates a group and reports honestly which participants actually landed in it.
 *
 * The usual surprise: a contact whose "who can add me to groups" privacy setting
 * excludes you is silently left out of the created group. WhatsApp does not return
 * a per-participant error for that, so we diff the requested list against the
 * metadata it hands back and always return an invite link as the remedy.
 */
export async function createGroup(
  subject: string,
  participants: string[],
): Promise<CreateGroupResult> {
  // Normalise before touching the socket, so a malformed number is reported as 400
  // rather than being masked by a 503 whenever the relay happens to be reconnecting.
  const requestedJids = [...new Set(participants.map(toUserJid))];
  const sock = waClient.requireSocket();

  // Creating a group around a number that has no WhatsApp account fails the whole
  // call, so filter first. `onWhatsApp` returning undefined means the lookup itself
  // failed - assume they exist rather than dropping them.
  let existing = requestedJids;
  let notOnWhatsApp: string[] = [];
  const lookup = await sock.onWhatsApp(...requestedJids);
  if (lookup) {
    const present = new Set(
      lookup.filter((r) => r.exists).map((r) => jidDecode(r.jid)?.user ?? r.jid),
    );
    existing = requestedJids.filter((jid) => present.has(jidDecode(jid)?.user ?? jid));
    notOnWhatsApp = requestedJids.filter((jid) => !existing.includes(jid));
  } else {
    logger.warn('onWhatsApp lookup returned nothing; creating group with all requested numbers');
  }

  const metadata = await sendQueue.enqueue(() => sock.groupCreate(subject, existing));
  waClient.cacheGroup(metadata);

  const inGroup = new Set<string>();
  for (const p of metadata.participants) {
    for (const candidate of [p.id, p.phoneNumber, p.lid]) {
      const user = jidDecode(candidate)?.user;
      if (user) inGroup.add(user);
    }
  }

  const added: string[] = [];
  const notAdded: string[] = [];
  for (const jid of existing) {
    const user = jidDecode(jid)?.user;
    if (user && inGroup.has(user)) added.push(jid);
    else notAdded.push(jid);
  }

  let inviteLink: string | undefined;
  try {
    const code = await sock.groupInviteCode(metadata.id);
    if (code) inviteLink = `${INVITE_BASE}${code}`;
  } catch (err) {
    logger.warn({ err, groupJid: metadata.id }, 'could not fetch group invite code');
  }

  const result: CreateGroupResult = {
    groupJid: metadata.id,
    subject: metadata.subject,
    requested: requestedJids.length,
    added,
    notOnWhatsApp,
    notAdded,
  };
  if (inviteLink) result.inviteLink = inviteLink;
  if (notAdded.length > 0) {
    result.hint =
      'Numbers in notAdded were not in the group after creation. The usual cause is their ' +
      '"who can add me to groups" privacy setting. Send them inviteLink instead.';
  }

  logger.info(
    {
      groupJid: result.groupJid,
      requested: result.requested,
      added: added.length,
      notAdded: notAdded.length,
      notOnWhatsApp: notOnWhatsApp.length,
    },
    'group created',
  );

  return result;
}

export async function getInviteLink(groupJid: string): Promise<string | undefined> {
  const sock = waClient.requireSocket();
  const code = await sock.groupInviteCode(groupJid);
  return code ? `${INVITE_BASE}${code}` : undefined;
}

function isSameUser(jid: string | undefined, user: string | undefined): boolean {
  if (!jid || !user) return false;
  return jidDecode(jid)?.user === user;
}
