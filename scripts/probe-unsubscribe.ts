import { strict as assert } from "node:assert";
import { runMailActionScenario, type MailActionScenarioOptions, type MailActionScenarioReport } from "@the-metafactory/cortex/desk-adapter-conformance";
import { mailUnsubscribeSnapshot, mailMessageRef } from "@the-metafactory/cortex/desk-sdk";
import { ACTION_ADAPTER_DIR } from "./build-actions";
import { FakeOneClickEndpoint, FakeUnsubscribeConnection, oneClickEndpoint, type OneClickHeaders } from "../src/fake-unsubscribe";
import type { UnsubscribeRequest } from "../src/interface";
import { ACCOUNT_ONE, ACCOUNT_TWO, binding, fakeMailSource, item } from "../test/fixtures/mail-source";

const MESSAGE = "<unsubscribe@example.test>";
const HEADERS = { listUnsubscribe: "<https://lists.example.test/remove/token>", listUnsubscribePost: "List-Unsubscribe=One-Click" };
const mail = (headers: OneClickHeaders | undefined = HEADERS) => fakeMailSource([binding()], null, [{ ...item(MESSAGE, ACCOUNT_ONE, "Invented newsletter"), ...(headers ? { headers } : {}) }]);
const snapshot: MailActionScenarioOptions["snapshot"] = c => mailUnsubscribeSnapshot({ ...c, input: { message: mailMessageRef(c.adapterId, c.connectionId, MESSAGE) } });
const bumpedRevision: MailActionScenarioOptions["snapshot"] = c => {
  const s = snapshot(c);
  s.provenance.revision += 1;
  return s;
};
const fresh = (account = ACCOUNT_ONE, messages: Record<string, OneClickHeaders> = { [MESSAGE]: HEADERS }) => new FakeUnsubscribeConnection(new FakeOneClickEndpoint(), account, messages);
const scenario = (provider: ReturnType<NonNullable<MailActionScenarioOptions["execution"]>["connection"]>, extra: Partial<MailActionScenarioOptions> = {}) => runMailActionScenario(ACTION_ADAPTER_DIR, { capabilityId: "mail.unsubscribe", mail: mail(), snapshot, execution: { connection: () => provider }, ...extra });
function check(report: MailActionScenarioReport, final: string) {
  assert.equal(report.stages.at(-1)?.state, final);
  assert.equal(report.networkRequests, 0);
  assert.equal(report.credentialRequests, 0);
  const first = report.stages[0]!;
  for (const stage of report.stages) {
    assert.deepEqual(stage.attemptIds, first.attemptIds);
    assert.equal(stage.snapshotDigest, report.snapshot.digest);
  }
  for (const entry of report.events as Record<string, any>[]) {
    const result = entry.event.kind === "owner-result" ? entry.event.response : entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "known" ? entry.event.lookup.result.response : undefined;
    if (!result) continue;
    assert.equal(result.operationId, report.operationId);
    assert.equal(result.attemptId, first.attemptIds[0]);
    assert.equal(result.snapshotDigest, report.snapshot.digest);
  }
  if (final === "succeeded") assert.ok(report.stages.at(-1)!.receipts.length > 0);
}
const timed = (fake: FakeUnsubscribeConnection) => ({ version: 1, unsubscribe: async (r: UnsubscribeRequest) => { await fake.unsubscribe(r); throw new Error("Synthetic lost response after native result"); }, lookupUnsubscribe: (id: string) => fake.lookupUnsubscribe(id) });
export async function probeUnsubscribe() {
  const reports: Record<string, MailActionScenarioReport> = {};
  const fake = fresh();
  reports.success = await scenario(fake, { steps: ["repeat", "restart", "repeat"] });
  check(reports.success, "succeeded");
  assert.equal(reports.success.ownerCalls.dispatch, 1);
  assert.deepEqual(fake.endpoint.effects, [{ url: "https://lists.example.test/remove/token", method: "POST", body: "List-Unsubscribe=One-Click" }]);
  const events = reports.success.events as Record<string, any>[];
  const approved = events.find(e => e.event.kind === "approved");
  assert.equal(approved!.event.authority.basis.kind, "confirmation");
  const saved = [...fake.requests.values()][0]!;
  assert.ok(saved.request.requestId.startsWith("mail.unsubscribe:"));
  const second = { ...structuredClone(saved.request), requestId: "mail.unsubscribe:distinct-fresh-press", context: { ...saved.request.context, operationId: "fresh-operation", attemptId: "fresh-attempt" } };
  const repeated = await fake.unsubscribe(second) as { status: string };
  assert.equal(repeated.status, "exists");
  assert.notEqual(second.requestId, saved.request.requestId);
  assert.equal(fake.endpoint.effects.length, 1);
  assert.equal(fake.requests.size, 2);
  const historical = await fake.lookupUnsubscribe(second.requestId) as any;
  assert.deepEqual(historical.request, second);
  assert.equal(historical.result.host, "lists.example.test");

  for (const [name, provider] of [["denied", fresh(ACCOUNT_TWO)], ["missing", fresh(ACCOUNT_ONE, {})], ["nativeNoHeader", fresh(ACCOUNT_ONE, { [MESSAGE]: {} as typeof HEADERS })]] as const) {
    reports[name] = await scenario(provider);
    check(reports[name]!, "failed");
    assert.equal(provider.endpoint.effects.length, 0);
  }
  for (const [name, headers] of [["noHeader", {}], ["invalidHeader", { listUnsubscribe: "<http://lists.example.test/remove>", listUnsubscribePost: "List-Unsubscribe=One-Click" }], ["noPost", { listUnsubscribe: HEADERS.listUnsubscribe }]] as const) {
    const provider = fresh();
    reports[name] = await scenario(provider, { mail: mail(headers) });
    check(reports[name]!, "failed");
    assert.equal(provider.endpoint.effects.length, 0);
    assert.equal(provider.requests.size, 0);
  }
  for (const headers of [HEADERS, { ...HEADERS, listUnsubscribe: "<https://user:pass@lists.example.test/remove>" }, { ...HEADERS, listUnsubscribe: "<https://lists.example.test/remove#fragment>" }, { ...HEADERS, listUnsubscribe: "<https://external.invalid/remove>" }]) {
    assert.equal(!!oneClickEndpoint(headers), headers === HEADERS);
  }
  for (const provider of [undefined, { unsubscribe: async () => ({}), lookupUnsubscribe: async () => ({}) }, { version: 2, unsubscribe: async () => ({}), lookupUnsubscribe: async () => ({}) }, { version: 1, unsubscribe: async () => ({}) }]) {
    const report = await scenario(provider);
    assert.equal(report.ownerCalls.dispatch, 0);
    assert.notEqual(report.stages[0]?.state, "succeeded");
  }
  for (const mode of ["account", "target", "destination", "cloud"] as const) {
    const provider = fresh();
    reports[mode] = await scenario(provider, { snapshot: c => {
      const s = snapshot(c);
      if (mode === "account") s.destinations[0]!.canonicalId = ACCOUNT_TWO;
      if (mode === "target") s.target = mailMessageRef(c.adapterId, c.connectionId, "other-message");
      if (mode === "destination") s.destinations = [];
      if (mode === "cloud") s.policy = "cloud";
      return s;
    } });
    assert.notEqual(reports[mode]!.stages.at(-1)?.state, "succeeded");
    assert.equal(provider.endpoint.effects.length, 0);
    assert.equal(provider.requests.size, 0);
  }
  const recovery = fresh();
  reports.timeout = await scenario(timed(recovery), { steps: ["restart", "reconcile", "restart", "repeat"] });
  check(reports.timeout, "succeeded");
  assert.deepEqual(reports.timeout.stages.map(s => s.state), ["uncertain", "uncertain", "succeeded", "succeeded", "succeeded"]);
  assert.equal(reports.timeout.ownerCalls.dispatch, 1);
  assert.equal(reports.timeout.ownerCalls.lookup, 1);
  assert.equal(reports.timeout.reconstructions, 2);
  assert.equal(recovery.endpoint.effects.length, 1);
  for (const field of ["action", "messageId", "account", "operationId", "attemptId", "snapshotDigest", "host"] as const) {
    const provider = fresh();
    reports[`history-${field}`] = await scenario({ ...timed(provider), lookupUnsubscribe: async (id: string) => {
      const found = await provider.lookupUnsubscribe(id) as any;
      if (found.status !== "found") return found;
      if (field === "action") found.action = "move";
      else if (field === "host") found.result.host = "other.example.test";
      else if (["operationId", "attemptId", "snapshotDigest"].includes(field)) found.request.context[field] = field === "snapshotDigest" ? "f".repeat(64) : "other";
      else found.request[field] = "other";
      return found;
    } }, { steps: ["restart", "reconcile", "repeat"] });
    check(reports[`history-${field}`]!, "uncertain");
    assert.equal(provider.endpoint.effects.length, 1);
  }
  for (const [name, lookupUnsubscribe] of [["unknownHistory", async () => ({ status: "unavailable" })], ["rejectedHistory", async () => { throw new Error("Synthetic rejected history"); }], ["malformedHistory", async () => ({ status: "found" })]] as const) {
    const provider = fresh();
    reports[name] = await scenario({ ...timed(provider), lookupUnsubscribe }, { steps: ["restart", "reconcile", "repeat"] });
    check(reports[name]!, "uncertain");
    assert.equal(provider.endpoint.effects.length, 0);
  }
  for (const mode of ["unavailable", "reject", "malformed"] as const) {
    const provider = fresh();
    let reads = 0;
    reports[`lost-${mode}`] = await scenario({ ...timed(provider), lookupUnsubscribe: async (id: string) => {
      if (++reads === 1) return provider.lookupUnsubscribe(id);
      if (mode === "reject") throw new Error("Synthetic recovery failure");
      return mode === "unavailable" ? { status: "unavailable" } : { status: "found" };
    } }, { steps: ["restart", "reconcile", "repeat"] });
    check(reports[`lost-${mode}`]!, "uncertain");
    assert.equal(provider.endpoint.effects.length, 1);
  }
  reports.savedMismatch = await scenario(fake, { snapshot: bumpedRevision, steps: ["restart", "reconcile", "repeat"] });
  check(reports.savedMismatch, "uncertain");
  assert.equal(fake.endpoint.effects.length, 1);
  let lookups = 0;
  reports.timeoutConflict = await scenario({ ...timed(fake), lookupUnsubscribe: async (id: string) => ++lookups === 1 ? { status: "not_found" } : fake.lookupUnsubscribe(id) }, { snapshot: bumpedRevision, steps: ["restart", "reconcile", "repeat"] });
  check(reports.timeoutConflict, "uncertain");
  assert.equal(fake.endpoint.effects.length, 1);
  return { reports, effects: recovery.endpoint.effects.length, distinctRequestIds: [saved.request.requestId, second.requestId], transport: "Injected fake endpoint records POST effects; no HTTP/TLS connection.", limit: "Controlled in-process reconstruction; no OS termination, concurrency or retention guarantee." };
}
if (import.meta.main) {
  const result = await probeUnsubscribe();
  console.log(JSON.stringify({ scenarios: Object.keys(result.reports), timeout: result.reports.timeout!.stages.map(s => s.state), effects: result.effects, distinctRequestIds: result.distinctRequestIds, transport: result.transport, limit: result.limit }));
}
