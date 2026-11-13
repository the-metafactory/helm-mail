import { callDraft, callLookup, type DraftRequest, type MailConnection } from "./interface";
import type { Check } from "./conformance";

export interface DraftSnapshot {
  id: string;
  account: string;
  requestId: string;
  messageId: string;
  recipient: string;
  subject: string;
  body: string;
  unsent: boolean;
}

export interface TestMailboxFixture {
  testMailbox: true;
  connection: MailConnection;
  request: DraftRequest;
  inspect(requestId: string): Promise<readonly DraftSnapshot[]>;
  remove(draft: DraftSnapshot): Promise<void>;
  timeoutMs?: number;
}

export async function runMailboxConformance(fixture: TestMailboxFixture): Promise<Check[]> {
  if (fixture.testMailbox !== true) throw new Error("An explicitly designated test mailbox is required");
  const { connection, request } = fixture;
  const removedRequest = { ...request, requestId: `${request.requestId}.removed` };
  const timeout = fixture.timeoutMs ?? 5000;
  const checks: Check[] = [];
  const record = (name: string, pass: boolean) => checks.push({ name, pass });
  const matches = (draft: DraftSnapshot, r: DraftRequest, id: string) =>
    draft.id === id && draft.account === r.account && draft.requestId === r.requestId &&
    draft.messageId === r.messageId && draft.recipient === r.recipient &&
    draft.subject === r.subject && draft.body === r.body && draft.unsent === true;

  for (const r of [request, removedRequest]) {
    const lookup = await callLookup(connection, r.requestId, timeout);
    const drafts = await fixture.inspect(r.requestId);
    if (lookup.kind !== "not_found" || drafts.length !== 0) {
      record("mailbox: request IDs are unused before the probe", false);
      return checks;
    }
  }

  const first = await callDraft(connection, request, timeout);
  const drafts = await fixture.inspect(request.requestId);
  const created = first.kind === "created" && first.account === request.account &&
    drafts.length === 1 && matches(drafts[0]!, request, first.id);
  record("mailbox: one unsent reply carries the request ID and requested content", created);
  if (!created || first.kind !== "created") return checks;

  const repeat = await callDraft(connection, request, timeout);
  const repeated = await fixture.inspect(request.requestId);
  record("mailbox: repeat returns the same draft without creating another",
    repeat.kind === "exists" && repeat.id === first.id && repeat.account === request.account &&
    repeated.length === 1 && matches(repeated[0]!, request, first.id));

  const conflict = await callDraft(connection, { ...request, body: `${request.body}\nOther content` }, timeout);
  const conflicted = await fixture.inspect(request.requestId);
  record("mailbox: changed content conflicts without changing the draft",
    conflict.kind === "conflict" && conflict.id === first.id && conflict.account === request.account &&
    conflicted.length === 1 && matches(conflicted[0]!, request, first.id));

  const otherAccount = await callDraft(connection, { ...request, account: `${request.account}.other` }, timeout);
  const afterAccountChange = await fixture.inspect(request.requestId);
  record("mailbox: changing the account conflicts without creating another draft",
    otherAccount.kind === "conflict" && otherAccount.id === first.id && otherAccount.account === request.account &&
    afterAccountChange.length === 1 && matches(afterAccountChange[0]!, request, first.id));

  const found = await callLookup(connection, request.requestId, timeout);
  record("mailbox: lookup finds the current draft in the requested account",
    found.kind === "found" && found.id === first.id && found.account === request.account);

  const disposable = await callDraft(connection, removedRequest, timeout);
  const beforeRemoval = await fixture.inspect(removedRequest.requestId);
  const removable = disposable.kind === "created" && beforeRemoval.length === 1 &&
    matches(beforeRemoval[0]!, removedRequest, disposable.id);
  record("mailbox: removal probe creates its own unsent draft", removable);
  if (!removable) return checks;
  await fixture.remove(beforeRemoval[0]!);
  const afterRemoval = await fixture.inspect(removedRequest.requestId);
  const missing = await callLookup(connection, removedRequest.requestId, timeout);
  record("mailbox: manual removal gives not_found without a historical assertion",
    afterRemoval.length === 0 && missing.kind === "not_found");
  return checks;
}
