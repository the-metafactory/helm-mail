import { mailReportDeclaration, type AdapterDeclaration, type ApprovedSnapshot, type DeskAdapterConnection, type DeskAdapterHost, type DispatchRequest, type ObjectReference, type OperationLookup, type OwnerResult } from "@the-metafactory/cortex/desk-sdk";
import { composeDeclaration } from "./compose-declaration";
import { inScope, messageOf, sameRef } from "./moves";
import { callReport, callReportLookup, INTERFACE_VERSION, isProviderReport, REPORT_KINDS, reportSupport, type ReportConnection, type ReportKind, type ReportRequest, type ReportResult } from "../interface";

export const REPORT_CAPABILITY: Readonly<Record<ReportKind, string>> = { draft: "mail.report.draft", spam: "mail.report.spam", phishing: "mail.report.phishing" };
export const REPORT_CAPABILITIES = REPORT_KINDS.map(kind => REPORT_CAPABILITY[kind]);

const now = () => new Date().toISOString();
const key = (capabilityId: string, ownerRequestId: string): string => `${capabilityId}:${ownerRequestId}`;

export function withMailReports(base: AdapterDeclaration, kinds: readonly ReportKind[] = REPORT_KINDS): AdapterDeclaration {
  if (base.adapterId !== "mail") throw new Error("Mail report bindings require the mail adapter.");
  const extra = mailReportDeclaration(base.adapterId, kinds);
  const known = new Set(base.capabilities.map(item => item.capabilityId));
  return composeDeclaration(base, { ...extra, capabilities: extra.capabilities.filter(item => !known.has(item.capabilityId)) });
}

function envelope(context: { operationId: string; attemptId: string; snapshotDigest: string }, suffix: string) {
  return { lifecycleVersion: "1.0.0" as const, operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest, resultId: `${context.attemptId}:${suffix}`, reportedAt: now() };
}

type Refusal = "missing" | "denied" | "unavailable";
const REFUSALS: Record<Refusal, [string, string]> = {
  missing: ["mail.message_missing", "The message no longer exists."],
  denied: ["mail.account_denied", "The account is unavailable to this connection."],
  unavailable: ["mail.unavailable", "This connection cannot perform the report."],
};

function refused(context: { operationId: string; attemptId: string; snapshotDigest: string }, ownerRequestId: string, why: Refusal): OwnerResult {
  const base = envelope(context, `refused:${why}`);
  const [code, message] = REFUSALS[why];
  return { ...base, result: { kind: "failed", error: { code, message }, evidence: { kind: "no-effect", evidenceId: `mail-report:${context.operationId}:${why}`, observedAt: base.reportedAt, ownerRequestId, receipt: { status: why }, final: true } } };
}

function uncertain(context: { operationId: string; attemptId: string; snapshotDigest: string }, ownerRequestId: string): OwnerResult {
  return { ...envelope(context, "uncertain"), result: { kind: "uncertain", error: { code: "mail.provider_uncertain", message: "The report outcome is unknown until matching historical evidence settles it." }, ownerRequestId } };
}

function reported(context: { operationId: string; attemptId: string; snapshotDigest: string }, ownerRequestId: string, kind: ReportKind, message: ObjectReference, value: ReportResult): OwnerResult {
  const base = envelope(context, "reported");
  return { ...base, result: { kind: "succeeded", output: { ref: message, folder: value.folder }, evidence: { kind: "effect", evidenceId: `mail-report:${context.operationId}`, observedAt: base.reportedAt, ownerRequestId, receipt: { kind, folder: value.folder }, refs: [message], ownerRevision: value.folder } } };
}

function historyMatches(old: ReportRequest, kind: ReportKind, snapshot: ApprovedSnapshot, ownerRequestId: string, account: string, connection: DeskAdapterConnection): boolean {
  const message = messageOf(snapshot, connection);
  return !!message && old.requestId === key(REPORT_CAPABILITY[kind], ownerRequestId) && old.kind === kind && sameRef(old.message as ObjectReference, message) && inScope(snapshot, connection, account);
}

export interface ReportBindingOptions {
  timeoutMs?: number;
  kinds?: readonly ReportKind[];
}

