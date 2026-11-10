import { FakeConnection } from "./fake";
import {
  INTERFACE_VERSION,
  VERBS,
  callDraft,
  callLookup,
  type DraftRequest,
} from "./interface";

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export const sampleRequest = (over: Partial<DraftRequest> = {}): DraftRequest => ({
  version: INTERFACE_VERSION,
  requestId: "req-1",
  account: "account-1",
  messageId: "<msg-1@example.invalid>",
  recipient: "to@example.invalid",
  subject: "Subject",
  body: "Body",
  ...over,
});

const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, detail });

export async function runConformance(
  make: (opts?: ConstructorParameters<typeof FakeConnection>[0]) => FakeConnection = (o) =>
    new FakeConnection(o),
): Promise<Check[]> {
  const out: Check[] = [];

  const a = make();
  const first = await callDraft(a, sampleRequest());
  const again = await callDraft(a, sampleRequest());
  out.push(
    check(
      "repeat: same id and content gives one draft and the same id",
      first.kind === "created" &&
        again.kind === "exists" &&
        again.id === first.id &&
        a.draftCount === 1,
      JSON.stringify({ first, again }),
    ),
  );

  const clash = await callDraft(a, sampleRequest({ body: "Other body" }));
  out.push(
    check(
      "conflict: same id with different content is a conflict",
      clash.kind === "conflict" && a.draftCount === 1,
      JSON.stringify(clash),
    ),
  );

  const found = await callLookup(a, "req-1");
  const missing = await callLookup(a, "req-none");
  const down = make({ fault: "unavailable" });
  const unavailable = await callLookup(down, "req-1");
  out.push(
    check(
      "lookup: found, not found and unavailable stay distinct",
      found.kind === "found" &&
        first.kind === "created" &&
        found.id === first.id &&
        missing.kind === "not_found" &&
        unavailable.kind === "unavailable",
      JSON.stringify({ found, missing, unavailable }),
    ),
  );

  const faults = await Promise.all(
    (["timeout", "nonzero-exit", "garbage"] as const).map(async (fault) => {
      const c = make({ fault });
      return [fault, await callDraft(c, sampleRequest(), 50), await callLookup(c, "req-1", 50)] as const;
    }),
  );
  out.push(
    check(
      "timeout: timeout, non-zero exit and unstructured output are unknown",
      faults.every(([, d, l]) => d.kind === "unknown" && l.kind === "unknown"),
      JSON.stringify(faults),
    ),
  );

  const noVersion = await callDraft(make({ version: null }), sampleRequest());
  out.push(
    check("version: a connection with no version is unsupported", noVersion.kind === "unsupported"),
  );

  const verbs = surface(make());
  out.push(
    check(
      "no send: the interface and the fake expose no send verb",
      !VERBS.some((v) => /send/i.test(v)) && !verbs.some((v) => /send/i.test(v)),
      JSON.stringify(verbs),
    ),
  );

  return out;
}

export function surface(c: object): string[] {
  const names = new Set<string>();
  for (let o: object | null = c; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const n of Object.getOwnPropertyNames(o)) {
      if (n !== "constructor" && typeof (c as Record<string, unknown>)[n] === "function") names.add(n);
    }
  }
  return [...names];
}
