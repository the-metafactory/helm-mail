export const ADAPTER_ID = "mail";
export const PACKAGE_ID = "the-metafactory.helm-mail";
export const PACKAGE_VERSION = "0.1.0";

export const CAPABILITIES = {
  mailboxes: "mail.mailbox.list",
  listed: "mail.message.query",
  watch: "mail.message.watch",
} as const;

export const MAILBOX_ID = "inbox";
export const PAGE_LIMIT = 20;
export const FIRST_PARAGRAPH_LIMIT = 1000;

const ref = (schemaId: string) => ({ schemaId, version: "1.0.0" });
const urn = (schemaId: string) => ({ $ref: `urn:desk-schema:${schemaId}:1.0.0` });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const text = { type: "string", minLength: 1 };

const SCHEMAS = {
  empty: "mail.empty",
  error: "mail.error",
  mailbox: "mail.mailbox",
  mailboxes: "mail.mailbox.list.output",
  message: "mail.message",
  messages: "mail.message.query.output",
  watched: "mail.message.watch.output",
  queryInput: "mail.message.query.input",
} as const;

export const declaration = {
  adapterId: ADAPTER_ID,
  label: "Mail",
  contractRange: "^1.0.0",
  schemas: [
    { ...ref(SCHEMAS.empty), schema: object({}) },
    { ...ref(SCHEMAS.error), schema: object({ code: text, message: text }, ["code", "message"]) },
    { ...ref(SCHEMAS.mailbox), schema: object({ label: text }, ["label"]) },
    { ...ref(SCHEMAS.mailboxes), schema: object({ items: { type: "array", items: urn(SCHEMAS.mailbox) } }, ["items"]) },
    {
      ...ref(SCHEMAS.message),
      schema: object(
        {
          messageId: text,
          account: text,
          from: object({ name: { type: "string" }, address: text }, ["address"]),
          subject: { type: "string" },
          receivedAt: text,
          firstParagraph: { type: "string", maxLength: FIRST_PARAGRAPH_LIMIT },
        },
        ["messageId", "account", "from", "subject", "receivedAt", "firstParagraph"],
      ),
    },
    {
      ...ref(SCHEMAS.messages),
      schema: object(
        { items: { type: "array", items: urn(SCHEMAS.message) }, health: { type: "string", enum: ["fresh", "stale"] } },
        ["items", "health"],
      ),
    },
    { ...ref(SCHEMAS.watched), schema: object({ items: { type: "array", items: urn(SCHEMAS.message) } }, ["items"]) },
    { ...ref(SCHEMAS.queryInput), schema: object({ messageId: text }) },
  ],
  objectTypes: [
    { objectType: "mailbox", label: "Mailbox", schemaRef: ref(SCHEMAS.mailbox), relationships: [] },
    { objectType: "message", label: "Message", schemaRef: ref(SCHEMAS.message), relationships: [] },
  ],
  capabilities: [
    capability(CAPABILITIES.mailboxes, "List mailboxes", "query", ["mailbox"], SCHEMAS.empty, SCHEMAS.mailboxes),
    capability(CAPABILITIES.listed, "Listed mail", "query", ["message"], SCHEMAS.queryInput, SCHEMAS.messages),
    capability(CAPABILITIES.watch, "Watch listed mail", "observation", ["message"], SCHEMAS.empty, SCHEMAS.watched),
  ],
};

function capability(capabilityId: string, label: string, kind: string, objectTypes: string[], input: string, output: string) {
  return { capabilityId, label, kind, objectTypes, inputSchemaRef: ref(input), outputSchemaRef: ref(output), errorSchemaRef: ref(SCHEMAS.error) };
}

const base = { version: "1.0.0", adapterId: ADAPTER_ID };
const messageQuery = { objectsPointer: "/items", aggregatePointers: ["/health"], ordering: "provider", stableSnapshot: true, limits: { items: PAGE_LIMIT } };

export const readBindings = [
  { ...base, capabilityId: CAPABILITIES.mailboxes, mode: "destinations", objectType: "mailbox", inputSchemaRef: ref(SCHEMAS.empty), outputSchemaRef: ref(SCHEMAS.mailboxes), display: { title: "/label" } },
  { ...base, capabilityId: CAPABILITIES.listed, mode: "query", objectType: "message", inputSchemaRef: ref(SCHEMAS.queryInput), outputSchemaRef: ref(SCHEMAS.messages), destinationType: "mailbox", display: { title: "/subject" }, query: messageQuery },
  { ...base, capabilityId: CAPABILITIES.watch, mode: "poll", objectType: "message", inputSchemaRef: ref(SCHEMAS.empty), outputSchemaRef: ref(SCHEMAS.watched), destinationType: "mailbox", display: { title: "/subject" }, observation: { modes: ["poll"], objectsPointer: "/items", resumable: false } },
];

export const setup = {
  version: "1.0.0",
  schemas: [
    { schemaId: `${ADAPTER_ID}.setup.configuration`, version: "1.0.0", schema: object({}) },
    { schemaId: `${ADAPTER_ID}.setup.account`, version: "1.0.0", schema: object({}) },
  ],
  configurationSchemaRef: ref(`${ADAPTER_ID}.setup.configuration`),
  accountScopeSchemaRef: ref(`${ADAPTER_ID}.setup.account`),
  authMethods: [{ kind: "local" }],
};
