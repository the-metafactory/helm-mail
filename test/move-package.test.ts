import { expect, test } from "bun:test";
import { probeMoves } from "../scripts/probe-moves";
import { createDeskAdapter } from "../src/adapter-actions/backend";
import { MOVE_CAPABILITIES } from "../src/adapter/moves";
import { fakeBridge } from "./fixtures/mail-source";
import type { DeskConnectorFactory } from "@the-metafactory/cortex/desk-sdk";

test("packaged move lifecycle keeps native guarantees conservative", () => {
  const { host } = fakeBridge({ "connection-example": "account-example" });
  const factories = new Map<string, DeskConnectorFactory>();
  host.registerConnector = (id, factory) => { factories.set(id, factory); };
  createDeskAdapter({ ...host, mailExecution: { connection: () => ({ version: 1, methods: ["move", "restore", "lookupMove"] }), invoke: async () => { throw new Error("No fixture mutation"); }, lookupContext: async () => { throw new Error("No fixture lookup"); } } });
  for (const capabilityId of MOVE_CAPABILITIES) {
    const connector = factories.get(capabilityId)!({ adapterId: "mail", connectionId: "connection-example" });
    expect(connector.support?.dedup).toEqual({ kind: "none" });
    expect(connector.support?.operationLookup).toBe("historical");
    expect(connector.support?.cancellation).toBe("none");
    expect(connector.support?.conditionalUpdate).toBe(capabilityId === "mail.restore" ? "owner-enforced" : "none");
    expect(connector.support?.compensationCapabilityId).toBe(capabilityId === "mail.restore" ? undefined : "mail.restore");
    expect(connector.cancel).toBeUndefined();
  }
});

test("actual action package moves and restores through the public production-journal runner", async () => {
  const report = await probeMoves();
  expect(report.effects).toBe(1);
  expect(report.reports.timeout!.reconstructions).toBe(2);
});
