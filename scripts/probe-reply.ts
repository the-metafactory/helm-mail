import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMailActionScenario, type MailActionScenarioReport, type MailActionScenarioOptions } from "@the-metafactory/cortex/desk-adapter-conformance";
import { MAIL_REPLY_DRAFT_CAPABILITY, mailReplyDraftSnapshot, mailAccountRef, mailMessageRef, type Json } from "@the-metafactory/cortex/desk-sdk";
import { ACTION_ADAPTER_DIR } from "./build-actions";
import { FakeConnection } from "../src/fake";
import { CliConnection } from "../src/cli";
import { type DraftRequest } from "../src/interface";
import { binding, fakeMailSource, ACCOUNT_ONE, ACCOUNT_TWO, item } from "../test/fixtures/mail-source";

const BODY = "  Exact reply\nwith spaces  ";
const MESSAGE = "<reply@example.test>";
const mail = fakeMailSource([binding()], null, [item(MESSAGE, ACCOUNT_ONE, "Example subject")]);
const snapshotWith = (body: string): MailActionScenarioOptions["snapshot"] => context => mailReplyDraftSnapshot({ ...context, account: mailAccountRef(context.adapterId, context.connectionId, context.account), message: mailMessageRef(context.adapterId, context.connectionId, MESSAGE), body });
const snapshot = snapshotWith(BODY);
const timeoutProvider = (fake: FakeConnection) => ({ version: 1, draft: async (request: DraftRequest) => { await fake.draft(request); throw new Error("Synthetic provider timeout after effect"); }, lookup: (id: string) => fake.lookup(id) });
const scenario = (extra: Partial<MailActionScenarioOptions> = {}) => runMailActionScenario(ACTION_ADAPTER_DIR, { capabilityId: MAIL_REPLY_DRAFT_CAPABILITY, mail, snapshot, ...extra });
const asRecord = (value: Json): Record<string, any> => value as Record<string, any>;

function checkCorrelation(report: MailActionScenarioReport) {
  const stages = report.stages;
  assert.equal(stages.at(-1)?.state, "succeeded");
  const attempts = stages[0]!.attemptIds;
  assert.equal(attempts.length, 1);
  for (const stage of stages) {
    assert.deepEqual(stage.attemptIds, attempts);
    assert.equal(stage.snapshotDigest, report.snapshot.digest);
  }
  const events = report.events.map(asRecord);
  const approval = events.find(entry => entry.event.kind === "approved")!.event;
  assert.equal(approval.snapshot.input.body, BODY);
  assert.equal(approval.authority.basis.kind, "confirmation");
  const results = events.flatMap(entry => entry.event.kind === "owner-result" ? [entry.event.response] : entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "known" ? [entry.event.lookup.result.response] : []);
  assert.ok(results.some(result => result.result.kind === "succeeded"));
  for (const result of results) {
    assert.equal(result.operationId, report.operationId);
    assert.equal(result.attemptId, attempts[0]);
    assert.equal(result.snapshotDigest, report.snapshot.digest);
  }
  assert.equal(report.networkRequests, 0);
  assert.equal(report.credentialRequests, 0);
}

function checkTimeoutRecovery(report: MailActionScenarioReport) {
  checkCorrelation(report);
  assert.deepEqual(report.stages.map(stage => stage.state), ["uncertain", "uncertain", "succeeded", "succeeded", "succeeded"]);
  assert.equal(report.reconstructions, 2);
  assert.equal(report.ownerCalls.dispatch, 1);
  assert.equal(report.ownerCalls.lookup, 1);
}

