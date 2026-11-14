import { describe, expect, test } from "bun:test";
import type { DeskAdapterHost, QueryFetchRequest } from "@the-metafactory/cortex/desk-sdk";
import { createDeskAdapter } from "../src/adapter/backend";
import { CAPABILITIES } from "../src/adapter/manifest";
import { ACCOUNT_ONE, ACCOUNT_TWO, BODY_CANARY, SHARED_ID, fakeBridge, item } from "./fixtures/mail-source";

const mailbox = (connectionId: string) => ({ adapterId: "mail", connectionId, objectType: "mailbox", canonicalId: "inbox" });
const request = (connectionId: string, input: Record<string, unknown> = {}, extra: Partial<QueryFetchRequest> = {}): QueryFetchRequest => ({
  readVersion: "1.0.0", queryId: "q", capabilityId: CAPABILITIES.listed, input: input as QueryFetchRequest["input"], destinations: [mailbox(connectionId)], limit: 20, ...extra,
});
interface Page { payload: { items: { messageId: string; account: string; from: unknown; subject: string; receivedAt: string; firstParagraph: string }[]; health: string }; annotations: { ref: { adapterId: string; connectionId: string; objectType: string; canonicalId: string }; evidence: { observedAt: string } }[]; cursor?: string }

const query = async (host: DeskAdapterHost, req: QueryFetchRequest): Promise<Page> => {
  const handler = createDeskAdapter(host).bindings.handlers[CAPABILITIES.listed];
  return (await handler!(req, new AbortController().signal)) as Page;
};
const fetchWatch = async (host: DeskAdapterHost, connectionId: string) => {
  const binding = createDeskAdapter(host).bindings.observations[CAPABILITIES.watch] as { fetch(r: unknown, s: AbortSignal): Promise<{ payload: { items: unknown[] }; events: { kind: string; ref: { connectionId: string } }[]; coverage: string }> };
  return binding.fetch({ source: { adapterId: "mail", connectionId, destinations: [mailbox(connectionId)] }, mode: "poll", limit: 20 }, new AbortController().signal);
};

describe("the mail adapter's bounded query", () => {
  test("returns sender, subject, date and first paragraph, and never a body", async () => {
    const { host } = fakeBridge({ one: ACCOUNT_ONE }, {
      mail: [{ ...item("<one@example.test>", ACCOUNT_ONE, "Subject one", "Opening line."), body: BODY_CANARY, html: BODY_CANARY } as never],
    });

    const page = await query(host, request("one"));

    expect(page.payload.items).toEqual([{ messageId: "<one@example.test>", account: ACCOUNT_ONE, from: { name: "Sender Example", address: "sender@example.test" }, subject: "Subject one", receivedAt: "2026-11-14T07:00:00.000Z", firstParagraph: "Opening line." }]);
    expect(JSON.stringify(page)).not.toContain(BODY_CANARY);
    expect(page.payload.health).toBe("fresh");
  });

  test("reads one listed mail by Message-ID and nothing else", async () => {
    const { host } = fakeBridge({ one: ACCOUNT_ONE });

    const page = await query(host, request("one", { messageId: SHARED_ID }));

    expect(page.payload.items.map(mail => mail.subject)).toEqual(["Shared subject, account one"]);
    expect((await query(host, request("one", { messageId: "<absent@example.test>" }))).payload.items).toEqual([]);
  });

  test("admits no mail that names no account, none of another account and none of another connection", async () => {
    const { host, listings } = fakeBridge({ one: ACCOUNT_ONE });
    const listing = listings.get("one")!;
    const foreign = { ...listing.mail[0]!, ref: { connection: "other", messageId: "<foreign@example.test>" } };
    const unaccounted = { ...listing.mail[0]!, ref: { connection: "one", messageId: "<orphan@example.test>" }, account: "" };
    const otherAccount = { ...listing.mail[0]!, ref: { connection: "one", messageId: "<elsewhere@example.test>" }, account: ACCOUNT_TWO };
    listings.set("one", { ...listing, mail: [...listing.mail, foreign, unaccounted, otherAccount] });

    const ids = (await query(host, request("one"))).payload.items.map(mail => mail.messageId);

    expect(ids).toEqual(["<one@example.test>", SHARED_ID]);
  });

  test("keeps the same Message-ID under two connections as two objects", async () => {
    const { host } = fakeBridge({ one: ACCOUNT_ONE, two: ACCOUNT_TWO });

    const one = await query(host, request("one", { messageId: SHARED_ID }));
    const two = await query(host, request("two", { messageId: SHARED_ID }));

    expect(one.annotations.map(entry => entry.ref)).toEqual([{ adapterId: "mail", connectionId: "one", objectType: "message", canonicalId: SHARED_ID }]);
    expect(two.annotations.map(entry => entry.ref)).toEqual([{ adapterId: "mail", connectionId: "two", objectType: "message", canonicalId: SHARED_ID }]);
    expect(one.payload.items[0]?.subject).toBe("Shared subject, account one");
    expect(two.payload.items[0]?.subject).toBe("Shared subject, account two");
  });

  test("refuses a request that spans two connections", async () => {
    const { host } = fakeBridge({ one: ACCOUNT_ONE, two: ACCOUNT_TWO });

    await expect(query(host, request("one", {}, { destinations: [mailbox("one"), mailbox("two")] }))).rejects.toThrow("mail.one_connection");
  });

  test("reads a connection the host does not bind as an error, not as empty mail", async () => {
    const { host } = fakeBridge({});

    await expect(query(host, request("unbound"))).rejects.toThrow("mail.not_bound");
  });

  test("pages by cursor within the request's limit", async () => {
    const { host } = fakeBridge({ one: ACCOUNT_ONE });

    const first = await query(host, request("one", {}, { limit: 1 }));
    const second = await query(host, request("one", {}, { limit: 1, cursor: first.cursor }));

    expect(first.payload.items).toHaveLength(1);
    expect(first.cursor).toBe("1");
    expect(second.payload.items.map(mail => mail.messageId)).toEqual([SHARED_ID]);
    expect(second.cursor).toBeUndefined();
  });

  test("shows a stale connection as stale, keeps the last listed mail and reports nothing deleted", async () => {
    const { host } = fakeBridge({ one: ACCOUNT_ONE }, { stale: true });

    const page = await query(host, request("one"));

    expect(page.payload.health).toBe("stale");
    expect(page.payload.items).toHaveLength(2);
    expect(JSON.stringify(page)).not.toContain("deleted");
  });
});

describe("the mail adapter's observation", () => {
  test("keeps an observation of listed mail per connection", async () => {
    const { host } = fakeBridge({ one: ACCOUNT_ONE, two: ACCOUNT_TWO });

    const one = await fetchWatch(host, "one");
    const two = await fetchWatch(host, "two");

    expect(one.coverage).toBe("objects");
    expect(one.events.map(event => [event.kind, event.ref.connectionId])).toEqual([["present", "one"], ["present", "one"]]);
    expect(two.events.map(event => event.ref.connectionId)).toEqual(["two"]);
  });

  test("on a stale connection verifies nothing and deletes nothing", async () => {
    const { host } = fakeBridge({ one: ACCOUNT_ONE }, { stale: true });

    const batch = await fetchWatch(host, "one");

    expect(batch).toMatchObject({ coverage: "none", events: [], payload: { items: [] } });
  });
});
