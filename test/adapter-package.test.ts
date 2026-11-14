import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DESK_ADAPTER_SDK_VERSION, runConformance } from "@the-metafactory/cortex/desk-adapter-conformance";
import { ADAPTER_DIR, buildAdapter } from "../scripts/build-adapter";
import { binding, fakeMailSource } from "./fixtures/mail-source";

describe("the packaged mail adapter", () => {
  test("the committed package is what the build produces", async () => {
    const built = await buildAdapter();

    for (const [name, content] of Object.entries(built)) expect(readFileSync(join(ADAPTER_DIR, name), "utf8")).toBe(content);
  });

  test("is conformant over a fake Mail source, for a local and a cloud connection, with no network use", async () => {
    for (const dataPolicy of [undefined, "cloud"] as const) {
      const report = await runConformance(ADAPTER_DIR, { mail: fakeMailSource([binding(dataPolicy ? { dataPolicy } : {})]) });

      expect(report.status).toBe("conformant");
      expect(report.capabilities.filter(item => item.verdict !== "conformant")).toEqual([]);
      expect(report.networkRequests).toBe(0);
      expect(report.actions).toEqual([]);
    }
  });

  test("stays conformant while its connection is stale", async () => {
    const report = await runConformance(ADAPTER_DIR, { mail: fakeMailSource([binding()], "synthetic provider failure") });

    expect(report.status).toBe("conformant");
  });

  test("reads no mail for a connection the host binds to no Mail source", async () => {
    const report = await runConformance(ADAPTER_DIR, { mail: fakeMailSource([binding({ connectionId: "connection-other" })]) });

    expect(report.status).toBe("refused");
  });

  test("a denied cloud reader is reported when the pinned harness reports one", async () => {
    const report = await runConformance(ADAPTER_DIR, { mail: fakeMailSource([binding()]) });
    const cloud = report.capabilities.filter(item => (item.probe as string) === "cloud-reader");

    if (Number(DESK_ADAPTER_SDK_VERSION.split(".")[1]) >= 7) expect(cloud.length).toBeGreaterThan(0);
    for (const item of cloud) expect(item.verdict).toBe("conformant");
  });

  test("declares only reads: no action, no Day item and no attention mapping", () => {
    const manifest = JSON.parse(readFileSync(join(ADAPTER_DIR, "desk-adapter.json"), "utf8")) as {
      declaration: { capabilities: { kind: string }[] };
      draftingBindings: unknown[];
      readBindings: Record<string, unknown>[];
    };

    expect(manifest.declaration.capabilities.every(capability => capability.kind === "query" || capability.kind === "observation")).toBe(true);
    expect(manifest.draftingBindings).toEqual([]);
    expect(JSON.stringify(manifest).toLowerCase()).not.toMatch(/attention|\bday\b|send/);
    expect(readFileSync(join(ADAPTER_DIR, "backend.mjs"), "utf8")).not.toContain("registerConnector(");
  });
});
