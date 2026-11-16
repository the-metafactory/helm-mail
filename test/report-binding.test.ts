import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { OperationLookup, DeskAdapterHost, DeskConnectorFactory, DispatchRequest, ObjectReference, OwnerResult } from "@the-metafactory/cortex/desk-sdk";
import { registerMailReports, withMailReports } from "../src/adapter/reports";
import { declaration } from "../src/adapter/manifest";
import { FakeReportConnection } from "../src/fake-report";
import { availableReportKinds, callReport, parseReportLookup, reportSupport } from "../src/interface";
import { fakeBridge, item } from "./fixtures/mail-source";

const ACCOUNT = "account-one";
const MESSAGE = "<one@example.test>";
const connection = { adapterId: "mail", connectionId: "one" };
const message: ObjectReference = { ...connection, objectType: "message", canonicalId: MESSAGE };

function request(kind: string, id = "operation-one"): DispatchRequest {
  const capabilityId = `mail.report.${kind}`;
  const snapshot = {
    provenance: { conversationId: "conversation-one", proposalId: id, revision: 1, entryId: null, link: "?fixture=one" },
    ...connection, capabilityId,
    inputSchemaRef: { schemaId: `${capabilityId}.input`, version: "1.0.0" }, outputSchemaRef: { schemaId: "mail.mail.report.output", version: "1.0.0" }, errorSchemaRef: { schemaId: "mail.mail.error", version: "1.0.0" },
    input: { message }, target: message,
    destinations: [{ ...connection, objectType: "account", canonicalId: ACCOUNT }], sources: [], policy: "local" as const,
  };
  return {
    lifecycleVersion: "1.0.0", operationId: id, attemptId: `attempt-${id}`, idempotencyKey: id, ownerRequestId: id,
    snapshot: { ...snapshot, digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") },
    authority: { principalRef: "principal-one", basis: { kind: "confirmation", confirmationId: "confirmation-one", transport: "web" }, connectionRevision: "1", policyRevision: "1", decisionRef: "decision-one", authorizedAt: new Date().toISOString() }, supportDeclarationId: "mail-report-interface-1", deadlineAt: new Date(Date.now() + 1000).toISOString(),
  };
}

function binding(provider: FakeReportConnection, options: { listed?: boolean; original?: DispatchRequest; methods?: ("report" | "lookupReport" | "restore" | "move" | "lookupMove")[] } = {}) {
  const bridge = fakeBridge({ one: ACCOUNT }, { mail: options.listed === false ? [] : [item(MESSAGE, ACCOUNT, "Synthetic message")] });
  const factories = new Map<string, DeskConnectorFactory>();
  const host: DeskAdapterHost = { ...bridge.host, mailExecution: {
    connection: () => ({ version: 1, methods: options.methods ?? ["report", "lookupReport", "restore", "move", "lookupMove"] }),
    invoke: async (_connection, method, input) => method === "report" ? provider.report(input as never) : provider.lookupReport!(input as string),
    lookupContext: async () => { if (!options.original) throw new Error("No fixture approval"); const o = options.original; return { operationId: o.operationId, attemptId: o.attemptId, ownerRequestId: o.ownerRequestId, snapshotDigest: o.snapshot.digest, snapshot: o.snapshot }; },
  }, registerConnector(id, factory) { factories.set(id, factory); } };
  registerMailReports(host, { timeoutMs: 10 });
  return (id: string) => factories.get(`mail.report.${id}`)!(connection);
}
const signal = () => new AbortController().signal;
const fresh = (extra: ConstructorParameters<typeof FakeReportConnection>[0] = {}) => new FakeReportConnection({ account: ACCOUNT, folders: { [MESSAGE]: "Inbox" }, ...extra });

describe("inactive Mail report bindings", () => {
  test("declares the three report kinds once and leaves the read declaration alone", () => {
    const old = JSON.stringify(declaration);
    const combined = withMailReports(declaration as never);
    expect(JSON.stringify(declaration)).toBe(old);
    expect(combined.capabilities.map(c => c.capabilityId).filter(id => id.startsWith("mail.report."))).toEqual(["mail.report.draft", "mail.report.spam", "mail.report.phishing"]);
    expect(withMailReports(declaration as never, ["draft"]).capabilities.filter(c => c.capabilityId.startsWith("mail.report.")).map(c => c.capabilityId)).toEqual(["mail.report.draft"]);
  });

  test("Report as draft saves a draft with the original attached, once, and sends nothing", async () => {
    const provider = fresh();
    const connector = binding(provider)("draft");
    const approved = request("draft");
    const a = await connector.dispatch!(approved, signal()) as OwnerResult;
    const b = await connector.dispatch!(approved, signal()) as OwnerResult;
    expect(a.result.kind).toBe("succeeded");
    expect(b.result.kind).toBe("succeeded");
    expect(provider.reportDrafts).toEqual([{ requestId: "mail.report.draft:operation-one", messageId: MESSAGE, attachedOriginal: MESSAGE, folder: "Drafts", sent: false }]);
    expect(provider.sent).toHaveLength(0);
    expect(provider.submissions).toHaveLength(0);
    expect(provider.folders.get(MESSAGE)).toBe("Inbox");
    expect(connector.support?.compensationCapabilityId).toBeUndefined();
  });

  test("a provider report submits once and its Undo is the restore of the location", async () => {
    const provider = fresh();
    const connector = binding(provider)("spam");
    expect(connector.support?.compensationCapabilityId).toBe("mail.restore");
    const result = await connector.dispatch!(request("spam"), signal()) as OwnerResult;
    expect(result.result.kind).toBe("succeeded");
    expect(provider.submissions).toHaveLength(1);
    expect(provider.folders.get(MESSAGE)).toBe("Junk");
    await provider.restore!({ version: 1, requestId: "undo", action: "restore", account: ACCOUNT, messageId: MESSAGE, from: "Junk", context: { operationId: "u", attemptId: "u", snapshotDigest: "0".repeat(64) } });
    expect(provider.folders.get(MESSAGE)).toBe("Inbox");
    expect(provider.submissions).toHaveLength(1);
  });

  test("a kind the connection does not declare is unavailable", async () => {
    const provider = fresh({ reportKinds: ["draft"] });
    expect(availableReportKinds(provider)).toEqual(["draft"]);
    expect(reportSupport(provider, "spam")).toContain("does not declare");
    const outcome = await callReport(provider, { version: 1, requestId: "r", kind: "phishing", message: { ...connection, objectType: "message", canonicalId: MESSAGE } });
    expect(outcome.kind).toBe("unsupported");
    expect(provider.reported.size).toBe(0);
  });

  test("missing report, lookup or restore methods make the kinds unavailable", () => {
    expect(availableReportKinds({ ...fresh(), version: 1, restore: undefined, report: fresh().report, lookupReport: fresh().lookupReport, reportKinds: ["draft", "spam"] })).toEqual(["draft"]);
    expect(availableReportKinds({ version: 2, reportKinds: ["draft"], report: async () => ({}), lookupReport: async () => ({}) })).toEqual([]);
    const noLookup = fresh({ lookup: false });
    expect(availableReportKinds(noLookup)).toEqual([]);
    const connector = binding(fresh(), { methods: ["report", "lookupReport"] });
    expect(connector("draft").dispatch).toBeDefined();
    expect(connector("spam").dispatch).toBeUndefined();
    expect(binding(fresh(), { methods: ["report"] })("draft").dispatch).toBeUndefined();
    const noMove = binding(fresh(), { methods: ["report", "lookupReport", "restore", "lookupMove"] });
    expect(noMove("draft").dispatch).toBeDefined();
    expect(noMove("spam").dispatch).toBeUndefined();
  });

  test("a missing message or another account runs nothing", async () => {
    const gone = fresh();
    const missing = await binding(gone, { listed: false })("spam").dispatch!(request("spam"), signal()) as OwnerResult;
    expect(missing.result.kind).toBe("failed");
    expect(gone.reported.size).toBe(0);
    for (const mode of ["other-account", "empty", "no-target", "other-connection"] as const) {
      const provider = fresh();
      const approved = request("draft");
      if (mode === "other-account") approved.snapshot.destinations[0]!.canonicalId = "other-account";
      if (mode === "empty") approved.snapshot.destinations = [];
      if (mode === "no-target") delete approved.snapshot.target;
      if (mode === "other-connection") approved.snapshot.input = { message: { ...message, connectionId: "other" } };
      const result = await binding(provider)("draft").dispatch!(approved, signal()) as OwnerResult;
      expect(result.result.kind).toBe("failed");
      expect(provider.reported.size).toBe(0);
      expect(provider.reportDrafts).toHaveLength(0);
    }
  });

  test("a report approved for one kind cannot run through another kind's connector", async () => {
    const provider = fresh();
    const result = await binding(provider)("draft").dispatch!(request("spam"), signal()) as OwnerResult;
    expect(result.result.kind).toBe("failed");
    expect(provider.reported.size).toBe(0);
  });

  test("timeout stays uncertain, and a fresh binding reads the provider's historical outcome without a second report", async () => {
    const provider = fresh({ timeoutAfterReport: true });
    const approved = request("spam");
    const first = await binding(provider)("spam").dispatch!(approved, signal()) as OwnerResult;
    expect(first.result.kind).toBe("uncertain");
    expect(provider.submissions).toHaveLength(1);
    const lookup = await binding(provider, { original: approved })("spam").lookup!({ lifecycleVersion: "1.0.0", operationId: approved.operationId, ownerRequestId: approved.ownerRequestId }, signal()) as OperationLookup;
    expect(lookup.result.kind).toBe("known");
    if (lookup.result.kind !== "known") throw new Error("Expected the historical owner result");
    expect(lookup.result.response.result.kind).toBe("succeeded");
    expect(lookup.result.response.snapshotDigest).toBe(approved.snapshot.digest);
    expect(provider.submissions).toHaveLength(1);
  });

  test("history for another message, kind or request is not accepted", async () => {
    for (const field of ["kind", "message", "requestId"] as const) {
      const provider = fresh({ timeoutAfterReport: true });
      const approved = request("spam");
      await binding(provider)("spam").dispatch!(approved, signal());
      const stored = provider.reported.values().next().value!;
      if (field === "kind") stored.request.kind = "phishing";
      if (field === "message") { stored.request.message.canonicalId = "<other@example.test>"; stored.result.ref.canonicalId = "<other@example.test>"; }
      if (field === "requestId") stored.request.requestId = "mail.report.spam:other";
      const lookup = await binding(provider, { original: approved })("spam").lookup!({ lifecycleVersion: "1.0.0", operationId: approved.operationId, ownerRequestId: approved.ownerRequestId }, signal()) as OperationLookup;
      expect(lookup.result.kind).not.toBe("known");
      const again = await binding(provider)("spam").dispatch!(approved, signal()) as OwnerResult;
      expect(again.result.kind).toBe("uncertain");
      expect(provider.submissions).toHaveLength(1);
    }
  });

  test("lookup output must carry a request and a result for the same message", () => {
    const request = { version: 1, requestId: "r", kind: "spam", message: { ...connection, objectType: "message", canonicalId: MESSAGE } };
    expect(parseReportLookup({ status: "found", request, result: { ref: request.message, folder: "Junk" } })?.status).toBe("found");
    expect(parseReportLookup({ status: "found", request, result: { ref: { ...request.message, canonicalId: "x" }, folder: "Junk" } })).toBeUndefined();
    expect(parseReportLookup({ status: "found", request })).toBeUndefined();
  });
});
