# WhatsApp Personal Group Relay

[![CI](https://github.com/nathanpixodeo/whatsapp-personal-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/nathanpixodeo/whatsapp-personal-bot/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.9-green.svg)](https://nodejs.org)
[![Status: MVP](https://img.shields.io/badge/status-MVP-orange.svg)](#roadmap)

Authenticated HTTP endpoint that posts text into WhatsApp groups through a **linked
personal account**, and creates new groups on demand.

```
POST /send  {"message": "Build #412 failed", "groupJid": "1203...@g.us"}  →  202
```

Built on [Baileys](https://github.com/WhiskeySockets/Baileys), which speaks the WhatsApp
multi-device protocol directly over a WebSocket. No browser, no Chromium, ~60 MB RSS.

This README supersedes the install and code sections of
`WHATSAPP_PERSONAL_GROUP_RELAY_DEBIAN.md`, which is kept as background. See
[Corrections to the design doc](#corrections-to-the-design-doc).

---

## Contents

- [**Read this before deploying**](#read-this-before-deploying) — ban risk, what
  `AUTH_DIR` is, which routes are account-takeover surfaces
- [Requirements](#requirements)
- [Quick start (local)](#quick-start-local) · [Link the device](#link-the-device)
- [API](#api) — [docs](#api-docs) · [`/health`](#get-health) · [`/qr`](#get-qr) ·
  [`/pair`](#post-pair) · [console](#test-console) · [`/chats`](#get-chats) ·
  [`/send`](#post-send) · [`POST /groups`](#post-groups) · [errors](#errors)
- [Anti-ban pacing](#anti-ban-pacing) — [what it cannot do](#what-this-cannot-do) ·
  [what it does](#what-it-does) · [`/limits`](#get-limits)
- [Configuration](#configuration)
- [Debian deployment](#debian-deployment)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Corrections to the design doc](#corrections-to-the-design-doc)
- [Roadmap](#roadmap)
- [Project layout](#project-layout)
- [Security](#security) · [Contributing](#contributing) · [License](#license)

---

## Read this before deploying

- **This is an unofficial client.** It logs in as a real person via the same
  "Linked devices" mechanism as WhatsApp Web. Automating a personal account can get the
  number **rate-limited, restricted, or banned**, with no warning and no appeal path.
  Use a **dedicated, non-critical** number. Keep a fallback notification channel.
- **`AUTH_DIR` is a full account credential.** Whoever can read those files can send and
  read messages as the linked account. Mode `0700`, owned by the service user, never
  committed, never in an unencrypted backup.
- **`GET /qr`, `POST /pair`, the `/ui` console and the `/docs` API browser grant account
  takeover.** Scanning that QR or typing that pairing code links a new device, and Swagger
  UI's "Try it out" reaches both routes. They must never be reachable from the internet —
  reach them through an SSH tunnel. `/ui` and `/docs` enforce loopback themselves; the API
  key on `/qr` and `/pair` is defence in depth, not the primary control.
- **`202` is not a delivery guarantee.** It means the socket accepted the stanza.
  Delivery ACKs are logged, not yet persisted.
- **Nothing here hides the automation from WhatsApp.** Baileys speaks the real
  multi-device protocol, so the account is a normally linked device and every message is
  attributable to it. The pacing controls reduce *spam-like behaviour*, which is what
  enforcement actually keys on — they are not a disguise. See
  [Anti-ban pacing](#anti-ban-pacing).

The official [WhatsApp Business Platform Groups API](https://developers.facebook.com/docs/whatsapp)
was evaluated and cannot replace this: it caps groups at **8 participants**, groups must be
**created by the business number**, and it **cannot post into a pre-existing group**.

---

## Requirements

- **Node.js 22.9+** (`--env-file-if-exists` in the npm scripts needs 22.9; systemd uses
  `EnvironmentFile=` and does not depend on it).
- A phone with WhatsApp installed, for the one-time QR scan and any future re-link.
- Debian 12/13 for the systemd deployment. No Rust toolchain, no `build-essential`,
  no `node-gyp` — Baileys' crypto dependency ships prebuilt WASM.

## Quick start (local)

```bash
npm ci
cp .env.example .env
# Generate a key and put it in .env as API_KEY=
openssl rand -hex 32

npm run dev
```

### Link the device

Easiest path — the built-in test console:

```
http://localhost:3000/ui
```

Paste the API key, then either scan the QR it renders or request an 8-character pairing
code. The same page exercises `/health`, `/groups`, `/chats`, `/send`, `POST /groups`, and
`/limits`, so no curl is needed to test. It is served to **loopback callers only** (see
[Test console](#test-console)).

Interactive API reference at `http://localhost:3000/docs` — same loopback rule (see
[API docs](#api-docs)).

Or by hand:

```bash
export KEY=<your API_KEY>

# Option A: scan the ASCII QR printed to stdout.
# Option B: fetch it as a PNG.
curl -s -H "X-API-Key: $KEY" -H 'Accept: image/png' localhost:3000/qr -o qr.png

# Option C: pairing code instead of a camera.
curl -s -X POST localhost:3000/pair -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"phoneNumber":"+62 812 3456 789"}'
```

For A/B, scan from **WhatsApp → Settings → Linked devices → Link a device**. The QR rotates
every ~20 s; re-fetch if it expires. For C, use **Link with phone number instead** on that
same screen and type the code within ~60 s.

Right after pairing the socket closes with `restartRequired` and reconnects immediately —
that is normal, not an error.

```bash
curl -s localhost:3000/health                                  # → 200 "connected"
curl -s -H "X-API-Key: $KEY" localhost:3000/groups             # → JIDs of your groups
curl -s -X POST localhost:3000/send \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"message":"hello","groupJid":"1203...@g.us"}'           # → 202
```

Or find a group JID by name without touching the HTTP API (**stop the relay first**):

```bash
npm run find-group -- "Team Ops"
```

---

## API

Every route requires the `X-API-Key` header except `/health` and the two browser surfaces,
`/` `/ui` and `/docs` — a browser cannot attach a header to a page load or its static
assets, so those are gated to **loopback** instead, which is the stronger control anyway.
The key is compared in constant time. Bodies are capped at 64 KB; rate limiting is per API
key (`RATE_LIMIT_PER_MINUTE`, default 60/min), falling back to per-IP for unauthenticated
requests.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | none | `200` only when connected **and** not send-blocked; otherwise `503`. |
| `GET` | `/` `/ui` | none, loopback only | Test console. `403 local_only` for any other caller. |
| `GET` | `/docs` | none, loopback only | Swagger UI. `/docs/json` is the raw OpenAPI 3.1 document. |
| `GET` | `/qr` | key | Pairing QR. `409` when already linked, `503` when none is pending. |
| `POST` | `/pair` | key | 8-character pairing code for `{"phoneNumber": "+62…"}`. Camera-free alternative to `/qr`. |
| `GET` | `/groups` | key | Groups this account participates in, with JIDs. |
| `GET` | `/chats` | key | Every conversation: 1:1 chats from history sync **plus** all groups. |
| `POST` | `/groups` | key | Create a group. `201`. |
| `GET` | `/groups/:jid/invite` | key | Invite link for an existing group. Usually needs admin. |
| `POST` | `/send` | key | Send text. `202`. |
| `GET` | `/limits` | key | Pacing state: sends this hour/day, caps, quiet hours, cooldowns. |

### API docs

```
http://localhost:3000/docs        Swagger UI
http://localhost:3000/docs/json   OpenAPI 3.1 document
```

Generated from the same JSON schemas Fastify validates with, so the document cannot drift
from the implementation — a route whose schema changes changes its docs in the same commit.

**Treat `/docs` as a takeover surface, not as documentation.** "Try it out" issues real
requests, including `GET /qr` and `POST /pair`. It is therefore gated to loopback exactly
like `/ui` (both the socket peer address **and** `req.ip`), and the guard sits in an
encapsulated Fastify scope so it covers the plugin's static assets too, not just the HTML.
`deploy/nginx.conf` denies the whole `/docs` prefix. `ENABLE_DOCS=false` removes it.

The console page links to it, and the spec declares the `X-API-Key` security scheme
globally with `/health` overriding it to none — so the "Authorize" button is filled in once
and every operation carries the key. `/` and `/ui` are deliberately absent from the
document: they serve one HTML page, not an API.

Response schemas all set `additionalProperties: true`. That is load-bearing rather than
lax: Fastify serializes with fast-json-stringify, which **drops** any property a response
schema does not list, so a strict schema would silently truncate real responses.

### `GET /health`

```json
{
  "state": "connected",
  "healthy": true,
  "me": { "jid": "628123456789:12@s.whatsapp.net", "name": "Relay" },
  "qrAvailable": false,
  "reconnects": 2,
  "connectedAt": "2026-08-04T09:12:44.001Z",
  "queueDepth": 0,
  "uptimeSeconds": 8140
}
```

`state` is one of `starting`, `awaiting_qr`, `connecting`, `connected`, `needs_relink`,
`replaced`, `restricted`, `stopped`. One enum, not a pair of booleans that can disagree —
so a `200` here always means a send would actually be attempted.

`outgoingBlocked: true` appears when WhatsApp is throttling this account's outbound
messages (`reachoutTimeLock`). The socket is open but sends will fail, so health is `503`.

`needs_relink` distinguishes its two causes in `reason`, because they need different
actions: `linking never completed` (the handshake never finished — the stored credentials
are junk) versus `session logged out from the phone` (a real session was revoked). Neither
wipes `AUTH_DIR` automatically; a wrong guess there destroys a working session.

### `GET /qr`

`Accept: image/png` → a 512 px PNG. Otherwise JSON with `qr` (raw payload), `dataUrl`
(inline `<img src>`), and `generatedAt`. `cache-control: no-store`.

### `POST /pair`

```jsonc
{ "phoneNumber": "+62 812 3456 789" }   // any format; digits extracted, 8–15 required
```

```json
{ "phoneNumber": "628123456789", "code": "ABCD1234", "display": "ABCD-1234", "expiresInSeconds": 60 }
```

Only works while `state` is `awaiting_qr` (`503 pairing_unavailable` otherwise) and before
credentials exist (`409 already_linked` after). Carries the same weight as `/qr`: handing the
code to the wrong person links **their** device to this account.

### Test console

`GET /` and `GET /ui` serve one self-contained HTML page — no CDN, no external script, so
nothing off-box sees the API key or the QR. Key input, live `/health` poll, QR with
auto-refresh, pairing code, group list with copy-JID, send form with an idempotency
double-send button, group creation, and a raw response log.

It is refused with `403 local_only` unless **both** the socket peer address and `req.ip` are
loopback. Checking only `req.ip` would be bypassable: `trustProxy` is on, so a direct
request carrying `X-Forwarded-For: 127.0.0.1` would otherwise read as local.

`ENABLE_UI=false` removes the routes. `deploy/nginx.conf` additionally denies `/`, `/ui`,
`/pair`, and `/qr`.

### `GET /chats`

Every conversation the account knows about — 1:1 chats **and** groups — in one list.

```
GET /chats?kind=all&search=deploy&limit=500&includeArchived=true
```

| Query | Default | Notes |
|---|---|---|
| `kind` | `all` | `all`, `dm`, `group`, `broadcast`, `newsletter`, `other`. |
| `search` | — | Case-insensitive substring of name or JID, ≤ 100 chars. |
| `limit` | `500` | 1–10000. Applied after filtering. |
| `includeArchived` | `true` | `false` drops archived chats. |

```json
{
  "count": 214,
  "matched": 214,
  "total": 214,
  "counts": { "dm": 190, "group": 22, "broadcast": 2, "newsletter": 0, "other": 0 },
  "historySync": {
    "enabled": true,
    "complete": true,
    "chunks": 6,
    "chatsReceived": 192,
    "truncated": false
  },
  "chats": [
    {
      "jid": "120363...@g.us",
      "kind": "group",
      "name": "Deploy alerts",
      "participantCount": 7,
      "iAmAdmin": true,
      "announceOnly": false,
      "unreadCount": 0,
      "lastActivity": "2026-08-04T09:12:44.000Z"
    }
  ]
}
```

**Groups are always complete; 1:1 chats arrive over time.** Two different mechanisms are
merged here, and the difference matters:

- **Groups** come from `groupFetchAllParticipating()` — a real request/response call. Every
  group is present on the first `/chats` call, even seconds after linking.
- **1:1 chats have no fetch-all RPC.** Verified against the installed
  `baileys@7.0.0-rc14` type definitions: the socket exposes `chatModify` and nothing that
  reads a chat list. Chats are *pushed* to the client — `messaging-history.set` in chunks
  after linking, then `chats.upsert`/`chats.update` as they change. So one request only
  ever sees what has arrived so far.

That is what `historySync` is for. Poll `/chats` until `complete: true` instead of treating
the first response as the full list; `chunks` and `chatsReceived` climb while the push is in
progress. The test console's Conversations panel does exactly this — *"keep polling until
history sync completes"*, every 5 s. `truncated: true` means the `MAX_CHATS` = 10 000
ceiling was hit; the store refuses to evict rather than let a partial list look complete.

`historySync.enabled: false` (`SYNC_HISTORY=false`) means no push was requested, so only
groups are listable. `note` is added when the list is not final, explaining why in plain
words instead of returning a short list that looks authoritative.

**The history push carries messages; they are never stored.** `messaging-history.set`
delivers a `messages` array alongside `chats`, and it is deliberately not passed into the
store. Only chat metadata is retained — JID, name, unread count, timestamps, flags — so
turning history sync on does not make this process a message archive.

The store is **in-memory**: the chat list is lost on restart, and WhatsApp only re-pushes
history on a fresh link. After a restart, groups are still complete immediately, while 1:1
chats repopulate only as they see activity. Persisting the store is a deliberate non-goal
for the MVP.

### `POST /send`

```jsonc
{
  "message": "Build #412 failed",   // 1–4000 chars, non-whitespace
  "groupJid": "1203...@g.us"        // optional; falls back to DEFAULT_GROUP_JID
}
```

`202` with `{"groupJid":"…","status":"accepted","messageId":"3EB0…"}`.

`status` is `accepted` (the socket took it) or **`unknown`** — Baileys can resolve without
a message key. `unknown` is deliberately not an error: returning `5xx` would invite a
retry and duplicate a message that may well have been sent.

Send an `Idempotency-Key` header to make retries safe. A repeated key replays the stored
response with `idempotentReplay: true`; a key still in flight gets `409`. The store is
in-memory with a 24 h TTL, so it covers webhook retries but **not** a restart in between
(see [Roadmap](#roadmap)).

Sends are serialized through one queue with a minimum gap of `SEND_MIN_INTERVAL_MS`
(default 1500 ms) **plus a random 0–`SEND_JITTER_MS`**, and a "typing…" pause sized from
the message length precedes each one. Concurrent requests queue instead of racing. Volume
caps and quiet hours are checked before the message is queued, so they answer `429`/`503`
immediately rather than after a wait — see [Anti-ban pacing](#anti-ban-pacing).

### `POST /groups`

```jsonc
{
  "subject": "Deploy alerts",
  "participants": ["+62 812-3456-789", "628998887777"]   // any format; digits extracted
}
```

`201` with the honest outcome:

```json
{
  "groupJid": "120363...@g.us",
  "subject": "Deploy alerts",
  "inviteLink": "https://chat.whatsapp.com/AbCdEf…",
  "requested": 2,
  "added": ["628123456789@s.whatsapp.net"],
  "notOnWhatsApp": [],
  "notAdded": ["628998887777@s.whatsapp.net"],
  "hint": "Numbers in notAdded were not in the group after creation. The usual cause is their \"who can add me to groups\" privacy setting. Send them inviteLink instead."
}
```

The common surprise in group automation: a contact whose *"who can add me to groups"*
privacy setting excludes you is **silently** left out, with no per-participant error from
WhatsApp. The relay diffs the requested list against the returned metadata and always
fetches an invite link as the remedy. It is still `201` — the group exists — so check
`notAdded` rather than the status code.

`notAdded` is named for what is observable (they are not in the group), not `failedToAdd`,
which would assert a cause the protocol never confirmed.

---

## Anti-ban pacing

### What this cannot do

**It cannot hide the automation.** Baileys implements WhatsApp's own multi-device
protocol. The relay appears under **Linked devices** on the phone, the same as WhatsApp
Web, and every message is cryptographically attributable to the account. There is no flag,
user-agent, or device string that makes automated sending invisible, and any project
claiming otherwise is selling theatre.

So the goal is not evasion. It is to **not behave like spam**, because behaviour is what
enforcement keys on:

- perfectly uniform send intervals, which no human produces
- bursts, and sustained volume no person would type
- a constant rate around the clock, including 04:00
- hammering the same chat

And the strongest signal is none of those: it is **recipients blocking or reporting the
account**. Pacing cannot fix unwanted messages. Only sending to people who expect them
can, and that is a decision about what you send, not a setting.

Deliberately **not** implemented: message-content spinning, number rotation, proxy
rotation, fingerprint spoofing, and ban "recovery". They do not work against a first-party
protocol client, and shipping them would imply a safety that does not exist.

### What it does

| Control | Var | Default | Effect |
|---|---|---|---|
| Jitter | `SEND_JITTER_MS` | `2500` | Random 0–2500 ms added to every gap. A gap that is always exactly 1500 ms is a cleaner fingerprint than sending fast. |
| Typing indicator | `TYPING_CPS`, `TYPING_MAX_MS` | `18`, `6000` | `composing` presence for `len/18` seconds (±30 % randomised, capped), then `paused`, then the send. Sending 400 characters with no typing at all is the cheapest tell there is. |
| Hourly cap | `HOURLY_SEND_LIMIT` | off | Rolling 60-minute ceiling → `429 hourly_limit`. |
| Daily cap | `DAILY_SEND_LIMIT` | off | Rolling 24-hour ceiling → `429 daily_limit`. |
| Per-chat cooldown | `PER_TARGET_MIN_INTERVAL_MS` | off | Minimum gap to the **same** JID → `429 target_cooldown`. |
| Quiet hours | `QUIET_HOURS`, `QUIET_HOURS_TZ` | off, `UTC` | Refuses sends inside a local-time window → `503 quiet_hours`. |
| Device label | `DEVICE_NAME` | `Chrome (Linux)` | What shows under **Linked devices**. A label, not a disguise. |

`HUMANIZE=false` disables jitter and typing simulation (the caps and quiet hours still
apply). Useful for tests where a deterministic gap matters.

Windows are **rolling**, not calendar-aligned: `DAILY_SEND_LIMIT=200` means 200 in any
24 hours, not 200 since midnight — a cap that resets at midnight lets you send 400 in two
hours across the boundary.

Quiet hours **wrap past midnight** (`23-7` = 23:00–06:59) and are evaluated in
`QUIET_HOURS_TZ` via `Intl`, not the server clock, so the window means the same thing on a
UTC host. Equal bounds (`5-5`) are ignored with a warning rather than guessed: they could
mean "always" or "never" with equal plausibility.

A slot is **reserved when the request is admitted**, not when the message leaves. Otherwise
N concurrent requests all read the same count and blow past the cap together. If the send
then fails, the slot is released — a send that never happened must not eat the day's
budget. The one exception is the `unknown` outcome, which keeps its slot: it may well have
been delivered, and a volume cap that under-counts is the wrong way to be wrong.

There is **no warm-up ramp**. On a fresh number, start with small caps
(`HOURLY_SEND_LIMIT=10`, `DAILY_SEND_LIMIT=50`) and raise them over a week or two. The
right ramp depends on the number's age and who it is messaging, so it is a judgement call,
not a default.

The counters are in-memory and reset on restart, which hands back the full budget. Do not
treat `/limits` as an audit trail.

### `GET /limits`

```json
{
  "humanize": true,
  "sentLastHour": 3,
  "sentLastDay": 41,
  "hourlyLimit": 30,
  "dailyLimit": 200,
  "quietHours": { "window": "23:00-07:00", "timeZone": "Asia/Ho_Chi_Minh", "active": false },
  "pacing": { "minIntervalMs": 1500, "jitterMs": 2500, "perTargetMinIntervalMs": 0 },
  "typing": { "enabled": true, "charsPerSecond": 18, "maxMs": 6000 },
  "counterNote": "Rolling windows over in-memory timestamps, reserved when a send is admitted rather than when it leaves. Lost on restart."
}
```

`null` for `hourlyLimit`/`dailyLimit`/`quietHours` means that control is off. Unlike
`/health`, this needs the API key: send volume is operational detail about the account,
while `/health` is deliberately reachable by any watchdog. The console shows the same data
under **Pacing (anti-ban)**.

---

### Errors

| Status | Body `error` | Meaning |
|---|---|---|
| `400` | `invalid_message`, `no_target`, `bad_request`, `invalid_participant`, `invalid_group_jid` | Client input. |
| `401` | `unauthorized` | Missing or wrong `X-API-Key`. |
| `403` | `local_only` | `/ui` or `/docs` requested from a non-loopback address. |
| `404` | `not_found` | Unknown route. |
| `409` | `already_linked`, `in_flight`, `invite_unavailable` | State conflict. |
| `413` | — | Body over 64 KB (Fastify). |
| `429` | — | Rate limit (`RATE_LIMIT_PER_MINUTE`). |
| `429` | `hourly_limit`, `daily_limit`, `target_cooldown` | Pacing cap reached. Retry later; `message` says when. |
| `503` | `wa_not_connected`, `queue_closed`, `qr_unavailable`, `pairing_unavailable` | Not currently usable; retry later. |
| `503` | `quiet_hours` | Inside the configured quiet window. `503` not `429`, because the block is a property of the clock, not of the caller. |
| `500` | `internal_error` | Generic on purpose — details stay in the log, since exceptions can carry message content. |

---

## Configuration

All of `.env.example`, validated with zod at startup. **Invalid or missing config exits
`78`** rather than starting in a half-configured state.

| Var | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Keep on loopback. |
| `PORT` | `3000` | Also acts as the single-instance lock. |
| `API_KEY` | — | **Required**, ≥32 chars. `openssl rand -hex 32`. |
| `API_KEY_FILE` | — | Read the key from a file instead. Used only when `API_KEY` is unset. |
| `AUTH_DIR` | `./data/auth` | Resolved to an absolute path. |
| `DEFAULT_GROUP_JID` | — | Optional `/send` fallback target. |
| `SEND_MIN_INTERVAL_MS` | `1500` | Minimum gap between sends. |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per API key. |
| `ENABLE_UI` | `true` | Test console at `/` and `/ui`. Loopback-only either way. |
| `ENABLE_DOCS` | `true` | Swagger UI at `/docs`. Loopback-only either way. |
| `SYNC_HISTORY` | `true` | Accept WhatsApp's history push, which populates `/chats`. |
| `HUMANIZE` | `true` | Jitter and typing simulation. Caps and quiet hours apply regardless. |
| `SEND_JITTER_MS` | `2500` | Random extra delay added to each gap. |
| `TYPING_CPS` | `18` | Typing speed used to size the `composing` pause. |
| `TYPING_MAX_MS` | `6000` | Cap on that pause. `0` disables typing simulation. |
| `PER_TARGET_MIN_INTERVAL_MS` | `0` | Minimum gap to the same chat. `0` = off. |
| `HOURLY_SEND_LIMIT` | `0` | Rolling 60-min ceiling. `0` = off. |
| `DAILY_SEND_LIMIT` | `0` | Rolling 24-h ceiling. `0` = off. |
| `QUIET_HOURS` | — | e.g. `23-7`. Wraps past midnight; equal bounds ignored. |
| `QUIET_HOURS_TZ` | `UTC` | IANA zone the window is evaluated in, e.g. `Asia/Ho_Chi_Minh`. |
| `DEVICE_NAME` | `Chrome (Linux)` | Label under **Linked devices**. Keep it stable. |
| `LOG_LEVEL` | `info` | `trace`…`fatal`. |
| `LOG_PRETTY` | `false` | `true` for local development only. |

`QUIET_HOURS` and `QUIET_HOURS_TZ` are validated at startup like everything else: `99-7`
and `Mars/Olympus` both exit `78` with the offending var named, rather than silently
disabling the window.

`AUTH_DIR` is resolved to an absolute path at load. A relative path silently creates a
second, empty session whenever the working directory differs, which then reads as
"logged out".

---

## Debian deployment

### 1. Node 22 and a service user

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v   # expect v22.9 or newer

sudo useradd --system --create-home --shell /usr/sbin/nologin whatsappbot
```

### 2. Code

```bash
sudo mkdir -p /opt/whatsapp-relay
sudo chown whatsappbot:whatsappbot /opt/whatsapp-relay
sudo -u whatsappbot -H git clone <repo-url> /opt/whatsapp-relay
cd /opt/whatsapp-relay
```

`sudo -u` alone keeps **root's** `HOME`, so npm writes its cache to `/root/.npm` and fails
with `EACCES`. Pass the environment explicitly:

```bash
sudo -u whatsappbot -H env HOME=/home/whatsappbot npm ci
sudo -u whatsappbot -H env HOME=/home/whatsappbot npm run build
# TypeScript is a devDependency and is only needed for the build above.
sudo -u whatsappbot -H env HOME=/home/whatsappbot npm prune --omit=dev
```

### 3. Config and the API key

```bash
sudo install -d -m 0750 -o root -g whatsappbot /etc/whatsapp-relay

# Non-secret settings. AUTH_DIR and API_KEY_FILE come from the unit file.
sudo tee /etc/whatsapp-relay/relay.env >/dev/null <<'EOF'
HOST=127.0.0.1
PORT=3000
SEND_MIN_INTERVAL_MS=1500
RATE_LIMIT_PER_MINUTE=60
LOG_LEVEL=info

# Pacing. Start conservative on a fresh number and raise over a week or two.
HOURLY_SEND_LIMIT=30
DAILY_SEND_LIMIT=200
QUIET_HOURS=23-7
QUIET_HOURS_TZ=Asia/Ho_Chi_Minh
EOF
sudo chmod 0640 /etc/whatsapp-relay/relay.env
sudo chown root:whatsappbot /etc/whatsapp-relay/relay.env

# The key, delivered as a systemd credential rather than an env var, so it never
# shows up in `systemctl show` or /proc/<pid>/environ.
openssl rand -hex 32 | sudo tee /etc/whatsapp-relay/api_key >/dev/null
sudo chmod 0640 /etc/whatsapp-relay/api_key
sudo chown root:whatsappbot /etc/whatsapp-relay/api_key
```

### 4. Service

```bash
sudo cp deploy/whatsapp-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-relay
journalctl -u whatsapp-relay -f
```

`StateDirectory=whatsapp-relay` creates `/var/lib/whatsapp-relay` mode `0700` owned by the
service user; the unit points `AUTH_DIR` there. The unit runs under
`ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, `SystemCallFilter=@system-service`,
`MemoryMax=512M`, and stops restart loops after 5 failures in 5 minutes.

### 5. Link the device over an SSH tunnel

```bash
# On your workstation:
ssh -L 3000:127.0.0.1:3000 user@server
```

Then open `http://localhost:3000/ui`, paste the API key
(`sudo cat /etc/whatsapp-relay/api_key`), and scan the QR — or request a pairing code if a
camera is impractical. Equivalent by hand:

```bash
curl -s -H "X-API-Key: $KEY" -H 'Accept: image/png' localhost:3000/qr -o qr.png
```

The tunnel makes the request arrive from `127.0.0.1`, which is what the console requires.
Scan, then confirm:

```bash
curl -s localhost:3000/health | jq .state    # → "connected"
```

The QR also appears in `journalctl -u whatsapp-relay` as ASCII if the terminal renders it.

### 6. Remote callers (optional)

Only if something off-box must call `/send`. See `deploy/nginx.conf`, which terminates
TLS, allowlists source IPs, and **explicitly refuses `/`, `/ui`, `/qr`, `/pair` and the
whole `/docs` prefix** — every one of those is an account-takeover surface. If the caller
runs on the same host, skip nginx and let it talk to `127.0.0.1:3000`.

---

## Operations

**Logs.** pino JSON to stdout, captured by journald. Message text is **never** logged —
only a length and a SHA-256 prefix. `API_KEY`, `authorization`, `x-api-key`, and QR
payloads are redacted.

**Delivery ACKs** are logged as `message ack` with `status` `1` (server), `2` (delivered),
`3` (read). An absent ACK is an **unknown** outcome, never an automatic failure, and never
auto-retried.

**Restarts** reconnect from the persisted session with no new QR. `SIGTERM` stops accepting
requests, drains the send queue (up to 15 s), closes the socket, then flushes credentials
last — a half-written credential file forces a re-link, which needs a human with the phone.
Reconnects use exponential backoff to 30 s with ±20 % jitter.

**Terminal states** stop reconnecting and need a human:

| State | Cause | Action |
|---|---|---|
| `needs_relink` | Device unlinked from the phone (`401`). | Delete `AUTH_DIR`, restart, re-scan `/qr`. |
| `replaced` | Another client claimed this session (`440`). | Find the second instance. Do not run two. |
| `restricted` | WhatsApp returned `403`. | The account is likely restricted or banned. |

`AUTH_DIR` is **never** wiped automatically. A spurious `loggedOut` would otherwise turn a
recoverable blip into a mandatory re-scan.

**One owner only.** A WhatsApp session must have exactly one active client. The
`127.0.0.1:3000` bind is what enforces this: a second instance fails `EADDRINUSE` before it
can touch `AUTH_DIR`. **Stop the service** before running `npm run find-group`; on the
server it also needs the config the unit file normally supplies:

```bash
sudo systemctl stop whatsapp-relay
sudo -u whatsappbot -H env HOME=/home/whatsappbot \
  API_KEY="$(sudo cat /etc/whatsapp-relay/api_key)" \
  AUTH_DIR=/var/lib/whatsapp-relay/auth \
  npm run find-group -- "Team Ops"
sudo systemctl start whatsapp-relay
```

**Key rotation.** Write a new key to `/etc/whatsapp-relay/api_key`, update the callers,
then `systemctl restart whatsapp-relay`. There is no dual-key window yet, so expect a short
gap.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Exit `78` at startup | Config invalid. The offending vars are printed to stderr. |
| `/qr` returns `503 qr_unavailable` | Socket not open yet, or already linked-and-reconnecting. Check `/health`. |
| `/qr` returns `409 already_linked` | A session exists. Delete `AUTH_DIR` and restart to re-link. |
| QR appears on every restart | `AUTH_DIR` is not persisting. Check ownership and that the path is absolute. |
| `503 wa_not_connected` on `/send` | Not connected. `/health` has `state` and `reason`. |
| `needs_relink` with reason `linking never completed` | The QR expired unscanned, or a pairing code was issued for a number other than the phone being linked. `creds.json` is half-written junk: stop the process, delete `AUTH_DIR`, start, and finish the link promptly (QR refreshes ~20 s, codes last ~60 s). |
| `needs_relink` with reason `session logged out from the phone` | The device was removed under WhatsApp → Linked devices. Same fix, but the session was real, so check nobody unlinked it on purpose first. |
| `/chats` lists groups but few or no 1:1 chats | The history push is still arriving, or `SYNC_HISTORY=false`. Check `historySync.complete`; poll until true. After a restart the in-memory store is empty and WhatsApp only re-pushes on a fresh link. |
| Sends fail while `/health` shows `outgoingBlocked` | WhatsApp is throttling the account. Slow down; raise `SEND_MIN_INTERVAL_MS`, and set `HOURLY_SEND_LIMIT`/`DAILY_SEND_LIMIT` if they are still off. |
| `429 hourly_limit` / `daily_limit` | Your own cap, not WhatsApp's. `GET /limits` shows the counters and windows. They are in-memory, so a restart hands the budget back. |
| `429 target_cooldown` | Two messages to the same chat inside `PER_TARGET_MIN_INTERVAL_MS`. `message` says how long to wait. |
| `503 quiet_hours` | Inside `QUIET_HOURS`. Check `quietHours.timeZone` in `/limits` — it defaults to `UTC`, not the server's local zone. |
| `/docs` returns `403 local_only` | Reached from a non-loopback address, or through a proxy. Use `ssh -L 3000:127.0.0.1:3000 user@host`; a forged `X-Forwarded-For` will not pass, since the socket peer is checked too. |
| `403`/`forbidden` in the log | Account restricted. A new number is usually the only fix. |
| Group send rejected but `/send` returned `202` | Announce-only group and this account is not admin. `GET /groups` shows `announceOnly`. |
| `EACCES` from npm during install | `sudo -u` without `-H env HOME=…`. See step 2. |

---

## Corrections to the design doc

`WHATSAPP_PERSONAL_GROUP_RELAY_DEBIAN.md` proposed Express + `whatsapp-web.js` +
Chromium. These are defects in it, not preferences:

| # | Doc | Problem | Here |
|---|---|---|---|
| 1 | `sudo -u whatsappbot npm install` | Keeps root's `HOME` → npm cache in `/root/.npm` → `EACCES`. | `sudo -u … -H env HOME=… npm ci`. |
| 2 | `req.get("x-api-key") !== process.env.API_KEY` | Non-constant-time compare leaks the key byte by byte. | `timingSafeEqual` over SHA-256 digests (equal length, no length leak). |
| 3 | `express.json()` before `requireApiKey` | Unauthenticated bodies get parsed. | Fastify `onRequest` hook — fires **before** body parsing, unlike `preHandler`. |
| 4 | `whatsappReady` + `groupConfigured` booleans | Can disagree; `ready` is set even when the group failed to resolve. | One `ConnState` enum. |
| 5 | `client.sendMessage` per request | Concurrent sends interleave with no pacing → rate-limit/ban risk. | Serialized queue with min-interval pacing. |
| 6 | No `SIGTERM` handling | A restart mid-credential-write corrupts the session and forces a re-link. | Graceful shutdown, `saveCreds` last. |
| 7 | `dataPath: "./sessions"` | Relative to CWD; silently creates a second empty session. | `AUTH_DIR` resolved absolute. |
| 8 | systemd unit | Only `NoNewPrivileges` + `PrivateTmp`; API key in a plain `600` file. | Full hardening set + `StateDirectory` + `LoadCredential`. |
| 9 | `--no-sandbox` under `NoNewPrivileges` | Disabling the Chromium sandbox on a process rendering remote content. | Moot — no browser. |
| 10 | Resolve `GROUP_NAME` at boot | Names are mutable and non-unique; a rename silently retargets sends. | JIDs at runtime; name lookup is a CLI (`npm run find-group`). |

Baileys instead of `whatsapp-web.js` also removes the browser-crash failure class and
~400 MB of RAM.

`baileys` is pinned to the exact version `7.0.0-rc14` with the lockfile committed.
Counter-intuitive but deliberate: for an unofficial client, "stable" tracks the upstream
*protocol*, not the semver tag. `latest` is the `7.x` RC track where protocol fixes land;
`6.7.24` carries the `legacy` tag and pulls `libsignal` from a git URL. Upgrades are a
deliberate, tested step.

## Roadmap

Not built yet — the MVP is deliberately scoped:

1. **SQLite (WAL) outbox** — idempotency key and queued message in one transaction, drained
   by a worker. Survives restart and makes duplicates structurally impossible. Closes the
   one real gap in the current in-memory idempotency.
2. Persisted delivery state machine (`queued → sending → accepted → ack1 → ack2 → ack3`,
   plus `failed`/`unknown`).
3. `GET /metrics` — reconnects, queue depth, send attempts, ACK counts.
4. Relink alert: outbound webhook on `needs_relink` and on ACK stall.
5. API-key rotation with a dual-key overlap window.
6. Boot verification of `DEFAULT_GROUP_JID` (exists, and this account participates).
7. Dependency/vulnerability monitoring, given the pinned RC.

## Project layout

```
src/
  index.ts              start, bind, graceful shutdown
  config.ts             zod-validated env; exits 78 when invalid
  logger.ts             pino + redaction; message text never logged
  wa/
    client.ts           socket lifecycle, ConnState, QR capture, reconnect/backoff
    groups.ts           list / create / invite code / JID normalization
    sendQueue.ts        serialized sender with jittered min-interval pacing
    send.ts             group send with honest accepted/unknown outcome
    chatStore.ts        conversation list fed by history-sync pushes; metadata only
    humanizer.ts        jitter, typing simulation, volume caps, quiet hours
  http/
    server.ts           Fastify instance, hooks, error mapping
    auth.ts             timing-safe API key check (onRequest)
    localOnly.ts        loopback gate for /ui and /docs (socket peer AND req.ip)
    openapi.ts          OpenAPI document options + the loopback-gated Swagger UI
    schemas.ts          response schemas; additionalProperties: true is load-bearing
    idempotency.ts      LRU keyed on Idempotency-Key
    routes/             health, ui, qr, pair, groups, chats, send, limits
    ui/page.ts          the test console, one self-contained HTML string
deploy/
  whatsapp-relay.service
  nginx.conf
scripts/find-group.ts   one-off: group name → JID
```

---

## Security

**Do not report a security problem in a public issue.** Use
[private vulnerability reporting](https://github.com/nathanpixodeo/whatsapp-personal-bot/security/advisories/new).

[`SECURITY.md`](SECURITY.md) has the threat model, the operator hardening checklist, and
the list of documented trade-offs that will be closed as working-as-intended — chief
among them that this is an unofficial client and that the automation is not hidden.

The two assets worth attacking are `AUTH_DIR`, which is a full account credential, and
`API_KEY`. The account-takeover surfaces are `GET /qr`, `POST /pair`, `/ui` and `/docs`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Read
[Scope](CONTRIBUTING.md#scope) first: content spinning, number rotation, proxy rotation,
fingerprint spoofing and ban "recovery" are refused on principle, not on quality.

```bash
npm ci && npm run typecheck && npm run build
```

CI runs exactly those two checks on Node 22 and 24. There is no automated test suite
yet, so a pull request should say how the change was exercised by hand.

Notable changes are recorded in [`CHANGELOG.md`](CHANGELOG.md).

## License

[GNU Affero General Public License v3.0 or later](LICENSE).

Copyright © 2026 nathanpixodeo.

This program is free software: you can redistribute it and/or modify it under the terms
of the GNU Affero General Public License as published by the Free Software Foundation,
either version 3 of the License, or (at your option) any later version. It is
distributed in the hope that it will be useful, but **WITHOUT ANY WARRANTY**; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See
the [LICENSE](LICENSE) file for the full text.

AGPL section 13 is the clause that matters for a service like this one: **if you run a
modified version and let others interact with it over a network, you must offer those
users the corresponding source.** Running an unmodified copy for yourself carries no
such obligation.

Nothing in the licence changes the warning at the top of this README. WhatsApp's terms
are a separate matter from the software licence, and automating a personal account can
get the number banned.
