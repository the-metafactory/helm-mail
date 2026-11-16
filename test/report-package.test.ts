import { expect, test } from "bun:test";
import type { DeskConnectorFactory } from "@the-metafactory/cortex/desk-sdk";
import { probeReports } from "../scripts/probe-reports";
import { createDeskAdapter } from "../src/adapter-actions/backend";
import { declaration } from "../src/adapter-actions/manifest";
import { REPORT_CAPABILITIES } from "../src/adapter/reports";
import { fakeBridge } from "./fixtures/mail-source";

test("actual action package reports through the public production-journal runner", async () => {
  const { reports } = await probeReports();
  expect(reports.timeout!.stages.map(stage => stage.state)).toEqual(["uncertain", "uncertain", "succeeded"]);
}, 30_000);

test("the packaged declaration lists each report kind once, with restore declared a single time", () => {
  const ids = declaration.capabilities.map(capability => capability.capabilityId);
  for (const id of REPORT_CAPABILITIES) expect(ids.filter(item => item === id)).toHaveLength(1);
  expect(ids.filter(item => item === "mail.restore")).toHaveLength(1);
});

test("a connection offering only report and lookup lists the draft report and no provider report", () => {
  const { host } = fakeBridge({ "connection-example": "account-example" });
  const factories = new Map<string, DeskConnectorFactory>();
  host.registerConnector = (id, factory) => { factories.set(id, factory); };
  createDeskAdapter({ ...host, mailExecution: { connection: () => ({ version: 1, methods: ["report", "lookupReport"] }), invoke: async () => { throw new Error("No fixture call"); }, lookupContext: async () => { throw new Error("No fixture lookup"); } } });
  const connection = { adapterId: "mail", connectionId: "connection-example" };
  const draft = factories.get("mail.report.draft")!(connection);
  expect(draft.dispatch).toBeDefined();
  expect(draft.support?.compensationCapabilityId).toBeUndefined();
  expect(factories.get("mail.report.spam")!(connection).dispatch).toBeUndefined();
  expect(factories.get("mail.report.phishing")!(connection).dispatch).toBeUndefined();
});
