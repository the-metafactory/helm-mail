// src/adapter-actions/backend.ts
import {
  MAIL_REPLY_DRAFT_CAPABILITY,
  mailReplyDraftSnapshot,
  mailAccountRef,
  mailReplySubject
} from "@the-metafactory/cortex/desk-sdk";

// src/interface.ts
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isText = (v) => typeof v === "string" && v.length > 0;
function parseDraftResult(raw) {
  if (!isObject(raw) || !isText(raw.id) || !isText(raw.account))
    return;
  if (raw.status !== "created" && raw.status !== "exists" && raw.status !== "conflict") {
    return;
  }
  return { status: raw.status, id: raw.id, account: raw.account };
}
function parseLookupResult(raw) {
  if (!isObject(raw))
    return;
  if (raw.status === "not_found")
    return { status: "not_found" };
  if (raw.status === "unavailable")
    return { status: "unavailable" };
  if (raw.status === "found" && isText(raw.id) && isText(raw.account)) {
    return { status: "found", id: raw.id, account: raw.account };
  }
  return;
}

// src/adapter/backend.ts
import { createHash } from "node:crypto";

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
function messagesOf(connectionId, listing, max = Infinity) {
  const seen = new Set;
  const messages = [];
  for (const mail of listing.mail) {
    if (messages.length >= max)
      break;
    const message = toMessage(connectionId, listing.account, mail);
    if (!message || seen.has(message.messageId))
      continue;
    seen.add(message.messageId);
    messages.push(message);
  }
  return messages;
}
async function listedMail(host, connectionId) {
  const listing = await host.mail.listed({ adapterId: ADAPTER_ID, connectionId });
  if (!listing)
    throw new Error("mail.not_bound");
  return listing;
}
function connectionOf(request) {
  const destination = request.destinations[0];
  if (!destination || request.destinations.some((other) => other.connectionId !== destination.connectionId))
    throw new Error("mail.one_connection");
  return destination.connectionId;
}
var contentDigest = (message) => createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 16);
var evidence = (connectionId, message, at) => {
  const digest = contentDigest(message);
  return { evidenceId: `mail:${connectionId}:${message.messageId}:${digest}`, revision: digest, observedAt: at };
};
function offsetOf(cursor) {
  if (cursor === undefined)
    return 0;
  if (!/^\d+$/.test(cursor))
    throw new Error("mail.bad_cursor");
  return Number(cursor);
}
var listingDigest = (health, messages) => createHash("sha256").update(JSON.stringify([health, messages])).digest("hex").slice(0, 32);
function messagePage(host) {
  return async (request) => {
    const connectionId = connectionOf(request);
    const listing = await listedMail(host, connectionId);
    const messages = messagesOf(connectionId, listing);
    const wanted = request.input?.messageId;
    const matching = typeof wanted === "string" ? messages.filter((message) => message.messageId === wanted) : messages;
    const offset = offsetOf(request.cursor);
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
      snapshot: { kind: "stable", id: listingDigest(health, matching) },
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
            ref: object2(connectionId, "message", message.messageId),
            schemaRef: MESSAGE_SCHEMA,
            destination: mailbox(connectionId),
            observedAt: item.observedAt,
            revision: item.revision,
            evidenceId: item.evidenceId
          };
        }),
        gap: more,
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

// src/adapter-actions/manifest.ts
import { mailReplyDraftDeclaration } from "@the-metafactory/cortex/desk-sdk";
var reply = mailReplyDraftDeclaration(ADAPTER_ID);
var readDeclaration = declaration;
var declaration2 = {
  ...readDeclaration,
  schemas: [...readDeclaration.schemas, ...reply.schemas],
  objectTypes: [...readDeclaration.objectTypes, ...reply.objectTypes.filter((item) => !readDeclaration.objectTypes.some((read) => read.objectType === item.objectType))],
  capabilities: [...readDeclaration.capabilities, ...reply.capabilities]
};

