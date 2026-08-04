# WhatsApp Personal Group Relay

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

## Read this before deploying

- **This is an unofficial client.** It logs in as a real person via the same
  "Linked devices" mechanism as WhatsApp Web. Automating a personal account can get the
  number **rate-limited, restricted, or banned**, with no warning and no appeal path.
  Use a **dedicated, non-critical** number. Keep a fallback notification channel.
- **`AUTH_DIR` is a full account credential.** Whoever can read those files can send and
  read messages as the linked account. Mode `0700`, owned by the service user, never
  committed, never in an unencrypted backup.
- **`GET /qr`, `POST /pair` and the `/ui` console grant account takeover.** Scanning that QR
  or typing that pairing code links a new device. They must never be reachable from the
  internet — reach them through an SSH tunnel. `/ui` enforces loopback itself; the API key on
  `/qr` and `/pair` is defence in depth, not the primary control.
- **`202` is not a delivery guarantee.** It means the socket accepted the stanza.
  Delivery ACKs are logged, not yet persisted.

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
code. The same page exercises `/health`, `/groups`, `/send`, and `POST /groups`, so no curl
is needed to test. It is served to **loopback callers only** (see
[Test console](#test-console)).

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

Every route except `/health` requires the `X-API-Key` header. The key is compared in
constant time. Bodies are capped at 64 KB; rate limiting is per API key
(`RATE_LIMIT_PER_MINUTE`, default 60/min), falling back to per-IP for unauthenticated
requests.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | none | `200` only when connected **and** not send-blocked; otherwise `503`. |
| `GET` | `/` `/ui` | none, loopback only | Test console. `403 local_only` for any other caller. |
| `GET` | `/qr` | key | Pairing QR. `409` when already linked, `503` when none is pending. |
| `POST` | `/pair` | key | 8-character pairing code for `{"phoneNumber": "+62…"}`. Camera-free alternative to `/qr`. |
| `GET` | `/groups` | key | Groups this account participates in, with JIDs. |
| `GET` | `/chats` | key | Every conversation: 1:1 chats from history sync **plus** all groups. |
| `POST` | `/groups` | key | Create a group. `201`. |
| `GET` | `/groups/:jid/invite` | key | Invite link for an existing group. Usually needs admin. |
| `POST` | `/send` | key | Send text. `202`. |

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
(default 1500 ms). Concurrent requests queue instead of racing — unpaced bursts are what
gets numbers flagged.

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

### Errors

| Status | Body `error` | Meaning |
|---|---|---|
| `400` | `invalid_message`, `no_target`, `bad_request`, `invalid_participant`, `invalid_group_jid` | Client input. |
| `401` | `unauthorized` | Missing or wrong `X-API-Key`. |
| `403` | `local_only` | `/ui` requested from a non-loopback address. |
| `404` | `not_found` | Unknown route. |
| `409` | `already_linked`, `in_flight`, `invite_unavailable` | State conflict. |
| `413` | — | Body over 64 KB (Fastify). |
| `429` | — | Rate limit. |
| `503` | `wa_not_connected`, `queue_closed`, `qr_unavailable`, `pairing_unavailable` | Not currently usable; retry later. |
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
| `SYNC_HISTORY` | `true` | Accept WhatsApp's history push, which populates `/chats`. |
| `LOG_LEVEL` | `info` | `trace`…`fatal`. |
| `LOG_PRETTY` | `false` | `true` for local development only. |

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
TLS, allowlists source IPs, and **explicitly refuses `/qr`**. If the caller runs on the
same host, skip nginx and let it talk to `127.0.0.1:3000`.

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
| Sends fail while `/health` shows `outgoingBlocked` | WhatsApp is throttling the account. Slow down; raise `SEND_MIN_INTERVAL_MS`. |
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
    sendQueue.ts        serialized sender with min-interval pacing
    send.ts             group send with honest accepted/unknown outcome
    chatStore.ts        conversation list fed by history-sync pushes; metadata only
  http/
    server.ts           Fastify instance, hooks, error mapping
    auth.ts             timing-safe API key check (onRequest)
    idempotency.ts      LRU keyed on Idempotency-Key
    routes/             health, ui, qr, pair, groups, chats, send
    ui/page.ts          the test console, one self-contained HTML string
deploy/
  whatsapp-relay.service
  nginx.conf
scripts/find-group.ts   one-off: group name → JID
```
