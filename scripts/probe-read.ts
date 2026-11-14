import { DESK_ADAPTER_SDK_VERSION, formatFailureReport, formatReport, runConformance, runFailureScenarios, type ConformanceReport } from "@the-metafactory/cortex/desk-adapter-conformance";
import { createDeskAdapter } from "../src/adapter/backend";
import { CAPABILITIES } from "../src/adapter/manifest";
import { ACCOUNT_TWO, BODY_CANARY, SHARED_ID, binding, fakeBridge, fakeMailSource, item } from "../test/fixtures/mail-source";
import { ADAPTER_DIR } from "./build-adapter";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

const withBody = [{ ...item("<one@example.test>", "account-one", "Subject one", "Opening line."), body: BODY_CANARY, html: BODY_CANARY } as never];

const scenarios: [string, ReturnType<typeof fakeMailSource>][] = [
  ["fresh local connection", fakeMailSource([binding()])],
  ["stale connection (provider failure)", fakeMailSource([binding()], "synthetic provider failure")],
  ["cloud connection", fakeMailSource([binding({ dataPolicy: "cloud" })])],
];

for (const [name, mail] of scenarios) {
  const report: ConformanceReport = await runConformance(ADAPTER_DIR, { mail });
  check(`${name}: conformance`, report.status === "conformant" && report.networkRequests === 0, report.status);
  if (report.status !== "conformant") console.log(formatReport(report));
}

const local = await runConformance(ADAPTER_DIR, { mail: fakeMailSource([binding()]) });
const cloudReader = local.capabilities.filter(item => (item.probe as string) === "cloud-reader");
check("denied scope: a cloud reader of a local connection is denied", cloudReader.length > 0 && cloudReader.every(item => item.verdict === "conformant"), cloudReader.map(item => item.detail).join("; ") || `no cloud-reader probe in Desk SDK ${DESK_ADAPTER_SDK_VERSION}`);

const failuresReport = await runFailureScenarios(ADAPTER_DIR, { mail: fakeMailSource([binding()]) });
check("failure scenarios: isolated", failuresReport.status === "isolated" && failuresReport.networkRequests === 0, failuresReport.status);
if (failuresReport.status !== "isolated") console.log(formatFailureReport(failuresReport));

// Two connections through the published kit: the same Message-ID under each stays two objects, and no body leaks.
const SECOND = "connection-two";
const both = await runConformance(ADAPTER_DIR, {
  mail: fakeMailSource([binding(), binding({ connectionId: SECOND, account: ACCOUNT_TWO })], null, [...withBody, item(SHARED_ID, "account-one", "Shared one", "Shared."), item(SHARED_ID, ACCOUNT_TWO, "Shared two", "Shared.")]),
});
check("two connections: conformance", both.status === "conformant", both.status);
const queries = both.mailQueries ?? [];
const connections = new Set(queries.map(q => q.connectionId));
check("two connections: the kit read both", connections.size === 2 && connections.has(SECOND), [...connections].join(", "));
check("two connections: every query conformant", queries.length > 0 && queries.every(q => q.verdict === "conformant"), queries.filter(q => q.verdict !== "conformant").map(q => `${q.connectionId}:${q.detail}`).join("; "));
const answered = JSON.stringify(queries.map(q => q.objects));
check("two connections: no body in any answer", !answered.includes(BODY_CANARY));
const sharedOn = (connectionId: string) => JSON.stringify(queries.filter(q => q.connectionId === connectionId).map(q => q.objects)).includes(SHARED_ID);
check("two connections: the shared Message-ID is answered on each connection", [...connections].every(sharedOn));
check("two connections: account two's mail stays off connection one", !JSON.stringify(queries.filter(q => q.connectionId !== SECOND).map(q => q.objects)).includes("Shared two"));

const request = { readVersion: "1.0.0", queryId: "q", capabilityId: CAPABILITIES.listed, input: {}, limit: 20, destinations: [{ adapterId: "mail", connectionId: "one", objectType: "mailbox", canonicalId: "inbox" }] } as const;
const run = async (stale: boolean): Promise<string> => {
  const { host } = fakeBridge({ one: "account-one" }, { stale, mail: withBody });
  const page = await createDeskAdapter(host).bindings.handlers[CAPABILITIES.listed]!(request as never, new AbortController().signal);
  return JSON.stringify(page);
};
const [fresh, stale] = [await run(false), await run(true)];
check("no body in any result", !fresh.includes(BODY_CANARY) && !stale.includes(BODY_CANARY));
check("stale connection shows stale and keeps its mail", stale.includes("\"health\":\"stale\"") && stale.includes("Subject one"));

if (failures.length > 0) { console.error(`${failures.length} check(s) failed`); process.exit(1); }
