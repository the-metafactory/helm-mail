// src/adapter/manifest.ts
var ADAPTER_ID = "mail";
var CAPABILITIES = {
  mailboxes: "mail.mailbox.list",
  listed: "mail.message.query",
  watch: "mail.message.watch"
};
var MAILBOX_ID = "inbox";
var PAGE_LIMIT = 20;
var FIRST_PARAGRAPH_LIMIT = 1000;
var ref = (schemaId) => ({ schemaId, version: "1.0.0" });
var urn = (schemaId) => ({ $ref: `urn:desk-schema:${schemaId}:1.0.0` });
var object = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties
});
var text = { type: "string", minLength: 1 };
var SCHEMAS = {
  empty: "mail.empty",
  error: "mail.error",
  mailbox: "mail.mailbox",
  mailboxes: "mail.mailbox.list.output",
  message: "mail.message",
  messages: "mail.message.query.output",
  watched: "mail.message.watch.output",
  queryInput: "mail.message.query.input"
};
var declaration = {
  adapterId: ADAPTER_ID,
  label: "Mail",
  contractRange: "^1.0.0",
  schemas: [
    { ...ref(SCHEMAS.empty), schema: object({}) },
    { ...ref(SCHEMAS.error), schema: object({ code: text, message: text }, ["code", "message"]) },
    { ...ref(SCHEMAS.mailbox), schema: object({ label: text }, ["label"]) },
    { ...ref(SCHEMAS.mailboxes), schema: object({ items: { type: "array", items: urn(SCHEMAS.mailbox) } }, ["items"]) },
    {
      ...ref(SCHEMAS.message),
      schema: object({
        messageId: text,
        account: text,
        from: object({ name: { type: "string" }, address: text }, ["address"]),
        subject: { type: "string" },
        receivedAt: text,
        firstParagraph: { type: "string", maxLength: FIRST_PARAGRAPH_LIMIT }
      }, ["messageId", "account", "from", "subject", "receivedAt", "firstParagraph"])
    },
    {
      ...ref(SCHEMAS.messages),
      schema: object({ items: { type: "array", items: urn(SCHEMAS.message) }, health: { type: "string", enum: ["fresh", "stale"] } }, ["items", "health"])
    },
    { ...ref(SCHEMAS.watched), schema: object({ items: { type: "array", items: urn(SCHEMAS.message) } }, ["items"]) },
    { ...ref(SCHEMAS.queryInput), schema: object({ messageId: text }) }
  ],
  objectTypes: [
    { objectType: "mailbox", label: "Mailbox", schemaRef: ref(SCHEMAS.mailbox), relationships: [] },
    { objectType: "message", label: "Message", schemaRef: ref(SCHEMAS.message), relationships: [] }
  ],
  capabilities: [
    capability(CAPABILITIES.mailboxes, "List mailboxes", "query", ["mailbox"], SCHEMAS.empty, SCHEMAS.mailboxes),
    capability(CAPABILITIES.listed, "Listed mail", "query", ["message"], SCHEMAS.queryInput, SCHEMAS.messages),
    capability(CAPABILITIES.watch, "Watch listed mail", "observation", ["message"], SCHEMAS.empty, SCHEMAS.watched)
  ]
};
function capability(capabilityId, label, kind, objectTypes, input, output) {
  return { capabilityId, label, kind, objectTypes, inputSchemaRef: ref(input), outputSchemaRef: ref(output), errorSchemaRef: ref(SCHEMAS.error) };
}
var base = { version: "1.0.0", adapterId: ADAPTER_ID };
var messageQuery = { objectsPointer: "/items", aggregatePointers: ["/health"], ordering: "provider", stableSnapshot: true, limits: { items: PAGE_LIMIT } };
var readBindings = [
  { ...base, capabilityId: CAPABILITIES.mailboxes, mode: "destinations", objectType: "mailbox", inputSchemaRef: ref(SCHEMAS.empty), outputSchemaRef: ref(SCHEMAS.mailboxes), display: { title: "/label" } },
  { ...base, capabilityId: CAPABILITIES.listed, mode: "query", objectType: "message", inputSchemaRef: ref(SCHEMAS.queryInput), outputSchemaRef: ref(SCHEMAS.messages), destinationType: "mailbox", display: { title: "/subject" }, query: messageQuery },
  { ...base, capabilityId: CAPABILITIES.watch, mode: "poll", objectType: "message", inputSchemaRef: ref(SCHEMAS.empty), outputSchemaRef: ref(SCHEMAS.watched), destinationType: "mailbox", display: { title: "/subject" }, observation: { modes: ["poll"], objectsPointer: "/items", resumable: false } }
];
var setup = {
  version: "1.0.0",
  schemas: [
    { schemaId: `${ADAPTER_ID}.setup.configuration`, version: "1.0.0", schema: object({}) },
    { schemaId: `${ADAPTER_ID}.setup.account`, version: "1.0.0", schema: object({}) }
  ],
  configurationSchemaRef: ref(`${ADAPTER_ID}.setup.configuration`),
  accountScopeSchemaRef: ref(`${ADAPTER_ID}.setup.account`),
  authMethods: [{ kind: "local" }]
};

