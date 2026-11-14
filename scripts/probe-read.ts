import { DESK_ADAPTER_SDK_VERSION, formatReport, runConformance, type ConformanceReport } from "@the-metafactory/cortex/desk-adapter-conformance";
import { createDeskAdapter } from "../src/adapter/backend";
import { CAPABILITIES } from "../src/adapter/manifest";
import { BODY_CANARY, binding, fakeBridge, fakeMailSource, item } from "../test/fixtures/mail-source";
import { ADAPTER_DIR } from "./build-adapter";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
};
const atLeast = (version: string, floor: string): boolean => {
  const [a = 0, b = 0] = version.split(".").map(Number);
  const [c = 0, d = 0] = floor.split(".").map(Number);
  return a > c || (a === c && b >= d);
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
if (cloudReader.length > 0) check("denied scope: a cloud reader of a local connection is denied", cloudReader.every(item => item.verdict === "conformant"), cloudReader.map(item => item.detail).join("; "));
else check("denied scope: cloud-reader probe", !atLeast(DESK_ADAPTER_SDK_VERSION, "1.7"), `not exercised by Desk SDK ${DESK_ADAPTER_SDK_VERSION}; the harness reports it from 1.7.0`);

console.log(`skip failure scenarios: Desk SDK ${DESK_ADAPTER_SDK_VERSION} serves no fake Mail source to them (from 1.7.0); enable with the 1.7.0 pin`);

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
