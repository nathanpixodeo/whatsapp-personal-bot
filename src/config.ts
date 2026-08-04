import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * The API key is the only thing standing between the internet and an account that
 * can post as a real person, so a weak or absent key is a startup failure rather
 * than a warning. 32 chars is one `openssl rand -hex 16`.
 */
const MIN_API_KEY_LENGTH = 32;

const GROUP_JID_RE = /^\d+-?\d*@g\.us$/;

const schema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_KEY: z
    .string()
    .min(MIN_API_KEY_LENGTH, `API_KEY must be at least ${MIN_API_KEY_LENGTH} characters`),
  AUTH_DIR: z.string().min(1).default('./data/auth'),
  DEFAULT_GROUP_JID: z
    .string()
    .regex(GROUP_JID_RE, 'DEFAULT_GROUP_JID must look like 1234567890-1234567890@g.us')
    .optional(),
  SEND_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1500),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Browser test console at / and /ui. Loopback-only regardless of this flag; set
  // false to drop the routes entirely.
  ENABLE_UI: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Ask WhatsApp to push the chat history after linking. Required for GET /chats to
  // list 1:1 conversations - there is no fetch-all-chats RPC, so without the push the
  // only listable conversations are groups.
  SYNC_HISTORY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

/**
 * Reads the API key from a file when `API_KEY_FILE` is set. Under systemd this is
 * pointed at a `LoadCredential=` path, which keeps the key out of the process
 * environment - so it stays out of `systemctl show` and `/proc/<pid>/environ`.
 */
function readApiKeyFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    process.stderr.write(`Could not read API_KEY_FILE at ${path}: ${String(err)}\n`);
    process.exit(78); // EX_CONFIG
  }
}

function load() {
  // Treat empty strings as absent so a blank line in .env falls back to the
  // default instead of failing regex/min-length validation.
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''),
  );

  if (!raw.API_KEY && raw.API_KEY_FILE) {
    raw.API_KEY = readApiKeyFile(raw.API_KEY_FILE);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Written to stderr directly: the logger depends on this config.
    process.stderr.write(`Invalid environment configuration:\n${issues}\n`);
    process.exit(78); // EX_CONFIG
  }

  return {
    ...parsed.data,
    // Relative auth paths silently create a second, empty session whenever the
    // working directory differs, which reads as "logged out". Resolve once here.
    AUTH_DIR: resolve(parsed.data.AUTH_DIR),
  };
}

export const config = load();

export type Config = typeof config;

/** Message length cap enforced by POST /send. */
export const MAX_MESSAGE_LENGTH = 4000;

/** Request body cap. Fastify rejects anything larger with 413. */
export const MAX_BODY_BYTES = 64 * 1024;

/** How long a stored idempotent response stays replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
