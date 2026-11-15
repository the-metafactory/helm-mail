import { expect, test } from "bun:test";
import { createDeskAdapter } from "../src/adapter-actions/backend";
import { fakeBridge } from "./fixtures/mail-source";
import { probeUnsubscribe } from "../scripts/probe-unsubscribe";

test("packaged unsubscribe uses real journal, fake-provider message suppression and strict historical recovery", async () => {
  const result = await probeUnsubscribe();
  expect(result.effects).toBe(1);
  expect(new Set(result.distinctRequestIds).size).toBe(2);
}, 20_000);

test("unsubscribe exposes conservative historical lifecycle without undo", () => {
  const factories = new Map<string, import("@the-metafactory/cortex/desk-sdk").DeskConnectorFactory>();
  const { host } = fakeBridge({ "connection-example": "account-example" });
  createDeskAdapter({ ...host, registerConnector: (id, factory) => { factories.set(id, factory); }, mailExecution: { connection: () => ({ version: 1, methods: ["unsubscribe", "lookupUnsubscribe"] }), invoke: async () => { throw new Error("No metadata mutation"); }, lookupContext: async () => { throw new Error("No metadata lookup"); } } });
  const connector = factories.get("mail.unsubscribe")!({ adapterId: "mail", connectionId: "connection-example" });
  expect(connector.support?.dedup).toEqual({ kind: "none" });
  expect(connector.support?.operationLookup).toBe("historical");
  expect(connector.support?.cancellation).toBe("none");
  expect(connector.support?.compensationCapabilityId).toBeUndefined();
  expect(connector.cancel).toBeUndefined();
});
