import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { DeskAdapterHost, DeskConnectorFactory, DispatchRequest, Json, ObjectReference, OwnerResult, OperationLookup } from "@the-metafactory/cortex/desk-sdk";
import { registerMailMoves, withMailMoves } from "../src/adapter/moves";
import { declaration } from "../src/adapter/manifest";
import { FakeMoveConnection, type FakeMoveOptions } from "../src/fake-move";
import { fakeBridge, item } from "./fixtures/mail-source";

const ACCOUNT = "account-one";
const MESSAGE = "<one@example.test>";
const connection = { adapterId: "mail", connectionId: "one" };
const message: ObjectReference = { ...connection, objectType: "message", canonicalId: MESSAGE };

function request(capabilityId: string, extra: Record<string, Json> = {}, id = "operation-one"): DispatchRequest {
  const snapshot = {
    provenance: { conversationId: "conversation-one", proposalId: id, revision: 1, entryId: null, link: "?fixture=one" },
    ...connection, capabilityId,
    inputSchemaRef: { schemaId: `${capabilityId}.input`, version: "1.0.0" }, outputSchemaRef: { schemaId: "mail.mail.move.output", version: "1.0.0" }, errorSchemaRef: { schemaId: "mail.mail.error", version: "1.0.0" },
    input: { message, ...extra }, target: message,
    destinations: [{ ...connection, objectType: "account", canonicalId: ACCOUNT }], sources: [], policy: "local" as const,
  };
  return {
    lifecycleVersion: "1.0.0", operationId: id, attemptId: `attempt-${id}`, idempotencyKey: id, ownerRequestId: id,
    snapshot: { ...snapshot, digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") },
    authority: { principalRef: "principal-one", basis: { kind: "confirmation", confirmationId: "confirmation-one", transport: "web" }, connectionRevision: "1", policyRevision: "1", decisionRef: "decision-one", authorizedAt: new Date().toISOString() }, supportDeclarationId: "mail-move-interface-1", deadlineAt: new Date(Date.now() + 1000).toISOString(),
  };
}

function binding(provider: FakeMoveConnection, original?: DispatchRequest) {
  const bridge = fakeBridge({ one: ACCOUNT }, { mail: [item(MESSAGE, ACCOUNT, "Synthetic message")] });
  const factories = new Map<string, DeskConnectorFactory>();
  const host: DeskAdapterHost = { ...bridge.host, mailExecution: {
    connection: () => ({ version: 1, methods: ["move", ...(provider.restore ? ["restore" as const] : []), "lookupMove"] }),
    invoke: async (_connection, method, input) => method === "move" ? provider.move(input as never) : method === "restore" ? provider.restore!(input as never) : provider.lookupMove(input as string),
    lookupContext: async () => { if (!original) throw new Error("No fixture approval"); return { operationId: original.operationId, attemptId: original.attemptId, ownerRequestId: original.ownerRequestId, snapshotDigest: original.snapshot.digest, snapshot: original.snapshot }; },
  }, registerConnector(id, factory) { factories.set(id, factory); } };
  registerMailMoves(host, { timeoutMs: 10 });
  return { bridge, connector: (id: string) => factories.get(id)!(connection) };
}

describe("inactive Mail move bindings", () => {
  test("adds the released move wire references without changing the read declaration", () => {
    const old = JSON.stringify(declaration);
    const combined = withMailMoves(declaration as never);
    expect(JSON.stringify(declaration)).toBe(old);
    expect(combined.capabilities.slice(-3).map(c => [c.capabilityId, c.inputSchemaRef.schemaId, c.outputSchemaRef.schemaId, c.errorSchemaRef.schemaId])).toEqual([
      ["mail.move", "mail.move.input", "mail.mail.move.output", "mail.mail.error"],
      ["mail.trash", "mail.trash.input", "mail.mail.move.output", "mail.mail.error"],
      ["mail.restore", "mail.restore.input", "mail.mail.move.output", "mail.mail.error"],
    ]);
  });

  test("moves once for the same approved attempt, and Undo returns to the previous folder", async () => {
    const provider = new FakeMoveConnection({ account: ACCOUNT, folders: { [MESSAGE]: "Inbox" } });
    const { connector } = binding(provider);
    const move = connector("mail.move");
    const approved = request("mail.move", { target: "archive" });
    const a = await move.dispatch!(approved, new AbortController().signal) as OwnerResult;
    const b = await move.dispatch!(approved, new AbortController().signal) as OwnerResult;
    expect(a.result.kind).toBe("succeeded");
    expect(b.result.kind).toBe("succeeded");
    expect(provider.effects).toHaveLength(1);
    expect(provider.folders.get(MESSAGE)).toBe("Archive");
    const undone = await connector("mail.restore").dispatch!(request("mail.restore", { from: "Archive" }, "undo-one"), new AbortController().signal) as OwnerResult;
    expect(undone.result.kind).toBe("succeeded");
    expect(provider.folders.get(MESSAGE)).toBe("Inbox");
    expect(provider.effects).toHaveLength(2);
  });

  test("Trash is reversible and never removes the message", async () => {
    const provider = new FakeMoveConnection({ account: ACCOUNT, folders: { [MESSAGE]: "Inbox" } });
    const { connector } = binding(provider);
    await connector("mail.trash").dispatch!(request("mail.trash"), new AbortController().signal);
    expect(provider.folders.get(MESSAGE)).toBe("Trash");
    await connector("mail.restore").dispatch!(request("mail.restore", { from: "Trash" }, "undo-trash"), new AbortController().signal);
    expect(provider.folders.get(MESSAGE)).toBe("Inbox");
  });

  test("a changed location makes Undo conflict without a new mutation", async () => {
    const provider = new FakeMoveConnection({ account: ACCOUNT, folders: { [MESSAGE]: "Inbox" } });
    const { connector } = binding(provider);
    await connector("mail.move").dispatch!(request("mail.move", { target: "junk" }), new AbortController().signal);
    provider.folders.set(MESSAGE, "Later");
    const result = await connector("mail.restore").dispatch!(request("mail.restore", { from: "Junk" }, "undo-changed"), new AbortController().signal) as OwnerResult;
    expect(result.result.kind).toBe("conflict");
    expect(provider.folders.get(MESSAGE)).toBe("Later");
    expect(provider.effects).toHaveLength(1);
  });

  test("missing messages and denied accounts have no provider mutation", async () => {
    const cases: FakeMoveOptions[] = [{ account: ACCOUNT, folders: {} }, { account: "other-account", folders: { [MESSAGE]: "Inbox" } }];
    for (const options of cases) {
      const provider = new FakeMoveConnection(options);
      const result = await binding(provider).connector("mail.move").dispatch!(request("mail.move", { target: "archive" }), new AbortController().signal) as OwnerResult;
      expect(result.result.kind).toBe("failed");
      expect(provider.effects).toHaveLength(0);
    }
  });

  test("another connection's message is refused before the provider is invoked", async () => {
    const provider = new FakeMoveConnection({ account: ACCOUNT, folders: { [MESSAGE]: "Inbox" } });
    const approved = request("mail.move", { target: "archive" });
    approved.snapshot.input = { message: { ...message, connectionId: "other-connection" }, target: "archive" };
    const result = await binding(provider).connector("mail.move").dispatch!(approved, new AbortController().signal) as OwnerResult;
    expect(result.result.kind).toBe("failed");
    expect(provider.requests.size).toBe(0);
  });

  test("no restore support makes every move unavailable", () => {
    const { connector } = binding(new FakeMoveConnection({ restore: false }));
    for (const id of ["mail.move", "mail.trash", "mail.restore"]) expect(connector(id).dispatch).toBeUndefined();
  });

  test("the admitted snapshot must name its message and exactly one matching account", async () => {
    for (const mode of ["empty", "multiple", "other-account", "no-target"] as const) {
      const provider = new FakeMoveConnection({ account: ACCOUNT, folders: { [MESSAGE]: "Inbox" } });
      const approved = request("mail.move", { target: "archive" });
      if (mode === "empty") approved.snapshot.destinations = [];
      if (mode === "multiple") approved.snapshot.destinations.push({ ...approved.snapshot.destinations[0]! });
      if (mode === "other-account") approved.snapshot.destinations[0]!.canonicalId = "other-account";
      if (mode === "no-target") delete approved.snapshot.target;
      const result = await binding(provider).connector("mail.move").dispatch!(approved, new AbortController().signal) as OwnerResult;
      expect(result.result.kind).toBe("failed");
      expect(provider.effects).toHaveLength(0);
      expect(provider.requests.size).toBe(0);
    }
  });

  test("timeout stays uncertain, and a fresh binding can read the provider's historical outcome", async () => {
    const provider = new FakeMoveConnection({ account: ACCOUNT, folders: { [MESSAGE]: "Inbox" }, timeoutAfterEffect: true });
    const approved = request("mail.move", { target: "archive" });
    const first = await binding(provider).connector("mail.move").dispatch!(approved, new AbortController().signal) as OwnerResult;
    expect(first.result.kind).toBe("uncertain");
    expect(provider.effects).toHaveLength(1);
    const fresh = binding(provider, approved).connector("mail.move");
    const lookup = await fresh.lookup!({ lifecycleVersion: "1.0.0", operationId: approved.operationId, ownerRequestId: approved.ownerRequestId }, new AbortController().signal) as OperationLookup;
    expect(lookup.result.kind).toBe("known");
    if (lookup.result.kind !== "known") throw new Error("Expected the historical owner result");
    expect(lookup.result.response.result.kind).toBe("succeeded");
    expect(lookup.result.response.attemptId).toBe(approved.attemptId);
    expect(lookup.result.response.snapshotDigest).toBe(approved.snapshot.digest);
    expect(provider.effects).toHaveLength(1);
  });

  test("a historical lookup cannot substitute another account's outcome", async () => {
    const provider = new FakeMoveConnection({ account: ACCOUNT, folders: { [MESSAGE]: "Inbox" } });
    const approved = request("mail.move", { target: "archive" });
    await binding(provider).connector("mail.move").dispatch!(approved, new AbortController().signal);
    const stored = provider.requests.values().next().value!;
    if (stored.result.status !== "moved") throw new Error("Expected a saved move");
    stored.result.account = "other-account";
    const lookup = await binding(provider, approved).connector("mail.move").lookup!({ lifecycleVersion: "1.0.0", operationId: approved.operationId, ownerRequestId: approved.ownerRequestId }, new AbortController().signal) as OperationLookup;
    expect(lookup.result.kind).toBe("unknown");
    expect(provider.effects).toHaveLength(1);
  });

  test("a historical lookup cannot substitute another action's success", async () => {
    for (const action of ["move", "restore"] as const) {
      const provider = new FakeMoveConnection({ account: ACCOUNT, folders: { [MESSAGE]: action === "restore" ? "Archive" : "Inbox" }, previousFolders: { [MESSAGE]: "Inbox" } });
      const approved = request(`mail.${action}`, action === "restore" ? { from: "Archive" } : { target: "archive" });
      await binding(provider).connector(`mail.${action}`).dispatch!(approved, new AbortController().signal);
      const stored = provider.requests.values().next().value!;
      if (stored.result.status !== "moved" && stored.result.status !== "restored") throw new Error("Expected a saved mutation");
      stored.result.status = action === "restore" ? "moved" : "restored";
      const lookup = await binding(provider, approved).connector(`mail.${action}`).lookup!({ lifecycleVersion: "1.0.0", operationId: approved.operationId, ownerRequestId: approved.ownerRequestId }, new AbortController().signal) as OperationLookup;
      expect(lookup.result.kind).toBe("unknown");
      expect(provider.effects).toHaveLength(1);
    }
  });
});
