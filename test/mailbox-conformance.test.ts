import { expect, test } from "bun:test";
import { sampleRequest } from "../src/conformance";
import { runMailboxConformance, type DraftSnapshot, type TestMailboxFixture } from "../src/mailbox-conformance";
import type { DraftRequest } from "../src/interface";

function makeFixture(): TestMailboxFixture & { drafts: DraftSnapshot[] } {
  const drafts: DraftSnapshot[] = [];
  let counter = 0;
  return {
    testMailbox: true,
    request: sampleRequest(),
    drafts,
    connection: {
      version: 1,
      async draft(request: DraftRequest) {
        const existing = drafts.find((d) => d.requestId === request.requestId);
        if (existing) return {
          status: existing.body === request.body && existing.account === request.account ? "exists" : "conflict", id: existing.id, account: existing.account,
        };
        const draft = { ...request, id: `draft-${++counter}`, unsent: true };
        drafts.push(draft);
        return { status: "created", id: draft.id, account: draft.account };
      },
      async lookup(requestId: string) {
        const draft = drafts.find((d) => d.requestId === requestId);
        return draft ? { status: "found", id: draft.id, account: draft.account } : { status: "not_found" };
      },
    },
    async inspect(requestId) { return drafts.filter((d) => d.requestId === requestId); },
    async remove(draft) { drafts.splice(drafts.indexOf(draft), 1); },
  };
}

test("mailbox conformance verifies provider state and leaves the primary draft for inspection", async () => {
  const fixture = makeFixture();
  const checks = await runMailboxConformance(fixture);
  expect(checks).toHaveLength(7);
  for (const check of checks) expect(check.pass, check.name).toBe(true);
  expect(fixture.drafts).toHaveLength(1);
  expect(fixture.drafts[0]!.requestId).toBe(fixture.request.requestId);
});

test("mailbox conformance catches duplicate drafts despite an exists reply", async () => {
  const fixture = makeFixture();
  const original = fixture.connection.draft.bind(fixture.connection);
  let calls = 0;
  fixture.connection.draft = async (r) => {
    const result = await original(r);
    if (++calls === 2) fixture.drafts.push({ ...fixture.drafts[0]! });
    return result;
  };
  const checks = await runMailboxConformance(fixture);
  expect(checks.find((c) => c.name.startsWith("mailbox: repeat"))?.pass).toBe(false);
});

test("mailbox conformance catches stale lookup after provider removal", async () => {
  const fixture = makeFixture();
  const original = fixture.connection.lookup.bind(fixture.connection);
  fixture.connection.lookup = async (id) => id.endsWith(".removed") && fixture.drafts.length
    ? { status: "found", id: "stale", account: "account-1" } : original(id);
  const checks = await runMailboxConformance(fixture);
  expect(checks.find((c) => c.name.startsWith("mailbox: manual removal"))?.pass).toBe(false);
});

test("mailbox conformance requires an explicit test designation and unused IDs", async () => {
  const fixture = makeFixture();
  await expect(runMailboxConformance({ ...fixture, testMailbox: false } as unknown as TestMailboxFixture)).rejects.toThrow("test mailbox");
  await fixture.connection.draft(fixture.request);
  const checks = await runMailboxConformance(fixture);
  expect(checks).toEqual([{ name: "mailbox: request IDs are unused before the probe", pass: false }]);
  expect(fixture.drafts).toHaveLength(1);
});

test("mailbox conformance catches wrong content and sent messages from provider inspection", async () => {
  for (const change of [{ unsent: false }, { account: "wrong-account" }, { messageId: "wrong-thread" }, { body: "changed" }]) {
    const fixture = makeFixture();
    const inspect = fixture.inspect.bind(fixture);
    fixture.inspect = async (id) => (await inspect(id)).map((d) => ({ ...d, ...change }));
    const checks = await runMailboxConformance(fixture);
    expect(checks[0]!.pass).toBe(false);
  }
});
