import { describe, expect, test } from "bun:test";
import type { DeskAdapterHost } from "@the-metafactory/cortex/desk-sdk";
import { JUDGEMENT_CAPABILITIES, JUDGEMENT_UNDO, JUDGEMENT_UNDO_CAPABILITY, withMailJudgements } from "../src/adapter/judgements";
import { createDeskAdapter } from "../src/adapter-actions/backend";
import { connection, connectors, fakeHostStore, probeJudgements } from "../scripts/probe-judgements";
import { fakeBridge } from "./fixtures/mail-source";

const base = () => fakeBridge({ [connection.connectionId]: "account-example" }).host;

describe("Mail judgement capabilities", () => {
  test("every judgement capability is declared with its Undo marking, and the declaration is idempotent", () => {
    const declaration = createDeskAdapter(connectors(base()).hosted).declaration;
    const ids = declaration.capabilities.map(item => item.capabilityId);
    for (const id of JUDGEMENT_CAPABILITIES) expect(ids.filter(x => x === id)).toHaveLength(1);
    expect(JUDGEMENT_UNDO).toEqual({ unimportant: "yes", "block-domain": "yes", correct: "by-correction", "not-phishing": "yes", snooze: "yes", "snooze-cancel": "yes", waiting: "yes", undo: "no" });
    expect(withMailJudgements(declaration).capabilities).toHaveLength(declaration.capabilities.length);
  });

  test("a change reaches the host unchanged, and the adapter keeps no state", async () => {
    const store = fakeHostStore();
    const { hosted, connector } = connectors({ ...base(), mailJudgements: store.bridge });
    createDeskAdapter(hosted);
    const unimportant = connector("mail.judgement.unimportant");
    expect(unimportant.support?.compensationCapabilityId).toBe(JUDGEMENT_UNDO_CAPABILITY);
    expect(connector(JUDGEMENT_UNDO_CAPABILITY).support?.compensationCapabilityId).toBeUndefined();
    const request = { operationId: "o", snapshot: { digest: "d", input: { action: "unimportant", message: { canonicalId: "m" } } } } as never;
    await unimportant.dispatch!(request, new AbortController().signal);
    await unimportant.dispatch!(request, new AbortController().signal);
    expect(store.calls).toEqual([request, request]);
    expect(store.marked.size).toBe(1);
  });

  test("a host without the judgement operation leaves every judgement unavailable with no fallback", () => {
    const { hosted, connector } = connectors(base() as DeskAdapterHost);
    createDeskAdapter(hosted);
    for (const id of JUDGEMENT_CAPABILITIES) {
      const item = connector(id);
      expect(item.support).toBeUndefined();
      expect(item.dispatch).toBeUndefined();
    }
  });

  test("probe lists the declarations and runs one change and its Undo through the host store", async () => {
    expect((await probeJudgements()).calls).toBe(2);
  });
});
