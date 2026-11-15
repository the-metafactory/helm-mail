import type { AdapterDeclaration, DeskAdapterConnection, DeskAdapterHost, DispatchRequest, Json, ObjectReference, OwnerResult, OperationLookup } from "@the-metafactory/cortex/desk-sdk";
import { callMove, callMoveLookup, INTERFACE_VERSION, moveSupport, type MailConnection, type MoveContext, type MoveRequest, type MoveResult, type RestoreRequest } from "../interface";

export const MOVE_CAPABILITIES = ["mail.move", "mail.trash", "mail.restore"] as const;
const SCHEMA_VERSION = "1.0.0";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const schemaRef = (schemaId: string) => ({ schemaId, version: SCHEMA_VERSION });
const object = (properties: Record<string, Json>, required: string[]): Record<string, Json> => ({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required, properties });
const reference = (objectType: string) => object({ adapterId: { type: "string", const: "mail" }, connectionId: { type: "string", minLength: 1 }, objectType: { type: "string", const: objectType }, canonicalId: { type: "string", minLength: 1 } }, ["adapterId", "connectionId", "objectType", "canonicalId"]);

export function withMailMoves(base: AdapterDeclaration): AdapterDeclaration {
  if (base.adapterId !== "mail") throw new Error("Mail move bindings require the mail adapter.");
  const message = reference("message");
  const folder = { type: "string", minLength: 1, maxLength: 200 };
  const inputs = {
    "mail.move": object({ message, target: { type: "string", enum: ["archive", "junk"] } }, ["message", "target"]),
    "mail.trash": object({ message }, ["message"]),
    "mail.restore": object({ message, from: folder }, ["message", "from"]),
  };
  const error = schemaRef("mail.mail.error");
  return {
    ...base,
    schemas: [...base.schemas,
      { ...error, schema: object({ code: { type: "string", pattern: "^mail\\..+$" }, message: { type: "string", minLength: 1 }, issues: { type: "array", items: object({ path: { type: "string" }, code: { type: "string" }, message: { type: "string" } }, ["path", "code", "message"]) } }, ["code", "message"]) },
      { ...schemaRef("mail.mail.move.output"), schema: object({ ref: message, folder }, ["ref", "folder"]) },
      ...MOVE_CAPABILITIES.map(capabilityId => ({ ...schemaRef(`${capabilityId}.input`), schema: inputs[capabilityId] })),
    ],
    capabilities: [...base.capabilities, ...MOVE_CAPABILITIES.map(capabilityId => ({ capabilityId, label: capabilityId === "mail.restore" ? "Move mail back" : capabilityId === "mail.trash" ? "Move mail to Trash" : "Move mail", kind: "action" as const, objectTypes: ["message"], inputSchemaRef: schemaRef(`${capabilityId}.input`), outputSchemaRef: schemaRef("mail.mail.move.output"), errorSchemaRef: error }))],
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sameRef = (left: ObjectReference, right: ObjectReference): boolean => left.adapterId === right.adapterId && left.connectionId === right.connectionId && left.objectType === right.objectType && left.canonicalId === right.canonicalId;
const key = (capabilityId: string, ownerRequestId: string): string => `${capabilityId}:${ownerRequestId}`;
const now = () => new Date().toISOString();

function messageOf(request: DispatchRequest, connection: DeskAdapterConnection): ObjectReference | undefined {
  const input = request.snapshot.input;
  if (!isRecord(input) || !isRecord(input.message)) return undefined;
  const m = input.message;
  if (m.adapterId !== connection.adapterId || m.connectionId !== connection.connectionId || m.objectType !== "message" || typeof m.canonicalId !== "string" || !m.canonicalId) return undefined;
  const message = { ...connection, objectType: "message", canonicalId: m.canonicalId };
  return request.snapshot.target === undefined || !sameRef(request.snapshot.target, message) ? undefined : message;
}

function resultFor(context: MoveContext, ownerRequestId: string, message: ObjectReference, value: MoveResult): OwnerResult {
  const at = now();
  const base = { lifecycleVersion: "1.0.0" as const, ...context, resultId: `${context.attemptId}:${value.status}:${at}`, reportedAt: at };
  if (value.status === "moved" || value.status === "restored" || value.status === "exists") {
    return { ...base, result: { kind: "succeeded", output: { ref: message, folder: value.folder }, evidence: { kind: "effect", evidenceId: `mail-move:${context.operationId}`, observedAt: at, ownerRequestId, receipt: { id: value.id, account: value.account, folder: value.folder, previousFolder: value.previousFolder }, refs: [message], ownerRevision: value.folder } } };
  }
  const evidence = { kind: "no-effect" as const, evidenceId: `mail-move:${context.operationId}:${value.status}`, observedAt: at, ownerRequestId, receipt: { status: value.status }, final: true as const };
  if (value.status === "conflict") return { ...base, result: { kind: "conflict", error: { code: "mail.location_conflict", message: "The message changed location after the move." }, currentOwnerRevision: value.folder, evidence } };
  const code = value.status === "missing" ? "mail.message_missing" : value.status === "denied" ? "mail.account_denied" : "mail.unavailable";
  return { ...base, result: { kind: "failed", error: { code, message: value.status === "missing" ? "The message no longer exists." : value.status === "denied" ? "The account is unavailable to this connection." : "This connection cannot perform the move." }, evidence } };
}

export function registerMailMoves(host: DeskAdapterHost, connectionFor: (connection: DeskAdapterConnection) => MailConnection | undefined, options: { timeoutMs?: number } = {}): void {
  for (const capabilityId of MOVE_CAPABILITIES) host.registerConnector(capabilityId, connection => {
    const provider = connectionFor(connection);
    const identity = { kind: "action" as const, ...connection, capabilityId };
    if (!provider || moveSupport(provider)) return identity;
    return {
      ...identity, writerOwner: "mail-move",
      support: { lifecycleVersion: "1.0.0" as const, ...connection, capabilityId, declarationId: "mail-move-interface-1", dedup: { kind: "guaranteed" as const, scope: "connection-capability" as const, retentionMs: RETENTION_MS, bindsSnapshot: true as const, concurrent: true as const }, operationLookup: "historical" as const, conditionalUpdate: capabilityId === "mail.restore" ? "owner-enforced" as const : "none" as const, cancellation: "none" as const, ...(capabilityId === "mail.restore" ? {} : { compensationCapabilityId: "mail.restore" }) },
      async dispatch(request: DispatchRequest): Promise<OwnerResult> {
        const context = { operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest };
        const message = messageOf(request, connection);
        if (!message) return resultFor(context, request.ownerRequestId, { ...connection, objectType: "message", canonicalId: "unavailable" }, { status: "denied" });
        const listing = await host.mail.listed(connection);
        if (!listing || request.snapshot.destinations.length !== 1 || request.snapshot.destinations.some(ref => ref.adapterId !== connection.adapterId || ref.connectionId !== connection.connectionId || ref.objectType !== "account" || ref.canonicalId !== listing.account)) return resultFor(context, request.ownerRequestId, message, { status: "denied" });
        const requestId = key(capabilityId, request.ownerRequestId);
        const previous = await callMoveLookup(provider, requestId, options.timeoutMs);
        if (previous?.status === "found") {
          const old = previous.request;
          if (old.requestId !== requestId || `mail.${old.action}` !== capabilityId || old.context.operationId !== request.operationId || old.context.snapshotDigest !== request.snapshot.digest || old.account !== listing.account || old.messageId !== message.canonicalId) return resultFor(context, request.ownerRequestId, message, { status: "conflict", folder: "unknown" });
          return resultFor(context, request.ownerRequestId, message, previous.result);
        }
        if (capabilityId !== "mail.restore" && !listing.mail.some(mail => mail.account === listing.account && mail.ref.connection === connection.connectionId && mail.ref.messageId === message.canonicalId)) return resultFor(context, request.ownerRequestId, message, { status: "missing" });
        const input = request.snapshot.input as Record<string, Json>;
        const base = { version: INTERFACE_VERSION, requestId, account: listing.account, messageId: message.canonicalId, context };
        let move: MoveRequest | RestoreRequest;
        if (capabilityId === "mail.restore") {
          if (typeof input.from !== "string" || !input.from.trim()) return resultFor(context, request.ownerRequestId, message, { status: "unavailable" });
          move = { ...base, action: "restore", from: input.from };
        } else {
          if (capabilityId === "mail.move" && input.target !== "archive" && input.target !== "junk") return resultFor(context, request.ownerRequestId, message, { status: "unavailable" });
          move = { ...base, action: capabilityId === "mail.trash" ? "trash" : "move", target: capabilityId === "mail.trash" ? "trash" : input.target as "archive" | "junk" };
        }
        const outcome = await callMove(provider, move, options.timeoutMs);
        if (outcome.kind === "result") return resultFor(context, request.ownerRequestId, message, outcome.value);
        if (outcome.kind === "unsupported") return resultFor(context, request.ownerRequestId, message, { status: "unavailable" });
        return { lifecycleVersion: "1.0.0", ...context, resultId: `${context.attemptId}:uncertain`, reportedAt: now(), result: { kind: "uncertain", error: { code: "mail.provider_uncertain", message: "The move outcome is unknown until lookup settles it." }, ownerRequestId: request.ownerRequestId } };
      },
      async lookup(request): Promise<OperationLookup> {
        const checkedAt = now();
        const base = { lifecycleVersion: "1.0.0" as const, operationId: request.operationId, checkedAt };
        const listing = await host.mail.listed(connection);
        if (!listing) return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The connection is unavailable." } } };
        const found = await callMoveLookup(provider, key(capabilityId, request.ownerRequestId), options.timeoutMs);
        if (!found || found.status !== "found") return { ...base, result: { kind: "unknown", reason: { code: "mail.lookup_unavailable", message: "The provider has no definitive move outcome." } } };
        const old = found.request;
        if (old.requestId !== key(capabilityId, request.ownerRequestId) || `mail.${old.action}` !== capabilityId || old.context.operationId !== request.operationId || old.account !== listing.account) return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The result belongs to another connection scope." } } };
        return { ...base, result: { kind: "known", response: resultFor(old.context, request.ownerRequestId, { ...connection, objectType: "message", canonicalId: old.messageId }, found.result) } };
      },
    };
  });
}