// src/adapter/backend.ts
var SCHEMA_VERSION = "1.0.0";
var MESSAGE_SCHEMA = { schemaId: "mail.message", version: SCHEMA_VERSION };
var MAILBOX_SCHEMA = { schemaId: "mail.mailbox", version: SCHEMA_VERSION };
var object2 = (connectionId, objectType, canonicalId) => ({ adapterId: ADAPTER_ID, connectionId, objectType, canonicalId });
var mailbox = (connectionId) => object2(connectionId, "mailbox", MAILBOX_ID);
var now = () => new Date().toISOString();
function toMessage(connectionId, account, mail) {
  if (mail.ref.connection !== connectionId || !mail.account || mail.account !== account)
    return;
  const name = mail.from.name;
  return {
    messageId: mail.ref.messageId,
    account: mail.account,
    from: { ...name ? { name } : {}, address: mail.from.address },
    subject: mail.subject,
    receivedAt: mail.receivedAt,
    firstParagraph: (mail.firstParagraph ?? "").slice(0, FIRST_PARAGRAPH_LIMIT)
  };
}
function messagesOf(connectionId, listing) {
  const seen = new Set;
  const messages = [];
  for (const mail of listing.mail) {
    const message = toMessage(connectionId, listing.account, mail);
    if (!message || seen.has(message.messageId))
      continue;
    seen.add(message.messageId);
    messages.push(message);
  }
  return messages;
}
async function listedMessages(host, connectionId) {
  const listing = await host.mail.listed({ adapterId: ADAPTER_ID, connectionId });
  if (!listing)
    throw new Error("mail.not_bound");
  return { listing, messages: messagesOf(connectionId, listing) };
}
function connectionOf(request) {
  const destination = request.destinations[0];
  if (!destination || request.destinations.some((other) => other.connectionId !== destination.connectionId))
    throw new Error("mail.one_connection");
  return destination.connectionId;
}
var evidence = (connectionId, message, at) => ({
  evidenceId: `mail:${connectionId}:${message.messageId}`,
  revision: `${message.receivedAt}|${message.subject.length}|${message.firstParagraph.length}`,
  observedAt: at
});
function messagePage(host) {
  return async (request) => {
    const connectionId = connectionOf(request);
    const { listing, messages } = await listedMessages(host, connectionId);
    const wanted = request.input?.messageId;
    const matching = typeof wanted === "string" ? messages.filter((message) => message.messageId === wanted) : messages;
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
        ref: object2(connectionId, "message", message.messageId),
        schemaRef: MESSAGE_SCHEMA,
        destination,
        position: offset + index,
        evidence: evidence(connectionId, message, observedAt)
      })),
      observedAt,
      ordering: "provider",
      snapshot: { kind: "stable", id: `${health}:${matching.length}:${matching[0]?.messageId ?? ""}` },
      ...next < matching.length ? { cursor: String(next) } : {}
    };
  };
}
function listMailboxes(request) {
  const connectionId = connectionOf(request);
  const at = now();
  return {
    readVersion: "1.0.0",
    payload: { items: [{ label: "Inbox" }] },
    annotations: [{ pointer: "/items/0", ref: mailbox(connectionId), schemaRef: MAILBOX_SCHEMA, destination: mailbox(connectionId), position: 0, evidence: { evidenceId: `mailbox:${connectionId}`, revision: "1", observedAt: at } }],
    observedAt: at,
    ordering: "provider",
    snapshot: { kind: "stable", id: "mailboxes" }
  };
}
function watch(host) {
  return {
    modes: ["poll"],
    async fetch(request) {
      const connectionId = request.source.connectionId;
      const { listing, messages } = await listedMessages(host, connectionId);
      const at = now();
      if (listing.health.state === "stale") {
        return { version: "1.0.0", payload: { items: [] }, events: [], gap: false, coverage: "none" };
      }
      const page = messages.slice(0, Math.min(request.limit, PAGE_LIMIT));
      return {
        version: "1.0.0",
        payload: { items: page },
        events: page.map((message, index) => {
          const item = evidence(connectionId, message, listing.health.state === "fresh" ? listing.health.listedAt : at);
          return {
            kind: "present",
            pointer: `/items/${index}`,
            ref: object2(connectionId, "message", message.messageId),
            schemaRef: MESSAGE_SCHEMA,
            destination: mailbox(connectionId),
            observedAt: item.observedAt,
            revision: item.revision,
            evidenceId: item.evidenceId
          };
        }),
        gap: messages.length > page.length,
        coverage: "objects"
      };
    }
  };
}
function createDeskAdapter(host) {
  return {
    declaration,
    bindings: {
      handlers: {
        [CAPABILITIES.mailboxes]: listMailboxes,
        [CAPABILITIES.listed]: messagePage(host)
      },
      observations: { [CAPABILITIES.watch]: watch(host) }
    }
  };
}
export {
  createDeskAdapter
};
