import { composeDeclaration } from "./compose-declaration";
import { mailUnsubscribeDeclaration, mailUnsubscribeSnapshot, type AdapterDeclaration, type DeskAdapterHost, type DeskMailOperationContext, type OwnerResult } from "@the-metafactory/cortex/desk-sdk";
import { parseUnsubscribeLookup, parseUnsubscribeResult, type UnsubscribeLookup, type UnsubscribeResult } from "../interface";

export function withMailUnsubscribe(base: AdapterDeclaration): AdapterDeclaration {
  return composeDeclaration(base, mailUnsubscribeDeclaration(base.adapterId));
}
const key = (id: string) => `mail.unsubscribe:${id}`;
const now = () => new Date().toISOString();
function scoped(context: DeskMailOperationContext, account: string): boolean {
  try {
    const s = context.snapshot;
    return mailUnsubscribeSnapshot({ ...s, account, input: s.input as Parameters<typeof mailUnsubscribeSnapshot>[0]["input"] }).digest === s.digest;
  } catch { return false; }
}
function envelope(c: DeskMailOperationContext) {
  return { lifecycleVersion: "1.0.0" as const, operationId: c.operationId, attemptId: c.attemptId, snapshotDigest: c.snapshotDigest, resultId: `${c.attemptId}:${now()}`, reportedAt: now() };
}
function uncertain(c: DeskMailOperationContext): OwnerResult {
  return { ...envelope(c), result: { kind: "uncertain", ownerRequestId: c.ownerRequestId, error: { code: "mail.unsubscribe_unknown", message: "The provider outcome requires matching historical evidence." } } };
}
function settled(c: DeskMailOperationContext, value: UnsubscribeResult): OwnerResult {
  const base = envelope(c);
  const evidence = { evidenceId: key(c.ownerRequestId), observedAt: base.reportedAt, ownerRequestId: c.ownerRequestId };
  if (value.status === "unsubscribed" || value.status === "exists") return { ...base, result: { kind: "succeeded", output: { ref: c.snapshot.target!, host: value.host }, evidence: { ...evidence, kind: "effect", refs: [c.snapshot.target!], receipt: { id: value.id, account: value.account, host: value.host } } } };
  if (value.status === "conflict") return uncertain(c);
  return { ...base, result: { kind: "failed", error: { code: `mail.unsubscribe_${value.status}`, message: "The message cannot be unsubscribed through this connection." }, evidence: { ...evidence, kind: "no-effect", receipt: { status: value.status }, final: true } } };
}
function validResult(value: UnsubscribeResult, c: DeskMailOperationContext, account: string, host?: string): boolean {
  return value.status !== "unsubscribed" && value.status !== "exists" || value.account === account && value.id === c.snapshot.target?.canonicalId && value.host === host;
}
function matches(found: Extract<UnsubscribeLookup, { status: "found" }>, c: DeskMailOperationContext, account: string, host?: string): boolean {
  const r = found.request;
  return scoped(c, account) && r.requestId === key(c.ownerRequestId) && r.account === account && r.messageId === c.snapshot.target?.canonicalId
    && r.context.operationId === c.operationId && r.context.attemptId === c.attemptId && r.context.snapshotDigest === c.snapshotDigest && (found.result.status !== "unsubscribed" && found.result.status !== "exists" || found.result.account === account && found.result.id === c.snapshot.target?.canonicalId && (host === undefined || found.result.host === host));
}
export function registerMailUnsubscribe(host: DeskAdapterHost): void {
  host.registerConnector("mail.unsubscribe", connection => {
    const identity = { kind: "action" as const, ...connection, capabilityId: "mail.unsubscribe" };
    const bridge = host.mailExecution;
    const bound = bridge?.connection(connection);
    if (!bridge || bound?.version !== 1 || !bound.methods.includes("unsubscribe") || !bound.methods.includes("lookupUnsubscribe")) return identity;
    const listingFor = async (c: DeskMailOperationContext) => {
      const listing = await host.mail.listed(connection);
      const message = listing?.mail.find(m => m.account === listing.account && m.ref.connection === connection.connectionId && m.ref.messageId === c.snapshot.target?.canonicalId);
      return { listing, message };
    };
    const history = async (c: DeskMailOperationContext) => parseUnsubscribeLookup(await bridge.invoke(connection, "lookupUnsubscribe", key(c.ownerRequestId)));
    return { ...identity, writerOwner: "helm-mail.unsubscribe", support: { lifecycleVersion: "1.0.0" as const, ...connection, capabilityId: identity.capabilityId, declarationId: "helm-mail.unsubscribe.1", dedup: { kind: "none" as const }, operationLookup: "historical" as const, conditionalUpdate: "none" as const, cancellation: "none" as const },
      async dispatch(request): Promise<OwnerResult> {
        const c = { operationId: request.operationId, attemptId: request.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest: request.snapshot.digest, snapshot: request.snapshot };
        try {
          const { listing, message } = await listingFor(c);
          if (!listing || listing.health.state !== "fresh" || !scoped(c, listing.account)) return settled(c, { status: "denied" });
          const old = await history(c);
          if (!old || old.status === "unavailable") return uncertain(c);
          if (old.status === "found") return matches(old, c, listing.account, message?.unsubscribe?.host) ? settled(c, old.result) : uncertain(c);
          if (!message) return settled(c, { status: "missing" });
          if (!message.unsubscribe?.oneClick) return settled(c, { status: "unavailable" });
          const result = parseUnsubscribeResult(await bridge.invoke(connection, "unsubscribe", { version: 1, requestId: key(c.ownerRequestId), account: listing.account, messageId: message.ref.messageId, context: { operationId: c.operationId, attemptId: c.attemptId, snapshotDigest: c.snapshotDigest } }));
          return result && validResult(result, c, listing.account, message.unsubscribe.host) ? settled(c, result) : uncertain(c);
        } catch { return uncertain(c); }
      },
      async lookup(request) {
        const base = { lifecycleVersion: "1.0.0" as const, operationId: request.operationId, checkedAt: now() };
        const unknown = { ...base, result: { kind: "unknown" as const, reason: { code: "mail.unsubscribe_unknown", message: "No matching historical unsubscribe evidence is available." } } };
        try {
          const c = await bridge.lookupContext(connection, request);
          const { listing, message } = await listingFor(c);
          const old = await history(c);
          return listing && old?.status === "found" && matches(old, c, listing.account, message?.unsubscribe?.host) ? { ...base, result: { kind: "known" as const, response: settled(c, old.result) } } : unknown;
        } catch { return unknown; }
      },
    };
  });
}
