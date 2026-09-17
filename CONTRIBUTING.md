# Contributing

Thanks for taking a look. This is a small, deliberately scoped project — please read
[Scope](#scope) before writing code, because the most common contribution here is one
that will be declined on principle rather than on quality.

Security problems do **not** go in issues or pull requests. See
[`SECURITY.md`](SECURITY.md).

## Scope

The project is an authenticated HTTP relay that posts into WhatsApp groups through a
linked personal account. Its [roadmap](README.md#roadmap) lists what is planned.

**Permanently out of scope.** These are refused on principle, and a pull request
implementing one will be closed regardless of how well it is written:

- message-content spinning or randomisation intended to dodge detection,
- phone-number rotation, proxy rotation, fingerprint or device spoofing,
- ban "recovery" or appeal automation,
- anything whose purpose is bulk unsolicited messaging.

The reasoning is in [Anti-ban pacing](README.md#anti-ban-pacing): Baileys speaks
WhatsApp's first-party multi-device protocol, so none of these actually work, and
shipping them would imply a safety that does not exist. Pacing controls exist to avoid
behaving like spam, not to hide.

Also currently out of scope, though not on principle: message receiving and
auto-replies, media sending, and multi-account support. Open an issue before starting
on any of them.

## Getting set up

```bash
npm ci
cp .env.example .env
openssl rand -hex 32     # put the result in .env as API_KEY=
npm run dev
```

Node 22.9 or newer, because the npm scripts use `--env-file-if-exists`. Use a
**dedicated, non-critical** WhatsApp number for development — see
[Read this before deploying](README.md#read-this-before-deploying).

Only one process may own a WhatsApp session at a time. The `127.0.0.1:3000` bind is what
enforces that: a second instance fails with `EADDRINUSE` before it can touch `AUTH_DIR`.
Stop the relay before running `npm run find-group`.

The test console at `http://localhost:3000/ui` exercises every route without curl, and
`http://localhost:3000/docs` is the generated OpenAPI reference. Both are loopback-only.

## Before opening a pull request

```bash
npm run typecheck    # tsc over src/ and scripts/
npm run build        # must emit cleanly
```

Both must pass. CI runs exactly these on Node 22 and 24.

There is no automated test suite yet. Until there is, say in the pull request how you
exercised the change by hand — which routes you hit, what `/health` and `/limits`
reported, whether a real message was sent.

## Code conventions

Match the surrounding code rather than a style guide:

- TypeScript, ESM, `strict` plus `noUncheckedIndexedAccess`. No `any` escape hatches and
  no `@ts-expect-error` without a comment saying why.
- Validate input with zod at the boundary; the JSON schemas in `src/http/schemas.ts`
  generate the OpenAPI document, so a route contract and its docs change in one commit.
- Response schemas keep `additionalProperties: true` on purpose — Fastify's serializer
  drops unlisted properties, so a strict schema silently truncates real responses.
- **Never log message text.** The logger redacts `API_KEY`, `authorization`, `x-api-key`
  and QR payloads; message bodies are reduced to a length and a SHA-256 prefix. Keep it
  that way.
- Errors returned to clients stay generic; detail belongs in the log, because exception
  text can carry message content.
- Comments explain *why*, not what. The existing ones are the model: they record the
  trap that made the line necessary.
- Name things after what is observable. `notAdded` rather than `failedToAdd`, because
  the protocol never confirms the cause.

## Commits

Imperative subject line, sentence case, no type prefix, roughly under 72 characters, and
it should say what changed *and why* where that is not obvious:

```
Add OpenAPI docs and send pacing to reduce spam-like behaviour
```

Put the longer reasoning in the body. Keep one logical change per commit.

## Dependencies

`baileys` is pinned to the exact prerelease `7.0.0-rc14` with the lockfile committed.
This is deliberate and explained in
[Corrections to the design doc](README.md#corrections-to-the-design-doc) — for an
unofficial client, "stable" tracks the upstream *protocol*, not the semver tag. Bumping
it is a standalone, tested pull request, never a drive-by.

New runtime dependencies need a reason in the pull request. The current set is small on
purpose, and one of the arguments for Baileys over `whatsapp-web.js` was removing a
browser and ~400 MB of RAM.

## Licensing of contributions

The project is licensed under **AGPL-3.0-or-later**. By opening a pull request you agree
that your contribution is licensed under the same terms. Inbound equals outbound; there
is no separate CLA.

Note what AGPL section 13 means in practice here: if you run a modified version and let
others interact with it over a network, you must offer them the modified source.
