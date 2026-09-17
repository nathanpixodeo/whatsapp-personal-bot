<!--
Security fixes do not start as a public pull request. Open a private advisory first:
https://github.com/nathanpixodeo/whatsapp-personal-bot/security/advisories/new
-->

## What and why

<!-- What changes, and the reason. Link the issue with "Closes #123" if there is one. -->

## How it was exercised

<!--
There is no automated test suite yet, so say what you actually ran: which routes you
hit, what /health and /limits reported, whether a real message was sent and to what.
Never paste an API key, a QR payload, a pairing code or real message content.
-->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] README updated if behaviour, a route, an error code or a config var changed
- [ ] `CHANGELOG.md` updated under `Unreleased`
- [ ] No message text, API key or QR payload added to any log line
- [ ] No new runtime dependency, or the pull request explains why one is needed
- [ ] `baileys` version unchanged, or this pull request does nothing else
- [ ] Nothing here is on the refused list in [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md#scope)
