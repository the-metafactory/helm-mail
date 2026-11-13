import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const bodyFile = args.find((a) => a.startsWith("--file="))?.slice(7);
if (process.env.CAPTURE) {
  writeFileSync(process.env.CAPTURE, JSON.stringify({
    args,
    body: bodyFile ? readFileSync(bodyFile, "utf8") : undefined,
  }));
}
switch (process.env.FAULT) {
  case "timeout": await Bun.sleep(30_000); break;
  case "nonzero": console.log('{"status":"not_found"}'); process.exit(1);
  case "garbage": console.log("not json"); process.exit(0);
  case "error-json": console.log('{"success":false,"error":"failure"}'); process.exit(0);
  case "unavailable": console.log('{"status":"unavailable"}'); process.exit(0);
}
console.log(args[1] === "create"
  ? JSON.stringify({ status: "created", id: "draft-1", account: "account-1" })
  : JSON.stringify(process.env.LOOKUP_ACCOUNT
    ? { status: "found", id: "draft-existing", account: process.env.LOOKUP_ACCOUNT }
    : { status: "not_found" }));
