import {
  INTERFACE_VERSION,
  type DraftRequest,
  type MailConnection,
} from "./interface";

export type Fault = "none" | "timeout" | "nonzero-exit" | "garbage" | "unavailable";

export interface FakeOptions {
  version?: number | null;
  account?: string;
  fault?: Fault;
}

const contentKey = (r: DraftRequest) =>
  JSON.stringify([r.account, r.messageId, r.recipient, r.subject, r.body]);

export class FakeConnection implements MailConnection {
  readonly version?: number;
  fault: Fault;
  private readonly account: string;
  private readonly drafts = new Map<string, { id: string; key: string; account: string }>();
  private counter = 0;

  constructor(options: FakeOptions = {}) {
    if (options.version !== null) this.version = options.version ?? INTERFACE_VERSION;
    this.account = options.account ?? "account-1";
    this.fault = options.fault ?? "none";
  }

  get draftCount(): number {
    return this.drafts.size;
  }

  async draft(request: DraftRequest): Promise<unknown> {
    const early = await this.applyFault();
    if (early !== undefined) return early;
    const key = contentKey(request);
    const existing = this.drafts.get(request.requestId);
    if (existing) {
      return {
        status: existing.key === key ? "exists" : "conflict",
        id: existing.id,
        account: existing.account,
      };
    }
    const id = `draft-${++this.counter}`;
    this.drafts.set(request.requestId, { id, key, account: request.account || this.account });
    return { status: "created", id, account: request.account || this.account };
  }

  async lookup(requestId: string): Promise<unknown> {
    if (this.fault === "unavailable") return { status: "unavailable" };
    const early = await this.applyFault();
    if (early !== undefined) return early;
    const found = this.drafts.get(requestId);
    return found
      ? { status: "found", id: found.id, account: found.account }
      : { status: "not_found" };
  }

  private async applyFault(): Promise<unknown> {
    switch (this.fault) {
      case "timeout":
        return new Promise(() => {});
      case "nonzero-exit":
        throw new Error("exit code 1");
      case "garbage":
        return "not json";
      default:
        return undefined;
    }
  }
}
