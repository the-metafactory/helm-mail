import { FakeReportConnection, type FakeReportOptions } from "./fake-report";
import { InvitationRefusal, parseInvitationRequest, type InvitationLookup, type InvitationRequest, type InvitationResult, type InvitationVerb } from "./interface";

export interface FakeInvitationOptions extends FakeReportOptions {
  invitations?: Record<string, { revision?: string }>;
  eventRestore?: boolean;
  timeoutAfterInvitation?: boolean;
}

export interface FakeInvitationState {
  revision: number;
  reply: "" | "accept" | "decline" | "tentative";
  removed: boolean;
}

export class FakeInvitationConnection extends FakeReportConnection {
  readonly invitationStates = new Map<string, FakeInvitationState>();
  readonly invitationCalls: { requestId: string; verb: InvitationVerb }[] = [];
  readonly invitationHistory = new Map<string, { request: InvitationRequest; result: InvitationResult }>();
  notifications = 0;
  timeoutAfterInvitation: boolean;
  readonly invitationRestore?: (request: InvitationRequest) => Promise<unknown>;
  readonly lookupInvitation = (requestId: string): Promise<unknown> => {
    const saved = this.invitationHistory.get(requestId);
    return Promise.resolve<InvitationLookup>(saved ? { status: "found", ...structuredClone(saved) } : { status: "not_found" });
  };

  constructor(options: FakeInvitationOptions = {}) {
    super(options);
    this.timeoutAfterInvitation = options.timeoutAfterInvitation ?? false;
    for (const [id, state] of Object.entries(options.invitations ?? {})) this.invitationStates.set(id, { revision: Number(state.revision ?? 1), reply: "", removed: false });
    if (options.eventRestore !== false) this.invitationRestore = request => this.act("invitationRestore", request);
  }

  invitationReply(request: InvitationRequest): Promise<unknown> { return this.act("invitationReply", request); }
  invitationRemove(request: InvitationRequest): Promise<unknown> { return this.act("invitationRemove", request); }

  /** Changes the invitation the way the organizer or another client would. */
  change(invitationId: string): void { this.invitationStates.get(invitationId)!.revision++; }

  private async act(verb: InvitationVerb, raw: InvitationRequest): Promise<unknown> {
    const request = parseInvitationRequest(raw);
    if (!request) throw new Error("The invitation request is malformed.");
    const old = this.invitationHistory.get(request.requestId);
    if (old) {
      if (JSON.stringify(old.request) !== JSON.stringify(request)) throw new Error("The request ID names a different invitation call.");
      return structuredClone(old.result);
    }
    const id = request.invitation.canonicalId;
    const state = this.invitationStates.get(id);
    if (!state) throw new InvitationRefusal("missing");
    if (String(state.revision) !== request.expectedRevision) throw new InvitationRefusal("changed", String(state.revision));
    this.invitationCalls.push({ requestId: request.requestId, verb });
    if (verb === "invitationReply") {
      state.reply = request.reply!;
      this.notifications++;
    } else if (verb === "invitationRemove") {
      if (state.reply !== "decline" || state.removed) throw new InvitationRefusal("denied");
      state.removed = true;
    } else state.removed = false;
    state.revision++;
    const result = { ref: structuredClone(request.invitation), revision: String(state.revision) };
    this.invitationHistory.set(request.requestId, { request: structuredClone(request), result });
    if (this.timeoutAfterInvitation) return new Promise(() => {});
    return structuredClone(result);
  }
}
