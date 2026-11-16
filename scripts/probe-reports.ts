import { strict as assert } from "node:assert";
import { runMailActionScenario, type MailActionScenarioOptions, type MailActionScenarioReport } from "@the-metafactory/cortex/desk-adapter-conformance";
import { mailAccountRef, mailMessageRef, mailMoveSnapshot, mailReportSnapshot, type MailReportKind } from "@the-metafactory/cortex/desk-sdk";
import { ACTION_ADAPTER_DIR } from "./build-actions";
import { FakeReportConnection } from "../src/fake-report";
import { ACCOUNT_ONE, ACCOUNT_TWO, binding, fakeMailSource, item } from "../test/fixtures/mail-source";

const MESSAGE = "<report@example.test>";
const mail = fakeMailSource([binding()], null, [item(MESSAGE, ACCOUNT_ONE, "Example message")]);
const reportSnapshot = (kind: MailReportKind): MailActionScenarioOptions["snapshot"] => context => mailReportSnapshot({ ...context, kind, input: { message: mailMessageRef(context.adapterId, context.connectionId, MESSAGE) } });
const restoreSnapshot = (from: string): MailActionScenarioOptions["snapshot"] => context => mailMoveSnapshot({ ...context, account: mailAccountRef(context.adapterId, context.connectionId, context.account), input: { action: "restore", message: mailMessageRef(context.adapterId, context.connectionId, MESSAGE), from } });
const fresh = (extra: ConstructorParameters<typeof FakeReportConnection>[0] = {}) => new FakeReportConnection({ account: ACCOUNT_ONE, folders: { [MESSAGE]: "Inbox" }, ...extra });
type Provider = ReturnType<NonNullable<MailActionScenarioOptions["execution"]>["connection"]>;
const run = (provider: Provider, capabilityId: string, snapshot: MailActionScenarioOptions["snapshot"], extra: Partial<MailActionScenarioOptions> = {}): Promise<MailActionScenarioReport> => runMailActionScenario(ACTION_ADAPTER_DIR, { capabilityId, mail: extra.mail ?? mail, snapshot, execution: { connection: () => provider }, ...extra });

export async function probeReports() {
  const reports: Record<string, MailActionScenarioReport> = {};

  const drafted = fresh();
  reports.draft = await run(drafted, "mail.report.draft", reportSnapshot("draft"), { steps: ["repeat", "restart", "repeat"] });
  assert.equal(reports.draft.stages.at(-1)?.state, "succeeded");
  assert.equal(drafted.reportDrafts.length, 1);
  assert.deepEqual(drafted.reportDrafts[0], { requestId: drafted.reportDrafts[0]!.requestId, messageId: MESSAGE, attachedOriginal: MESSAGE, folder: "Drafts", sent: false });
  assert.equal(drafted.sent.length, 0);
  assert.equal(drafted.submissions.length, 0);
  assert.equal(drafted.folders.get(MESSAGE), "Inbox");

  for (const kind of ["spam", "phishing"] as const) {
    const fake = fresh();
    reports[kind] = await run(fake, `mail.report.${kind}`, reportSnapshot(kind), { steps: ["repeat", "restart", "repeat"] });
    assert.equal(reports[kind]!.stages.at(-1)?.state, "succeeded");
    assert.equal(fake.submissions.length, 1);
    assert.equal(fake.submissions[0]!.kind, kind);
    assert.equal(fake.folders.get(MESSAGE), "Junk");
    const undone = await run(fake, "mail.restore", restoreSnapshot("Junk"));
    assert.equal(undone.stages.at(-1)?.state, "succeeded");
    assert.equal(fake.folders.get(MESSAGE), "Inbox");
    assert.equal(fake.submissions.length, 1, "Undo restores the location and does not retract the report");
    reports[`undo-${kind}`] = undone;
  }

  const absent = fakeMailSource([binding()], null, []);
  const foreign: (kind: MailReportKind) => MailActionScenarioOptions["snapshot"] = kind => context => {
    const value = reportSnapshot(kind)(context);
    value.destinations = [mailAccountRef(context.adapterId, context.connectionId, ACCOUNT_TWO)];
    return value;
  };
  for (const name of ["missing", "denied"] as const) {
    for (const kind of ["draft", "spam"] as const) {
      const fake = fresh();
      const report = name === "missing" ? await run(fake, `mail.report.${kind}`, reportSnapshot(kind), { mail: absent }) : await run(fake, `mail.report.${kind}`, foreign(kind));
      if (name === "missing") assert.equal(report.stages.at(-1)?.state, "failed");
      else assert.notEqual(report.stages.at(-1)?.state, "succeeded");
      assert.equal(fake.reported.size, 0);
      assert.equal(fake.reportDrafts.length + fake.submissions.length, 0);
      assert.equal(fake.folders.get(MESSAGE), "Inbox");
      reports[`${name}-${kind}`] = report;
    }
  }

  const noRestore = fresh();
  const draftOnly = { version: 1, report: (r: never) => noRestore.report(r), lookupReport: (id: string) => noRestore.lookupReport!(id) };
  reports.unavailableSpam = await run(draftOnly, "mail.report.spam", reportSnapshot("spam"));
  assert.notEqual(reports.unavailableSpam.stages.at(-1)?.state, "succeeded");
  assert.equal(reports.unavailableSpam.ownerCalls.dispatch, 0);
  assert.equal(noRestore.reported.size, 0);
  reports.draftWithoutRestore = await run(draftOnly, "mail.report.draft", reportSnapshot("draft"));
  assert.equal(reports.draftWithoutRestore.stages.at(-1)?.state, "succeeded");
  assert.equal(noRestore.reportDrafts.length, 1);

  const interrupted = fresh({ timeoutAfterReport: true });
  const timed = { version: 1, report: async (r: never) => { await Promise.race([interrupted.report(r), new Promise(done => setTimeout(done, 20))]); throw new Error("Synthetic timeout after native result"); }, lookupReport: (id: string) => interrupted.lookupReport!(id), restore: interrupted.restore!, lookupMove: (id: string) => interrupted.lookupMove(id) };
  reports.timeout = await run(timed, "mail.report.spam", reportSnapshot("spam"), { steps: ["restart", "reconcile"] });
  assert.equal(reports.timeout.stages.at(-1)?.state, "succeeded");
  assert.equal(interrupted.submissions.length, 1);
  return { reports };
}

if (import.meta.main) {
  const { reports } = await probeReports();
  console.log(JSON.stringify({ scenarios: Object.keys(reports), timeout: reports.timeout!.stages.map(stage => stage.state) }));
}
