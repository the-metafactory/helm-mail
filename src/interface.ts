export const INTERFACE_VERSION = 1;

export const VERBS = ["draft", "lookup", "move", "restore", "lookup-move"] as const;

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
  | { status: "found"; id: string; account: string; request?: DraftRequest }
  | { status: "not_found" }
  | { status: "unavailable" };

export interface MailConnection {
  readonly version?: number;
  draft(request: DraftRequest): Promise<unknown>;
  lookup(requestId: string): Promise<unknown>;
  move?(request: MoveRequest): Promise<unknown>;
  restore?(request: RestoreRequest): Promise<unknown>;
  lookupMove?(requestId: string): Promise<unknown>;
  unsubscribe?(request: UnsubscribeRequest): Promise<unknown>;
  lookupUnsubscribe?(requestId: string): Promise<unknown>;
  readonly reportKinds?: readonly ReportKind[];
  report?(request: ReportRequest): Promise<unknown>;
  lookupReport?(requestId: string): Promise<unknown>;
}

export interface MoveContext {
  operationId: string;
  attemptId: string;
  snapshotDigest: string;
}

interface MoveBase {
  version: number;
  requestId: string;
  account: string;
  messageId: string;
  context: MoveContext;
}

export interface MoveRequest extends MoveBase {
  action: "move" | "trash";
  target: "archive" | "junk" | "trash";
}

export interface RestoreRequest extends MoveBase {
  action: "restore";
  from: string;
}

export type MoveResult =
  | { status: "moved" | "restored" | "exists"; id: string; account: string; folder: string; previousFolder: string }
  | { status: "missing" | "denied" | "unavailable" }
  | { status: "conflict"; folder: string };

export type MoveLookupResult =
  | { status: "found"; request: MoveRequest | RestoreRequest; result: MoveResult }
  | { status: "not_found" | "unavailable" };

export type MoveOutcome =
  | { kind: "result"; value: MoveResult }
  | { kind: "unknown" | "unsupported"; reason: string };

export type MoveConnection = Pick<MailConnection, "version" | "move" | "restore" | "lookupMove">;

export function moveSupport(conn: MoveConnection): string | undefined {
  return checkVersion(conn) ?? (typeof conn.move !== "function" || typeof conn.restore !== "function" || typeof conn.lookupMove !== "function" ? "connection does not offer move, restore and historical lookup" : undefined);
}

export function parseMoveResult(raw: unknown): MoveResult | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.status === "missing" || raw.status === "denied" || raw.status === "unavailable") return { status: raw.status };
  if (raw.status === "conflict" && isText(raw.folder)) return { status: "conflict", folder: raw.folder };
  if ((raw.status === "moved" || raw.status === "restored" || raw.status === "exists") && isText(raw.id) && isText(raw.account) && isText(raw.folder) && isText(raw.previousFolder)) {
    return { status: raw.status, id: raw.id, account: raw.account, folder: raw.folder, previousFolder: raw.previousFolder };
  }
  return undefined;
}

function moveResultMismatch(request: { action: string; account: string; messageId: string }, value: MoveResult): string | undefined {
  if ((value.status === "moved" || value.status === "restored" || value.status === "exists") && (value.account !== request.account || value.id !== request.messageId)) return "move result belongs to another account or message";
  if ((request.action === "restore" && value.status === "moved") || (request.action !== "restore" && value.status === "restored")) return "move result belongs to another action";
  return undefined;
}

export function parseMoveLookup(raw: unknown): MoveLookupResult | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.status === "not_found" || raw.status === "unavailable") return { status: raw.status };
  const r = raw.request;
  const value = parseMoveResult(raw.result);
  if (raw.status !== "found" || !isObject(r) || !value || r.version !== INTERFACE_VERSION || !isText(r.requestId) || !isText(r.account) || !isText(r.messageId) || !isObject(r.context)) return undefined;
  if (typeof r.action !== "string" || moveResultMismatch({ action: r.action, account: r.account, messageId: r.messageId }, value)) return undefined;
  const c = r.context;
  if (!isText(c.operationId) || !isText(c.attemptId) || typeof c.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.snapshotDigest)) return undefined;
  const base = { version: r.version, requestId: r.requestId, account: r.account, messageId: r.messageId, context: { operationId: c.operationId, attemptId: c.attemptId, snapshotDigest: c.snapshotDigest } };
  if (r.action === "restore" && isText(r.from)) return { status: "found", request: { ...base, action: "restore", from: r.from }, result: value };
  if ((r.action === "move" && (r.target === "archive" || r.target === "junk")) || r.action === "trash" && r.target === "trash") return { status: "found", request: { ...base, action: r.action, target: r.target }, result: value };
  return undefined;
}

