# WhatsApp Personal Account Group Relay on Debian

## Purpose

This document describes an unofficial relay service that receives authenticated HTTP requests and sends their text content to a WhatsApp group through a linked personal WhatsApp account.

> **Important:** This design automates WhatsApp Web and does not use Meta's official WhatsApp Business Platform Groups API. WhatsApp may log out, restrict, or ban automated personal accounts. Do not use this design for spam, bulk messaging, safety-critical notifications, or workflows that require guaranteed delivery.

## Architecture

```text
Upstream application/webhook
        |
        | HTTPS + API key + idempotency key
        v
Nginx reverse proxy
        |
        v
Node.js relay API (Express)
        |
        v
whatsapp-web.js + Chromium
        |
        v
Linked personal WhatsApp account -> Target group
```

The personal account must already be a member of the target group. The first login requires scanning a QR code from **WhatsApp > Linked devices > Link a device**. `LocalAuth` stores the linked session on disk for subsequent restarts.

## Requirements

- Debian 11/12 or a compatible Debian-based server
- At least 1 GB RAM; 2 GB is preferable for Chromium
- Node.js 18 or newer (Node.js 20 LTS is recommended)
- Chromium
- A dedicated, non-critical WhatsApp account
- A domain and TLS certificate for Internet-facing deployments
- A persistent disk for the WhatsApp session

## 1. Install the runtime

```bash
sudo apt update
sudo apt install -y curl chromium

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node --version
npm --version
```

Create a dedicated service account and application directory:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin whatsappbot
sudo mkdir -p /opt/whatsapp-group-relay
sudo chown whatsappbot:whatsappbot /opt/whatsapp-group-relay
```

Install the application dependencies:

```bash
cd /opt/whatsapp-group-relay
sudo -u whatsappbot npm init -y
sudo -u whatsappbot npm install express whatsapp-web.js qrcode-terminal dotenv
```

## 2. Configuration

Create `/opt/whatsapp-group-relay/.env`:

```dotenv
PORT=3000
API_KEY=replace-with-a-long-random-secret
GROUP_NAME=Exact WhatsApp Group Name
```

Protect the file:

```bash
sudo chown whatsappbot:whatsappbot /opt/whatsapp-group-relay/.env
sudo chmod 600 /opt/whatsapp-group-relay/.env
```

For production, prefer a stable group ID over `GROUP_NAME`. Group names can change and are not guaranteed to be unique. The initial implementation prints the resolved group ID after login so it can later be stored as `GROUP_ID`.

## 3. Relay application

Create `/opt/whatsapp-group-relay/server.js`:

```javascript
require("dotenv").config();

const express = require("express");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
app.use(express.json({ limit: "64kb" }));

