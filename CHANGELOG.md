# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While
the major version is `0`, minor bumps may carry breaking changes.

## [Unreleased]

### Added

- `AGPL-3.0-or-later` licence, security policy, contribution guide, changelog, CI
  workflow and issue/pull-request templates.

### Security

- Resolved three dependency advisories flagged by the new `npm audit` CI job. Lockfile
  only — no manifest change, and `baileys` stays pinned at `7.0.0-rc14`.
  - `fastify` 5.11.2 → 5.12.5: schema validation bypass via root primitive coercion
    mismatch ([GHSA-w2qp-rph6-63g4]) and `X-Forwarded-*` spoofing under the `trustProxy`
    hop count ([GHSA-3m5p-2c4r-xxw2]). The second one touches this project directly,
    since `trustProxy` is on — though the `/ui` and `/docs` loopback gate was already
    checking the socket peer address alongside `req.ip` precisely so a forged
    `X-Forwarded-For` could not pass on its own.
  - `fast-uri` → 3.1.8 (transitive, via ajv): server-side request forgery and host
    confusion, four advisories.
  - `sharp` → 0.35.4 (transitive): libheif vulnerabilities, [GHSA-rgj7-g3m4-5g8c].

[GHSA-w2qp-rph6-63g4]: https://github.com/advisories/GHSA-w2qp-rph6-63g4
[GHSA-3m5p-2c4r-xxw2]: https://github.com/advisories/GHSA-3m5p-2c4r-xxw2
[GHSA-rgj7-g3m4-5g8c]: https://github.com/advisories/GHSA-rgj7-g3m4-5g8c

## [0.1.0] - 2026-08-04

First working relay. Not tagged in git; the version is what `package.json` declared at
the time.

### Added

- **HTTP relay** on Fastify, bound to loopback. `POST /send` posts text into a WhatsApp
  group through a linked personal account and answers `202`.
- **WhatsApp transport** via [Baileys](https://github.com/WhiskeySockets/Baileys)
  `7.0.0-rc14`, pinned exactly with the lockfile committed. Speaks the multi-device
  protocol over a WebSocket — no browser, no Chromium, ~60 MB RSS.
- **Device linking** two ways: `GET /qr` (ASCII to stdout, JSON, or a 512 px PNG via
  `Accept: image/png`) and `POST /pair` for an 8-character pairing code when a camera is
  impractical.
- **Group routes.** `GET /groups` lists participating groups with JIDs,
  `POST /groups` creates one and reports `added` / `notAdded` / `notOnWhatsApp` honestly
  with an invite link as the remedy, `GET /groups/:jid/invite` fetches an invite link.
- **`GET /chats`** merges groups (complete immediately, from
  `groupFetchAllParticipating()`) with 1:1 chats (pushed over history sync), exposing a
  `historySync` block so callers can poll until `complete`. Metadata only — message
  bodies from the push are discarded.
- **Anti-ban pacing.** Serialized send queue with a jittered minimum interval, typing
  simulation sized from message length, rolling hourly and daily caps, per-chat
  cooldown, and timezone-aware quiet hours that wrap past midnight. State readable at
  `GET /limits`.
- **Idempotency.** `Idempotency-Key` on `/send` replays the stored response; an in-flight
  key gets `409`. In-memory LRU with a 24 h TTL.
- **Test console** at `/` and `/ui` — one self-contained HTML page, no CDN, exercising
  every route.
- **OpenAPI 3.1 document** at `/docs/json` with Swagger UI at `/docs`, generated from the
  same schemas Fastify validates with, so docs cannot drift from the implementation.
- **`GET /health`** reporting a single `ConnState` enum rather than booleans that can
  disagree, plus `outgoingBlocked` when WhatsApp throttles the account.
- **Debian deployment**: hardened systemd unit with `StateDirectory`, `LoadCredential`
  for the API key, `ProtectSystem=strict` and a syscall filter; nginx config that
  terminates TLS, allowlists source IPs and denies every pairing surface.
- **`npm run find-group`** to resolve a group name to a JID without the HTTP API.

### Security

- API key compared in constant time over SHA-256 digests; auth runs in Fastify's
  `onRequest` hook, so unauthenticated bodies are never parsed.
- `/ui` and `/docs` gated to loopback by socket peer address **and** `req.ip`, so a
  forged `X-Forwarded-For` does not pass.
- Message text never logged — only a length and a SHA-256 prefix. `API_KEY`,
  `authorization`, `x-api-key` and QR payloads redacted.
- Config validated with zod at startup; invalid or missing config exits `78` instead of
  running half-configured. `API_KEY` must be at least 32 characters.
- `AUTH_DIR` resolved to an absolute path and never wiped automatically.
- Graceful `SIGTERM`: stop accepting, drain the queue, close the socket, flush
  credentials last, so a restart cannot corrupt the session into a forced re-link.

[Unreleased]: https://github.com/nathanpixodeo/whatsapp-personal-bot/compare/f0b9a6f...HEAD
[0.1.0]: https://github.com/nathanpixodeo/whatsapp-personal-bot/commit/f0b9a6f
