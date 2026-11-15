import { strict as assert } from "node:assert";
import type { DeskAdapterHost, DeskConnectorFactory, DispatchRequest, OwnerResult } from "@the-metafactory/cortex/desk-sdk";
import { createDeskAdapter } from "../src/adapter-actions/backend";
import { JUDGEMENT_CAPABILITIES, JUDGEMENT_UNDO, registerMailJudgements } from "../src/adapter/judgements";
import { fakeBridge } from "../test/fixtures/mail-source";

export const connection = { adapterId: "mail", connectionId: "connection-example" };

export function fakeHostStore() {
  const marked = new Set<string>();
  const calls: DispatchRequest[] = [];
  const bridge = {
    async changeJudgement(request: DispatchRequest): Promise<OwnerResult> {
      calls.push(request);
      const input = request.snapshot.input as { action: string; message: { canonicalId: string }; operationId?: string };
      if (input.action === "unimportant") marked.add(input.message.canonicalId);
      if (input.action === "undo") marked.delete(input.message.canonicalId);
      const at = new Date().toISOString();
      return { lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId: `${request.attemptId}:done`, reportedAt: at, result: { kind: "succeeded", output: { ref: input.message, message: "Done.", undo: input.action !== "undo" }, evidence: { kind: "effect", evidenceId: request.operationId, observedAt: at, ownerRequestId: request.ownerRequestId, receipt: { action: input.action }, refs: [input.message], ownerRevision: String(marked.size) } } } as unknown as OwnerResult;
    },
  };
  return { marked, calls, bridge };
}

export function connectors(host: DeskAdapterHost) {
  const factories = new Map<string, DeskConnectorFactory>();
  const hosted = { ...host, registerConnector: (id: string, factory: DeskConnectorFactory) => { factories.set(id, factory); } } as DeskAdapterHost;
  return { hosted, connector: (id: string) => factories.get(id)!(connection) };
}

export async function probeJudgements() {
  const store = fakeHostStore();
  const { host } = fakeBridge({ [connection.connectionId]: "account-example" });
  const { hosted, connector } = connectors({ ...host, mailJudgements: store.bridge });
  const adapter = createDeskAdapter(hosted);
  const declared = adapter.declaration.capabilities.map(item => item.capabilityId).filter(id => JUDGEMENT_CAPABILITIES.includes(id));
  assert.deepEqual(declared, JUDGEMENT_CAPABILITIES);
  for (const [action, undo] of Object.entries(JUDGEMENT_UNDO)) console.log(`mail.judgement.${action}: Undo ${undo}`);
  const message = { ...connection, objectType: "message", canonicalId: "message-example" };
  const run = (capability: string, input: Record<string, unknown>, id: string) => connector(capability).dispatch!({ lifecycleVersion: "1.0.0", operationId: id, attemptId: `attempt-${id}`, idempotencyKey: id, ownerRequestId: id, snapshot: { input, digest: id } as never, authority: {} as never, supportDeclarationId: "mail-judgement-owner", deadlineAt: new Date(Date.now() + 1000).toISOString() }, new AbortController().signal) as Promise<OwnerResult>;
  assert.equal((await run("mail.judgement.unimportant", { action: "unimportant", message }, "one")).result.kind, "succeeded");
  assert.equal(store.marked.has("message-example"), true);
  assert.equal((await run("mail.judgement.undo", { action: "undo", message, operationId: "one" }, "two")).result.kind, "succeeded");
  assert.equal(store.marked.has("message-example"), false);
  return { declared, calls: store.calls.length };
}

if (import.meta.main) {
  const report = await probeJudgements();
  console.log(`Mail judgement probe passed: ${report.declared.length} capabilities declared, one change and its Undo reached the host store (${report.calls} host calls).`);
}
