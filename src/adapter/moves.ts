import { mailMoveDeclaration, type AdapterDeclaration, type ApprovedSnapshot, type DeskAdapterConnection, type DeskAdapterHost, type DispatchRequest, type Json, type ObjectReference, type OwnerResult, type OperationLookup } from "@the-metafactory/cortex/desk-sdk";
import { callMove, callMoveLookup, INTERFACE_VERSION, moveSupport, type MoveConnection, type MoveContext, type MoveRequest, type MoveResult, type RestoreRequest } from "../interface";

export const MOVE_CAPABILITIES = ["mail.move", "mail.trash", "mail.restore"] as const;
export function withMailMoves(base: AdapterDeclaration): AdapterDeclaration {
  if (base.adapterId !== "mail") throw new Error("Mail move bindings require the mail adapter.");
  const moves = mailMoveDeclaration(base.adapterId);
  return {
    ...base,
    schemas: [...base.schemas, ...moves.schemas.filter(item => !base.schemas.some(old => old.schemaId === item.schemaId && old.version === item.version))],
    objectTypes: [...base.objectTypes, ...moves.objectTypes.filter(item => !base.objectTypes.some(old => old.objectType === item.objectType))],
    capabilities: [...base.capabilities, ...moves.capabilities],
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sameRef = (left: ObjectReference, right: ObjectReference): boolean => left.adapterId === right.adapterId && left.connectionId === right.connectionId && left.objectType === right.objectType && left.canonicalId === right.canonicalId;
const key = (capabilityId: string, ownerRequestId: string): string => `${capabilityId}:${ownerRequestId}`;
const now = () => new Date().toISOString();

function messageOf(snapshot: ApprovedSnapshot, connection: DeskAdapterConnection): ObjectReference | undefined {
  const input = snapshot.input;
  if (!isRecord(input) || !isRecord(input.message)) return undefined;
  const m = input.message;
  if (m.adapterId !== connection.adapterId || m.connectionId !== connection.connectionId || m.objectType !== "message" || typeof m.canonicalId !== "string" || !m.canonicalId) return undefined;
  const message = { ...connection, objectType: "message", canonicalId: m.canonicalId };
  return snapshot.target === undefined || !sameRef(snapshot.target, message) ? undefined : message;
}

function historyMatches(old: MoveRequest | RestoreRequest, snapshot: ApprovedSnapshot, context: MoveContext, ownerRequestId: string, account: string, connection: DeskAdapterConnection, capabilityId: string): boolean {
  const message = messageOf(snapshot, connection);
  const input = snapshot.input as Record<string, Json>;
  return !!message && old.requestId === key(capabilityId, ownerRequestId) && `mail.${old.action}` === capabilityId
    && old.context.operationId === context.operationId && old.context.attemptId === context.attemptId && old.context.snapshotDigest === context.snapshotDigest
    && old.account === account && old.messageId === message.canonicalId
    && snapshot.adapterId === connection.adapterId && snapshot.connectionId === connection.connectionId
    && snapshot.destinations.length === 1 && sameRef(snapshot.destinations[0]!, { ...connection, objectType: "account", canonicalId: account })
    && (old.action === "restore" ? old.from === input.from : old.target === (capabilityId === "mail.trash" ? "trash" : input.target));
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

export function registerMailMoves(host: DeskAdapterHost, options: { timeoutMs?: number } = {}): void {
  for (const capabilityId of MOVE_CAPABILITIES) host.registerConnector(capabilityId, connection => {
    const bridge = host.mailExecution;
    const bound = bridge?.connection(connection);
    const provider: MoveConnection | undefined = bridge && bound?.version === 1 && ["move", "restore", "lookupMove"].every(method => bound.methods.includes(method as "move" | "restore" | "lookupMove")) ? {
      version: 1,
      move: request => bridge.invoke(connection, "move", request),
      restore: request => bridge.invoke(connection, "restore", request),
      lookupMove: requestId => bridge.invoke(connection, "lookupMove", requestId),
    } : undefined;
    const identity = { kind: "action" as const, ...connection, capabilityId };
    if (!provider || moveSupport(provider)) return identity;
    return {
      ...identity, writerOwner: "mail-move",
      support: { lifecycleVersion: "1.0.0" as const, ...connection, capabilityId, declarationId: "mail-move-interface-1", dedup: { kind: "none" as const }, operationLookup: "historical" as const, conditionalUpdate: capabilityId === "mail.restore" ? "owner-enforced" as const : "none" as const, cancellation: "none" as const, ...(capabilityId === "mail.restore" ? {} : { compensationCapabilityId: "mail.restore" }) },
      async dispatch(request: DispatchRequest): Promise<OwnerResult> {
        const context = { operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest };
        const message = messageOf(request.snapshot, connection);
        if (!message) return resultFor(context, request.ownerRequestId, { ...connection, objectType: "message", canonicalId: "unavailable" }, { status: "denied" });
        const listing = await host.mail.listed(connection);
        if (!listing || listing.health.state !== "fresh" || request.snapshot.adapterId !== connection.adapterId || request.snapshot.connectionId !== connection.connectionId || request.snapshot.destinations.length !== 1 || request.snapshot.destinations.some(ref => ref.adapterId !== connection.adapterId || ref.connectionId !== connection.connectionId || ref.objectType !== "account" || ref.canonicalId !== listing.account)) return resultFor(context, request.ownerRequestId, message, { status: "denied" });
        const requestId = key(capabilityId, request.ownerRequestId);
        const previous = await callMoveLookup(provider, requestId, options.timeoutMs);
        if (previous?.status === "found") {
          const old = previous.request;
          if (!historyMatches(old, request.snapshot, context, request.ownerRequestId, listing.account, connection, capabilityId)) return resultFor(context, request.ownerRequestId, message, { status: "conflict", folder: "unknown" });
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
        let context;
        try { context = await bridge!.lookupContext(connection, request); } catch { return { ...base, result: { kind: "unknown", reason: { code: "mail.lookup_unavailable", message: "Original approved context is unavailable." } } }; }
        const listing = await host.mail.listed(connection);
        if (!listing) return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The connection is unavailable." } } };
        const found = await callMoveLookup(provider, key(capabilityId, request.ownerRequestId), options.timeoutMs);
        if (!found || found.status !== "found") return { ...base, result: { kind: "unknown", reason: { code: "mail.lookup_unavailable", message: "The provider has no definitive move outcome." } } };
        const old = found.request;
        if (!historyMatches(old, context.snapshot, context, request.ownerRequestId, listing.account, connection, capabilityId)) return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The result belongs to another connection scope." } } };
        return { ...base, result: { kind: "known", response: resultFor(old.context, request.ownerRequestId, { ...connection, objectType: "message", canonicalId: old.messageId }, found.result) } };
      },
    };
  });
}
