// src/adapter-actions/backend.ts
import {
  MAIL_REPLY_DRAFT_CAPABILITY,
  mailReplyDraftSnapshot,
  mailAccountRef,
  mailReplySubject
} from "@the-metafactory/cortex/desk-sdk";

// src/interface.ts
var INTERFACE_VERSION = 1;
function moveSupport(conn) {
  return checkVersion(conn) ?? (typeof conn.move !== "function" || typeof conn.restore !== "function" || typeof conn.lookupMove !== "function" ? "connection does not offer move, restore and historical lookup" : undefined);
}
function parseMoveResult(raw) {
  if (!isObject(raw))
    return;
  if (raw.status === "missing" || raw.status === "denied" || raw.status === "unavailable")
    return { status: raw.status };
  if (raw.status === "conflict" && isText(raw.folder))
    return { status: "conflict", folder: raw.folder };
  if ((raw.status === "moved" || raw.status === "restored" || raw.status === "exists") && isText(raw.id) && isText(raw.account) && isText(raw.folder) && isText(raw.previousFolder)) {
    return { status: raw.status, id: raw.id, account: raw.account, folder: raw.folder, previousFolder: raw.previousFolder };
  }
  return;
}
function moveResultMismatch(request, value) {
  if ((value.status === "moved" || value.status === "restored" || value.status === "exists") && (value.account !== request.account || value.id !== request.messageId))
    return "move result belongs to another account or message";
  if (request.action === "restore" && value.status === "moved" || request.action !== "restore" && value.status === "restored")
    return "move result belongs to another action";
  return;
}
function parseMoveLookup(raw) {
  if (!isObject(raw))
    return;
  if (raw.status === "not_found" || raw.status === "unavailable")
    return { status: raw.status };
  const r = raw.request;
  const value = parseMoveResult(raw.result);
  if (raw.status !== "found" || !isObject(r) || !value || r.version !== INTERFACE_VERSION || !isText(r.requestId) || !isText(r.account) || !isText(r.messageId) || !isObject(r.context))
    return;
  if (typeof r.action !== "string" || moveResultMismatch({ action: r.action, account: r.account, messageId: r.messageId }, value))
    return;
  const c = r.context;
  if (!isText(c.operationId) || !isText(c.attemptId) || typeof c.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.snapshotDigest))
    return;
  const base = { version: r.version, requestId: r.requestId, account: r.account, messageId: r.messageId, context: { operationId: c.operationId, attemptId: c.attemptId, snapshotDigest: c.snapshotDigest } };
  if (r.action === "restore" && isText(r.from))
    return { status: "found", request: { ...base, action: "restore", from: r.from }, result: value };
  if (r.action === "move" && (r.target === "archive" || r.target === "junk") || r.action === "trash" && r.target === "trash")
    return { status: "found", request: { ...base, action: r.action, target: r.target }, result: value };
  return;
}
async function callMove(conn, request, timeoutMs = 5000) {
  const bad = moveSupport(conn);
  if (bad)
    return { kind: "unsupported", reason: bad };
  const called = await guarded(() => request.action === "restore" ? conn.restore(request) : conn.move(request), timeoutMs);
  if (!called.ok)
    return { kind: "unknown", reason: called.reason };
  const value = parseMoveResult(called.value);
  if (!value)
    return { kind: "unknown", reason: "unstructured move output" };
  const mismatch = moveResultMismatch(request, value);
  if (mismatch)
    return { kind: "unknown", reason: mismatch };
  return { kind: "result", value };
}
async function callMoveLookup(conn, requestId, timeoutMs = 5000) {
  if (moveSupport(conn))
    return;
  const called = await guarded(() => conn.lookupMove(requestId), timeoutMs);
  return called.ok ? parseMoveLookup(called.value) : undefined;
}
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
function parseDraftRequest(raw) {
  if (!isObject(raw) || raw.version !== INTERFACE_VERSION || !isText(raw.requestId) || !/^[A-Za-z0-9._:@-]{1,200}$/.test(raw.requestId))
    return;
  if (!isText(raw.account) || !isText(raw.messageId) || !isText(raw.recipient) || !isText(raw.subject) || typeof raw.body !== "string")
    return;
  return { version: INTERFACE_VERSION, requestId: raw.requestId, account: raw.account, messageId: raw.messageId, recipient: raw.recipient, subject: raw.subject, body: raw.body };
}
function parseLookupResult(raw) {
  if (!isObject(raw))
    return;
  if (raw.status === "not_found")
    return { status: "not_found" };
  if (raw.status === "unavailable")
    return { status: "unavailable" };
  if (raw.status === "found" && isText(raw.id) && isText(raw.account)) {
    const request = raw.request === undefined ? undefined : parseDraftRequest(raw.request);
    if (raw.request !== undefined && !request)
      return;
    return { status: "found", id: raw.id, account: raw.account, ...request ? { request } : {} };
  }
  return;
}
function checkVersion(conn) {
  if (conn.version === undefined)
    return "connection declares no version";
  if (conn.version !== INTERFACE_VERSION) {
    return `connection version ${String(conn.version)} is not ${INTERFACE_VERSION}`;
  }
  return;
}
async function guarded(call, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
  });
  const run = (async () => {
    try {
      return { ok: true, value: await call() };
    } catch (e) {
      return { ok: false, reason: `failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
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

// src/adapter/judgements.ts
import { judgementCapability, mailJudgementDeclaration } from "@the-metafactory/cortex/desk-sdk";
var JUDGEMENT_ACTIONS = ["unimportant", "block-domain", "correct", "not-phishing", "snooze", "snooze-cancel", "waiting", "undo"];
var JUDGEMENT_CAPABILITIES = JUDGEMENT_ACTIONS.map(judgementCapability);
var JUDGEMENT_UNDO_CAPABILITY = judgementCapability("undo");
var JUDGEMENT_UNDO = {
  unimportant: "yes",
  "block-domain": "yes",
  correct: "by-correction",
  "not-phishing": "yes",
  snooze: "yes",
  "snooze-cancel": "yes",
  waiting: "yes",
  undo: "no"
};
function withMailJudgements(base) {
  if (base.adapterId !== "mail")
    throw new Error("Mail judgement bindings require the mail adapter.");
  const judgements = mailJudgementDeclaration(base.adapterId);
  const known = new Set(base.capabilities.map((item) => item.capabilityId));
  return {
    ...base,
    schemas: [...base.schemas, ...judgements.schemas.filter((item) => !base.schemas.some((old) => old.schemaId === item.schemaId && old.version === item.version))],
    objectTypes: [...base.objectTypes, ...judgements.objectTypes.filter((item) => !base.objectTypes.some((old) => old.objectType === item.objectType))],
    capabilities: [...base.capabilities, ...judgements.capabilities.filter((item) => JUDGEMENT_CAPABILITIES.includes(item.capabilityId) && !known.has(item.capabilityId))]
  };
}
function registerMailJudgements(host) {
  for (const action of JUDGEMENT_ACTIONS) {
    const capabilityId = judgementCapability(action);
    host.registerConnector(capabilityId, (connection) => {
      const identity = { kind: "action", ...connection, capabilityId };
      const bridge = host.mailJudgements;
      if (!bridge)
        return identity;
      return {
        ...identity,
        writerOwner: "mail-judgement",
        support: { lifecycleVersion: "1.0.0", ...connection, capabilityId, declarationId: "mail-judgement-owner", dedup: { kind: "guaranteed", scope: "connection-capability", retentionMs: 604800000, bindsSnapshot: true, concurrent: true }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none", ...JUDGEMENT_UNDO[action] === "no" ? {} : { compensationCapabilityId: JUDGEMENT_UNDO_CAPABILITY } },
        dispatch: (request) => bridge.changeJudgement(request)
      };
    });
  }
}

// src/adapter/moves.ts
import { mailMoveDeclaration } from "@the-metafactory/cortex/desk-sdk";
var MOVE_CAPABILITIES = ["mail.move", "mail.trash", "mail.restore"];
function withMailMoves(base) {
  if (base.adapterId !== "mail")
    throw new Error("Mail move bindings require the mail adapter.");
  const moves = mailMoveDeclaration(base.adapterId);
  return {
    ...base,
    schemas: [...base.schemas, ...moves.schemas.filter((item) => !base.schemas.some((old) => old.schemaId === item.schemaId && old.version === item.version))],
    objectTypes: [...base.objectTypes, ...moves.objectTypes.filter((item) => !base.objectTypes.some((old) => old.objectType === item.objectType))],
    capabilities: [...base.capabilities, ...moves.capabilities]
  };
}
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var sameRef = (left, right) => left.adapterId === right.adapterId && left.connectionId === right.connectionId && left.objectType === right.objectType && left.canonicalId === right.canonicalId;
var key = (capabilityId, ownerRequestId) => `${capabilityId}:${ownerRequestId}`;
var now2 = () => new Date().toISOString();
function messageOf(snapshot, connection) {
  const input = snapshot.input;
  if (!isRecord(input) || !isRecord(input.message))
    return;
  const m = input.message;
  if (m.adapterId !== connection.adapterId || m.connectionId !== connection.connectionId || m.objectType !== "message" || typeof m.canonicalId !== "string" || !m.canonicalId)
    return;
  const message = { ...connection, objectType: "message", canonicalId: m.canonicalId };
  return snapshot.target === undefined || !sameRef(snapshot.target, message) ? undefined : message;
}
function inScope(snapshot, connection, account) {
  return snapshot.adapterId === connection.adapterId && snapshot.connectionId === connection.connectionId && snapshot.destinations.length === 1 && sameRef(snapshot.destinations[0], { ...connection, objectType: "account", canonicalId: account });
}
function historyMatches(old, snapshot, context, ownerRequestId, account, connection, capabilityId) {
  const message = messageOf(snapshot, connection);
  const input = snapshot.input;
  return !!message && old.requestId === key(capabilityId, ownerRequestId) && `mail.${old.action}` === capabilityId && old.context.operationId === context.operationId && old.context.attemptId === context.attemptId && old.context.snapshotDigest === context.snapshotDigest && old.account === account && old.messageId === message.canonicalId && inScope(snapshot, connection, account) && (old.action === "restore" ? old.from === input.from : old.target === (capabilityId === "mail.trash" ? "trash" : input.target));
}
function uncertain(context, ownerRequestId) {
  return { lifecycleVersion: "1.0.0", ...context, resultId: `${context.attemptId}:uncertain`, reportedAt: now2(), result: { kind: "uncertain", error: { code: "mail.provider_uncertain", message: "The move outcome is unknown until matching historical evidence settles it." }, ownerRequestId } };
}
function resultFor(context, ownerRequestId, message, value) {
  const at = now2();
  const base = { lifecycleVersion: "1.0.0", ...context, resultId: `${context.attemptId}:${value.status}:${at}`, reportedAt: at };
  if (value.status === "moved" || value.status === "restored" || value.status === "exists") {
    return { ...base, result: { kind: "succeeded", output: { ref: message, folder: value.folder }, evidence: { kind: "effect", evidenceId: `mail-move:${context.operationId}`, observedAt: at, ownerRequestId, receipt: { id: value.id, account: value.account, folder: value.folder, previousFolder: value.previousFolder }, refs: [message], ownerRevision: value.folder } } };
  }
  const evidence = { kind: "no-effect", evidenceId: `mail-move:${context.operationId}:${value.status}`, observedAt: at, ownerRequestId, receipt: { status: value.status }, final: true };
  if (value.status === "conflict")
    return { ...base, result: { kind: "conflict", error: { code: "mail.location_conflict", message: "The message changed location after the move." }, currentOwnerRevision: value.folder, evidence } };
  const code = value.status === "missing" ? "mail.message_missing" : value.status === "denied" ? "mail.account_denied" : "mail.unavailable";
  return { ...base, result: { kind: "failed", error: { code, message: value.status === "missing" ? "The message no longer exists." : value.status === "denied" ? "The account is unavailable to this connection." : "This connection cannot perform the move." }, evidence } };
}
function registerMailMoves(host, options = {}) {
  for (const capabilityId of MOVE_CAPABILITIES)
    host.registerConnector(capabilityId, (connection) => {
      const bridge = host.mailExecution;
      const bound = bridge?.connection(connection);
      const provider = bridge && bound?.version === 1 && ["move", "restore", "lookupMove"].every((method) => bound.methods.includes(method)) ? {
        version: 1,
        move: (request) => bridge.invoke(connection, "move", request),
        restore: (request) => bridge.invoke(connection, "restore", request),
        lookupMove: (requestId) => bridge.invoke(connection, "lookupMove", requestId)
      } : undefined;
      const identity = { kind: "action", ...connection, capabilityId };
      if (!provider || moveSupport(provider))
        return identity;
      return {
        ...identity,
        writerOwner: "mail-move",
        support: { lifecycleVersion: "1.0.0", ...connection, capabilityId, declarationId: "mail-move-interface-1", dedup: { kind: "none" }, operationLookup: "historical", conditionalUpdate: capabilityId === "mail.restore" ? "owner-enforced" : "none", cancellation: "none", ...capabilityId === "mail.restore" ? {} : { compensationCapabilityId: "mail.restore" } },
        async dispatch(request) {
          const context = { operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest };
          const message = messageOf(request.snapshot, connection);
          if (!message)
            return resultFor(context, request.ownerRequestId, { ...connection, objectType: "message", canonicalId: "unavailable" }, { status: "denied" });
          const listing = await host.mail.listed(connection);
          if (!listing || listing.health.state !== "fresh" || !inScope(request.snapshot, connection, listing.account))
            return resultFor(context, request.ownerRequestId, message, { status: "denied" });
          const requestId = key(capabilityId, request.ownerRequestId);
          const previous = await callMoveLookup(provider, requestId, options.timeoutMs);
          if (!previous || previous.status === "unavailable")
            return uncertain(context, request.ownerRequestId);
          if (previous.status === "found") {
            const old = previous.request;
            if (!historyMatches(old, request.snapshot, context, request.ownerRequestId, listing.account, connection, capabilityId))
              return uncertain(context, request.ownerRequestId);
            return resultFor(context, request.ownerRequestId, message, previous.result);
          }
          if (capabilityId !== "mail.restore" && !listing.mail.some((mail) => mail.account === listing.account && mail.ref.connection === connection.connectionId && mail.ref.messageId === message.canonicalId))
            return resultFor(context, request.ownerRequestId, message, { status: "missing" });
          const input = request.snapshot.input;
          const base = { version: INTERFACE_VERSION, requestId, account: listing.account, messageId: message.canonicalId, context };
          let move;
          if (capabilityId === "mail.restore") {
            if (typeof input.from !== "string" || !input.from.trim())
              return resultFor(context, request.ownerRequestId, message, { status: "unavailable" });
            move = { ...base, action: "restore", from: input.from };
          } else {
            if (capabilityId === "mail.move" && input.target !== "archive" && input.target !== "junk")
              return resultFor(context, request.ownerRequestId, message, { status: "unavailable" });
            move = { ...base, action: capabilityId === "mail.trash" ? "trash" : "move", target: capabilityId === "mail.trash" ? "trash" : input.target };
          }
          const outcome = await callMove(provider, move, options.timeoutMs);
          if (outcome.kind === "result")
            return resultFor(context, request.ownerRequestId, message, outcome.value);
          if (outcome.kind === "unsupported")
            return resultFor(context, request.ownerRequestId, message, { status: "unavailable" });
          return uncertain(context, request.ownerRequestId);
        },
        async lookup(request) {
          const checkedAt = now2();
          const base = { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt };
          let context;
          try {
            context = await bridge.lookupContext(connection, request);
          } catch {
            return { ...base, result: { kind: "unknown", reason: { code: "mail.lookup_unavailable", message: "Original approved context is unavailable." } } };
          }
          const listing = await host.mail.listed(connection);
          if (!listing)
            return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The connection is unavailable." } } };
          const found = await callMoveLookup(provider, key(capabilityId, request.ownerRequestId), options.timeoutMs);
          if (!found || found.status !== "found")
            return { ...base, result: { kind: "unknown", reason: { code: "mail.lookup_unavailable", message: "The provider has no definitive move outcome." } } };
          const old = found.request;
          if (!historyMatches(old, context.snapshot, context, request.ownerRequestId, listing.account, connection, capabilityId))
            return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The result belongs to another connection scope." } } };
          return { ...base, result: { kind: "known", response: resultFor(old.context, request.ownerRequestId, { ...connection, objectType: "message", canonicalId: old.messageId }, found.result) } };
        }
      };
    });
}

// src/adapter-actions/manifest.ts
import { mailReplyDraftDeclaration } from "@the-metafactory/cortex/desk-sdk";
var reply = mailReplyDraftDeclaration(ADAPTER_ID);
var readDeclaration = declaration;
var declaration2 = withMailJudgements(withMailMoves({
  ...readDeclaration,
  schemas: [...readDeclaration.schemas, ...reply.schemas],
  objectTypes: [...readDeclaration.objectTypes, ...reply.objectTypes.filter((item) => !readDeclaration.objectTypes.some((read) => read.objectType === item.objectType))],
  capabilities: [...readDeclaration.capabilities, ...reply.capabilities]
}));

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
function uncertain2(context) {
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
            return uncertain2(context);
          return settled(connection, context, value);
        });
      } catch {
        return uncertain2(context);
      }
    },
    async lookup(request) {
      const checkedAt = new Date().toISOString();
      const base = { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt };
      try {
        const context = await bridge.lookupContext(connection, request);
        const found = parseLookupResult(await bridge.invoke(connection, "lookup", requestId(request.ownerRequestId)));
        const account = context.snapshot.destinations[0]?.canonicalId;
        const listing = await host.mail.listed(connection);
        const saved = found?.status === "found" ? found.request : undefined;
        const mail = listing?.mail.find((item) => item.ref.connection === connection.connectionId && item.ref.messageId === context.snapshot.target?.canonicalId && item.account === account);
        const body = context.snapshot.input.body;
        if (found?.status === "found" && found.account === account && saved && mail && listing?.account === account && listing.health.state === "fresh" && scopeMatches(context, listing.account) && saved.requestId === requestId(request.ownerRequestId) && saved.account === account && saved.messageId === context.snapshot.target?.canonicalId && saved.body === body && saved.recipient === mail.from.address && saved.subject === mailReplySubject(mail.subject)) {
          return { ...base, result: { kind: "known", response: settled(connection, context, { status: "exists", id: found.id, account: found.account }) } };
        }
        return { ...base, result: { kind: "unknown", reason: { code: "mail.lookup_unknown", message: "No matching saved draft is known." } } };
      } catch {
        return { ...base, result: { kind: "unavailable", reason: { code: "mail.lookup_unavailable", message: "Historical draft lookup is unavailable." } } };
      }
    }
  };
}
function createDeskAdapter2(host) {
  const reads = createDeskAdapter(host);
  registerMailMoves(host);
  registerMailJudgements(host);
  host.registerConnector(CAPABILITY, (connection) => connector(host, connection));
  return { ...reads, declaration: declaration2 };
}
export {
  createDeskAdapter2 as createDeskAdapter
};
