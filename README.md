# helm-mail

helm-mail adds mail capabilities to Helm and gives the Cortex Desk a mail adapter. It is generic: a deployment customizes it by supplying a mail CLI or connection behind a versioned interface. It holds no accounts, hosts, credentials or mail.

## Status

Interface 1.0 supports draft creation and draft lookup, with a fake connection,
a CLI connection and conformance runners. See [the CLI connection](docs/cli-connection.md)
for deployment configuration and the opt-in test-mailbox probe.

```sh
bun install
bun test
bun run conformance
```

The default conformance run uses only the fake connection and contacts no mailbox.

| Step | Tracked in |
| --- | --- |
| Mail connection interface 1.0 | [cortex#3367](https://github.com/the-metafactory/cortex/issues/3367) |
| Implement the interface for the mail CLI | [cortex#3368](https://github.com/the-metafactory/cortex/issues/3368) |
| Read mail through the Desk adapter | [cortex#3369](https://github.com/the-metafactory/cortex/issues/3369) |
| Bind reply drafts | [cortex#3371](https://github.com/the-metafactory/cortex/issues/3371) |
| Mail's full migration | [cortex#3356](https://github.com/the-metafactory/cortex/issues/3356) |

## What it replaces

helm-mail replaces the mail commands in [`cortex-desk-adapters`](https://github.com/the-metafactory/cortex-desk-adapters), one command at a time:

- `desk-mail`
- `desk-mail-move`
- `desk-mail-trash`
- `desk-mail-draft`
- `desk-mail-invite`
- `desk-mail-report`
- `desk-mail-dmarc`
- `desk-classify-mail`

Each command keeps working until its replacement has cut over. Sending mail is not specified yet, so `desk-mail-send` is not part of this plan.

## License

[MIT](LICENSE)