export async function callMove(conn: MoveConnection, request: MoveRequest | RestoreRequest, timeoutMs = 5000): Promise<MoveOutcome> {
  const bad = moveSupport(conn);
  if (bad) return { kind: "unsupported", reason: bad };
  const called = await guarded(() => request.action === "restore" ? conn.restore!(request) : conn.move!(request), timeoutMs);
  if (!called.ok) return { kind: "unknown", reason: called.reason };
  const value = parseMoveResult(called.value);
  if (!value) return { kind: "unknown", reason: "unstructured move output" };
  const mismatch = moveResultMismatch(request, value);
  if (mismatch) return { kind: "unknown", reason: mismatch };
  return { kind: "result", value };
}

export async function callMoveLookup(conn: MoveConnection, requestId: string, timeoutMs = 5000): Promise<MoveLookupResult | undefined> {
  if (moveSupport(conn)) return undefined;
  const called = await guarded(() => conn.lookupMove!(requestId), timeoutMs);
  return called.ok ? parseMoveLookup(called.value) : undefined;
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

export function parseDraftRequest(raw: unknown): DraftRequest | undefined {
  if (!isObject(raw) || raw.version !== INTERFACE_VERSION || !isText(raw.requestId) || !/^[A-Za-z0-9._:@-]{1,200}$/.test(raw.requestId)) return undefined;
  if (!isText(raw.account) || !isText(raw.messageId) || !isText(raw.recipient) || !isText(raw.subject) || typeof raw.body !== "string") return undefined;
  return { version: INTERFACE_VERSION, requestId: raw.requestId, account: raw.account, messageId: raw.messageId, recipient: raw.recipient, subject: raw.subject, body: raw.body };
}

export function parseLookupResult(raw: unknown): LookupResult | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.status === "not_found") return { status: "not_found" };
  if (raw.status === "unavailable") return { status: "unavailable" };
  if (raw.status === "found" && isText(raw.id) && isText(raw.account)) {
    const request = raw.request === undefined ? undefined : parseDraftRequest(raw.request);
    if (raw.request !== undefined && !request) return undefined;
    return { status: "found", id: raw.id, account: raw.account, ...(request ? { request } : {}) };
  }
  return undefined;
}

export function checkVersion(conn: Pick<MailConnection, "version">): string | undefined {
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

export interface UnsubscribeRequest {
  version: number;
  requestId: string;
  account: string;
  messageId: string;
  context: MoveContext;
}
export type UnsubscribeResult =
  | { status: "unsubscribed" | "exists"; id: string; account: string; host: string }
  | { status: "missing" | "denied" | "unavailable" | "conflict" };
export type UnsubscribeLookup = { status: "found"; action: "unsubscribe"; request: UnsubscribeRequest; result: UnsubscribeResult } | { status: "not_found" | "unavailable" };

export function parseUnsubscribeResult(raw: unknown): UnsubscribeResult | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.status === "missing" || raw.status === "denied" || raw.status === "unavailable" || raw.status === "conflict") return { status: raw.status };
  if ((raw.status === "unsubscribed" || raw.status === "exists") && isText(raw.id) && isText(raw.account) && isText(raw.host) && raw.host.length <= 200) return { status: raw.status, id: raw.id, account: raw.account, host: raw.host };
  return undefined;
}

export function parseUnsubscribeLookup(raw: unknown): UnsubscribeLookup | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.status === "not_found" || raw.status === "unavailable") return { status: raw.status };
  const r = raw.request;
  const result = parseUnsubscribeResult(raw.result);
  if (raw.status !== "found" || raw.action !== "unsubscribe" || !isObject(r) || !result || r.version !== 1 || !isText(r.requestId) || !isText(r.account) || !isText(r.messageId) || !isObject(r.context)) return undefined;
  const c = r.context;
  if (!isText(c.operationId) || !isText(c.attemptId) || typeof c.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(c.snapshotDigest)) return undefined;
  if ((result.status === "unsubscribed" || result.status === "exists") && (result.id !== r.messageId || result.account !== r.account)) return undefined;
  return { status: "found", action: "unsubscribe", request: { version: 1, requestId: r.requestId, account: r.account, messageId: r.messageId, context: { operationId: c.operationId, attemptId: c.attemptId, snapshotDigest: c.snapshotDigest } }, result };
}

