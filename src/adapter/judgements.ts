import { judgementCapability, mailJudgementDeclaration, type AdapterDeclaration, type DeskAdapterHost, type DispatchRequest, type MailJudgementAction, type OwnerResult } from "@the-metafactory/cortex/desk-sdk";

export const JUDGEMENT_ACTIONS = ["unimportant", "block-domain", "correct", "not-phishing", "snooze", "snooze-cancel", "waiting", "undo"] as const satisfies readonly MailJudgementAction[];
export const JUDGEMENT_CAPABILITIES = JUDGEMENT_ACTIONS.map(judgementCapability);
export const JUDGEMENT_UNDO_CAPABILITY = judgementCapability("undo");

export type JudgementUndo = "yes" | "no" | "by-correction";
export const JUDGEMENT_UNDO: Readonly<Record<MailJudgementAction, JudgementUndo>> = {
  unimportant: "yes",
  "block-domain": "yes",
  correct: "by-correction",
  "not-phishing": "yes",
  snooze: "yes",
  "snooze-cancel": "yes",
  waiting: "yes",
  undo: "no",
};

export function withMailJudgements(base: AdapterDeclaration): AdapterDeclaration {
  if (base.adapterId !== "mail") throw new Error("Mail judgement bindings require the mail adapter.");
  const judgements = mailJudgementDeclaration(base.adapterId);
  const known = new Set(base.capabilities.map(item => item.capabilityId));
  return {
    ...base,
    schemas: [...base.schemas, ...judgements.schemas.filter(item => !base.schemas.some(old => old.schemaId === item.schemaId && old.version === item.version))],
    objectTypes: [...base.objectTypes, ...judgements.objectTypes.filter(item => !base.objectTypes.some(old => old.objectType === item.objectType))],
    capabilities: [...base.capabilities, ...judgements.capabilities.filter(item => JUDGEMENT_CAPABILITIES.includes(item.capabilityId) && !known.has(item.capabilityId))],
  };
}

export function registerMailJudgements(host: DeskAdapterHost): void {
  for (const action of JUDGEMENT_ACTIONS) {
    const capabilityId = judgementCapability(action);
    host.registerConnector(capabilityId, connection => {
      const identity = { kind: "action" as const, ...connection, capabilityId };
      const bridge = host.mailJudgements;
      if (!bridge) return identity;
      return {
        ...identity, writerOwner: "mail-judgement",
        support: { lifecycleVersion: "1.0.0" as const, ...connection, capabilityId, declarationId: "mail-judgement-owner", dedup: { kind: "guaranteed" as const, scope: "connection-capability" as const, retentionMs: 604800000, bindsSnapshot: true, concurrent: true }, operationLookup: "none" as const, conditionalUpdate: "none" as const, cancellation: "none" as const, ...(JUDGEMENT_UNDO[action] === "no" ? {} : { compensationCapabilityId: JUDGEMENT_UNDO_CAPABILITY }) },
        dispatch: (request: DispatchRequest): Promise<OwnerResult> => bridge.changeJudgement(request),
      };
    });
  }
}
