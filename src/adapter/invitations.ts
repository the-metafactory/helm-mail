import { INVITATION_CAPABILITIES, mailInvitationDeclaration, mailInvitationSnapshot, type AdapterDeclaration, type DeskAdapterConnection, type DeskAdapterHost, type DispatchRequest, type InvitationAction, type ObjectReference, type OperationLookup, type OwnerResult } from "@the-metafactory/cortex/desk-sdk";
import { composeDeclaration } from "./compose-declaration";
import { sameRef } from "./moves";
import { callInvitation, callInvitationLookup, INTERFACE_VERSION, invitationSupport, type InvitationConnection, type InvitationReplyKind, type InvitationRequest, type InvitationResult, type InvitationVerb } from "../interface";

export const INVITATION_ACTIONS: readonly InvitationAction[] = ["accept", "decline", "tentative", "remove", "restore"];
const VERB: Record<InvitationAction, InvitationVerb> = { accept: "invitationReply", decline: "invitationReply", tentative: "invitationReply", remove: "invitationRemove", restore: "invitationRestore" };
export const INVITATION_BINDING_CAPABILITIES = INVITATION_ACTIONS.map(action => INVITATION_CAPABILITIES[action]);

const now = () => new Date().toISOString();
const key = (capabilityId: string, ownerRequestId: string): string => `${capabilityId}:${ownerRequestId}`;

export function withMailInvitations(base: AdapterDeclaration): AdapterDeclaration {
  if (base.adapterId !== "mail") throw new Error("Mail invitation bindings require the mail adapter.");
  const extra = mailInvitationDeclaration(base.adapterId);
  const known = new Set(base.capabilities.map(item => item.capabilityId));
  return composeDeclaration(base, { ...extra, capabilities: extra.capabilities.filter(item => !known.has(item.capabilityId)) });
}

interface Context { operationId: string; attemptId: string; snapshotDigest: string }
const envelope = (context: Context, suffix: string) => ({ lifecycleVersion: "1.0.0" as const, operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest, resultId: `${context.attemptId}:${suffix}`, reportedAt: now() });

type Refusal = "missing" | "denied" | "unavailable";
const REFUSALS: Record<Refusal, [string, string]> = {
  missing: ["mail.message_missing", "The invitation or its message no longer exists."],
  denied: ["mail.account_denied", "The account is unavailable to this connection."],
  unavailable: ["mail.unavailable", "This connection cannot perform the invitation action."],
};

function noEffect(context: Context, ownerRequestId: string, suffix: string, receipt: Record<string, string>) {
  return { kind: "no-effect" as const, evidenceId: `mail-invitation:${context.operationId}:${suffix}`, observedAt: now(), ownerRequestId, receipt, final: true as const };
}

function refused(context: Context, ownerRequestId: string, why: Refusal): OwnerResult {
  const [code, message] = REFUSALS[why];
  return { ...envelope(context, `refused:${why}`), result: { kind: "failed", error: { code, message }, evidence: noEffect(context, ownerRequestId, why, { status: why }) } };
}

function changed(context: Context, ownerRequestId: string, currentRevision: string): OwnerResult {
  return { ...envelope(context, "changed"), result: { kind: "conflict", error: { code: "mail.invitation_changed", message: "The invitation changed. Read it again before acting." }, currentOwnerRevision: currentRevision, evidence: noEffect(context, ownerRequestId, "changed", { status: "changed" }) } };
}

function uncertain(context: Context, ownerRequestId: string): OwnerResult {
  return { ...envelope(context, "uncertain"), result: { kind: "uncertain", error: { code: "mail.provider_uncertain", message: "The invitation outcome is unknown until matching historical evidence settles it." }, ownerRequestId } };
}

function done(context: Context, ownerRequestId: string, action: InvitationAction, invitation: ObjectReference, value: InvitationResult): OwnerResult {
  const base = envelope(context, "done");
  return { ...base, result: { kind: "succeeded", output: { ref: invitation, revision: value.revision }, evidence: { kind: "effect", evidenceId: `mail-invitation:${context.operationId}`, observedAt: base.reportedAt, ownerRequestId, receipt: { action }, refs: [invitation], ownerRevision: value.revision } } };
}

interface Approved { message: ObjectReference; invitation: ObjectReference; expectedRevision: string }

function approvedOf(snapshot: DispatchRequest["snapshot"], connection: DeskAdapterConnection, account: string, action: InvitationAction): Approved | undefined {
  const input = snapshot.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const { message, invitation, expectedRevision } = input as Record<string, unknown>;
  const ref = (raw: unknown, objectType: string): ObjectReference | undefined => {
    const r = raw as Record<string, unknown> | null;
    return r && typeof r === "object" && r.adapterId === connection.adapterId && r.connectionId === connection.connectionId && r.objectType === objectType && typeof r.canonicalId === "string" && r.canonicalId ? { ...connection, objectType, canonicalId: r.canonicalId } : undefined;
  };
  const m = ref(message, "message");
  const i = ref(invitation, "invitation");
  if (!m || !i || typeof expectedRevision !== "string" || snapshot.capabilityId !== INVITATION_CAPABILITIES[action] || !snapshot.target || !sameRef(snapshot.target, i)) return undefined;
  try {
    const expected = mailInvitationSnapshot({ adapterId: connection.adapterId, connectionId: connection.connectionId, account, action, messageId: m.canonicalId, invitationId: i.canonicalId, expectedRevision, provenance: snapshot.provenance });
    return expected.digest === snapshot.digest ? { message: m, invitation: i, expectedRevision } : undefined;
  } catch { return undefined; }
}

