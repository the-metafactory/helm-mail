import { mailReplyDraftDeclaration, type DeskAdapterDefinition } from "@the-metafactory/cortex/desk-sdk";
import { composeDeclaration } from "../adapter/compose-declaration";
import { withMailUnsubscribe } from "../adapter/unsubscribe";
import { withMailMoves } from "../adapter/moves";
import { ADAPTER_ID, declaration as reads } from "../adapter/manifest";

const reply = mailReplyDraftDeclaration(ADAPTER_ID);
const readDeclaration = reads as unknown as DeskAdapterDefinition["declaration"];
export const declaration: DeskAdapterDefinition["declaration"] = withMailUnsubscribe(withMailMoves(composeDeclaration(readDeclaration, reply)));