export const REPORT_KINDS = ["draft", "spam", "phishing"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type ProviderReportKind = Exclude<ReportKind, "draft">;
export const isProviderReport = (kind: ReportKind): kind is ProviderReportKind => kind !== "draft";

export interface ReportMessage {
  adapterId: string;
  connectionId: string;
  objectType: "message";
  canonicalId: string;
}

export interface ReportRequest {
  version: number;
  requestId: string;
  kind: ReportKind;
  message: ReportMessage;
}

export interface ReportResult {
  ref: ReportMessage;
  folder: string;
}

export type ReportLookup =
  | { status: "found"; request: ReportRequest; result: ReportResult }
  | { status: "not_found" | "unavailable" };

export type ReportOutcome =
  | { kind: "result"; value: ReportResult }
  | { kind: "unknown" | "unsupported"; reason: string };

export type ReportConnection = Pick<MailConnection, "version" | "reportKinds" | "report" | "lookupReport" | "restore">;

const isReportKind = (v: unknown): v is ReportKind => (REPORT_KINDS as readonly unknown[]).includes(v);

function parseReportMessage(raw: unknown): ReportMessage | undefined {
  if (!isObject(raw) || !isText(raw.adapterId) || !isText(raw.connectionId) || raw.objectType !== "message" || !isText(raw.canonicalId)) return undefined;
  return { adapterId: raw.adapterId, connectionId: raw.connectionId, objectType: "message", canonicalId: raw.canonicalId };
}

export function parseReportRequest(raw: unknown): ReportRequest | undefined {
  if (!isObject(raw) || raw.version !== INTERFACE_VERSION || !isText(raw.requestId) || !isReportKind(raw.kind)) return undefined;
  const message = parseReportMessage(raw.message);
  return message ? { version: INTERFACE_VERSION, requestId: raw.requestId, kind: raw.kind, message } : undefined;
}

export function parseReportResult(raw: unknown): ReportResult | undefined {
  if (!isObject(raw) || !isText(raw.folder) || raw.folder.length > 200) return undefined;
  const ref = parseReportMessage(raw.ref);
  return ref ? { ref, folder: raw.folder } : undefined;
}

export function parseReportLookup(raw: unknown): ReportLookup | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.status === "not_found" || raw.status === "unavailable") return { status: raw.status };
  const request = parseReportRequest(raw.request);
  const result = parseReportResult(raw.result);
  if (raw.status !== "found" || !request || !result) return undefined;
  if (result.ref.canonicalId !== request.message.canonicalId) return undefined;
  return { status: "found", request, result };
}

/** Why a kind is unavailable on a connection, or undefined when it is offered. A provider report also needs restore, because Undo moves the mail back. */
export function reportSupport(conn: ReportConnection, kind: ReportKind): string | undefined {
  const bad = checkVersion(conn);
  if (bad) return bad;
  if (!Array.isArray(conn.reportKinds) || !conn.reportKinds.includes(kind)) return `connection does not declare the ${kind} report`;
  if (typeof conn.report !== "function" || typeof conn.lookupReport !== "function") return "connection does not offer report and historical lookup";
  if (isProviderReport(kind) && typeof conn.restore !== "function") return "connection cannot restore a provider report";
  return undefined;
}

export const availableReportKinds = (conn: ReportConnection): ReportKind[] => REPORT_KINDS.filter(kind => !reportSupport(conn, kind));

export async function callReport(conn: ReportConnection, request: ReportRequest, timeoutMs = 5000): Promise<ReportOutcome> {
  const bad = reportSupport(conn, request.kind);
  if (bad) return { kind: "unsupported", reason: bad };
  const called = await guarded(() => conn.report!(request), timeoutMs);
  if (!called.ok) return { kind: "unknown", reason: called.reason };
  const value = parseReportResult(called.value);
  if (!value) return { kind: "unknown", reason: "unstructured report output" };
  if (value.ref.canonicalId !== request.message.canonicalId) return { kind: "unknown", reason: "report result belongs to another message" };
  return { kind: "result", value };
}

export async function callReportLookup(conn: ReportConnection, kind: ReportKind, requestId: string, timeoutMs = 5000): Promise<ReportLookup | undefined> {
  if (reportSupport(conn, kind)) return undefined;
  const called = await guarded(() => conn.lookupReport!(requestId), timeoutMs);
  return called.ok ? parseReportLookup(called.value) : undefined;
}
