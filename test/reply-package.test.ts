import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_ADAPTER_DIR, buildActions } from "../scripts/build-actions";
import { probeReply } from "../scripts/probe-reply";
import { createDeskAdapter } from "../src/adapter-actions/backend";
import { MAIL_REPLY_DRAFT_CAPABILITY, type DeskConnectorFactory } from "@the-metafactory/cortex/desk-sdk";
import { fakeBridge } from "./fixtures/mail-source";

describe("inactive reply action package", () => {
  test("the committed action generation is fresh and exports only its factory", async () => {
    for (const [name, bytes] of Object.entries(await buildActions())) expect(readFileSync(join(ACTION_ADAPTER_DIR, name), "utf8")).toBe(bytes);
    const backend = await import(join(ACTION_ADAPTER_DIR, "backend.mjs"));
    expect(Object.keys(backend)).toEqual(["createDeskAdapter"]);
    const manifest = JSON.parse(readFileSync(join(ACTION_ADAPTER_DIR, "desk-adapter.json"), "utf8"));
    expect(manifest.deskSdkRange).toBe("^1.13.0");
    expect(manifest.declaration.capabilities.filter((capability: { kind: string; capabilityId: string }) => capability.kind === "action" && capability.capabilityId === MAIL_REPLY_DRAFT_CAPABILITY).map((capability: { capabilityId: string }) => capability.capabilityId)).toEqual([MAIL_REPLY_DRAFT_CAPABILITY]);
    expect(manifest.declaration.objectTypes.some((object: { objectType: string }) => object.objectType === "account")).toBe(true);
    expect(manifest.readBindings.length).toBe(3);
  });

  test("the lifecycle has historical lookup and makes no concurrent dedup/send/cancel/compensation promise", () => {
    const { host } = fakeBridge({ "connection-example": "account-example" });
    let factory: DeskConnectorFactory | undefined;
    host.registerConnector = (id, create) => { if (id === MAIL_REPLY_DRAFT_CAPABILITY) factory = create; };
    const definition = createDeskAdapter({ ...host, mailExecution: { connection: () => ({ version: 1, methods: ["draft", "lookup"] }), invoke: async () => { throw new Error("No provider may execute in metadata test"); }, lookupContext: async () => { throw new Error("No lookup may execute in metadata test"); } } });
    const connector = factory!({ adapterId: "mail", connectionId: "connection-example" });
    expect(connector.support?.dedup).toEqual({ kind: "none" });
    expect(connector.support?.operationLookup).toBe("historical");
    expect(connector.support?.cancellation).toBe("none");
    expect(connector.support?.compensationCapabilityId).toBeUndefined();
    expect(connector.cancel).toBeUndefined();
    expect(Object.keys(connector)).not.toContain("send");
    expect(definition.bindings.handlers["mail.message.query"]).toBeFunction();
  });

  test("actual packaged binding drives fake/native timeout recovery, exact approval, scope refusal and durable repeat", async () => {
    const report = await probeReply();
    expect(report.effects).toEqual({ fake: 1, timeoutFake: 1, native: 1 });
    expect(report.native.reconstructions).toBe(2);
  });
});