export async function probeReply() {
  const fake = new FakeConnection();
  const seen: DraftRequest[] = [];
  const provider = { version: 1, draft: async (request: DraftRequest) => { seen.push(request); return fake.draft(request); }, lookup: (id: string) => fake.lookup(id) };
  const success = await scenario({ execution: { connection: () => provider }, steps: ["repeat", "restart", "repeat"] });
  checkCorrelation(success);
  assert.equal(success.stages[0]?.state, "succeeded");
  assert.equal(success.ownerCalls.dispatch, 1);
  assert.equal(fake.draftCount, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.body, BODY);
  assert.equal(seen[0]!.recipient, "sender@example.test");
  assert.equal(seen[0]!.subject, "Re: Example subject");
  assert.equal(seen[0]!.requestId, `${MAIL_REPLY_DRAFT_CAPABILITY}:conformance-request`);

  const interrupted = new FakeConnection();
  const timed = await scenario({ execution: { connection: () => (timeoutProvider(interrupted)) }, steps: ["restart", "reconcile", "restart", "repeat"] });
  checkTimeoutRecovery(timed);
  assert.equal(interrupted.draftCount, 1);

  const replayFake = new FakeConnection();
  const noReplay = await scenario({ execution: { connection: () => (timeoutProvider(replayFake)) }, steps: ["repeat"] });
  assert.deepEqual(noReplay.stages.map(stage => stage.state), ["uncertain", "uncertain"]);
  assert.equal(noReplay.stages[1]?.outcome, "not-dispatchable");
  assert.equal(noReplay.ownerCalls.dispatch, 1);
  assert.equal(replayFake.draftCount, 1);

  let deniedCalls = 0;
  const denied = await scenario({ mail: fakeMailSource([binding(), binding({ connectionId: "connection-other", account: ACCOUNT_TWO })], null, [item(MESSAGE, ACCOUNT_TWO, "Another account")]), execution: { connection: () => ({ version: 1, draft: async () => { deniedCalls++; return {}; }, lookup: async () => ({ status: "not_found" }) }) } });
  assert.notEqual(denied.stages[0]?.state, "succeeded");
  assert.equal(deniedCalls, 0);
  for (const connection of [undefined, { draft: provider.draft, lookup: provider.lookup }, { version: 1, draft: provider.draft }] as const) {
    const unavailable = await scenario({ execution: { connection: () => connection } });
    assert.notEqual(unavailable.stages[0]?.state, "succeeded");
    assert.equal(unavailable.ownerCalls.dispatch, 0);
  }
  assert.equal(seen.length, 1);

  const foreign = await scenario({ execution: { connection: () => provider }, snapshot: context => {
    const approved = snapshot(context);
    return { ...approved, target: { ...approved.target!, connectionId: "foreign-connection" } };
  } });
  assert.equal(foreign.ownerCalls.dispatch, 0);
  assert.equal(seen.length, 1);
  const cloud = await scenario({ execution: { connection: () => provider }, snapshot: context => ({ ...snapshot(context), policy: "cloud" }) });
  assert.equal(cloud.ownerCalls.dispatch, 0);

  const serialRepeat = await scenario({ execution: { connection: () => provider } });
  checkCorrelation(serialRepeat);
  assert.equal(seen.length, 2);
  assert.equal(fake.draftCount, 1);
  const serialConflict = await scenario({ execution: { connection: () => provider }, snapshot: snapshotWith("Different approved content") });
  assert.equal(serialConflict.stages[0]?.state, "conflict");
  assert.equal(seen.length, 3);
  assert.equal(fake.draftCount, 1);

  const timeoutConflict = await scenario({ execution: { connection: () => timeoutProvider(fake) }, snapshot: snapshotWith("Different approved content"), steps: ["restart", "reconcile", "repeat"] });
  assert.equal(timeoutConflict.stages[0]?.state, "uncertain");
  assert.equal(timeoutConflict.stages.at(-1)?.state, "uncertain");
  assert.ok(timeoutConflict.stages.every(stage => stage.state !== "succeeded"));
  assert.equal(fake.draftCount, 1);
  assert.equal(timeoutConflict.ownerCalls.dispatch, 1);
  const legacyFake = new FakeConnection();
  const legacyProvider = timeoutProvider(legacyFake);
  const legacyLookup = await scenario({ execution: { connection: () => ({ ...legacyProvider, lookup: async (id: string) => {
    const found = await legacyFake.lookup(id) as { status: string; id?: string; account?: string };
    return { status: found.status, ...(found.id ? { id: found.id, account: found.account } : {}) };
  } }) }, steps: ["restart", "reconcile", "repeat"] });
  assert.ok(legacyLookup.stages.every(stage => stage.state === "uncertain"));
  assert.equal(legacyFake.draftCount, 1);
  assert.equal(legacyLookup.ownerCalls.dispatch, 1);

  for (const [field, value] of Object.entries({ recipient: "other@example.test", subject: "Different subject", messageId: "<other@example.test>" })) {
    const altered = new FakeConnection();
    const owner = timeoutProvider(altered);
    const mismatched = await scenario({ execution: { connection: () => ({ ...owner, lookup: async (id: string) => {
      const found = await altered.lookup(id) as { status: string; request: DraftRequest };
      return { ...found, request: { ...found.request, [field]: value } };
    } }) }, steps: ["restart", "reconcile", "repeat"] });
    assert.ok(mismatched.stages.every(stage => stage.state === "uncertain"));
    assert.equal(altered.draftCount, 1);
    assert.equal(mismatched.ownerCalls.dispatch, 1);
  }

  const dir = mkdtempSync(join(tmpdir(), "helm-reply-fake-"));
  try {
    const statePath = join(dir, "state.json");
    const cli = new CliConnection({ command: [process.execPath, join(import.meta.dir, "../test/fixtures/reply-native-cli.ts")], env: { HELM_REPLY_FAKE_STATE: statePath }, timeoutMs: 500 });
    const native = await scenario({ execution: { connection: () => cli }, dispatchWaitMs: 2_000, steps: ["restart", "reconcile", "restart", "repeat"] });
    checkTimeoutRecovery(native);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.creates, 1);
    assert.equal(state.lookups, 2);
    assert.deepEqual(state.draft, { id: "fake-native-draft", version: 1, requestId: `${MAIL_REPLY_DRAFT_CAPABILITY}:conformance-request`, account: ACCOUNT_ONE, messageId: MESSAGE, recipient: "sender@example.test", subject: "Re: Example subject", body: BODY });
    assert.ok(!JSON.stringify(state).includes("attemptId"));
    return { success, timed, noReplay, denied, foreign, cloud, serialRepeat, serialConflict, timeoutConflict, legacyLookup, native, effects: { fake: fake.draftCount, timeoutFake: interrupted.draftCount, native: state.creates }, reconstructionLimit: "Controlled in-process loader/factory/connector/host reconstruction; no OS process termination." };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const reports = await probeReply();
  console.log(JSON.stringify({ effects: reports.effects, stages: reports.native.stages.map(stage => stage.state), reconstructions: reports.native.reconstructions, limit: reports.reconstructionLimit }));
}
