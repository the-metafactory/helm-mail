import { expect, test } from "bun:test";
import { runConformance } from "../src/conformance";
import { FakeConnection } from "../src/fake";
import { callDraft } from "../src/interface";
import { sampleRequest } from "../src/conformance";

test("conformance run passes over the fake connection", async () => {
  const results = await runConformance();
  expect(results.length).toBeGreaterThanOrEqual(6);
  for (const r of results) expect(r.pass, `${r.name} ${r.detail ?? ""}`).toBe(true);
});

test("conformance run reports a miss when the connection is wrong", async () => {
  class Broken extends FakeConnection {
    override async draft(): Promise<unknown> {
      return { status: "created", id: "x", account: "a" };
    }
  }
  const results = await runConformance((o) => new Broken(o));
  expect(results.some((r) => !r.pass)).toBe(true);
});

test("a send method on a connection is caught", async () => {
  class Sender extends FakeConnection {
    async send() {}
  }
  const results = await runConformance((o) => new Sender(o));
  expect(results.find((r) => r.name.startsWith("no send"))?.pass).toBe(false);
});

test("unversioned connection is unsupported, not success", async () => {
  const o = await callDraft(new FakeConnection({ version: null }), sampleRequest());
  expect(o.kind).toBe("unsupported");
});
