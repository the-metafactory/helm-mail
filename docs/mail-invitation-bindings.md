# Mail invitation bindings

The packaged Mail adapter binds invitation replies and removal, inactive until the host activates them. Grants, prompts and receipts belong to the host (cortex#3543).

| Capability | What runs | Undo |
| --- | --- | --- |
| `mail.invitation.accept`, `.decline`, `.tentative` | Sends the reply through the connection. The organizer is notified. | None. The notification cannot be retracted. |
| `mail.invitation.remove` | Removes a declined invitation's event. | `mail.invitation.restore`, when the connection can restore events. Otherwise the receipt says it cannot be undone. |
| `mail.invitation.restore` | Restores the removed event. | None. |

## Connection interface

A connection provides `lookupInvitation(requestId)` and any of `invitationReply(request)`, `invitationRemove(request)` and `invitationRestore(request)`.

- A request is `{ version, requestId, message, invitation, expectedRevision }`, plus `reply` for a reply. The result is `{ ref, revision }`. The same request ID returns the same result.
- `lookupInvitation` returns `{ status: "found", request, result }`, or `not_found` or `unavailable`.
- A provider refusal rejects with `InvitationRefusal("changed", currentRevision)`, `("missing")` or `("denied")`. Any other rejection, a timeout or malformed output stays uncertain until lookup settles it.
- `invitationSupport(connection, verb)` explains why a verb is unavailable.

## Adapter behavior

- A reply or removal against an invitation that changed since it was shown is refused with a conflict carrying the current revision; the host then re-reads the invitation. Nothing is sent.
- Removal is approved against the revision the decline returned, so an event that changed since declining is refused.
- Removal registers `mail.invitation.restore` as its Undo only when the connection offers `invitationRestore`.
- History is read first; a matching earlier request settles the attempt without a second call.

## Proof

`bun run probe:invitations` runs each reply, a stale refusal, removal, its Undo, a removal after a change, and a restart after a timeout through the public production-journal runner.
