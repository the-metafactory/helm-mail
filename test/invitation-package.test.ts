import { expect, test } from "bun:test";
import type { DeskConnectorFactory } from "@the-metafactory/cortex/desk-sdk";
import { probeInvitations } from "../scripts/probe-invitations";
import { createDeskAdapter } from "../src/adapter-actions/backend";
import { declaration } from "../src/adapter-actions/manifest";
import { INVITATION_BINDING_CAPABILITIES } from "../src/adapter/invitations";
import { fakeBridge } from "./fixtures/mail-source";

test("actual action package replies, refuses stale invitations, removes and undoes through the production-journal runner", async () => {
  const { reports } = await probeInvitations();
  expect(reports.stale!.stages.at(-1)?.state).toBe("conflict");
  expect(reports.removeChanged!.stages.at(-1)?.state).toBe("conflict");
  expect(reports.restore!.stages.at(-1)?.state).toBe("succeeded");
  expect(reports.timeout!.stages.map(stage => stage.state)).toEqual(["uncertain", "uncertain", "succeeded"]);
}, 60_000);

test("the packaged declaration lists each invitation action once", () => {
  const ids = declaration.capabilities.map(capability => capability.capabilityId);
  for (const id of INVITATION_BINDING_CAPABILITIES) expect(ids.filter(item => item === id)).toHaveLength(1);
});

test("a connection without event restore offers removal with no Undo, and no restore", () => {
  const { host } = fakeBridge({ "connection-example": "account-example" });
  const factories = new Map<string, DeskConnectorFactory>();
  host.registerConnector = (id, factory) => { factories.set(id, factory); };
  createDeskAdapter({ ...host, mailExecution: { connection: () => ({ version: 1, methods: ["invitationReply", "invitationRemove", "lookupInvitation"] }), invoke: async () => { throw new Error("No fixture call"); }, lookupContext: async () => { throw new Error("No fixture lookup"); } } });
  const connection = { adapterId: "mail", connectionId: "connection-example" };
  const remove = factories.get("mail.invitation.remove")!(connection);
  expect(remove.dispatch).toBeDefined();
  expect(remove.support?.compensationCapabilityId).toBeUndefined();
  expect(factories.get("mail.invitation.restore")!(connection).dispatch).toBeUndefined();
  expect(factories.get("mail.invitation.accept")!(connection).support?.compensationCapabilityId).toBeUndefined();
});

test("a connection with event restore links removal to its restore", () => {
  const { host } = fakeBridge({ "connection-example": "account-example" });
  const factories = new Map<string, DeskConnectorFactory>();
  host.registerConnector = (id, factory) => { factories.set(id, factory); };
  createDeskAdapter({ ...host, mailExecution: { connection: () => ({ version: 1, methods: ["invitationRemove", "invitationRestore", "lookupInvitation"] }), invoke: async () => { throw new Error("No fixture call"); }, lookupContext: async () => { throw new Error("No fixture lookup"); } } });
  const connection = { adapterId: "mail", connectionId: "connection-example" };
  expect(factories.get("mail.invitation.remove")!(connection).support?.compensationCapabilityId).toBe("mail.invitation.restore");
  expect(factories.get("mail.invitation.accept")!(connection).dispatch).toBeUndefined();
});
