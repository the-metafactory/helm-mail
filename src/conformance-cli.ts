import { runConformance } from "./conformance";

const results = await runConformance();
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}${r.pass ? "" : ` ${r.detail ?? ""}`}`);
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
