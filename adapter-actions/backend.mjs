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
function parseUnsubscribeResult(raw) {
  if (!isObject(raw))
    return;
  if (raw.status === "missing" || raw.status === "denied" || raw.status === "unavailable" || raw.status === "conflict")
    return { status: raw.status };
  if ((raw.status === "unsubscribed" || raw.status === "exists") && isText(raw.id) && isText(raw.account) && isText(raw.host) && raw.host.length <= 200)
    return { status: raw.status, id: raw.id, account: raw.account, host: raw.host };
  return;
}
function parseUnsubscribeLookup(raw) {
  if (!isObject(raw))
    return;
  if (raw.status === "not_found" || raw.status === "unavailable")
    return { status: raw.status };
  const r = raw.request;
  const result = parseUnsubscribeResult(raw.result);
  if (raw.status !== "found" || raw.action !== "unsubscribe" || !isObject(r) || !result || r.version !== 1 || !isText(r.requestId) || !isText(r.account) || !isText(r.messageId) || !isObject(r.context))
    return;
  const c = r.context;
  if (!isText(c.operationId) || !isText(c.attemptId) || typeof c.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.snapshotDigest))
    return;
  if ((result.status === "unsubscribed" || result.status === "exists") && (result.id !== r.messageId || result.account !== r.account))
    return;
  return { status: "found", action: "unsubscribe", request: { version: 1, requestId: r.requestId, account: r.account, messageId: r.messageId, context: { operationId: c.operationId, attemptId: c.attemptId, snapshotDigest: c.snapshotDigest } }, result };
}
var REPORT_KINDS = ["draft", "spam", "phishing"];
var isProviderReport = (kind) => kind !== "draft";
var isReportKind = (v) => REPORT_KINDS.includes(v);
function parseReportMessage(raw) {
  if (!isObject(raw) || !isText(raw.adapterId) || !isText(raw.connectionId) || raw.objectType !== "message" || !isText(raw.canonicalId))
    return;
  return { adapterId: raw.adapterId, connectionId: raw.connectionId, objectType: "message", canonicalId: raw.canonicalId };
}
function parseReportRequest(raw) {
  if (!isObject(raw) || raw.version !== INTERFACE_VERSION || !isText(raw.requestId) || !isReportKind(raw.kind))
    return;
  const message = parseReportMessage(raw.message);
  return message ? { version: INTERFACE_VERSION, requestId: raw.requestId, kind: raw.kind, message } : undefined;
}
function parseReportResult(raw) {
  if (!isObject(raw) || !isText(raw.folder) || raw.folder.length > 200)
    return;
  const ref = parseReportMessage(raw.ref);
  return ref ? { ref, folder: raw.folder } : undefined;
}
function parseReportLookup(raw) {
  if (!isObject(raw))
    return;
  if (raw.status === "not_found" || raw.status === "unavailable")
    return { status: raw.status };
  const request = parseReportRequest(raw.request);
  const result = parseReportResult(raw.result);
  if (raw.status !== "found" || !request || !result)
    return;
  if (result.ref.canonicalId !== request.message.canonicalId)
    return;
  return { status: "found", request, result };
}
function reportSupport(conn, kind) {
  const bad = checkVersion(conn);
  if (bad)
    return bad;
  if (!Array.isArray(conn.reportKinds) || !conn.reportKinds.includes(kind))
    return `connection does not declare the ${kind} report`;
  if (typeof conn.report !== "function" || typeof conn.lookupReport !== "function")
    return "connection does not offer report and historical lookup";
  if (isProviderReport(kind) && typeof conn.restore !== "function")
    return "connection cannot restore a provider report";
  return;
}
async function callReport(conn, request, timeoutMs = 5000) {
  const bad = reportSupport(conn, request.kind);
  if (bad)
    return { kind: "unsupported", reason: bad };
  const called = await guarded(() => conn.report(request), timeoutMs);
  if (!called.ok)
    return { kind: "unknown", reason: called.reason };
  const value = parseReportResult(called.value);
  if (!value)
    return { kind: "unknown", reason: "unstructured report output" };
  if (value.ref.canonicalId !== request.message.canonicalId)
    return { kind: "unknown", reason: "report result belongs to another message" };
  return { kind: "result", value };
}
async function callReportLookup(conn, kind, requestId, timeoutMs = 5000) {
  if (reportSupport(conn, kind))
    return;
  const called = await guarded(() => conn.lookupReport(requestId), timeoutMs);
  return called.ok ? parseReportLookup(called.value) : undefined;
}
var INVITATION_REPLY_KINDS = ["accept", "decline", "tentative"];

