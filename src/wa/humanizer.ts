import type { WASocket } from 'baileys';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Send pacing and volume limits, aimed at not getting the account flagged.
 *
 * Read this before tuning it, because the name invites the wrong expectation:
 *
 * This does NOT hide the automation. Baileys speaks WhatsApp's real multi-device
 * protocol, so the account is a normally linked device and every message is
 * attributable to it. No option here changes that, and anything claiming otherwise
 * would be theatre.
 *
 * What it does change is the behaviour enforcement actually keys on:
 *   - perfectly uniform send intervals, which no human produces
 *   - bursts, and sustained volume no person would type
 *   - activity at a constant rate around the clock
 *   - repeatedly hitting the same chat
 *
 * The strongest ban signal is none of these: it is recipients blocking or reporting
 * the account. Pacing cannot fix unwanted messages. Only sending to people who expect
 * them can, which is a decision about what you send, not a setting.
 */

type Reservation = {
  /** Give the slot back when the send fails, so a failure does not eat the day's budget. */
  release(): void;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type LimitSnapshot = {
  humanize: boolean;
  sentLastHour: number;
  sentLastDay: number;
  hourlyLimit: number | null;
  dailyLimit: number | null;
  quietHours: { window: string; timeZone: string; active: boolean } | null;
  pacing: { minIntervalMs: number; jitterMs: number; perTargetMinIntervalMs: number };
  typing: { enabled: boolean; charsPerSecond: number; maxMs: number };
};

class Humanizer {
  /** Send timestamps, newest last. Pruned to the last 24 h on every read. */
  private sends: number[] = [];
  private lastPerTarget = new Map<string, number>();
  private readonly quiet = parseQuietHours(config.QUIET_HOURS);

  /**
   * Checks every limit and reserves a slot in one step.
   *
   * Reserving at check time rather than counting completed sends is deliberate: the
   * checks run before the send is queued, so N concurrent requests would otherwise all
   * see the same count and overshoot a daily cap together. The cost is that a timestamp
   * reflects when the send was admitted, not when it left - a difference of at most one
   * queue interval.
   *
   * Throws tagged errors; server.ts maps the names to status codes.
   */
  reserve(target: string): Reservation {
    const now = Date.now();
    this.prune(now);

    if (this.quiet && isWithinQuietHours(now, this.quiet)) {
      const err = new Error(
        `Quiet hours ${formatWindow(this.quiet)} (${config.QUIET_HOURS_TZ}) are in effect. ` +
          'Sending overnight at a steady rate is a strong automation signal.',
      );
      err.name = 'QuietHours';
      throw err;
    }

    if (config.DAILY_SEND_LIMIT > 0 && this.countSince(now - DAY_MS) >= config.DAILY_SEND_LIMIT) {
      const err = new Error(
        `Daily send limit of ${config.DAILY_SEND_LIMIT} reached (rolling 24 h window).`,
      );
      err.name = 'DailyLimit';
      throw err;
    }

    if (config.HOURLY_SEND_LIMIT > 0 && this.countSince(now - HOUR_MS) >= config.HOURLY_SEND_LIMIT) {
      const err = new Error(
        `Hourly send limit of ${config.HOURLY_SEND_LIMIT} reached (rolling 60 min window).`,
      );
      err.name = 'HourlyLimit';
      throw err;
    }

    const gap = config.PER_TARGET_MIN_INTERVAL_MS;
    if (gap > 0) {
      const last = this.lastPerTarget.get(target);
      if (last !== undefined && now - last < gap) {
        const waitSeconds = Math.ceil((gap - (now - last)) / 1000);
        const err = new Error(
          `This chat was messaged ${Math.round((now - last) / 1000)}s ago; ` +
            `PER_TARGET_MIN_INTERVAL_MS requires ${Math.round(gap / 1000)}s. ` +
            `Retry in ${waitSeconds}s.`,
        );
        err.name = 'TargetCooldown';
        throw err;
      }
    }

    this.sends.push(now);
    const previousForTarget = this.lastPerTarget.get(target);
    this.lastPerTarget.set(target, now);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const i = this.sends.lastIndexOf(now);
        if (i !== -1) this.sends.splice(i, 1);
        // Restore the previous stamp rather than deleting the entry: a failed send
        // should not reset a cooldown that a successful earlier send established.
        if (previousForTarget === undefined) this.lastPerTarget.delete(target);
        else this.lastPerTarget.set(target, previousForTarget);
      },
    };
  }

  /**
   * Delay to apply before the next queued send, given when the last one ran.
   *
   * The jitter is the point. `SEND_MIN_INTERVAL_MS` alone produces gaps clustered on a
   * single value, which is a cleaner fingerprint than sending fast would be.
   */
  nextGapMs(lastRunAt: number): number {
    const base = config.SEND_MIN_INTERVAL_MS - (Date.now() - lastRunAt);
    const jitter = config.HUMANIZE ? Math.floor(Math.random() * (config.SEND_JITTER_MS + 1)) : 0;
    return Math.max(0, base) + jitter;
  }

  /**
   * Shows "typing…" for a length-proportional pause, then stops, then the caller sends.
   *
   * A real message is preceded by composing presence and a plausible delay. Sending
   * 400 characters with no typing indicator at all is the cheapest tell there is.
   *
   * Failures here are swallowed: presence is cosmetic and must never block the send.
   */
  async simulateTyping(sock: WASocket, jid: string, text: string): Promise<void> {
    if (!config.HUMANIZE || config.TYPING_MAX_MS === 0) return;

    const ms = Math.min(
      config.TYPING_MAX_MS,
      Math.round((text.length / config.TYPING_CPS) * 1000 * (0.7 + Math.random() * 0.6)),
    );
    if (ms <= 0) return;

    try {
      await sock.sendPresenceUpdate('composing', jid);
      await sleep(ms);
      await sock.sendPresenceUpdate('paused', jid);
    } catch (err) {
      logger.debug({ err, jid }, 'presence update failed; sending anyway');
    }
  }

  snapshot(): LimitSnapshot {
    const now = Date.now();
    this.prune(now);
    return {
      humanize: config.HUMANIZE,
      sentLastHour: this.countSince(now - HOUR_MS),
      sentLastDay: this.sends.length,
      hourlyLimit: config.HOURLY_SEND_LIMIT || null,
      dailyLimit: config.DAILY_SEND_LIMIT || null,
      quietHours: this.quiet
        ? {
            window: formatWindow(this.quiet),
            timeZone: config.QUIET_HOURS_TZ,
            active: isWithinQuietHours(now, this.quiet),
          }
        : null,
      pacing: {
        minIntervalMs: config.SEND_MIN_INTERVAL_MS,
        jitterMs: config.HUMANIZE ? config.SEND_JITTER_MS : 0,
        perTargetMinIntervalMs: config.PER_TARGET_MIN_INTERVAL_MS,
      },
      typing: {
        enabled: config.HUMANIZE && config.TYPING_MAX_MS > 0,
        charsPerSecond: config.TYPING_CPS,
        maxMs: config.TYPING_MAX_MS,
      },
    };
  }

  private countSince(from: number): number {
    let n = 0;
    for (let i = this.sends.length - 1; i >= 0 && this.sends[i]! >= from; i -= 1) n += 1;
    return n;
  }

  /** Keeps `sends` bounded by the widest window anything asks about. */
  private prune(now: number): void {
    const cutoff = now - DAY_MS;
    let drop = 0;
    while (drop < this.sends.length && this.sends[drop]! < cutoff) drop += 1;
    if (drop > 0) this.sends.splice(0, drop);
  }
}

type QuietWindow = { start: number; end: number };

function parseQuietHours(raw: string | undefined): QuietWindow | undefined {
  if (!raw) return undefined;
  const [start, end] = raw.split('-').map(Number) as [number, number];
  // A window of equal bounds would mean "always" or "never" with equal plausibility.
  // Refusing it is better than guessing which one the operator meant.
  if (start === end) {
    logger.warn({ QUIET_HOURS: raw }, 'quiet hours start equals end; ignoring the setting');
    return undefined;
  }
  return { start, end };
}

/** Wrapping window: 23-7 means 23:00-23:59 plus 00:00-06:59. */
function isWithinQuietHours(now: number, w: QuietWindow): boolean {
  const hour = hourIn(now, config.QUIET_HOURS_TZ);
  return w.start < w.end ? hour >= w.start && hour < w.end : hour >= w.start || hour < w.end;
}

/**
 * Hour of day in a named zone. Read from Intl rather than the process clock so the
 * window means the same thing whether the server runs on UTC or local time.
 */
function hourIn(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  return Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
}

function formatWindow(w: QuietWindow): string {
  return `${String(w.start).padStart(2, '0')}:00-${String(w.end).padStart(2, '0')}:00`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const humanizer = new Humanizer();
