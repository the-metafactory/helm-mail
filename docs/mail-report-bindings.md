# Mail report bindings

The packaged Mail adapter binds three report kinds, inactive until the host activates them. Grants, prompts and receipts belong to the host (cortex#3542).

| Capability | What runs | Undo |
| --- | --- | --- |
| `mail.report.draft` | Saves a draft with the original attached in the account's Drafts. Nothing is sent. | None. |
| `mail.report.spam` | Submits a spam report through the connection; the message moves to Junk. | `mail.restore` restores the location only. The report stands. |
| `mail.report.phishing` | Submits a phishing report through the connection; the message moves to Junk. | Same as spam. |

## Connection interface

A connection that offers reports sets `reportKinds` and provides `report(request)` and `lookupReport(requestId)`. A provider report also needs `restore`, because Undo moves the mail back.

- `report` takes `{ version, requestId, kind, message }` and returns `{ ref, folder }`. The same request ID returns the same result.
- `lookupReport` returns `{ status: "found", request, result }`, or `not_found` or `unavailable`.
- `reportSupport(connection, kind)` explains why a kind is unavailable. A kind missing from `reportKinds` is unavailable.

## Adapter behavior

- The adapter checks the listing before it calls the provider. A missing message or an account other than the approved one refuses with no effect, and the provider is not called.
- It reads history first. A matching earlier request settles the attempt without a second report; a mismatched one stays uncertain.
- A timeout or malformed output stays uncertain until `lookupReport` settles it.

## Known limit

The host bridge reports a connection's method names, not its `reportKinds`. In the package, a kind is therefore offered when the connection provides `report` and `lookupReport` (and `restore` for spam and phishing). A kind the connection does not declare is refused by the connection itself, which the adapter records as uncertain until history settles it. `registerMailReports` and `withMailReports` take a `kinds` option to narrow a deployment.

## Proof

`bun run probe:reports` runs both report kinds, the undo of a provider report, and the missing and denied refusals through the public production-journal runner.
