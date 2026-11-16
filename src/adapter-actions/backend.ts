import {
  MAIL_REPLY_DRAFT_CAPABILITY,
  mailReplyDraftSnapshot,
  mailAccountRef,
  mailReplySubject,
  type DeskAdapterConnection,
  type DeskAdapterDefinition,
  type DeskAdapterHost,
  type DeskActionConnector,
  type DeskMailOperationContext,
  type DispatchRequest,
  type OwnerResult,
} from "@the-metafactory/cortex/desk-sdk";
import { parseDraftResult, parseLookupResult, type DraftResult } from "../interface";
import { createDeskAdapter as createReads } from "../adapter/backend";
import { registerMailJudgements } from "../adapter/judgements";
import { registerMailUnsubscribe } from "../adapter/unsubscribe";
import { registerMailMoves } from "../adapter/moves";
import { registerMailReports } from "../adapter/reports";
import { declaration } from "./manifest";

const CAPABILITY = MAIL_REPLY_DRAFT_CAPABILITY;
const pending = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = pending.get(key);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, current);
  try {
    await previous;
    return await run();
  } finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}

function contextOf(request: DispatchRequest): DeskMailOperationContext {
  return { operationId: request.operationId, attemptId: request.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest: request.snapshot.digest, snapshot: request.snapshot };
}

function envelope(context: DeskMailOperationContext, suffix: string) {
  return { lifecycleVersion: "1.0.0" as const, operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest, reportedAt: new Date().toISOString(), resultId: `${context.attemptId}:${suffix}` };
}

function refused(context: DeskMailOperationContext, code: string): OwnerResult {
  const base = envelope(context, "refused");
  return { ...base, result: { kind: "failed", error: { code, message: "The approved Mail scope is unavailable." }, evidence: { kind: "no-effect", evidenceId: `${context.ownerRequestId}:refused`, observedAt: base.reportedAt, ownerRequestId: context.ownerRequestId, receipt: { code }, final: true } } };
}

function uncertain(context: DeskMailOperationContext): OwnerResult {
  return { ...envelope(context, "uncertain"), result: { kind: "uncertain", error: { code: "mail.unknown", message: "The draft outcome requires historical lookup." }, ownerRequestId: context.ownerRequestId } };
}

function settled(connection: DeskAdapterConnection, context: DeskMailOperationContext, value: DraftResult): OwnerResult {
  const base = envelope(context, value.status === "conflict" ? "conflict" : "saved");
  if (value.status === "conflict") return { ...base, result: { kind: "conflict", error: { code: "mail.request_conflict", message: "The request ID already names a different draft." }, currentOwnerRevision: value.id, evidence: { kind: "no-effect", evidenceId: context.ownerRequestId, observedAt: base.reportedAt, ownerRequestId: context.ownerRequestId, receipt: value, final: true } } };
  const ref = { ...connection, objectType: "draft", canonicalId: value.id };
  return { ...base, result: { kind: "succeeded", output: { ref }, evidence: { kind: "effect", evidenceId: context.ownerRequestId, observedAt: base.reportedAt, ownerRequestId: context.ownerRequestId, receipt: value, refs: [ref] } } };
}

function scopeMatches(context: DeskMailOperationContext, account: string): boolean {
  try {
    const snapshot = context.snapshot;
    const input = snapshot.input as { body: string };
    return mailReplyDraftSnapshot({ ...snapshot, account: mailAccountRef(snapshot.adapterId, snapshot.connectionId, account), message: snapshot.target!, body: input.body }).digest === snapshot.digest;
  } catch {
    return false;
  }
}

function connector(host: DeskAdapterHost, connection: DeskAdapterConnection): DeskActionConnector {
  const identity = { kind: "action" as const, ...connection, capabilityId: CAPABILITY };
  const bridge = host.mailExecution;
  const bound = bridge?.connection(connection);
  if (!bridge || bound?.version !== 1 || !bound.methods.includes("draft") || !bound.methods.includes("lookup")) return identity;
  const requestId = (ownerRequestId: string) => `${CAPABILITY}:${ownerRequestId}`;
  return {
    ...identity,
    writerOwner: "helm-mail.reply-draft",
    support: { lifecycleVersion: "1.0.0", ...connection, capabilityId: CAPABILITY, declarationId: "helm-mail.reply-draft.1", dedup: { kind: "none" }, operationLookup: "historical", conditionalUpdate: "none", cancellation: "none" },
    async dispatch(request) {
      const context = contextOf(request);
      const listing = await host.mail.listed(connection);
      if (!listing || listing.health.state !== "fresh" || !scopeMatches(context, listing.account)) return refused(context, "mail.scope_denied");
      const target = request.snapshot.target;
      const mail = listing.mail.find(item => item.ref.connection === connection.connectionId && item.ref.messageId === target?.canonicalId && item.account === listing.account);
      if (!mail || request.snapshot.adapterId !== connection.adapterId || request.snapshot.connectionId !== connection.connectionId) return refused(context, "mail.message_missing");
      const body = (request.snapshot.input as { body: string }).body;
      try {
        return await serialized(`${connection.adapterId}:${connection.connectionId}:${requestId(request.ownerRequestId)}`, async () => {
          const value = parseDraftResult(await bridge.invoke(connection, "draft", { version: 1, requestId: requestId(request.ownerRequestId), account: listing.account, messageId: mail.ref.messageId, recipient: mail.from.address, subject: mailReplySubject(mail.subject), body }));
          if (!value || value.account !== listing.account) return uncertain(context);
          return settled(connection, context, value);
        });
      } catch {
        return uncertain(context);
      }
    },
    async lookup(request) {
      const checkedAt = new Date().toISOString();
      const base = { lifecycleVersion: "1.0.0" as const, operationId: request.operationId, checkedAt };
      try {
        const context = await bridge.lookupContext(connection, request);
        const found = parseLookupResult(await bridge.invoke(connection, "lookup", requestId(request.ownerRequestId)));
        const account = context.snapshot.destinations[0]?.canonicalId;
        const listing = await host.mail.listed(connection);
        const saved = found?.status === "found" ? found.request : undefined;
        const mail = listing?.mail.find(item => item.ref.connection === connection.connectionId && item.ref.messageId === context.snapshot.target?.canonicalId && item.account === account);
        const body = (context.snapshot.input as { body: string }).body;
        if (found?.status === "found" && found.account === account && saved && mail && listing?.account === account && listing.health.state === "fresh" && scopeMatches(context, listing.account)
          && saved.requestId === requestId(request.ownerRequestId) && saved.account === account && saved.messageId === context.snapshot.target?.canonicalId && saved.body === body
          && saved.recipient === mail.from.address && saved.subject === mailReplySubject(mail.subject)) {
          return { ...base, result: { kind: "known", response: settled(connection, context, { status: "exists", id: found.id, account: found.account }) } };
        }
        return { ...base, result: { kind: "unknown", reason: { code: "mail.lookup_unknown", message: "No matching saved draft is known." } } };
      } catch {
        return { ...base, result: { kind: "unavailable", reason: { code: "mail.lookup_unavailable", message: "Historical draft lookup is unavailable." } } };
      }
    },
  };
}

export function createDeskAdapter(host: DeskAdapterHost): DeskAdapterDefinition {
  const reads = createReads(host);
  registerMailMoves(host);
  registerMailReports(host);
  registerMailJudgements(host);
  registerMailUnsubscribe(host);
  host.registerConnector(CAPABILITY, connection => connector(host, connection));
  return { ...reads, declaration };
}
