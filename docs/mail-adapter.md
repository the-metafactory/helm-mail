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

The Desk SDK is pinned to the Cortex release tag `v6.32.0` (Desk adapter SDK 1.13.0). `probe:read` runs the published conformance kit with a fake Mail source: the cloud-reader probe, the failure scenarios (`runFailureScenarios(dir, { mail })`), and a run on two connections whose per-query answers (`mailQueries`) it checks for separate objects and no body. The message query declares a stable snapshot whose ID digests the whole matching listing, so a listing that changes between pages answers with another snapshot ID. The Cortex query runner refuses a page whose snapshot ID differs from the one it was handed, so the read fails instead of silently omitting mail.

## Inactive reply action generation

`adapter-actions/` is a separately built, committed alternative to the existing
read-only `adapter/`, using the same adapter identity. Select exactly one generation;
this change does not configure, discover or activate the action candidate in a stack.
The existing read package and its full generic conformance/read checks remain intact.

The alternative retains the read handlers/metadata, adds the canonical account schema
and `mail.reply-draft.create`, and exports only `createDeskAdapter(host)`. SDK1.13's
optional `host.mailExecution` supplies host-selected version-1 draft/lookup methods.
Without both methods and the declared version, execution is unavailable. The package
receives no native connection, command configuration or credentials.

The approved canonical snapshot must match the exact message, account, connection,
body and digest. The recipient and reply subject come from current listed mail; the
body is never trimmed. Native request IDs are `mail.reply-draft.create:<ownerRequestId>`.
Same-request submissions are serialized because the native CLI's check/save are
separate operations. The lifecycle declares historical lookup and `dedup: none`, with no send,
cancellation or compensation. Native serial request-ID handling and the host journal
suppress repeats, but the interface offers no attested concurrent dedup guarantee.
Consequently the host cannot authorize same-key replay after uncertainty; lookup
must settle the existing attempt. Native request-ID evidence stays
in the saved draft; a missing draft at lookup remains unknown, never proof of no effect.
The process-local serialization map does not survive process termination or certify
separate loaders/processes. No 60-second retention or cross-process dedup guarantee
is advertised; this inactive package does not strengthen the existing interface.

`bun run build:actions` builds this alternative; `check:actions` checks its committed
bytes. `probe:reply` explicitly loads that package with invented data through the
public `runMailActionScenario`, production host admission and durable journal. It
checks exact confirmation/body/recipient/subject, one effect on repeat, missing
version/method refusal, foreign account/connection refusal, and timeout recovery
with original IDs and receipts after two loader/factory/connector/host reconstructions.
The real Helm `CliConnection` uses a fake CLI that saves its invented effect to a
private temporary file and waits until the connection timeout kills it; lookup
reads that effect after the binding is reconstructed. No original attempt IDs or
digest are stored in the fake native file.

The reconstruction is controlled within one Bun process; it is not an OS-process
crash test. The public scenario uses local exact confirmation and rejects a cloud
policy snapshot; Cortex's separate host tests cover broad-grant and cloud-created
grant refusal. This probe makes no claim to execute those grant cases. Generic
conformance is the read package's acceptance surface; dedicated Mail scenarios are
the action candidate's acceptance surface. Neither package is activated here, and
no real mailbox, credential, draft, send or native-path cutover is used.
