# CLI connection, interface 1.0

`CliConnection` implements `MailConnection` using a deployment's mail CLI.
The CLI must support request-ID drafts and lookup. Its source and configuration
are supplied by the deployment and are not part of this public package.

```ts
import { CliConnection } from "../src/cli";
import { callDraft, callLookup } from "../src/interface";

const connection = new CliConnection({ command: ["email"] });
const outcome = await callDraft(connection, {
  version: 1,
  requestId: "reply-request-1",
  account: "account-1",
  messageId: "<original@example.invalid>",
  recipient: "recipient@example.invalid",
  subject: "Re: Example",
  body: "Example reply",
});
const current = await callLookup(connection, "reply-request-1");
```

The command array can include a runtime and entry point. Arguments are passed
directly without a shell. `env` overrides inherited environment variables, so a
deployment can select an isolated CLI configuration. Never put deployment
values, account identities or credentials in this repository.

| Interface field/verb | CLI argument |
| --- | --- |
| `draft` | `draft create --no-markdown --output=json` |
| `requestId` | `--request-id=…` |
| `account` | `--account=…` (always explicit) |
| `messageId` | `--in-reply-to=…` |
| `recipient` | `--to=…` |
| `subject` | `--subject=…` |
| `body` | `--file=…` (temporary private file, removed when the process finishes) |
| `lookup(requestId)` | `draft lookup --output=json -- <requestId>` |

Bodies are plain text, including empty bodies. Request IDs follow the CLI's
1–200 character alphabet: letters, digits, `.`, `_`, `:`, `@`, `-`.
Use globally unique request IDs: lookup searches all configured IMAP accounts.
The CLI stores the request ID on the draft and compares its content on a repeat.
It returns `created`, `exists` or `conflict`, each with the draft's ID and account.
Before creation, the connection also looks up the ID across accounts: a draft in
another account is a conflict, and an unavailable lookup prevents creation.
Lookup reads current Drafts state and returns `found`, `not_found` or `unavailable`.
`not_found` makes no assertion about whether a draft previously existed or was sent.
There is no local success ledger or lookup cache.

The connection exposes no send verb. It never invokes a send command. Nonzero
exits, timeouts and malformed replies become `unknown` through `callDraft` and
`callLookup`; they do not imply that a draft was not created. The default connection
timeout is four seconds per operation. Draft lookup and creation share this single
deadline, including body-file preparation; creation does not start if the budget
has expired. The connection kills an unfinished CLI process and waits for it to
exit before returning. When increasing the connection timeout, also
increase the wrapper call's timeout (five seconds by default). An unknown outcome
requires lookup before deciding whether to retry. The CLI's check and save are
separate provider operations: callers must serialize submissions for a request
ID, including retries after a timeout, to avoid overlapping saves.

The native Desk continues to invoke `email draft create` without `--request-id`.
That command's arguments and result format remain unchanged. This connection
does not migrate or replace the native Desk command.

## Test-mailbox conformance

`bun run conformance` runs the fake suite. Live conformance is explicitly opt-in:

```sh
bun run conformance --mailbox-fixture /path/outside/repository/test-fixture.ts
```

The local fixture module exports `createFixture(): Promise<TestMailboxFixture>`.
Import its types from `src/mailbox-conformance.ts` and implement these hooks:

| Fixture field | Contract |
| --- | --- |
| `testMailbox` | Literal `true`: the deployment has explicitly designated a disposable test mailbox. |
| `connection` | A `CliConnection` running the actual CLI with only the isolated test configuration. |
| `request` | Invented content with a fresh request ID of at most 192 characters; its account is the test account. |
| `inspect(requestId)` | Independently read the provider's Drafts folder and return every exact matching draft as `DraftSnapshot`. Do not derive observations from CLI replies or a local ledger. |
| `remove(draft)` | Remove only the draft passed by the run, directly through the provider to simulate hand removal. |
| `timeoutMs` | Optional per-call timeout; set it above the connection's operation timeout. |

`DraftSnapshot.messageId` is the original message's ID from the draft's
`In-Reply-To` header; `id` is the draft's own ID. Inspect the account, recipient,
subject and plain body from the stored draft, normalizing transport line endings
where necessary. `unsent` must be established from its presence in Drafts and
provider draft state, not from the connection's return status. Inspect every
matching draft so a duplicate cannot hide behind a successful CLI reply.

The run checks that both request IDs are unused, creates the primary draft,
repeats it, tries changed content and a changed account, and checks lookup. It then creates a separate
request with `.removed` appended, removes that draft through the fixture and
checks `not_found`. It leaves the primary draft for the principal to inspect.
Failed probes can leave test drafts; inspect them before rerunning with fresh IDs.
The fixture is executable deployment code: keep it and all configuration outside
the public repository. Never run it against a real account unattended. The
principal's inspection of the retained draft is a separate checkpoint gate.