export function registerMailReports(host: DeskAdapterHost, options: ReportBindingOptions = {}): void {
  for (const kind of options.kinds ?? REPORT_KINDS) {
    const capabilityId = REPORT_CAPABILITY[kind];
    host.registerConnector(capabilityId, connection => {
      const bridge = host.mailExecution;
      const bound = bridge?.connection(connection);
      const offered = (method: "report" | "lookupReport" | "restore" | "move" | "lookupMove") => !!bound && bound.version === 1 && bound.methods.includes(method);
      const provider: ReportConnection | undefined = bridge && offered("report") && offered("lookupReport") ? {
        version: 1,
        reportKinds: options.kinds ?? REPORT_KINDS,
        report: request => bridge.invoke(connection, "report", request),
        lookupReport: requestId => bridge.invoke(connection, "lookupReport", requestId),
        ...(offered("restore") && offered("move") && offered("lookupMove") ? { restore: () => Promise.reject(new Error("Undo runs through the restore binding.")) } : {}),
      } : undefined;
      const identity = { kind: "action" as const, ...connection, capabilityId };
      if (!bridge || !provider || reportSupport(provider, kind)) return identity;
      return {
        ...identity, writerOwner: "mail-report",
        support: { lifecycleVersion: "1.0.0" as const, ...connection, capabilityId, declarationId: "mail-report-interface-1", dedup: { kind: "none" as const }, operationLookup: "historical" as const, conditionalUpdate: "none" as const, cancellation: "none" as const, ...(isProviderReport(kind) ? { compensationCapabilityId: "mail.restore" } : {}) },
        async dispatch(request: DispatchRequest): Promise<OwnerResult> {
          const context = { operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest };
          const message = messageOf(request.snapshot, connection);
          if (!message || request.snapshot.capabilityId !== capabilityId) return refused(context, request.ownerRequestId, "denied");
          const listing = await host.mail.listed(connection);
          if (!listing || listing.health.state !== "fresh" || !inScope(request.snapshot, connection, listing.account)) return refused(context, request.ownerRequestId, "denied");
          const present = listing.mail.some(mail => mail.account === listing.account && mail.ref.connection === connection.connectionId && mail.ref.messageId === message.canonicalId);
          const requestId = key(capabilityId, request.ownerRequestId);
          const previous = await callReportLookup(provider, kind, requestId, options.timeoutMs);
          if (!previous || previous.status === "unavailable") return uncertain(context, request.ownerRequestId);
          if (previous.status === "found") {
            return historyMatches(previous.request, kind, request.snapshot, request.ownerRequestId, listing.account, connection) && sameRef(previous.result.ref as ObjectReference, message)
              ? reported(context, request.ownerRequestId, kind, message, previous.result) : uncertain(context, request.ownerRequestId);
          }
          if (!present) return refused(context, request.ownerRequestId, "missing");
          const outcome = await callReport(provider, { version: INTERFACE_VERSION, requestId, kind, message: { adapterId: message.adapterId, connectionId: message.connectionId, objectType: "message", canonicalId: message.canonicalId } }, options.timeoutMs);
          if (outcome.kind === "result") return sameRef(outcome.value.ref as ObjectReference, message) ? reported(context, request.ownerRequestId, kind, message, outcome.value) : uncertain(context, request.ownerRequestId);
          return outcome.kind === "unsupported" ? refused(context, request.ownerRequestId, "unavailable") : uncertain(context, request.ownerRequestId);
        },
        async lookup(request): Promise<OperationLookup> {
          const base = { lifecycleVersion: "1.0.0" as const, operationId: request.operationId, checkedAt: now() };
          const unknown = { ...base, result: { kind: "unknown" as const, reason: { code: "mail.lookup_unavailable", message: "The provider has no definitive report outcome." } } };
          let context;
          try { context = await bridge.lookupContext(connection, request); } catch { return { ...unknown, result: { kind: "unknown", reason: { code: "mail.lookup_unavailable", message: "Original approved context is unavailable." } } }; }
          const listing = await host.mail.listed(connection);
          if (!listing) return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The connection is unavailable." } } };
          const found = await callReportLookup(provider, kind, key(capabilityId, request.ownerRequestId), options.timeoutMs);
          if (!found || found.status !== "found") return unknown;
          const message = messageOf(context.snapshot, connection);
          if (!message || context.snapshot.capabilityId !== capabilityId || !historyMatches(found.request, kind, context.snapshot, request.ownerRequestId, listing.account, connection) || !sameRef(found.result.ref as ObjectReference, message)) return { ...base, result: { kind: "denied", reason: { code: "mail.account_denied", message: "The result belongs to another connection scope." } } };
          return { ...base, result: { kind: "known", response: reported(context, request.ownerRequestId, kind, message, found.result) } };
        },
      };
    });
  }
}