let whatsappReady = false;
let targetGroupId = process.env.GROUP_ID || null;

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "personal-relay",
    dataPath: "./sessions",
  }),
  puppeteer: {
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

client.on("qr", (qr) => {
  console.log("Scan this QR code from WhatsApp > Linked devices:");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => console.log("WhatsApp authenticated"));

client.on("ready", async () => {
  whatsappReady = true;

  if (!targetGroupId) {
    const chats = await client.getChats();
    const matches = chats.filter(
      (chat) => chat.isGroup && chat.name === process.env.GROUP_NAME
    );

    if (matches.length !== 1) {
      console.error(
        `Expected one matching group, found ${matches.length}. Configure GROUP_ID.`
      );
      return;
    }

    targetGroupId = matches[0].id._serialized;
    console.log(`Resolved group ID: ${targetGroupId}`);
  }

  console.log("WhatsApp relay is ready");
});

client.on("auth_failure", (message) => {
  whatsappReady = false;
  console.error("WhatsApp authentication failed:", message);
});

client.on("disconnected", (reason) => {
  whatsappReady = false;
  console.error("WhatsApp disconnected:", reason);
});

client.on("message_ack", (message, ack) => {
  console.log("Message acknowledgement", {
    messageId: message.id._serialized,
    ack,
  });
});

function requireApiKey(req, res, next) {
  if (req.get("x-api-key") !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.status(whatsappReady && targetGroupId ? 200 : 503).json({
    api: "running",
    whatsappReady,
    groupConfigured: Boolean(targetGroupId),
  });
});

app.post("/send", requireApiKey, async (req, res) => {
  try {
    const { message } = req.body;

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: "A non-empty message string is required",
      });
    }

    if (message.length > 4000) {
      return res.status(400).json({
        success: false,
        error: "Message exceeds the 4,000-character application limit",
      });
    }

    if (!whatsappReady || !targetGroupId) {
      return res.status(503).json({
        success: false,
        error: "WhatsApp or the target group is not ready",
      });
    }

    const sent = await client.sendMessage(targetGroupId, message.trim());

    // This means the Web client accepted the call. It is not a delivery guarantee.
    return res.status(202).json({
      success: true,
      status: "accepted",
      messageId: sent.id._serialized,
    });
  } catch (error) {
    console.error("Send failed:", error);
    return res.status(500).json({
      success: false,
      error: "WhatsApp send failed",
    });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "127.0.0.1", () => {
  console.log(`Relay API listening on 127.0.0.1:${port}`);
});

client.initialize();
```

Set ownership:

```bash
sudo chown -R whatsappbot:whatsappbot /opt/whatsapp-group-relay
```

## 4. First login

Run the process interactively for the first login:

```bash
cd /opt/whatsapp-group-relay
sudo -u whatsappbot node server.js
```

Scan the QR code using the dedicated account. Wait for `WhatsApp relay is ready`, then stop the process with `Ctrl+C`.

The session is stored under `/opt/whatsapp-group-relay/sessions`. Treat this directory as a credential: restrict access, back it up securely if required, and never commit it to Git.

## 5. Run with systemd

Create `/etc/systemd/system/whatsapp-group-relay.service`:

```ini
[Unit]
Description=WhatsApp Personal Group Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=whatsappbot
Group=whatsappbot
WorkingDirectory=/opt/whatsapp-group-relay
ExecStart=/usr/bin/node /opt/whatsapp-group-relay/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Basic hardening. Test after changing Chromium or its launch arguments.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-group-relay
sudo systemctl status whatsapp-group-relay
sudo journalctl -u whatsapp-group-relay -f
```

## 6. Test the API locally

Health check:

```bash
curl http://127.0.0.1:3000/health
```

Send a test message:

```bash
curl -X POST http://127.0.0.1:3000/send \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: replace-with-a-long-random-secret' \
  --data '{"message":"Test message from the Debian relay"}'
```

Expected response:

```json
{
  "success": true,
  "status": "accepted",
  "messageId": "..."
}
```

`accepted` does not mean delivered. `whatsapp-web.js` acknowledgement events should be recorded separately, and a missing acknowledgement must be treated as an unknown outcome rather than an automatic failure.

## 7. Reverse proxy and network security

Bind Node.js only to `127.0.0.1`. If a remote application must call the relay, place Nginx in front of it and require HTTPS. Also consider:

- IP allowlisting at the firewall or Nginx layer
- A randomly generated API key with periodic rotation
- Request rate limiting
- A VPN or private network instead of a public endpoint
- Redacting message contents and credentials from logs
- A maximum request-body size

Do not expose Chromium's debugging port, the session directory, or the Node.js port publicly.

## 8. Idempotency and retry design

Webhook providers commonly retry requests. Without idempotency, one upstream event can create duplicate WhatsApp messages.

For production, require an `Idempotency-Key` header and persist its state in SQLite, PostgreSQL, or Redis:

1. Start a database transaction.
2. Insert the key with status `processing` under a unique constraint.
3. If the key already exists, return the previously recorded result.
4. Send the message once.
5. Store the WhatsApp message ID and status `accepted`.
6. Update delivery state when acknowledgement events arrive.

Do not blindly retry an unknown send result. The message may have been delivered even when the HTTP call timed out. Use a queue with bounded retries, exponential backoff, a dead-letter state, and operator review for ambiguous outcomes.

## 9. Production improvements

Before production use, add:

- Persistent idempotency storage
- A job queue so API requests do not send synchronously
- Rate limits and deliberate delays between sends
- Structured logs with secrets and message content redacted
- Metrics for readiness, disconnects, send attempts, ACK levels, and queue depth
- Alerts when QR relinking is required
- Graceful shutdown handling
- Exact `GROUP_ID` configuration
- Input schemas and message templates
- Automated dependency and vulnerability monitoring

Avoid running multiple relay processes against the same session directory. A single consumer should own a personal WhatsApp session.

## 10. Failure modes

| Failure | Expected handling |
| --- | --- |
| QR/session expired | Mark the service unhealthy and require an operator to relink the device. |
| Target group renamed | Use the stored group ID rather than resolving by name. |
| Account removed from group | Stop sending and alert an operator. |
| `sendMessage()` returns but no ACK arrives | Record the outcome as unknown; do not immediately resend. |
| Chromium crashes | Let systemd restart the service and monitor restart frequency. |
| WhatsApp Web changes | Pin and test library updates; expect occasional breakage. |
| Upstream webhook retries | Deduplicate using the upstream event ID/idempotency key. |
| Duplicate group names | Refuse to choose automatically; configure the exact group ID. |

## 11. Operational and policy considerations

- Obtain consent from group members for automated notifications.
- Send only relevant, expected messages.
- Do not scrape contacts, group members, or conversation history.
- Use a separate account so a restriction does not affect a critical personal number.
- Maintain a manual fallback channel.
- For business-critical or high-volume messaging, use an officially supported platform. If the organization becomes eligible, evaluate Meta's official WhatsApp Business Platform Groups API.

## References

- [whatsapp-web.js repository and installation](https://github.com/pedroslopez/whatsapp-web.js/)
- [Meta WhatsApp Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups)
- [Meta Groups API getting started](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started)
- [WhatsApp guidance on unauthorized automated or bulk messaging](https://faq.whatsapp.com/5957850900902049)
- [WhatsApp responsible-use guidance](https://faq.whatsapp.com/361005896189245)

## Disclaimer

This guide is an engineering reference, not an assurance that personal-account automation is permitted or stable. Review the current WhatsApp terms and policies before deployment. The APIs and behavior of WhatsApp Web can change without notice.
