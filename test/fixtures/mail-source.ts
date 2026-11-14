import type { DeskAdapterConnection, DeskAdapterHost, DeskListedMail, DeskMailListing } from "@the-metafactory/cortex/desk-sdk";
import { CONFORMANCE_CONNECTION_ID, type MailConnectionBinding, type MailReadSource, type MailSourceItem } from "@the-metafactory/cortex/desk-adapter-conformance";

export const SOURCE = "source-example";
export const ACCOUNT_ONE = "account-one";
export const ACCOUNT_TWO = "account-two";
export const SHARED_ID = "<shared@example.test>";
export const BODY_CANARY = "BODY-CANARY-full-body-text";
export const LISTED_AT = "2026-11-14T08:00:00.000Z";

export const item = (id: string, account: string | undefined, subject: string, firstParagraph?: string): MailSourceItem => ({
  id,
  ...(account === undefined ? {} : { account }),
  from: { name: "Sender Example", address: "sender@example.test" },
  subject,
  receivedAt: "2026-11-14T07:00:00.000Z",
  unread: true,
  ...(firstParagraph === undefined ? {} : { firstParagraph }),
});

export const SOURCE_MAIL: MailSourceItem[] = [
  item("<one@example.test>", ACCOUNT_ONE, "Subject for account one", "Opening line."),
  item(SHARED_ID, ACCOUNT_ONE, "Shared subject, account one", "Shared opening."),
  item(SHARED_ID, ACCOUNT_TWO, "Shared subject, account two", "Shared opening."),
  item("<orphan@example.test>", undefined, "Subject with no account"),
];

export const binding = (extra: Partial<MailConnectionBinding> = {}): MailConnectionBinding => ({
  adapterId: "mail",
  connectionId: CONFORMANCE_CONNECTION_ID,
  sourceId: SOURCE,
  account: ACCOUNT_ONE,
  ...extra,
});

export const fakeMailSource = (bindings: MailConnectionBinding[], error: string | null = null, mail: MailSourceItem[] = SOURCE_MAIL): MailReadSource => ({
  connections: () => bindings,
  listings: () => [{ id: SOURCE, readAt: Date.parse(LISTED_AT), error, mail }],
});

export interface FakeBridge {
  host: DeskAdapterHost;
  listings: Map<string, DeskMailListing | null>;
}

const listedMail = (connectionId: string, account: string, items: readonly MailSourceItem[]): DeskListedMail[] =>
  items
    .filter(mail => mail.account === account)
    .map(mail => ({ ref: { connection: connectionId, messageId: mail.id }, account, from: mail.from, subject: mail.subject, receivedAt: mail.receivedAt, unread: mail.unread, ...(mail.firstParagraph === undefined ? {} : { firstParagraph: mail.firstParagraph }) }));

export function fakeBridge(connections: Record<string, string>, options: { stale?: boolean; mail?: readonly MailSourceItem[] } = {}): FakeBridge {
  const listings = new Map<string, DeskMailListing | null>();
  for (const [connectionId, account] of Object.entries(connections)) {
    listings.set(connectionId, {
      connection: { adapterId: "mail", connectionId },
      account,
      health: options.stale ? { state: "stale", code: "provider_failure" } : { state: "fresh", listedAt: LISTED_AT },
      mail: listedMail(connectionId, account, options.mail ?? SOURCE_MAIL),
    });
  }
  const host: DeskAdapterHost = {
    sdkVersion: "1.6.0",
    registerConnector: () => undefined,
    mail: { listed: (connection: DeskAdapterConnection) => Promise.resolve(listings.get(connection.connectionId) ?? null) },
  };
  return { host, listings };
}