class InvitationRefusal extends Error {
  reason;
  currentRevision;
  name = "InvitationRefusal";
  constructor(reason, currentRevision) {
    super(`The invitation call was refused: ${reason}.`);
    this.reason = reason;
    this.currentRevision = currentRevision;
  }
}
var isInvitationObject = (type) => (raw) => isObject(raw) && isText(raw.adapterId) && isText(raw.connectionId) && raw.objectType === type && isText(raw.canonicalId) ? { adapterId: raw.adapterId, connectionId: raw.connectionId, objectType: type, canonicalId: raw.canonicalId } : undefined;
var parseInvitationMessage = isInvitationObject("message");
var parseInvitationRef = isInvitationObject("invitation");
function parseInvitationRequest(raw) {
  if (!isObject(raw) || raw.version !== INTERFACE_VERSION || !isText(raw.requestId) || !isText(raw.expectedRevision))
    return;
  const message = parseInvitationMessage(raw.message);
  const invitation = parseInvitationRef(raw.invitation);
  if (!message || !invitation)
    return;
  if (raw.reply !== undefined && !INVITATION_REPLY_KINDS.includes(raw.reply))
    return;
  return { version: INTERFACE_VERSION, requestId: raw.requestId, message, invitation, expectedRevision: raw.expectedRevision, ...raw.reply !== undefined ? { reply: raw.reply } : {} };
}
function parseInvitationResult(raw) {
  if (!isObject(raw) || !isText(raw.revision) || raw.revision.length > 500)
    return;
  const ref = parseInvitationRef(raw.ref);
  return ref ? { ref, revision: raw.revision } : undefined;
}
function parseInvitationLookup(raw) {
  if (!isObject(raw))
    return;
  if (raw.status === "not_found" || raw.status === "unavailable")
    return { status: raw.status };
  const request = parseInvitationRequest(raw.request);
  const result = parseInvitationResult(raw.result);
  if (raw.status !== "found" || !request || !result || result.ref.canonicalId !== request.invitation.canonicalId)
    return;
  return { status: "found", request, result };
}
function invitationSupport(conn, verb) {
  const bad = checkVersion(conn);
  if (bad)
    return bad;
  if (typeof conn[verb] !== "function" || typeof conn.lookupInvitation !== "function")
    return `connection does not offer ${verb} and historical lookup`;
  return;
}
async function callInvitation(conn, verb, request, timeoutMs = 5000) {
  const bad = invitationSupport(conn, verb);
  if (bad)
    return { kind: "unsupported", reason: bad };
  const called = await guarded(async () => {
    try {
      return await conn[verb](request);
    } catch (error) {
      return error instanceof InvitationRefusal || isObject(error) && error.name === "InvitationRefusal" ? { refusal: { reason: error.reason, currentRevision: error.currentRevision } } : Promise.reject(error);
    }
  }, timeoutMs);
  if (!called.ok)
    return { kind: "unknown", reason: called.reason };
  const raw = called.value;
  if (isObject(raw) && isObject(raw.refusal)) {
    const { reason, currentRevision } = raw.refusal;
    if (reason !== "changed" && reason !== "missing" && reason !== "denied")
      return { kind: "unknown", reason: "unstructured refusal" };
    return { kind: "refused", reason, ...isText(currentRevision) ? { currentRevision } : {} };
  }
  const value = parseInvitationResult(raw);
  if (!value)
    return { kind: "unknown", reason: "unstructured invitation output" };
  if (value.ref.canonicalId !== request.invitation.canonicalId)
    return { kind: "unknown", reason: "invitation result belongs to another invitation" };
  return { kind: "result", value };
}
async function callInvitationLookup(conn, verb, requestId, timeoutMs = 5000) {
  if (invitationSupport(conn, verb))
    return;
  const called = await guarded(() => conn.lookupInvitation(requestId), timeoutMs);
  return called.ok ? parseInvitationLookup(called.value) : undefined;
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

// src/adapter/compose-declaration.ts
function composeDeclaration(base, extra) {
  if (base.adapterId !== extra.adapterId)
    throw new Error("Declarations must name the same adapter.");
  return {
    ...base,
    schemas: [...base.schemas, ...extra.schemas.filter((item) => !base.schemas.some((old) => old.schemaId === item.schemaId && old.version === item.version))],
    objectTypes: [...base.objectTypes, ...extra.objectTypes.filter((item) => !base.objectTypes.some((old) => old.objectType === item.objectType))],
    capabilities: [...base.capabilities, ...extra.capabilities]
  };
}

// src/adapter/unsubscribe.ts
import { mailUnsubscribeDeclaration, mailUnsubscribeSnapshot } from "@the-metafactory/cortex/desk-sdk";
function withMailUnsubscribe(base) {
  return composeDeclaration(base, mailUnsubscribeDeclaration(base.adapterId));
}
var key = (id) => `mail.unsubscribe:${id}`;
var now2 = () => new Date().toISOString();
function scoped(context, account) {
  try {
    const s = context.snapshot;
    return mailUnsubscribeSnapshot({ ...s, account, input: s.input }).digest === s.digest;
  } catch {
    return false;
  }
}
function envelope(c) {
  return { lifecycleVersion: "1.0.0", operationId: c.operationId, attemptId: c.attemptId, snapshotDigest: c.snapshotDigest, resultId: `${c.attemptId}:${now2()}`, reportedAt: now2() };
}
function uncertain(c) {
  return { ...envelope(c), result: { kind: "uncertain", ownerRequestId: c.ownerRequestId, error: { code: "mail.unsubscribe_unknown", message: "The provider outcome requires matching historical evidence." } } };
}
function settled(c, value) {
  const base = envelope(c);
  const evidence = { evidenceId: key(c.ownerRequestId), observedAt: base.reportedAt, ownerRequestId: c.ownerRequestId };
  if (value.status === "unsubscribed" || value.status === "exists")
    return { ...base, result: { kind: "succeeded", output: { ref: c.snapshot.target, host: value.host }, evidence: { ...evidence, kind: "effect", refs: [c.snapshot.target], receipt: { id: value.id, account: value.account, host: value.host } } } };
  if (value.status === "conflict")
    return uncertain(c);
  return { ...base, result: { kind: "failed", error: { code: `mail.unsubscribe_${value.status}`, message: "The message cannot be unsubscribed through this connection." }, evidence: { ...evidence, kind: "no-effect", receipt: { status: value.status }, final: true } } };
}
function validResult(value, c, account, host) {
  return value.status !== "unsubscribed" && value.status !== "exists" || value.account === account && value.id === c.snapshot.target?.canonicalId && value.host === host;
}
function matches(found, c, account, host) {
  const r = found.request;
  return scoped(c, account) && r.requestId === key(c.ownerRequestId) && r.account === account && r.messageId === c.snapshot.target?.canonicalId && r.context.operationId === c.operationId && r.context.attemptId === c.attemptId && r.context.snapshotDigest === c.snapshotDigest && (found.result.status !== "unsubscribed" && found.result.status !== "exists" || found.result.account === account && found.result.id === c.snapshot.target?.canonicalId && (host === undefined || found.result.host === host));
}
function registerMailUnsubscribe(host) {
  host.registerConnector("mail.unsubscribe", (connection) => {
    const identity = { kind: "action", ...connection, capabilityId: "mail.unsubscribe" };
    const bridge = host.mailExecution;
    const bound = bridge?.connection(connection);
    if (!bridge || bound?.version !== 1 || !bound.methods.includes("unsubscribe") || !bound.methods.includes("lookupUnsubscribe"))
      return identity;
    const listingFor = async (c) => {
      const listing = await host.mail.listed(connection);
      const message = listing?.mail.find((m) => m.account === listing.account && m.ref.connection === connection.connectionId && m.ref.messageId === c.snapshot.target?.canonicalId);
      return { listing, message };
    };
    const history = async (c) => parseUnsubscribeLookup(await bridge.invoke(connection, "lookupUnsubscribe", key(c.ownerRequestId)));
    return {
      ...identity,
      writerOwner: "helm-mail.unsubscribe",
      support: { lifecycleVersion: "1.0.0", ...connection, capabilityId: identity.capabilityId, declarationId: "helm-mail.unsubscribe.1", dedup: { kind: "none" }, operationLookup: "historical", conditionalUpdate: "none", cancellation: "none" },
      async dispatch(request) {
        const c = { operationId: request.operationId, attemptId: request.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest: request.snapshot.digest, snapshot: request.snapshot };
        try {
          const { listing, message } = await listingFor(c);
          if (!listing || listing.health.state !== "fresh" || !scoped(c, listing.account))
            return settled(c, { status: "denied" });
          const old = await history(c);
          if (!old || old.status === "unavailable")
            return uncertain(c);
          if (old.status === "found")
            return matches(old, c, listing.account, message?.unsubscribe?.host) ? settled(c, old.result) : uncertain(c);
          if (!message)
            return settled(c, { status: "missing" });
          if (!message.unsubscribe?.oneClick)
            return settled(c, { status: "unavailable" });
          const result = parseUnsubscribeResult(await bridge.invoke(connection, "unsubscribe", { version: 1, requestId: key(c.ownerRequestId), account: listing.account, messageId: message.ref.messageId, context: { operationId: c.operationId, attemptId: c.attemptId, snapshotDigest: c.snapshotDigest } }));
          return result && validResult(result, c, listing.account, message.unsubscribe.host) ? settled(c, result) : uncertain(c);
        } catch {
          return uncertain(c);
        }
      },
      async lookup(request) {
        const base = { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt: now2() };
        const unknown = { ...base, result: { kind: "unknown", reason: { code: "mail.unsubscribe_unknown", message: "No matching historical unsubscribe evidence is available." } } };
        try {
          const c = await bridge.lookupContext(connection, request);
          const { listing, message } = await listingFor(c);
          const old = await history(c);
          return listing && old?.status === "found" && matches(old, c, listing.account, message?.unsubscribe?.host) ? { ...base, result: { kind: "known", response: settled(c, old.result) } } : unknown;
        } catch {
          return unknown;
        }
      }
    };
  });
}

// src/adapter/moves.ts
import { mailMoveDeclaration } from "@the-metafactory/cortex/desk-sdk";
var MOVE_CAPABILITIES = ["mail.move", "mail.trash", "mail.restore"];
function withMailMoves(base) {
  if (base.adapterId !== "mail")
    throw new Error("Mail move bindings require the mail adapter.");
  return composeDeclaration(base, mailMoveDeclaration(base.adapterId));
}
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var sameRef = (left, right) => left.adapterId === right.adapterId && left.connectionId === right.connectionId && left.objectType === right.objectType && left.canonicalId === right.canonicalId;
var key2 = (capabilityId, ownerRequestId) => `${capabilityId}:${ownerRequestId}`;
var now3 = () => new Date().toISOString();
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
  return !!message && old.requestId === key2(capabilityId, ownerRequestId) && `mail.${old.action}` === capabilityId && old.context.operationId === context.operationId && old.context.attemptId === context.attemptId && old.context.snapshotDigest === context.snapshotDigest && old.account === account && old.messageId === message.canonicalId && inScope(snapshot, connection, account) && (old.action === "restore" ? old.from === input.from : old.target === (capabilityId === "mail.trash" ? "trash" : input.target));
}
function uncertain2(context, ownerRequestId) {
  return { lifecycleVersion: "1.0.0", ...context, resultId: `${context.attemptId}:uncertain`, reportedAt: now3(), result: { kind: "uncertain", error: { code: "mail.provider_uncertain", message: "The move outcome is unknown until matching historical evidence settles it." }, ownerRequestId } };
}
function resultFor(context, ownerRequestId, message, value) {
  const at = now3();
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
          const requestId = key2(capabilityId, request.ownerRequestId);
          const previous = await callMoveLookup(provider, requestId, options.timeoutMs);
          if (!previous || previous.status === "unavailable")
            return uncertain2(context, request.ownerRequestId);
          if (previous.status === "found") {
            const old = previous.request;
            if (!historyMatches(old, request.snapshot, context, request.ownerRequestId, listing.account, connection, capabilityId))
              return uncertain2(context, request.ownerRequestId);
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
          return uncertain2(context, request.ownerRequestId);
        },
        async lookup(request) {
          const checkedAt = now3();
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
          const found = await callMoveLookup(provider, key2(capabilityId, request.ownerRequestId), options.timeoutMs);
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

// src/adapter/invitations.ts
import { INVITATION_CAPABILITIES, mailInvitationDeclaration, mailInvitationSnapshot } from "@the-metafactory/cortex/desk-sdk";
var INVITATION_ACTIONS = ["accept", "decline", "tentative", "remove", "restore"];
var VERB = { accept: "invitationReply", decline: "invitationReply", tentative: "invitationReply", remove: "invitationRemove", restore: "invitationRestore" };
var INVITATION_BINDING_CAPABILITIES = INVITATION_ACTIONS.map((action) => INVITATION_CAPABILITIES[action]);
var now4 = () => new Date().toISOString();
var key3 = (capabilityId, ownerRequestId) => `${capabilityId}:${ownerRequestId}`;
function withMailInvitations(base) {
  if (base.adapterId !== "mail")
    throw new Error("Mail invitation bindings require the mail adapter.");
  const extra = mailInvitationDeclaration(base.adapterId);
  const known = new Set(base.capabilities.map((item) => item.capabilityId));
  return composeDeclaration(base, { ...extra, capabilities: extra.capabilities.filter((item) => !known.has(item.capabilityId)) });
}
var envelope2 = (context, suffix) => ({ lifecycleVersion: "1.0.0", operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest, resultId: `${context.attemptId}:${suffix}`, reportedAt: now4() });
var REFUSALS = {
  missing: ["mail.message_missing", "The invitation or its message no longer exists."],
  denied: ["mail.account_denied", "The account is unavailable to this connection."],
  unavailable: ["mail.unavailable", "This connection cannot perform the invitation action."]
};
function noEffect(context, ownerRequestId, suffix, receipt) {
  return { kind: "no-effect", evidenceId: `mail-invitation:${context.operationId}:${suffix}`, observedAt: now4(), ownerRequestId, receipt, final: true };
}
function refused(context, ownerRequestId, why) {
  const [code, message] = REFUSALS[why];
  return { ...envelope2(context, `refused:${why}`), result: { kind: "failed", error: { code, message }, evidence: noEffect(context, ownerRequestId, why, { status: why }) } };
}
function changed(context, ownerRequestId, currentRevision) {
  return { ...envelope2(context, "changed"), result: { kind: "conflict", error: { code: "mail.invitation_changed", message: "The invitation changed. Read it again before acting." }, currentOwnerRevision: currentRevision, evidence: noEffect(context, ownerRequestId, "changed", { status: "changed" }) } };
}
function uncertain3(context, ownerRequestId) {
  return { ...envelope2(context, "uncertain"), result: { kind: "uncertain", error: { code: "mail.provider_uncertain", message: "The invitation outcome is unknown until matching historical evidence settles it." }, ownerRequestId } };
}
function done(context, ownerRequestId, action, invitation, value) {
  const base = envelope2(context, "done");
  return { ...base, result: { kind: "succeeded", output: { ref: invitation, revision: value.revision }, evidence: { kind: "effect", evidenceId: `mail-invitation:${context.operationId}`, observedAt: base.reportedAt, ownerRequestId, receipt: { action }, refs: [invitation], ownerRevision: value.revision } } };
}
function approvedOf(snapshot, connection, account, action) {
  const input = snapshot.input;
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return;
  const { message, invitation, expectedRevision } = input;
  const ref = (raw, objectType) => {
    const r = raw;
    return r && typeof r === "object" && r.adapterId === connection.adapterId && r.connectionId === connection.connectionId && r.objectType === objectType && typeof r.canonicalId === "string" && r.canonicalId ? { ...connection, objectType, canonicalId: r.canonicalId } : undefined;
  };
  const m = ref(message, "message");
  const i = ref(invitation, "invitation");
  if (!m || !i || typeof expectedRevision !== "string" || snapshot.capabilityId !== INVITATION_CAPABILITIES[action] || !snapshot.target || !sameRef(snapshot.target, i))
    return;
  try {
    const expected = mailInvitationSnapshot({ adapterId: connection.adapterId, connectionId: connection.connectionId, account, action, messageId: m.canonicalId, invitationId: i.canonicalId, expectedRevision, provenance: snapshot.provenance });
    return expected.digest === snapshot.digest ? { message: m, invitation: i, expectedRevision } : undefined;
  } catch {
    return;
  }
}
var nativeRequest = (requestId, approved, reply) => ({
  version: INTERFACE_VERSION,
  requestId,
  message: { adapterId: approved.message.adapterId, connectionId: approved.message.connectionId, objectType: "message", canonicalId: approved.message.canonicalId },
  invitation: { adapterId: approved.invitation.adapterId, connectionId: approved.invitation.connectionId, objectType: "invitation", canonicalId: approved.invitation.canonicalId },
  expectedRevision: approved.expectedRevision,
  ...reply ? { reply } : {}
});
function historyMatches2(old, expected) {
  return JSON.stringify(old) === JSON.stringify(expected);
}
function registerMailInvitations(host, options = {}) {
  for (const action of INVITATION_ACTIONS) {
    const capabilityId = INVITATION_CAPABILITIES[action];
    const verb = VERB[action];
    const reply = verb === "invitationReply" ? action : undefined;
    host.registerConnector(capabilityId, (connection) => {
      const bridge = host.mailExecution;
      const bound = bridge?.connection(connection);
      const offered = (method) => !!bound && bound.version === 1 && bound.methods.includes(method);
      const provider = bridge && offered(verb) && offered("lookupInvitation") ? {
        version: 1,
        [verb]: (request) => bridge.invoke(connection, verb, request),
        lookupInvitation: (requestId) => bridge.invoke(connection, "lookupInvitation", requestId)
      } : undefined;
      const identity = { kind: "action", ...connection, capabilityId };
      if (!bridge || !provider || invitationSupport(provider, verb))
        return identity;
      const restorable = action === "remove" && offered("invitationRestore");
      const requestKey = (ownerRequestId) => key3(capabilityId, ownerRequestId);
      return {
        ...identity,
        writerOwner: "mail-invitation",
        support: { lifecycleVersion: "1.0.0", ...connection, capabilityId, declarationId: "mail-invitation-interface-1", dedup: { kind: "none" }, operationLookup: "historical", conditionalUpdate: "owner-enforced", cancellation: "none", ...restorable ? { compensationCapabilityId: INVITATION_CAPABILITIES.restore } : {} },
        async dispatch(request) {
          const context = { operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest };
          const listing = await host.mail.listed(connection);
          if (!listing || listing.health.state !== "fresh")
            return refused(context, request.ownerRequestId, "denied");
          const approved = approvedOf(request.snapshot, connection, listing.account, action);
          if (!approved)
            return refused(context, request.ownerRequestId, "denied");
          const requestId = requestKey(request.ownerRequestId);
          const expected = nativeRequest(requestId, approved, reply);
          const previous = await callInvitationLookup(provider, verb, requestId, options.timeoutMs);
          if (!previous || previous.status === "unavailable")
            return uncertain3(context, request.ownerRequestId);
          if (previous.status === "found") {
            return historyMatches2(previous.request, expected) && sameRef(previous.result.ref, approved.invitation) ? done(context, request.ownerRequestId, action, approved.invitation, previous.result) : uncertain3(context, request.ownerRequestId);
          }
          if (action !== "restore" && !listing.mail.some((mail) => mail.account === listing.account && mail.ref.connection === connection.connectionId && mail.ref.messageId === approved.message.canonicalId))
            return refused(context, request.ownerRequestId, "missing");
          const outcome = await callInvitation(provider, verb, expected, options.timeoutMs);
          if (outcome.kind === "result")
            return !sameRef(outcome.value.ref, approved.invitation) ? uncertain3(context, request.ownerRequestId) : done(context, request.ownerRequestId, action, approved.invitation, outcome.value);
          if (outcome.kind === "refused")
            return outcome.reason === "changed" && outcome.currentRevision ? changed(context, request.ownerRequestId, outcome.currentRevision) : refused(context, request.ownerRequestId, outcome.reason === "changed" ? "unavailable" : outcome.reason);
          return outcome.kind === "unsupported" ? refused(context, request.ownerRequestId, "unavailable") : uncertain3(context, request.ownerRequestId);
        },
        async lookup(request) {
          const base = { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt: now4() };
          const unknown = (message) => ({ ...base, result: { kind: "unknown", reason: { code: "mail.lookup_unavailable", message } } });
          let context;
          try {
            context = await bridge.lookupContext(connection, request);
          } catch {
            return unknown("Original approved context is unavailable.");
          }
          const listing = await host.mail.listed(connection);
          if (!listing)
            return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The connection is unavailable." } } };
          const found = await callInvitationLookup(provider, verb, requestKey(request.ownerRequestId), options.timeoutMs);
          if (!found || found.status !== "found")
            return unknown("The provider has no definitive invitation outcome.");
          const approved = approvedOf(context.snapshot, connection, listing.account, action);
          if (!approved || !historyMatches2(found.request, nativeRequest(requestKey(request.ownerRequestId), approved, reply)) || !sameRef(found.result.ref, approved.invitation))
            return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The result belongs to another connection scope." } } };
          return { ...base, result: { kind: "known", response: done(context, request.ownerRequestId, action, approved.invitation, found.result) } };
        }
      };
    });
  }
}

// src/adapter/reports.ts
import { mailReportDeclaration } from "@the-metafactory/cortex/desk-sdk";
var REPORT_CAPABILITY = { draft: "mail.report.draft", spam: "mail.report.spam", phishing: "mail.report.phishing" };
var REPORT_CAPABILITIES = REPORT_KINDS.map((kind) => REPORT_CAPABILITY[kind]);
var now5 = () => new Date().toISOString();
var key4 = (capabilityId, ownerRequestId) => `${capabilityId}:${ownerRequestId}`;
function withMailReports(base, kinds = REPORT_KINDS) {
  if (base.adapterId !== "mail")
    throw new Error("Mail report bindings require the mail adapter.");
  const extra = mailReportDeclaration(base.adapterId, kinds);
  const known = new Set(base.capabilities.map((item) => item.capabilityId));
  return composeDeclaration(base, { ...extra, capabilities: extra.capabilities.filter((item) => !known.has(item.capabilityId)) });
}
function envelope3(context, suffix) {
  return { lifecycleVersion: "1.0.0", operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest, resultId: `${context.attemptId}:${suffix}`, reportedAt: now5() };
}
var REFUSALS2 = {
  missing: ["mail.message_missing", "The message no longer exists."],
  denied: ["mail.account_denied", "The account is unavailable to this connection."],
  unavailable: ["mail.unavailable", "This connection cannot perform the report."]
};
function refused2(context, ownerRequestId, why) {
  const base = envelope3(context, `refused:${why}`);
  const [code, message] = REFUSALS2[why];
  return { ...base, result: { kind: "failed", error: { code, message }, evidence: { kind: "no-effect", evidenceId: `mail-report:${context.operationId}:${why}`, observedAt: base.reportedAt, ownerRequestId, receipt: { status: why }, final: true } } };
}
function uncertain4(context, ownerRequestId) {
  return { ...envelope3(context, "uncertain"), result: { kind: "uncertain", error: { code: "mail.provider_uncertain", message: "The report outcome is unknown until matching historical evidence settles it." }, ownerRequestId } };
}
function reported(context, ownerRequestId, kind, message, value) {
  const base = envelope3(context, "reported");
  return { ...base, result: { kind: "succeeded", output: { ref: message, folder: value.folder }, evidence: { kind: "effect", evidenceId: `mail-report:${context.operationId}`, observedAt: base.reportedAt, ownerRequestId, receipt: { kind, folder: value.folder }, refs: [message], ownerRevision: value.folder } } };
}
function historyMatches3(old, kind, snapshot, ownerRequestId, account, connection) {
  const message = messageOf(snapshot, connection);
  return !!message && old.requestId === key4(REPORT_CAPABILITY[kind], ownerRequestId) && old.kind === kind && sameRef(old.message, message) && inScope(snapshot, connection, account);
}
function registerMailReports(host, options = {}) {
  for (const kind of options.kinds ?? REPORT_KINDS) {
    const capabilityId = REPORT_CAPABILITY[kind];
    host.registerConnector(capabilityId, (connection) => {
      const bridge = host.mailExecution;
      const bound = bridge?.connection(connection);
      const offered = (method) => !!bound && bound.version === 1 && bound.methods.includes(method);
      const provider = bridge && offered("report") && offered("lookupReport") ? {
        version: 1,
        reportKinds: options.kinds ?? REPORT_KINDS,
        report: (request) => bridge.invoke(connection, "report", request),
        lookupReport: (requestId) => bridge.invoke(connection, "lookupReport", requestId),
        ...offered("restore") && offered("move") && offered("lookupMove") ? { restore: () => Promise.reject(new Error("Undo runs through the restore binding.")) } : {}
      } : undefined;
      const identity = { kind: "action", ...connection, capabilityId };
      if (!bridge || !provider || reportSupport(provider, kind))
        return identity;
      return {
        ...identity,
        writerOwner: "mail-report",
        support: { lifecycleVersion: "1.0.0", ...connection, capabilityId, declarationId: "mail-report-interface-1", dedup: { kind: "none" }, operationLookup: "historical", conditionalUpdate: "none", cancellation: "none", ...isProviderReport(kind) ? { compensationCapabilityId: "mail.restore" } : {} },
        async dispatch(request) {
          const context = { operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest };
          const message = messageOf(request.snapshot, connection);
          if (!message || request.snapshot.capabilityId !== capabilityId)
            return refused2(context, request.ownerRequestId, "denied");
          const listing = await host.mail.listed(connection);
          if (!listing || listing.health.state !== "fresh" || !inScope(request.snapshot, connection, listing.account))
            return refused2(context, request.ownerRequestId, "denied");
          const present = listing.mail.some((mail) => mail.account === listing.account && mail.ref.connection === connection.connectionId && mail.ref.messageId === message.canonicalId);
          const requestId = key4(capabilityId, request.ownerRequestId);
          const previous = await callReportLookup(provider, kind, requestId, options.timeoutMs);
          if (!previous || previous.status === "unavailable")
            return uncertain4(context, request.ownerRequestId);
          if (previous.status === "found") {
            return historyMatches3(previous.request, kind, request.snapshot, request.ownerRequestId, listing.account, connection) && sameRef(previous.result.ref, message) ? reported(context, request.ownerRequestId, kind, message, previous.result) : uncertain4(context, request.ownerRequestId);
          }
          if (!present)
            return refused2(context, request.ownerRequestId, "missing");
          const outcome = await callReport(provider, { version: INTERFACE_VERSION, requestId, kind, message: { adapterId: message.adapterId, connectionId: message.connectionId, objectType: "message", canonicalId: message.canonicalId } }, options.timeoutMs);
          if (outcome.kind === "result")
            return sameRef(outcome.value.ref, message) ? reported(context, request.ownerRequestId, kind, message, outcome.value) : uncertain4(context, request.ownerRequestId);
          return outcome.kind === "unsupported" ? refused2(context, request.ownerRequestId, "unavailable") : uncertain4(context, request.ownerRequestId);
        },
        async lookup(request) {
          const base = { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt: now5() };
          const unknown = { ...base, result: { kind: "unknown", reason: { code: "mail.lookup_unavailable", message: "The provider has no definitive report outcome." } } };
          let context;
          try {
            context = await bridge.lookupContext(connection, request);
          } catch {
            return { ...unknown, result: { kind: "unknown", reason: { code: "mail.lookup_unavailable", message: "Original approved context is unavailable." } } };
          }
          const listing = await host.mail.listed(connection);
          if (!listing)
            return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The connection is unavailable." } } };
          const found = await callReportLookup(provider, kind, key4(capabilityId, request.ownerRequestId), options.timeoutMs);
          if (!found || found.status !== "found")
            return unknown;
          const message = messageOf(context.snapshot, connection);
          if (!message || context.snapshot.capabilityId !== capabilityId || !historyMatches3(found.request, kind, context.snapshot, request.ownerRequestId, listing.account, connection) || !sameRef(found.result.ref, message))
            return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The result belongs to another connection scope." } } };
          return { ...base, result: { kind: "known", response: reported(context, request.ownerRequestId, kind, message, found.result) } };
        }
      };
    });
  }
}

// src/adapter-actions/manifest.ts
import { mailReplyDraftDeclaration } from "@the-metafactory/cortex/desk-sdk";
var reply = mailReplyDraftDeclaration(ADAPTER_ID);
var readDeclaration = declaration;
var declaration2 = withMailInvitations(withMailReports(withMailJudgements(withMailUnsubscribe(withMailMoves(composeDeclaration(readDeclaration, reply))))));

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
function envelope4(context, suffix) {
  return { lifecycleVersion: "1.0.0", operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest, reportedAt: new Date().toISOString(), resultId: `${context.attemptId}:${suffix}` };
}
function refused3(context, code) {
  const base = envelope4(context, "refused");
  return { ...base, result: { kind: "failed", error: { code, message: "The approved Mail scope is unavailable." }, evidence: { kind: "no-effect", evidenceId: `${context.ownerRequestId}:refused`, observedAt: base.reportedAt, ownerRequestId: context.ownerRequestId, receipt: { code }, final: true } } };
}
function uncertain5(context) {
  return { ...envelope4(context, "uncertain"), result: { kind: "uncertain", error: { code: "mail.unknown", message: "The draft outcome requires historical lookup." }, ownerRequestId: context.ownerRequestId } };
}
function settled2(connection, context, value) {
  const base = envelope4(context, value.status === "conflict" ? "conflict" : "saved");
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
        return refused3(context, "mail.scope_denied");
      const target = request.snapshot.target;
      const mail = listing.mail.find((item) => item.ref.connection === connection.connectionId && item.ref.messageId === target?.canonicalId && item.account === listing.account);
      if (!mail || request.snapshot.adapterId !== connection.adapterId || request.snapshot.connectionId !== connection.connectionId)
        return refused3(context, "mail.message_missing");
      const body = request.snapshot.input.body;
      try {
        return await serialized(`${connection.adapterId}:${connection.connectionId}:${requestId(request.ownerRequestId)}`, async () => {
          const value = parseDraftResult(await bridge.invoke(connection, "draft", { version: 1, requestId: requestId(request.ownerRequestId), account: listing.account, messageId: mail.ref.messageId, recipient: mail.from.address, subject: mailReplySubject(mail.subject), body }));
          if (!value || value.account !== listing.account)
            return uncertain5(context);
          return settled2(connection, context, value);
        });
      } catch {
        return uncertain5(context);
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
          return { ...base, result: { kind: "known", response: settled2(connection, context, { status: "exists", id: found.id, account: found.account }) } };
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
  registerMailReports(host);
  registerMailInvitations(host);
  registerMailJudgements(host);
  registerMailUnsubscribe(host);
  host.registerConnector(CAPABILITY, (connection) => connector(host, connection));
  return { ...reads, declaration: declaration2 };
}
export {
  createDeskAdapter2 as createDeskAdapter
};
