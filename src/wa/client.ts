import { mkdir } from 'node:fs/promises';
import type { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from 'baileys';
import type { GroupMetadata, WASocket } from 'baileys';
import { LRUCache } from 'lru-cache';
import { config } from '../config.js';
import { logger, waLogger } from '../logger.js';
import { chatStore } from './chatStore.js';

/**
 * One enum instead of the usual `ready`/`groupConfigured` boolean pair: those can
 * disagree, and every disagreement is a state where /health lies.
 */
export type ConnState =
  /** process started, socket not opened yet */
  | 'starting'
  /** socket open, waiting for an operator to scan the QR */
  | 'awaiting_qr'
  /** credentials exist, handshake in progress */
  | 'connecting'
  /** usable */
  | 'connected'
  /** session revoked from the phone - an operator must re-scan */
  | 'needs_relink'
  /** another client took over this session - do not fight it */
  | 'replaced'
  /** WhatsApp returned 403 for this account */
  | 'restricted'
  /** deliberate shutdown */
  | 'stopped';

const TERMINAL_STATES: ReadonlySet<ConnState> = new Set<ConnState>([
  'needs_relink',
  'replaced',
  'restricted',
  'stopped',
]);

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const GROUP_CACHE_TTL_MS = 5 * 60 * 1000;

export type WaStatus = {
  state: ConnState;
  reason?: string;
  me?: { jid: string; name?: string };
  qrAvailable: boolean;
  reconnects: number;
  lastDisconnectAt?: string;
  connectedAt?: string;
  /** WhatsApp is blocking this account's outgoing messages. Sends will fail. */
  outgoingBlocked?: boolean;
};

export class WaClient {
  private sock: WASocket | undefined;
  private state: ConnState = 'starting';
  private reason: string | undefined;
  private qr: { value: string; at: number } | undefined;
  private saveCreds: (() => Promise<void>) | undefined;
  private authState: Awaited<ReturnType<typeof useMultiFileAuthState>>['state'] | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private reconnects = 0;
  private stopping = false;
  private lastDisconnectAt: Date | undefined;
  private connectedAt: Date | undefined;
  private outgoingBlocked = false;

  /**
   * Handed to Baileys as `cachedGroupMetadata`. Without it every group send does a
   * round trip to fetch participants before encrypting.
   */
  private readonly groupCache = new LRUCache<string, GroupMetadata>({
    max: 500,
    ttl: GROUP_CACHE_TTL_MS,
  });

  getStatus(): WaStatus {
    const status: WaStatus = {
      state: this.state,
      qrAvailable: this.qr !== undefined,
      reconnects: this.reconnects,
    };
    if (this.reason) status.reason = this.reason;
    if (this.sock?.user) {
      status.me = { jid: this.sock.user.id };
      if (this.sock.user.name) status.me.name = this.sock.user.name;
    }
    if (this.lastDisconnectAt) status.lastDisconnectAt = this.lastDisconnectAt.toISOString();
    if (this.connectedAt) status.connectedAt = this.connectedAt.toISOString();
    if (this.outgoingBlocked) status.outgoingBlocked = true;
    return status;
  }

  isConnected(): boolean {
    return this.state === 'connected' && this.sock !== undefined;
  }

  /** Current QR payload, or undefined once linked. */
  getQr(): { value: string; at: number } | undefined {
    return this.qr;
  }

  /** Throws a tagged error when the socket is not usable, so routes map it to 503. */
  requireSocket(): WASocket {
    if (!this.sock || this.state !== 'connected') {
      const err = new Error(`WhatsApp not connected (state=${this.state})`);
      err.name = 'WaNotConnected';
      throw err;
    }
    return this.sock;
  }

  cacheGroup(metadata: GroupMetadata): void {
    this.groupCache.set(metadata.id, metadata);
  }

  /**
   * Links this device using an 8-character pairing code typed into the phone instead
   * of a scanned QR. Only valid on an open-but-unregistered socket: once credentials
   * exist WhatsApp rejects the request, so we check first and say why.
   */
  async requestPairingCode(phoneDigits: string): Promise<string> {
    if (this.authState?.creds.registered) {
      const err = new Error('This account is already linked. Remove AUTH_DIR and restart to relink.');
      err.name = 'AlreadyLinked';
      throw err;
    }
    if (!this.sock || this.state !== 'awaiting_qr') {
      const err = new Error(
        `Pairing is only possible while awaiting_qr (state=${this.state}). Retry shortly.`,
      );
      err.name = 'PairingUnavailable';
      throw err;
    }
    const code = await this.sock.requestPairingCode(phoneDigits);
    logger.warn({ phoneDigits }, 'pairing code issued; enter it on the phone within 60s');
    return code;
  }

  async start(): Promise<void> {
    await mkdir(config.AUTH_DIR, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);
    this.authState = state;
    this.saveCreds = saveCreds;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopping || !this.authState) return;

    // Pin to the protocol version WhatsApp Web currently advertises. A stale
    // version is a common cause of silent handshake failures.
    let version: [number, number, number] | undefined;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
      logger.warn({ err }, 'could not fetch latest WA version, using library default');
    }

    const alreadyRegistered = Boolean(this.authState.creds.registered);
    this.setState(alreadyRegistered ? 'connecting' : 'awaiting_qr');

    const sock = makeWASocket({
      auth: this.authState,
      logger: waLogger,
      ...(version ? { version } : {}),
      // Shown in WhatsApp > Linked devices. The old value here was 'WhatsApp Relay',
      // which announced the automation in the account's own device list. This is a
      // label, not a disguise - WhatsApp still sees a linked device either way - and it
      // must stay stable, because a descriptor that changes every reconnect is more
      // anomalous than any particular string.
      browser: [config.DEVICE_NAME, 'Chrome', '120.0.0'],
      // History sync is what populates GET /chats; there is no RPC that lists chats.
      // Only chat metadata is kept (see chatStore) - the messages in the payload are
      // dropped, so this does not become a message archive.
      syncFullHistory: config.SYNC_HISTORY,
      shouldSyncHistoryMessage: () => config.SYNC_HISTORY,
      // Stay invisible so the phone keeps delivering notifications normally.
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
    });

    this.sock = sock;

    sock.ev.on('creds.update', () => {
      void this.saveCreds?.().catch((err) => logger.error({ err }, 'failed to persist creds'));
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect, reachoutTimeLock } = update;

      if (qr) {
        this.qr = { value: qr, at: Date.now() };
        this.setState('awaiting_qr');
        logger.warn(
          'not linked: fetch GET /qr (or scan the QR below) from WhatsApp > Linked devices',
        );
        printQr(qr);
      }

      if (reachoutTimeLock) {
        this.outgoingBlocked = reachoutTimeLock.isActive === true;
        if (this.outgoingBlocked) {
          logger.error(
            {
              enforcementType: reachoutTimeLock.enforcementType,
              until: reachoutTimeLock.timeEnforcementEnds,
            },
            'WhatsApp is blocking outgoing messages for this account',
          );
        }
      }

      if (connection === 'open') {
        this.qr = undefined;
        this.attempt = 0;
        this.connectedAt = new Date();
        this.setState('connected');
        logger.info({ jid: sock.user?.id }, 'WhatsApp connected');
      }

      if (connection === 'close') {
        this.lastDisconnectAt = new Date();
        this.handleClose(lastDisconnect?.error);
      }
    });

    // Chat list. `messages` in the history payload is intentionally not forwarded.
    sock.ev.on('messaging-history.set', ({ chats, contacts, progress, isLatest }) => {
      chatStore.ingestContacts(contacts);
      chatStore.ingestChats(chats);
      chatStore.noteSyncChunk({ chats: chats.length, progress, isLatest });
    });
    sock.ev.on('messaging-history.status', ({ status, syncType, explicit }) => {
      logger.info({ status, syncType, explicit }, 'history sync status');
      if (status === 'complete') chatStore.noteSyncComplete();
    });
    sock.ev.on('chats.upsert', (chats) => chatStore.ingestChats(chats));
    sock.ev.on('chats.update', (updates) => chatStore.ingestChats(updates));
    sock.ev.on('chats.delete', (ids) => chatStore.remove(ids));
    sock.ev.on('contacts.upsert', (contacts) => chatStore.ingestContacts(contacts));
    sock.ev.on('contacts.update', (contacts) => chatStore.ingestContacts(contacts));

    // Keep the metadata cache honest; a stale participant list breaks group sends.
    sock.ev.on('groups.update', (updates) => {
      for (const u of updates) if (u.id) this.groupCache.delete(u.id);
    });
    sock.ev.on('group-participants.update', ({ id }) => {
      this.groupCache.delete(id);
    });

    // ACKs are informational for now: 1 = server, 2 = delivered, 3 = read.
    // An absent ACK is an unknown outcome, never an automatic failure.
    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        if (update.status === undefined || !key.fromMe) continue;
        logger.info(
          { messageId: key.id, remoteJid: key.remoteJid, status: update.status },
          'message ack',
        );
      }
    });
  }

  private handleClose(error: Error | Boom | undefined): void {
    const statusCode = (error as Boom | undefined)?.output?.statusCode;
    const detail = error?.message ?? 'unknown';

    if (this.stopping) {
      this.setState('stopped', 'shutting down');
      return;
    }

    switch (statusCode) {
      case DisconnectReason.loggedOut: {
        // 401 covers two different situations that need different operator actions,
        // and `creds.registered` is what tells them apart: false means the QR/pairing
        // handshake never finished (code expired, wrong number, QR never scanned), so
        // the half-written creds.json is junk and must be deleted. True means a real
        // session was revoked from the phone.
        const linkNeverCompleted = this.authState?.creds.registered !== true;
        const reason = linkNeverCompleted
          ? 'linking never completed - delete AUTH_DIR and link again'
          : 'session logged out from the phone';
        // Never wipe AUTH_DIR automatically, not even in the never-completed case. A
        // wrong guess here destroys a working session; an operator decides.
        this.setState('needs_relink', reason);
        logger.error({ linkNeverCompleted }, `logged out: ${reason}`);
        return;
      }

      case DisconnectReason.connectionReplaced:
        // Another client claimed the session. Reconnecting would make the two
        // fight, and each takeover risks WhatsApp dropping the session entirely.
        this.setState('replaced', 'another client took over this session');
        logger.error('connection replaced: another instance or device owns this session');
        return;

      case DisconnectReason.forbidden:
        this.setState('restricted', 'WhatsApp returned 403 for this account');
        logger.error('forbidden: the account is likely restricted or banned');
        return;

      case DisconnectReason.restartRequired:
        // Expected immediately after a successful QR pairing. Not a fault, so it
        // does not consume backoff.
        this.attempt = 0;
        this.scheduleReconnect(0, 'restart required after pairing');
        return;

      case DisconnectReason.badSession:
        logger.error({ detail }, 'bad session: re-linking may be required if this repeats');
        this.scheduleReconnect(undefined, `bad session: ${detail}`);
        return;

      default:
        this.scheduleReconnect(undefined, detail);
    }
  }

  private scheduleReconnect(delayMs: number | undefined, reason: string): void {
    if (this.stopping) return;

    const delay = delayMs ?? jitter(Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS));
    this.attempt += 1;
    this.reconnects += 1;
    this.setState('connecting', reason);
    logger.warn({ reason, delayMs: delay, attempt: this.attempt }, 'reconnecting');

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((err) => {
        logger.error({ err }, 'reconnect failed');
        this.scheduleReconnect(undefined, 'reconnect threw');
      });
    }, delay);
  }

  private setState(next: ConnState, reason?: string): void {
    if (this.state !== next) logger.info({ from: this.state, to: next, reason }, 'state change');
    this.state = next;
    this.reason = reason;
    if (TERMINAL_STATES.has(next)) this.qr = undefined;
  }

  /**
   * Stops reconnecting, closes the socket, then flushes credentials. Order matters:
   * a half-written credential file forces a re-link, which needs a human with the
   * phone. `saveCreds` last is the cheapest insurance against that.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;

    try {
      await this.sock?.end(undefined);
    } catch (err) {
      logger.warn({ err }, 'error while closing WhatsApp socket');
    }

    try {
      await this.saveCreds?.();
    } catch (err) {
      logger.error({ err }, 'failed to flush creds on shutdown');
    }

    this.sock = undefined;
    this.setState('stopped', 'shutting down');
  }
}

function jitter(ms: number): number {
  // +/-20% so a fleet of restarts does not reconnect in lockstep.
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function printQr(value: string): void {
  // Imported lazily: the ASCII renderer is only needed during first-time linking.
  import('qrcode-terminal')
    .then(({ default: qrcode }) => qrcode.generate(value, { small: true }))
    .catch(() => {
      /* /qr endpoint is the primary path; ASCII output is a convenience */
    });
}

export const waClient = new WaClient();
