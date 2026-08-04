import { createHash } from 'node:crypto';
import { pino } from 'pino';
import { config } from './config.js';

/**
 * Message bodies are relayed on behalf of real people into real group chats, so
 * they never reach the log. Callers log `messageDigest()` instead, which is
 * enough to correlate a request with a send without retaining the content.
 */
export function messageDigest(text: string): { length: number; sha256: string } {
  return {
    length: text.length,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
  };
}

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'whatsapp-relay' },
  redact: {
    paths: [
      'req.headers["x-api-key"]',
      'req.headers.authorization',
      'req.headers.cookie',
      'headers["x-api-key"]',
      'headers.authorization',
      'apiKey',
      'API_KEY',
      'text',
      'qr',
      'dataUrl',
      '*.qr',
      // Fastify's default serializer never logs bodies; these cover a future
      // `req.log.info({ body })`. A bare `message` path is deliberately absent - it
      // matches `err.message` on every error, which censors diagnostics while `msg`
      // still carries the same string, so it buys nothing.
      'req.body.message',
      'body.message',
    ],
    censor: '[redacted]',
  },
  ...(config.LOG_PRETTY
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

/**
 * Baileys is chatty at info level and logs protocol internals that can include
 * message content, so it gets its own child pinned to `warn` unless LOG_LEVEL is
 * already more verbose than that.
 */
export const waLogger = logger.child(
  { component: 'baileys' },
  { level: ['trace', 'debug'].includes(config.LOG_LEVEL) ? config.LOG_LEVEL : 'warn' },
);
