import { FakeConnection } from "./fake";
import type { UnsubscribeLookup, UnsubscribeRequest, UnsubscribeResult } from "./interface";

export interface OneClickHeaders { listUnsubscribe?: string; listUnsubscribePost?: string }
export function oneClickEndpoint(headers?: OneClickHeaders): URL | undefined {
  if (headers?.listUnsubscribePost?.replace(/\s/g, "").toLowerCase() !== "list-unsubscribe=one-click") return undefined;
  for (const match of headers.listUnsubscribe?.matchAll(/<([^>]{1,2000})>/g) ?? []) {
    try {
      const url = new URL(match[1]!);
      if (url.protocol === "https:" && !url.username && !url.password && !url.hash && url.hostname.endsWith(".example.test") && (!url.port || url.port === "443")) return url;
    } catch {}
  }
  return undefined;
}
export class FakeOneClickEndpoint {
  readonly effects: { url: string; method: string; body: string }[] = [];
  async post(url: URL): Promise<void> {
    if (!url.hostname.endsWith(".example.test")) throw new Error("Only invented fake endpoints are supported.");
    this.effects.push({ url: url.href, method: "POST", body: "List-Unsubscribe=One-Click" });
  }
}
export class FakeUnsubscribeConnection extends FakeConnection {
  readonly requests = new Map<string, Extract<UnsubscribeLookup, { status: "found" }>>();
  private readonly messages: Map<string, OneClickHeaders>;
  private readonly completed = new Map<string, UnsubscribeResult>();
  constructor(readonly endpoint: FakeOneClickEndpoint, readonly ownerAccount: string, messages: Record<string, OneClickHeaders>) {
    super({ account: ownerAccount });
    this.messages = new Map(Object.entries(messages));
  }
  async lookupUnsubscribe(id: string): Promise<unknown> {
    return structuredClone(this.requests.get(id) ?? { status: "not_found" });
  }
  async unsubscribe(request: UnsubscribeRequest): Promise<unknown> {
    const old = this.requests.get(request.requestId);
    if (old) return JSON.stringify(old.request) === JSON.stringify(request) ? structuredClone(old.result) : { status: "conflict" };
    let result: UnsubscribeResult;
    const headers = this.messages.get(request.messageId);
    const endpoint = oneClickEndpoint(headers);
    const messageKey = JSON.stringify([request.account, request.messageId]);
    if (request.version !== 1) result = { status: "unavailable" };
    else if (request.account !== this.ownerAccount) result = { status: "denied" };
    else if (!headers) result = { status: "missing" };
    else if (!endpoint) result = { status: "unavailable" };
    else if (this.completed.has(messageKey)) result = { ...(this.completed.get(messageKey) as Extract<UnsubscribeResult, { host: string }>), status: "exists" };
    else {
      await this.endpoint.post(endpoint);
      result = { status: "unsubscribed", id: request.messageId, account: request.account, host: endpoint.host };
      this.completed.set(messageKey, result);
    }
    this.requests.set(request.requestId, { status: "found", action: "unsubscribe", request: structuredClone(request), result });
    return structuredClone(result);
  }
}
