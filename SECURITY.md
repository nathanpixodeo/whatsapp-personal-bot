# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/nathanpixodeo/whatsapp-personal-bot/security/advisories/new).
That opens a draft advisory visible only to you and the maintainers.

Please include:

- affected version or commit SHA,
- configuration relevant to the issue (`.env` values with secrets removed),
- reproduction steps or a proof of concept,
- the impact you believe it has.

This is a personal project with no SLA and no bug bounty. Expect a first response
within about a week. If a report is confirmed, the fix and the advisory are published
together.

## Supported versions

Only the current `main` branch is supported. There are no maintained release branches
and no backports.

`baileys` is pinned to the exact prerelease `7.0.0-rc14`. That pin is deliberate — see
[Corrections to the design doc](README.md#corrections-to-the-design-doc) — but it does
mean upstream protocol and security fixes are not picked up automatically. Dependency
monitoring is on the [roadmap](README.md#roadmap) and is not in place yet.

## Threat model

The design notes in [`README.md`](README.md#read-this-before-deploying) are the
authoritative version. Summarised:

**The two assets worth attacking**

| Asset | Why it matters |
|---|---|
| `AUTH_DIR` | A full WhatsApp account credential. Read access means sending and reading messages as the linked account. |
| `API_KEY` | Grants `/send`, `/groups`, `/chats`, `/limits` — and, if the port is exposed, `/qr` and `/pair`. |

**The account-takeover surfaces**

`GET /qr`, `POST /pair`, the `/ui` console and the `/docs` Swagger browser can each link
a new device to the WhatsApp account. `/ui` and `/docs` enforce loopback themselves
(socket peer address **and** `req.ip`, so a forged `X-Forwarded-For` does not pass).
`/qr` and `/pair` are protected by the API key, which is defence in depth, not the
primary control — the primary control is that the process binds `127.0.0.1` and
`deploy/nginx.conf` denies those prefixes outright.

## Accepted risks, not vulnerabilities

Reports about the following will be closed as working-as-intended. They are documented
trade-offs, not oversights:

- **The relay is an unofficial WhatsApp client.** It logs in as a real person through
  "Linked devices". Automating a personal account can get the number rate-limited,
  restricted or banned. Use a dedicated, non-critical number.
- **The automation is not hidden and is not meant to be.** Baileys speaks WhatsApp's
  real multi-device protocol, so every message is attributable to the account. Content
  spinning, number rotation, proxy rotation, fingerprint spoofing and ban "recovery" are
  deliberately absent.
- **Binding to a non-loopback `HOST` is unsupported.** Doing so exposes the pairing
  surfaces. Put nginx in front instead.
- **`202` from `/send` is not a delivery guarantee.** It means the socket accepted the
  stanza.
- **Idempotency and pacing counters are in-memory.** A restart hands back the send budget
  and forgets idempotency keys. A SQLite outbox is on the roadmap.
- **The chat store is in-memory and metadata-only.** Message bodies from the history push
  are deliberately discarded.

## What the process already does

Stated so reports can target the gaps rather than these:

- API key compared in constant time, over SHA-256 digests, so no length leak.
- Auth runs in Fastify's `onRequest` hook — before body parsing, so unauthenticated
  bodies are never parsed. Request bodies are capped at 64 KB.
- Invalid or missing config exits `78` at startup instead of running half-configured;
  `API_KEY` must be at least 32 characters.
- Message text is never logged — only a length and a SHA-256 prefix. `API_KEY`,
  `authorization`, `x-api-key` and QR payloads are redacted from logs.
- `500` responses are deliberately generic, because exception text can carry message
  content.
- `API_KEY_FILE` lets the key arrive as a systemd `LoadCredential`, keeping it out of
  `systemctl show` and `/proc/<pid>/environ`.
- The systemd unit runs with `ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`,
  `SystemCallFilter=@system-service` and `MemoryMax=512M`; `StateDirectory` creates the
  auth directory mode `0700`.
- `AUTH_DIR` is never wiped automatically, so a spurious `loggedOut` cannot destroy a
  working session.

## Operator checklist

Security of a deployment is mostly configuration:

- [ ] `HOST=127.0.0.1`. The port is never published.
- [ ] `API_KEY` is 32+ random bytes (`openssl rand -hex 32`), ideally via `API_KEY_FILE`.
- [ ] `AUTH_DIR` is mode `0700`, owned by the service user, excluded from unencrypted
      backups.
- [ ] `.env` is mode `0600` and is not committed — `.gitignore` already covers it.
- [ ] Remote callers, if any, go through `deploy/nginx.conf` with TLS and an IP allowlist.
- [ ] Pairing is done over an SSH tunnel, never over a published port.
- [ ] A dedicated WhatsApp number is used, with a fallback notification channel.
