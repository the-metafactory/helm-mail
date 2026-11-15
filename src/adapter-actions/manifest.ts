import { mailReplyDraftDeclaration, type DeskAdapterDefinition } from "@the-metafactory/cortex/desk-sdk";
import { withMailUnsubscribe } from "../adapter/unsubscribe";
import { withMailMoves } from "../adapter/moves";
import { ADAPTER_ID, declaration as reads } from "../adapter/manifest";

const reply = mailReplyDraftDeclaration(ADAPTER_ID);
const readDeclaration = reads as unknown as DeskAdapterDefinition["declaration"];
export const declaration: DeskAdapterDefinition["declaration"] = withMailUnsubscribe(withMailMoves({
  ...readDeclaration,
  schemas: [...readDeclaration.schemas, ...reply.schemas],
  objectTypes: [...readDeclaration.objectTypes, ...reply.objectTypes.filter(item => !readDeclaration.objectTypes.some(read => read.objectType === item.objectType))],
  capabilities: [...readDeclaration.capabilities, ...reply.capabilities],
}));
