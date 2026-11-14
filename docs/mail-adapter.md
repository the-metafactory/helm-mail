# Mail read adapter

The `mail` Desk adapter (`adapter/`, built from `src/adapter/`) reads mail only through the host's `host.mail.listed()` bridge. It never runs a provider, never searches one and holds no account, host or credential. It is inactive until the principal approves and activates the package.

## What it answers

| Capability | Kind | Answer |
| --- | --- | --- |
| `mail.mailbox.list` | query | One `inbox` destination per connection. |
| `mail.message.query` | query | Listed mail of one connection, at most 20 per page. An optional `messageId` input reads one listed mail. |
| `mail.message.watch` | observation | The same mail as `present` events per connection. |

Each message carries `messageId`, `account`, sender, subject, `receivedAt` and the first paragraph (1,000 characters at most). The adapter copies only those fields, so no body can pass through it.

## Rules it keeps

- One connection is one source-and-account pair. A message is referenced as `{ connection, messageId }`, so the same Message-ID under two connections is two objects.
- Mail with no account, with another account or from another connection is dropped.
- A stale connection reports `health: "stale"` and keeps its last listed mail. Its observation returns `coverage: "none"` with no events, so nothing is verified or treated as deleted.
- A request that spans two connections is refused.
- A connection with no explicit `dataPolicy` is `local`: the host denies a cloud reader before the adapter is called. The adapter sets no policy.
- No attention mapping, no Day item and no action connector.

## Verification

- `bun test` runs the unit tests with a fake bridge and the published conformance harness over a fake Mail source.
- `bun run probe:read` runs the harness on synthetic accounts (fresh, stale and cloud connections), then checks that no result carries a body.
- `bun run check:adapter` fails when `adapter/` differs from what `src/adapter/` builds.

The Desk SDK is pinned to the Cortex release tag `v6.27.0` (Desk adapter SDK 1.6.0). The cloud-reader probe and the failure scenarios for a Mail adapter arrive in SDK 1.7.0, which no release carries yet. `probe:read` requires the cloud-reader probe from 1.7.0 on; move the pin when that release is tagged and add `runFailureScenarios(dir, { mail })`.
