import { existsSync, readFileSync, writeFileSync } from "node:fs";
const path = process.env.HELM_REPLY_FAKE_STATE;
if (!path) throw new Error("Fake state is required");
const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { creates: 0, lookups: 0, draft: null };
const args = process.argv.slice(2);
const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args[0] !== "draft") throw new Error("Only fake draft commands are supported");
if (args[1] === "lookup") {
  state.lookups++;
  writeFileSync(path, JSON.stringify(state));
  const id = args[args.indexOf("--") + 1];
  console.log(JSON.stringify(state.draft?.requestId === id ? { status: "found", id: state.draft.id, account: state.draft.account } : { status: "not_found" }));
} else if (args[1] === "create") {
  const requestId = option("request-id");
  const draft = { id: "fake-native-draft", requestId, account: option("account"), messageId: option("in-reply-to"), recipient: option("to"), subject: option("subject"), body: readFileSync(option("file")!, "utf8") };
  if (!state.draft) {
    state.creates++;
    state.draft = draft;
    writeFileSync(path, JSON.stringify(state));
    await Bun.sleep(10_000);
  } else {
    console.log(JSON.stringify({ status: JSON.stringify(state.draft) === JSON.stringify(draft) ? "exists" : "conflict", id: state.draft.id, account: state.draft.account }));
  }
} else throw new Error("Unknown fake draft command");
