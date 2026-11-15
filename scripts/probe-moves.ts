import { strict as assert } from "node:assert";
import { runMailActionScenario, type MailActionScenarioOptions, type MailActionScenarioReport } from "@the-metafactory/cortex/desk-adapter-conformance";
import { mailMoveSnapshot, mailMessageRef, mailAccountRef, type Json, type MailMoveInput } from "@the-metafactory/cortex/desk-sdk";
import { ACTION_ADAPTER_DIR } from "./build-actions";
import { FakeMoveConnection } from "../src/fake-move";
import type { MoveRequest, RestoreRequest } from "../src/interface";
import { ACCOUNT_ONE, ACCOUNT_TWO, binding, fakeMailSource, item } from "../test/fixtures/mail-source";

const MESSAGE = "<move@example.test>";
const mail = fakeMailSource([binding()], null, [item(MESSAGE, ACCOUNT_ONE, "Example message")]);
const snapshot = (action: "move" | "trash" | "restore", target = "archive"): MailActionScenarioOptions["snapshot"] => context => {
  const message = mailMessageRef(context.adapterId, context.connectionId, MESSAGE);
  const input: MailMoveInput = action === "move" ? { action, message, target: target as "archive" | "junk" } : action === "trash" ? { action, message } : { action, message, from: target };
  return mailMoveSnapshot({ ...context, account: mailAccountRef(context.adapterId, context.connectionId, context.account), input });
};
const fresh = () => new FakeMoveConnection({ account: ACCOUNT_ONE, folders: { [MESSAGE]: "Inbox" } });
const scenario = (provider: ReturnType<NonNullable<MailActionScenarioOptions["execution"]>["connection"]>, action: "move" | "trash" | "restore" = "move", target = "archive", extra: Partial<MailActionScenarioOptions> = {}) => runMailActionScenario(ACTION_ADAPTER_DIR, { capabilityId: `mail.${action}`, mail, snapshot: snapshot(action, target), execution: { connection: () => provider }, ...extra });
const timedProvider = (fake: FakeMoveConnection) => ({ version: 1, move: async (request: MoveRequest) => { await fake.move(request); throw new Error("Synthetic timeout after native result"); }, restore: async (request: RestoreRequest) => { await fake.restore!(request); throw new Error("Synthetic timeout after native result"); }, lookupMove: (id: string) => fake.lookupMove(id) });

function check(report: MailActionScenarioReport, final: string) {
  assert.equal(report.stages.at(-1)?.state, final);
  assert.equal(report.networkRequests, 0);
  assert.equal(report.credentialRequests, 0);
  const attempts = report.stages[0]!.attemptIds;
  assert.equal(attempts.length, 1);
  for (const stage of report.stages) {
    assert.deepEqual(stage.attemptIds, attempts);
    assert.equal(stage.snapshotDigest, report.snapshot.digest);
  }
  const entries = report.events as Record<string, any>[];
  assert.equal(entries.find(entry => entry.event.kind === "approved")!.event.authority.basis.kind, "confirmation");
  for (const entry of entries) {
    const result = entry.event.kind === "owner-result" ? entry.event.response : entry.event.kind === "reconciliation" && entry.event.lookup.result.kind === "known" ? entry.event.lookup.result.response : undefined;
    if (!result) continue;
    assert.equal(result.operationId, report.operationId);
    assert.equal(result.attemptId, attempts[0]);
    assert.equal(result.snapshotDigest, report.snapshot.digest);
  }
  if (final === "succeeded") assert.ok(report.stages.at(-1)!.receipts.length > 0);
}

