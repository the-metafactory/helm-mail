import { strict as assert } from "node:assert";
import { runMailActionScenario, type MailActionScenarioOptions, type MailActionScenarioReport } from "@the-metafactory/cortex/desk-adapter-conformance";
import { mailInvitationSnapshot, type InvitationAction } from "@the-metafactory/cortex/desk-sdk";
import { ACTION_ADAPTER_DIR } from "./build-actions";
import { FakeInvitationConnection } from "../src/fake-invitation";
import { ACCOUNT_ONE, binding, fakeMailSource, item } from "../test/fixtures/mail-source";

const MESSAGE = "<invite@example.test>";
const INVITATION = "invitation-example";
const mail = fakeMailSource([binding()], null, [item(MESSAGE, ACCOUNT_ONE, "Example invitation")]);
const snapshotFor = (action: InvitationAction, expectedRevision = "1"): MailActionScenarioOptions["snapshot"] => context => mailInvitationSnapshot({ ...context, action, messageId: MESSAGE, invitationId: INVITATION, expectedRevision });
const fresh = (extra: ConstructorParameters<typeof FakeInvitationConnection>[0] = {}) => new FakeInvitationConnection({ account: ACCOUNT_ONE, folders: { [MESSAGE]: "Inbox" }, invitations: { [INVITATION]: {} }, ...extra });
type Provider = ReturnType<NonNullable<MailActionScenarioOptions["execution"]>["connection"]>;
const run = (provider: Provider, action: InvitationAction, expectedRevision = "1", extra: Partial<MailActionScenarioOptions> = {}): Promise<MailActionScenarioReport> => runMailActionScenario(ACTION_ADAPTER_DIR, { capabilityId: `mail.invitation.${action}`, mail, snapshot: snapshotFor(action, expectedRevision), execution: { connection: () => provider }, ...extra });
const last = (report: MailActionScenarioReport) => report.stages.at(-1)?.state;

export async function probeInvitations() {
  const reports: Record<string, MailActionScenarioReport> = {};

  for (const reply of ["accept", "decline", "tentative"] as const) {
    const fake = fresh();
    reports[reply] = await run(fake, reply, "1", { steps: ["repeat", "restart", "repeat"] });
    assert.equal(last(reports[reply]!), "succeeded");
    assert.equal(fake.notifications, 1, "a repeated or restarted reply notifies the organizer once");
    assert.equal(fake.invitationStates.get(INVITATION)!.reply, reply);
  }

  const stale = fresh();
  stale.change(INVITATION);
  reports.stale = await run(stale, "accept");
  assert.equal(last(reports.stale), "conflict");
  assert.equal(stale.notifications, 0);

  const declined = fresh();
  reports.decline2 = await run(declined, "decline");
  assert.equal(last(reports.decline2), "succeeded");
  reports.remove = await run(declined, "remove", "2");
  assert.equal(last(reports.remove), "succeeded");
  assert.equal(declined.invitationStates.get(INVITATION)!.removed, true);
  reports.restore = await run(declined, "restore", "3");
  assert.equal(last(reports.restore), "succeeded");
  assert.equal(declined.invitationStates.get(INVITATION)!.removed, false);
  assert.equal(declined.notifications, 1, "Undo does not notify the organizer");

  const edited = fresh();
  await run(edited, "decline");
  edited.change(INVITATION);
  reports.removeChanged = await run(edited, "remove", "2");
  assert.equal(last(reports.removeChanged), "conflict");
  assert.equal(edited.invitationStates.get(INVITATION)!.removed, false);

  const noRestore = fresh({ eventRestore: false });
  const bare = { version: 1, invitationRemove: (r: never) => noRestore.invitationRemove(r), lookupInvitation: noRestore.lookupInvitation };
  reports.restoreUnavailable = await run(bare, "restore", "1");
  assert.notEqual(last(reports.restoreUnavailable), "succeeded");
  assert.equal(reports.restoreUnavailable.ownerCalls.dispatch, 0);

  const interrupted = fresh({ timeoutAfterInvitation: true });
  const timed = { version: 1, invitationReply: async (r: never) => { await Promise.race([interrupted.invitationReply(r), new Promise(done => setTimeout(done, 20))]); throw new Error("Synthetic timeout after native result"); }, lookupInvitation: interrupted.lookupInvitation };
  reports.timeout = await run(timed, "accept", "1", { steps: ["restart", "reconcile"] });
  assert.equal(last(reports.timeout), "succeeded");
  assert.equal(interrupted.notifications, 1);
  return { reports };
}

if (import.meta.main) {
  const { reports } = await probeInvitations();
  console.log(JSON.stringify({ scenarios: Object.keys(reports), timeout: reports.timeout!.stages.map(stage => stage.state) }));
}