// src/adapter-actions/backend.ts
var CAPABILITY = MAIL_REPLY_DRAFT_CAPABILITY;
var pending = new Map;
async function serialized(key, run) {
  const previous = pending.get(key);
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  pending.set(key, current);
  try {
    await previous;
    return await run();
  } finally {
    release();
    if (pending.get(key) === current)
      pending.delete(key);
  }
}
function contextOf(request) {
  return { operationId: request.operationId, attemptId: request.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest: request.snapshot.digest, snapshot: request.snapshot };
}
function envelope(context, suffix) {
  return { lifecycleVersion: "1.0.0", operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest, reportedAt: new Date().toISOString(), resultId: `${context.attemptId}:${suffix}` };
}
function refused(context, code) {
  const base = envelope(context, "refused");
  return { ...base, result: { kind: "failed", error: { code, message: "The approved Mail scope is unavailable." }, evidence: { kind: "no-effect", evidenceId: `${context.ownerRequestId}:refused`, observedAt: base.reportedAt, ownerRequestId: context.ownerRequestId, receipt: { code }, final: true } } };
}
function uncertain(context) {
  return { ...envelope(context, "uncertain"), result: { kind: "uncertain", error: { code: "mail.unknown", message: "The draft outcome requires historical lookup." }, ownerRequestId: context.ownerRequestId } };
}
function settled(connection, context, value) {
  const base = envelope(context, value.status === "conflict" ? "conflict" : "saved");
  if (value.status === "conflict")
    return { ...base, result: { kind: "conflict", error: { code: "mail.request_conflict", message: "The request ID already names a different draft." }, currentOwnerRevision: value.id, evidence: { kind: "no-effect", evidenceId: context.ownerRequestId, observedAt: base.reportedAt, ownerRequestId: context.ownerRequestId, receipt: value, final: true } } };
  const ref = { ...connection, objectType: "draft", canonicalId: value.id };
  return { ...base, result: { kind: "succeeded", output: { ref }, evidence: { kind: "effect", evidenceId: context.ownerRequestId, observedAt: base.reportedAt, ownerRequestId: context.ownerRequestId, receipt: value, refs: [ref] } } };
}
function scopeMatches(context, account) {
  try {
    const snapshot = context.snapshot;
    const input = snapshot.input;
    return mailReplyDraftSnapshot({ ...snapshot, account: mailAccountRef(snapshot.adapterId, snapshot.connectionId, account), message: snapshot.target, body: input.body }).digest === snapshot.digest;
  } catch {
    return false;
  }
}
function connector(host, connection) {
  const identity = { kind: "action", ...connection, capabilityId: CAPABILITY };
  const bridge = host.mailExecution;
  const bound = bridge?.connection(connection);
  if (!bridge || bound?.version !== 1 || !bound.methods.includes("draft") || !bound.methods.includes("lookup"))
    return identity;
  const requestId = (ownerRequestId) => `${CAPABILITY}:${ownerRequestId}`;
  return {
    ...identity,
    writerOwner: "helm-mail.reply-draft",
    support: { lifecycleVersion: "1.0.0", ...connection, capabilityId: CAPABILITY, declarationId: "helm-mail.reply-draft.1", dedup: { kind: "none" }, operationLookup: "historical", conditionalUpdate: "none", cancellation: "none" },
    async dispatch(request) {
      const context = contextOf(request);
      const listing = await host.mail.listed(connection);
      if (!listing || listing.health.state !== "fresh" || !scopeMatches(context, listing.account))
        return refused(context, "mail.scope_denied");
      const target = request.snapshot.target;
      const mail = listing.mail.find((item) => item.ref.connection === connection.connectionId && item.ref.messageId === target?.canonicalId && item.account === listing.account);
      if (!mail || request.snapshot.adapterId !== connection.adapterId || request.snapshot.connectionId !== connection.connectionId)
        return refused(context, "mail.message_missing");
      const body = request.snapshot.input.body;
      try {
        return await serialized(`${connection.adapterId}:${connection.connectionId}:${requestId(request.ownerRequestId)}`, async () => {
          const value = parseDraftResult(await bridge.invoke(connection, "draft", { version: 1, requestId: requestId(request.ownerRequestId), account: listing.account, messageId: mail.ref.messageId, recipient: mail.from.address, subject: mailReplySubject(mail.subject), body }));
          if (!value || value.account !== listing.account)
            return uncertain(context);
          return settled(connection, context, value);
        });
      } catch {
        return uncertain(context);
      }
    },
    async lookup(request) {
      const checkedAt = new Date().toISOString();
      const base = { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt };
      try {
        const context = await bridge.lookupContext(connection, request);
        const found = parseLookupResult(await bridge.invoke(connection, "lookup", requestId(request.ownerRequestId)));
        const account = context.snapshot.destinations[0]?.canonicalId;
        if (found?.status === "found" && found.account === account)
          return { ...base, result: { kind: "known", response: settled(connection, context, { ...found, status: "exists" }) } };
        return { ...base, result: { kind: "unknown", reason: { code: "mail.lookup_unknown", message: "No matching saved draft is known." } } };
      } catch {
        return { ...base, result: { kind: "unavailable", reason: { code: "mail.lookup_unavailable", message: "Historical draft lookup is unavailable." } } };
      }
    }
  };
}
function createDeskAdapter2(host) {
  const reads = createDeskAdapter(host);
  host.registerConnector(CAPABILITY, (connection) => connector(host, connection));
  return { ...reads, declaration: declaration2 };
}
export {
  createDeskAdapter2 as createDeskAdapter
};
