import { FakeConnection } from "./fake";
import type { MoveRequest, MoveResult, RestoreRequest } from "./interface";

export interface FakeMoveOptions {
  account?: string;
  folders?: Record<string, string>;
  restore?: boolean;
  timeoutAfterEffect?: boolean;
  previousFolders?: Record<string, string>;
}

export class FakeMoveConnection extends FakeConnection {
  readonly folders: Map<string, string>;
  readonly effects: { requestId: string; messageId: string; from: string; to: string }[] = [];
  readonly requests = new Map<string, { request: MoveRequest | RestoreRequest; result: MoveResult }>();
  readonly restore?: (request: RestoreRequest) => Promise<unknown>;
  timeoutAfterEffect: boolean;
  private readonly moveAccount: string;
  protected readonly previous = new Map<string, string>();

  constructor(options: FakeMoveOptions = {}) {
    super({ account: options.account });
    this.moveAccount = options.account ?? "conformance-account";
    this.folders = new Map(Object.entries(options.folders ?? { "conformance-reference": "Inbox" }));
    this.timeoutAfterEffect = options.timeoutAfterEffect ?? false;
    for (const [id, folder] of Object.entries(options.previousFolders ?? {})) this.previous.set(id, folder);
    if (options.restore !== false) this.restore = request => this.perform(request);
  }

  async move(request: MoveRequest): Promise<unknown> {
    return this.perform(request);
  }

  async lookupMove(requestId: string): Promise<unknown> {
    const saved = this.requests.get(requestId);
    return saved ? { status: "found", ...structuredClone(saved) } : { status: "not_found" };
  }

  private async perform(request: MoveRequest | RestoreRequest): Promise<unknown> {
    const old = this.requests.get(request.requestId);
    if (old) {
      const comparable = (r: MoveRequest | RestoreRequest) => JSON.stringify({ ...r, context: { ...r.context, attemptId: "" } });
      return comparable(old.request) === comparable(request) ? structuredClone(old.result) : { status: "conflict", folder: this.folders.get(request.messageId) ?? "unknown" };
    }
    const from = this.folders.get(request.messageId);
    let result: MoveResult;
    if (request.account !== this.moveAccount) result = { status: "denied" };
    else if (from === undefined) result = { status: "missing" };
    else if (request.action === "restore" && from !== request.from) result = { status: "conflict", folder: from };
    else if (request.action === "restore" && !this.previous.has(request.messageId)) result = { status: "unavailable" };
    else {
      const to = request.action === "restore" ? this.previous.get(request.messageId)! : request.target === "junk" ? "Junk" : request.target === "trash" ? "Trash" : "Archive";
      if (request.action !== "restore") this.previous.set(request.messageId, from);
      this.folders.set(request.messageId, to);
      this.effects.push({ requestId: request.requestId, messageId: request.messageId, from, to });
      result = { status: request.action === "restore" ? "restored" : "moved", id: request.messageId, account: request.account, folder: to, previousFolder: from };
    }
    this.requests.set(request.requestId, { request: structuredClone(request), result });
    if (this.timeoutAfterEffect && (result.status === "moved" || result.status === "restored")) return new Promise(() => {});
    return structuredClone(result);
  }
}