export async function probeMoves() {
  const reports: Record<string, MailActionScenarioReport> = {};
  for (const [action, target, folder] of [["move", "archive", "Archive"], ["move", "junk", "Junk"], ["trash", "trash", "Trash"]] as const) {
    const fake = fresh();
    const moved = await scenario(fake, action, target, { steps: ["repeat", "restart", "repeat"] });
    check(moved, "succeeded");
    assert.equal(moved.ownerCalls.dispatch, 1);
    assert.equal(fake.effects.length, 1);
    assert.equal(fake.folders.get(MESSAGE), folder);
    const undone = await scenario(fake, "restore", folder, { steps: ["restart", "repeat"] });
    check(undone, "succeeded");
    assert.equal(fake.folders.get(MESSAGE), "Inbox");
    assert.equal(fake.effects.length, 2);
    reports[`${action}-${target}`] = moved;
    reports[`restore-${target}`] = undone;
  }
  const changed = fresh();
  await scenario(changed);
  changed.folders.set(MESSAGE, "Later");
  reports.conflict = await scenario(changed, "restore", "Archive");
  check(reports.conflict, "conflict");
  assert.equal(changed.effects.length, 1);
  assert.equal(changed.folders.get(MESSAGE), "Later");

  for (const [name, fake] of [["missing", new FakeMoveConnection({ account: ACCOUNT_ONE, folders: {} })], ["denied", new FakeMoveConnection({ account: ACCOUNT_TWO, folders: { [MESSAGE]: "Inbox" } })]] as const) {
    const report = await scenario(fake);
    check(report, "failed");
    assert.equal(fake.effects.length, 0);
    reports[name] = report;
  }
  for (const provider of [undefined, { move: async () => ({}), restore: async () => ({}), lookupMove: async () => ({}) }, new FakeMoveConnection({ restore: false }), { version: 1, move: async () => ({}), restore: async () => ({}) }]) {
    for (const action of ["move", "trash", "restore"] as const) {
      const report = await scenario(provider, action, action === "restore" ? "Archive" : "archive");
      assert.equal(report.ownerCalls.dispatch, 0);
      assert.notEqual(report.stages[0]?.state, "succeeded");
    }
  }
  for (const mode of ["empty", "duplicate", "foreign-account", "foreign-message", "no-target"] as const) {
    const fake = fresh();
    const report = await scenario(fake, "move", "archive", { snapshot: context => {
      const value = snapshot("move")(context);
      if (mode === "empty") value.destinations = [];
      if (mode === "duplicate") value.destinations = [...value.destinations, ...value.destinations];
      if (mode === "foreign-account") value.destinations = [mailAccountRef(context.adapterId, context.connectionId, ACCOUNT_TWO)];
      if (mode === "foreign-message") value.target = mailMessageRef(context.adapterId, context.connectionId, "<other@example.test>");
      if (mode === "no-target") delete value.target;
      return value;
    } });
    assert.notEqual(report.stages.at(-1)?.state, "succeeded");
    assert.equal(fake.requests.size, 0);
    assert.equal(fake.effects.length, 0);
    reports[mode] = report;
  }
  const unavailableHistory = fresh();
  reports.unavailableHistory = await scenario({ version: 1, move: (request: MoveRequest) => unavailableHistory.move(request), restore: (request: RestoreRequest) => unavailableHistory.restore!(request), lookupMove: async () => ({ status: "unavailable" }) });
  check(reports.unavailableHistory, "uncertain");
  assert.equal(unavailableHistory.effects.length, 0);
  const interrupted = fresh();
  reports.timeout = await scenario(timedProvider(interrupted), "move", "archive", { steps: ["restart", "reconcile", "restart", "repeat"] });
  check(reports.timeout, "succeeded");
  assert.deepEqual(reports.timeout.stages.map(stage => stage.state), ["uncertain", "uncertain", "succeeded", "succeeded", "succeeded"]);
  assert.equal(reports.timeout.reconstructions, 2);
  assert.equal(reports.timeout.ownerCalls.dispatch, 1);
  assert.equal(reports.timeout.ownerCalls.lookup, 1);
  assert.equal(interrupted.effects.length, 1);
  const noReplay = fresh();
  reports.noReplay = await scenario(timedProvider(noReplay), "move", "archive", { steps: ["repeat"] });
  check(reports.noReplay, "uncertain");
  assert.equal(reports.noReplay.stages[1]?.outcome, "not-dispatchable");
  assert.equal(noReplay.effects.length, 1);

  for (const field of ["action", "messageId", "account", "attemptId", "snapshotDigest", "target"] as const) {
    const fake = fresh();
    const timed = timedProvider(fake);
    reports[`history-${field}`] = await scenario({ ...timed, lookupMove: async (id: string) => {
      const found = await fake.lookupMove(id) as any;
      if (found.status !== "found") return found;
      if (field === "attemptId") found.request.context.attemptId = "another-attempt";
      else if (field === "snapshotDigest") found.request.context.snapshotDigest = "f".repeat(64);
      else found.request[field] = field === "action" ? "trash" : field === "target" ? "junk" : "other";
      return found;
    } }, "move", "archive", { steps: ["restart", "reconcile", "repeat"] });
    check(reports[`history-${field}`]!, "uncertain");
    assert.equal(fake.effects.length, 1);
    assert.equal(reports[`history-${field}`]!.ownerCalls.dispatch, 1);
  }
  const conflictFake = fresh();
  await scenario(conflictFake);
  let conflictLookups = 0;
  const conflictProvider = timedProvider(conflictFake);
  reports.timeoutConflict = await scenario({ ...conflictProvider, lookupMove: async (id: string) => ++conflictLookups === 1 ? { status: "not_found" } : conflictFake.lookupMove(id) }, "move", "junk", { steps: ["restart", "reconcile", "repeat"] });
  check(reports.timeoutConflict, "uncertain");
  assert.ok(reports.timeoutConflict.stages.every(stage => stage.state === "uncertain"));
  assert.equal(conflictFake.effects.length, 1);
  reports.savedMismatch = await scenario(conflictFake, "move", "junk", { steps: ["restart", "reconcile", "repeat"] });
  check(reports.savedMismatch, "uncertain");
  assert.ok(reports.savedMismatch.stages.every(stage => stage.state === "uncertain"));
  assert.equal(conflictFake.effects.length, 1);
  const mismatchEvents = reports.savedMismatch.events as Record<string, any>[];
  assert.ok(mismatchEvents.every(entry => entry.event.kind !== "owner-result" || entry.event.response.result.kind === "uncertain"));
  return { reports, effects: interrupted.effects.length, reconstructionLimit: "Controlled in-process loader/factory/connector/host reconstruction; no OS process termination." };
}
if (import.meta.main) {
  const result = await probeMoves();
  console.log(JSON.stringify({ scenarios: Object.keys(result.reports), timeout: result.reports.timeout!.stages.map(stage => stage.state), effects: result.effects, limit: result.reconstructionLimit }));
}