const nativeRequest = (requestId: string, approved: Approved, reply?: InvitationReplyKind): InvitationRequest => ({
  version: INTERFACE_VERSION, requestId,
  message: { adapterId: approved.message.adapterId, connectionId: approved.message.connectionId, objectType: "message", canonicalId: approved.message.canonicalId },
  invitation: { adapterId: approved.invitation.adapterId, connectionId: approved.invitation.connectionId, objectType: "invitation", canonicalId: approved.invitation.canonicalId },
  expectedRevision: approved.expectedRevision, ...(reply ? { reply } : {}),
});

function historyMatches(old: InvitationRequest, expected: InvitationRequest): boolean {
  return JSON.stringify(old) === JSON.stringify(expected);
}

export interface InvitationBindingOptions { timeoutMs?: number }

export function registerMailInvitations(host: DeskAdapterHost, options: InvitationBindingOptions = {}): void {
  for (const action of INVITATION_ACTIONS) {
    const capabilityId = INVITATION_CAPABILITIES[action];
    const verb = VERB[action];
    const reply = verb === "invitationReply" ? action as InvitationReplyKind : undefined;
    host.registerConnector(capabilityId, connection => {
      const bridge = host.mailExecution;
      const bound = bridge?.connection(connection);
      const offered = (method: InvitationVerb | "lookupInvitation") => !!bound && bound.version === 1 && bound.methods.includes(method);
      const provider: InvitationConnection | undefined = bridge && offered(verb) && offered("lookupInvitation") ? {
        version: 1,
        [verb]: (request: InvitationRequest) => bridge.invoke(connection, verb, request),
        lookupInvitation: (requestId: string) => bridge.invoke(connection, "lookupInvitation", requestId),
      } : undefined;
      const identity = { kind: "action" as const, ...connection, capabilityId };
      if (!bridge || !provider || invitationSupport(provider, verb)) return identity;
      const restorable = action === "remove" && offered("invitationRestore");
      const requestKey = (ownerRequestId: string) => key(capabilityId, ownerRequestId);
      return {
        ...identity, writerOwner: "mail-invitation",
        support: { lifecycleVersion: "1.0.0" as const, ...connection, capabilityId, declarationId: "mail-invitation-interface-1", dedup: { kind: "none" as const }, operationLookup: "historical" as const, conditionalUpdate: "owner-enforced" as const, cancellation: "none" as const, ...(restorable ? { compensationCapabilityId: INVITATION_CAPABILITIES.restore } : {}) },
        async dispatch(request: DispatchRequest): Promise<OwnerResult> {
          const context = { operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest };
          const listing = await host.mail.listed(connection);
          if (!listing || listing.health.state !== "fresh") return refused(context, request.ownerRequestId, "denied");
          const approved = approvedOf(request.snapshot, connection, listing.account, action);
          if (!approved) return refused(context, request.ownerRequestId, "denied");
          const requestId = requestKey(request.ownerRequestId);
          const expected = nativeRequest(requestId, approved, reply);
          const previous = await callInvitationLookup(provider, verb, requestId, options.timeoutMs);
          if (!previous || previous.status === "unavailable") return uncertain(context, request.ownerRequestId);
          if (previous.status === "found") {
            return historyMatches(previous.request, expected) && sameRef(previous.result.ref as ObjectReference, approved.invitation)
              ? done(context, request.ownerRequestId, action, approved.invitation, previous.result) : uncertain(context, request.ownerRequestId);
          }
          if (action !== "restore" && !listing.mail.some(mail => mail.account === listing.account && mail.ref.connection === connection.connectionId && mail.ref.messageId === approved.message.canonicalId)) return refused(context, request.ownerRequestId, "missing");
          const outcome = await callInvitation(provider, verb, expected, options.timeoutMs);
          if (outcome.kind === "result") return done(context, request.ownerRequestId, action, approved.invitation, outcome.value);
          if (outcome.kind === "refused") return outcome.reason === "changed" && outcome.currentRevision ? changed(context, request.ownerRequestId, outcome.currentRevision) : refused(context, request.ownerRequestId, outcome.reason === "changed" ? "unavailable" : outcome.reason);
          return outcome.kind === "unsupported" ? refused(context, request.ownerRequestId, "unavailable") : uncertain(context, request.ownerRequestId);
        },
        async lookup(request): Promise<OperationLookup> {
          const base = { lifecycleVersion: "1.0.0" as const, operationId: request.operationId, checkedAt: now() };
          const unknown = (message: string) => ({ ...base, result: { kind: "unknown" as const, reason: { code: "mail.lookup_unavailable", message } } });
          let context;
          try { context = await bridge.lookupContext(connection, request); } catch { return unknown("Original approved context is unavailable."); }
          const listing = await host.mail.listed(connection);
          if (!listing) return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The connection is unavailable." } } };
          const found = await callInvitationLookup(provider, verb, requestKey(request.ownerRequestId), options.timeoutMs);
          if (!found || found.status !== "found") return unknown("The provider has no definitive invitation outcome.");
          const approved = approvedOf(context.snapshot, connection, listing.account, action);
          if (!approved || !historyMatches(found.request, nativeRequest(requestKey(request.ownerRequestId), approved, reply)) || !sameRef(found.result.ref as ObjectReference, approved.invitation)) return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The result belongs to another connection scope." } } };
          return { ...base, result: { kind: "known", response: done(context, request.ownerRequestId, action, approved.invitation, found.result) } };
        },
      };
    });
  }
}
