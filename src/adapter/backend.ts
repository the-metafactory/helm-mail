import { createHash } from "node:crypto";
import type {
  DeskAdapterDefinition,
  DeskAdapterHost,
  DeskListedMail,
  DeskMailListing,
  ObservationRequest,
  QueryFetchRequest,
} from "@the-metafactory/cortex/desk-sdk";
import { ADAPTER_ID, CAPABILITIES, FIRST_PARAGRAPH_LIMIT, MAILBOX_ID, PAGE_LIMIT, declaration } from "./manifest";

const SCHEMA_VERSION = "1.0.0";
const MESSAGE_SCHEMA = { schemaId: "mail.message", version: SCHEMA_VERSION };
const MAILBOX_SCHEMA = { schemaId: "mail.mailbox", version: SCHEMA_VERSION };

interface Message {
  messageId: string;
  account: string;
  from: { name?: string; address: string };
  subject: string;
  receivedAt: string;
  firstParagraph: string;
}

const object = (connectionId: string, objectType: string, canonicalId: string) => ({ adapterId: ADAPTER_ID, connectionId, objectType, canonicalId });
const mailbox = (connectionId: string) => object(connectionId, "mailbox", MAILBOX_ID);
const now = () => new Date().toISOString();

function toMessage(connectionId: string, account: string, mail: DeskListedMail): Message | undefined {
  if (mail.ref.connection !== connectionId || !mail.account || mail.account !== account) return undefined;
  const name = mail.from.name;
  return {
    messageId: mail.ref.messageId,
    account: mail.account,
    from: { ...(name ? { name } : {}), address: mail.from.address },
    subject: mail.subject,
    receivedAt: mail.receivedAt,
    firstParagraph: (mail.firstParagraph ?? "").slice(0, FIRST_PARAGRAPH_LIMIT),
  };
}

function messagesOf(connectionId: string, listing: DeskMailListing, max = Infinity): Message[] {
  const seen = new Set<string>();
  const messages: Message[] = [];
  for (const mail of listing.mail) {
    if (messages.length >= max) break;
    const message = toMessage(connectionId, listing.account, mail);
    if (!message || seen.has(message.messageId)) continue;
    seen.add(message.messageId);
    messages.push(message);
  }
  return messages;
}

async function listedMail(host: DeskAdapterHost, connectionId: string): Promise<DeskMailListing> {
  const listing = await host.mail.listed({ adapterId: ADAPTER_ID, connectionId });
  if (!listing) throw new Error("mail.not_bound");
  return listing;
}

function connectionOf(request: QueryFetchRequest): string {
  const destination = request.destinations[0];
  if (!destination || request.destinations.some(other => other.connectionId !== destination.connectionId)) throw new Error("mail.one_connection");
  return destination.connectionId;
}

const evidence = (connectionId: string, message: Message, at: string) => ({
  evidenceId: `mail:${connectionId}:${message.messageId}:${createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 16)}`,
  revision: `${message.receivedAt}|${message.subject.length}|${message.firstParagraph.length}`,
  observedAt: at,
});

function messagePage(host: DeskAdapterHost) {
  return async (request: QueryFetchRequest) => {
    const connectionId = connectionOf(request);
    const listing = await listedMail(host, connectionId);
    const messages = messagesOf(connectionId, listing);
    const wanted = (request.input as { messageId?: unknown } | null)?.messageId;
    const matching = typeof wanted === "string" ? messages.filter(message => message.messageId === wanted) : messages;
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    const page = matching.slice(offset, offset + Math.min(request.limit, PAGE_LIMIT));
    const next = offset + page.length;
    const health = listing.health.state;
    const observedAt = listing.health.state === "fresh" ? listing.health.listedAt : now();
    const destination = request.destinations[0];
    return {
      readVersion: "1.0.0",
      payload: { items: page, health },
      annotations: page.map((message, index) => ({
        pointer: `/items/${index}`,
        ref: object(connectionId, "message", message.messageId),
        schemaRef: MESSAGE_SCHEMA,
        destination,
        position: offset + index,
        evidence: evidence(connectionId, message, observedAt),
      })),
      observedAt,
      ordering: "provider",
      snapshot: { kind: "live" as const },
      ...(next < matching.length ? { cursor: String(next) } : {}),
    };
  };
}

function listMailboxes(request: QueryFetchRequest) {
  const connectionId = connectionOf(request);
  const at = now();
  return {
    readVersion: "1.0.0",
    payload: { items: [{ label: "Inbox" }] },
    annotations: [{ pointer: "/items/0", ref: mailbox(connectionId), schemaRef: MAILBOX_SCHEMA, destination: mailbox(connectionId), position: 0, evidence: { evidenceId: `mailbox:${connectionId}`, revision: "1", observedAt: at } }],
    observedAt: at,
    ordering: "provider",
    snapshot: { kind: "stable", id: "mailboxes" },
  };
}

function watch(host: DeskAdapterHost) {
  return {
    modes: ["poll"] as const,
    async fetch(request: ObservationRequest) {
      const connectionId = request.source.connectionId;
      const listing = await listedMail(host, connectionId);
      const at = now();
      if (listing.health.state === "stale") {
        return { version: "1.0.0", payload: { items: [] }, events: [], gap: false, coverage: "none" };
      }
      const size = Math.min(request.limit, PAGE_LIMIT);
      const page = messagesOf(connectionId, listing, size + 1);
      const more = page.length > size;
      page.length = Math.min(page.length, size);
      return {
        version: "1.0.0",
        payload: { items: page },
        events: page.map((message, index) => {
          const item = evidence(connectionId, message, listing.health.state === "fresh" ? listing.health.listedAt : at);
          return {
            kind: "present",
            pointer: `/items/${index}`,
            ref: object(connectionId, "message", message.messageId),
            schemaRef: MESSAGE_SCHEMA,
            destination: mailbox(connectionId),
            observedAt: item.observedAt,
            revision: item.revision,
            evidenceId: item.evidenceId,
          };
        }),
        gap: more,
        coverage: "objects",
      };
    },
  };
}

export function createDeskAdapter(host: DeskAdapterHost): DeskAdapterDefinition {
  return {
    declaration: declaration as unknown as DeskAdapterDefinition["declaration"],
    bindings: {
      handlers: {
        [CAPABILITIES.mailboxes]: listMailboxes,
        [CAPABILITIES.listed]: messagePage(host),
      },
      observations: { [CAPABILITIES.watch]: watch(host) },
    },
  };
}
