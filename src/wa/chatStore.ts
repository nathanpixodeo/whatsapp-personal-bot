import { isJidBroadcast, isJidGroup, isJidNewsletter, jidNormalizedUser } from 'baileys';
import type { Chat, ChatUpdate, Contact } from 'baileys';
import { logger } from '../logger.js';

export type ChatKind = 'dm' | 'group' | 'broadcast' | 'newsletter' | 'other';

export type ChatSummary = {
  jid: string;
  kind: ChatKind;
  name?: string;
  unreadCount?: number;
  /** ISO timestamp of the last message in the chat, when WhatsApp reported one. */
  lastActivity?: string;
  archived?: boolean;
  pinned?: boolean;
  /** Cannot be written to - announcement groups and read-only broadcasts. */
  readOnly?: boolean;
  /** Group-only, merged in from groupFetchAllParticipating(). */
  participantCount?: number;
  iAmAdmin?: boolean;
  announceOnly?: boolean;
};

export type HistorySyncState = {
  /** Chunks of history WhatsApp has pushed so far. */
  chunks: number;
  chatsReceived: number;
  complete: boolean;
  progress?: number;
  lastChunkAt?: string;
};

/**
 * A hard ceiling rather than an LRU: dropping the oldest chat silently would make a
 * partial list look complete. If this is ever hit, the log says so and /chats reports
 * `truncated`.
 */
const MAX_CHATS = 10_000;

/**
 * Chat list assembled from WhatsApp's history-sync push.
 *
 * There is no fetch-all-chats RPC in Baileys v7 - verified against the installed
 * types, which expose only `chatModify` for mutations. Chats arrive exclusively via
 * `messaging-history.set` (once, shortly after linking) and `chats.upsert`, so this
 * store is the only way to answer "what conversations exist".
 *
 * PRIVACY: `messaging-history.set` also carries `messages`. They are deliberately
 * never passed in here. Only chat metadata is retained - no message bodies - so
 * enabling history sync does not turn this process into a message archive.
 */
class ChatStore {
  private readonly chats = new Map<string, ChatSummary>();
  private readonly names = new Map<string, string>();
  private truncated = false;
  private sync: HistorySyncState = { chunks: 0, chatsReceived: 0, complete: false };

  ingestContacts(contacts: (Contact | Partial<Contact>)[]): void {
    for (const c of contacts) {
      if (!c.id) continue;
      const name = c.name ?? c.notify ?? c.verifiedName;
      if (!name) continue;
      const key = jidNormalizedUser(c.id);
      this.names.set(key, name);
      // A contact can arrive after its chat did.
      const existing = this.chats.get(key);
      if (existing && !existing.name) existing.name = name;
    }
  }

  ingestChats(chats: (Chat | ChatUpdate)[]): void {
    for (const chat of chats) {
      if (!chat.id) continue;
      const jid = chat.id;
      const prev = this.chats.get(jid);

      if (!prev && this.chats.size >= MAX_CHATS) {
        if (!this.truncated) {
          this.truncated = true;
          logger.warn({ max: MAX_CHATS }, 'chat store full; further chats are dropped');
        }
        continue;
      }

      const next: ChatSummary = prev ?? { jid, kind: classify(jid) };
      // Partial updates must not blank a field that is simply absent from the patch.
      const name = chat.name ?? this.names.get(jidNormalizedUser(jid));
      if (name) next.name = name;
      if (chat.unreadCount != null) next.unreadCount = Math.max(0, chat.unreadCount);
      if (chat.archived != null) next.archived = chat.archived;
      if (chat.pinned != null) next.pinned = chat.pinned > 0;
      if (chat.readOnly != null) next.readOnly = chat.readOnly;
      const ts = toMillis(chat.conversationTimestamp);
      if (ts) next.lastActivity = new Date(ts).toISOString();

      this.chats.set(jid, next);
    }
  }

  remove(jids: string[]): void {
    for (const jid of jids) this.chats.delete(jid);
  }

  noteSyncChunk(input: { chats: number; progress?: number | null; isLatest?: boolean }): void {
    this.sync.chunks += 1;
    this.sync.chatsReceived += input.chats;
    this.sync.lastChunkAt = new Date().toISOString();
    if (input.progress != null) this.sync.progress = input.progress;
    // `isLatest` marks the final chunk of a sync; the explicit status event is more
    // reliable, but on some accounts only this arrives.
    if (input.isLatest) this.sync.complete = true;
    logger.info(
      { chunks: this.sync.chunks, chats: this.chats.size, progress: this.sync.progress },
      'history sync chunk',
    );
  }

  noteSyncComplete(): void {
    this.sync.complete = true;
    logger.info({ chats: this.chats.size }, 'history sync complete');
  }

  snapshot(): ChatSummary[] {
    return [...this.chats.values()].map((c) => ({ ...c }));
  }

  syncState(): HistorySyncState & { truncated: boolean } {
    return { ...this.sync, truncated: this.truncated };
  }
}

function classify(jid: string): ChatKind {
  if (isJidGroup(jid)) return 'group';
  if (isJidNewsletter(jid)) return 'newsletter';
  if (isJidBroadcast(jid)) return 'broadcast';
  if (jid.includes('@s.whatsapp.net') || jid.includes('@lid')) return 'dm';
  return 'other';
}

/** WhatsApp sends seconds, sometimes as a protobuf Long rather than a number. */
function toMillis(value: unknown): number | undefined {
  if (value == null) return undefined;
  let seconds: number;
  if (typeof value === 'number') seconds = value;
  else if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    seconds = (value as { toNumber: () => number }).toNumber();
  } else seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export const chatStore = new ChatStore();
