import { mailReplyDraftDeclaration, type DeskAdapterDefinition } from "@the-metafactory/cortex/desk-sdk";
import { withMailJudgements } from "../adapter/judgements";
import { composeDeclaration } from "../adapter/compose-declaration";
import { withMailUnsubscribe } from "../adapter/unsubscribe";
import { withMailMoves } from "../adapter/moves";
import { withMailInvitations } from "../adapter/invitations";
import { withMailReports } from "../adapter/reports";
import { ADAPTER_ID, declaration as reads } from "../adapter/manifest";

const reply = mailReplyDraftDeclaration(ADAPTER_ID);
const readDeclaration = reads as unknown as DeskAdapterDefinition["declaration"];
export const declaration: DeskAdapterDefinition["declaration"] = withMailInvitations(withMailReports(withMailJudgements(withMailUnsubscribe(withMailMoves(composeDeclaration(readDeclaration, reply))))));
