export const INTERFACE_VERSION = 1;

export const VERBS = ["draft", "lookup"] as const;

export interface DraftRequest {
  version: number;
  requestId: string;
  account: string;
  messageId: string;
  recipient: string;
  subject: string;
  body: string;
}

export type DraftResult = {
  status: "created" | "exists" | "conflict";
  id: string;
  account: string;
};

export type LookupResult =
  | { status: "found"; id: string; account: string }
  | { status: "not_found" }
  | { status: "unavailable" };

export interface MailConnection {
  readonly version?: number;
  draft(request: DraftRequest): Promise<unknown>;
  lookup(requestId: string): Promise<unknown>;
}

export type DraftOutcome =
  | { kind: "created"; id: string; account: string }
  | { kind: "exists"; id: string; account: string }
  | { kind: "conflict"; id: string; account: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "unknown"; reason: string };

export type LookupOutcome =
  | { kind: "found"; id: string; account: string }
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "unsupported"; reason: string }
  | { kind: "unknown"; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function parseDraftResult(raw: unknown): DraftResult | undefined {
  if (!isObject(raw) || !isText(raw.id) || !isText(raw.account)) return undefined;
  if (raw.status !== "created" && raw.status !== "exists" && raw.status !== "conflict") {
    return undefined;
  }
  return { status: raw.status, id: raw.id, account: raw.account };
}

export function parseLookupResult(raw: unknown): LookupResult | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.status === "not_found") return { status: "not_found" };
  if (raw.status === "unavailable") return { status: "unavailable" };
  if (raw.status === "found" && isText(raw.id) && isText(raw.account)) {
    return { status: "found", id: raw.id, account: raw.account };
  }
  return undefined;
}

export function checkVersion(conn: MailConnection): string | undefined {
  if (conn.version === undefined) return "connection declares no version";
  if (conn.version !== INTERFACE_VERSION) {
    return `connection version ${String(conn.version)} is not ${INTERFACE_VERSION}`;
  }
  return undefined;
}

async function guarded(call: () => Promise<unknown>, timeoutMs: number): Promise<
  { ok: true; value: unknown } | { ok: false; reason: string }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
  });
  const run = (async () => {
    try {
      return { ok: true as const, value: await call() };
    } catch (e) {
      return { ok: false as const, reason: `failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function callDraft(
  conn: MailConnection,
  request: DraftRequest,
  timeoutMs = 5000,
): Promise<DraftOutcome> {
  const bad = checkVersion(conn);
  if (bad) return { kind: "unsupported", reason: bad };
  const r = await guarded(() => conn.draft(request), timeoutMs);
  if (!r.ok) return { kind: "unknown", reason: r.reason };
  const parsed = parseDraftResult(r.value);
  if (!parsed) return { kind: "unknown", reason: "unstructured output" };
  return { kind: parsed.status, id: parsed.id, account: parsed.account };
}

export async function callLookup(
  conn: MailConnection,
  requestId: string,
  timeoutMs = 5000,
): Promise<LookupOutcome> {
  const bad = checkVersion(conn);
  if (bad) return { kind: "unsupported", reason: bad };
  const r = await guarded(() => conn.lookup(requestId), timeoutMs);
  if (!r.ok) return { kind: "unknown", reason: r.reason };
  const parsed = parseLookupResult(r.value);
  if (!parsed) return { kind: "unknown", reason: "unstructured output" };
  return parsed.status === "found"
    ? { kind: "found", id: parsed.id, account: parsed.account }
    : { kind: parsed.status };
}
