import { runConformance } from "./conformance";
import { runMailboxConformance, type TestMailboxFixture } from "./mailbox-conformance";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--mailbox-fixture")) {
  console.error("Usage: bun run conformance [--mailbox-fixture /path/to/test-fixture.ts]");
  process.exit(1);
}

const results = args.length
  ? await runMailboxConformance(await loadFixture(args[1]!))
  : await runConformance();
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}${r.pass ? "" : ` ${r.detail ?? ""}`}`);
}
process.exit(results.every((r) => r.pass) ? 0 : 1);

async function loadFixture(path: string): Promise<TestMailboxFixture> {
  const module = await import(pathToFileURL(resolve(path)).href);
  if (typeof module.createFixture !== "function") {
    throw new Error("Test fixture must export createFixture()");
  }
  return module.createFixture();
}
