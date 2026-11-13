import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliConnection } from "../src/cli";
import { sampleRequest, surface } from "../src/conformance";
import { callDraft, callLookup } from "../src/interface";

const command = [process.execPath, join(import.meta.dir, "fixtures/cli.ts")] as const;

test("CLI draft maps account, reply and literal content without a shell, then removes its body file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helm-mail-test-"));
  const capture = join(directory, "capture.json");
  try {
    const connection = new CliConnection({ command, env: { CAPTURE: capture } });
    const request = sampleRequest({ subject: "--subject=$(do-not-run) 'quoted'", body: "\n**Body**\n`literal`\n" });
    expect(await callDraft(connection, request)).toEqual({ kind: "created", id: "draft-1", account: "account-1" });
    const captured = JSON.parse(await readFile(capture, "utf8"));
    expect(captured.args).toEqual([
      "draft", "create", `--request-id=${request.requestId}`, `--account=${request.account}`,
      `--in-reply-to=${request.messageId}`, `--to=${request.recipient}`, `--subject=${request.subject}`,
      expect.stringMatching(/^--file=/), "--no-markdown", "--output=json",
    ]);
    expect(captured.body).toBe(request.body);
    expect(await stat(captured.args.find((a: string) => a.startsWith("--file=")).slice(7)).catch(() => null)).toBeNull();
    expect(surface(connection).some((name) => /send/i.test(name))).toBe(false);

    expect((await callDraft(connection, sampleRequest({ body: "" }))).kind).toBe("created");
    expect(JSON.parse(await readFile(capture, "utf8")).body).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lookup searches through the CLI and passes option-like IDs as positional data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helm-mail-test-"));
  const capture = join(directory, "capture.json");
  try {
    const connection = new CliConnection({ command, env: { CAPTURE: capture } });
    expect(await callLookup(connection, "--request-1")).toEqual({ kind: "not_found" });
    expect(JSON.parse(await readFile(capture, "utf8")).args).toEqual([
      "draft", "lookup", "--output=json", "--", "--request-1",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI failures and malformed replies stay unknown, including nonzero not_found output", async () => {
  for (const fault of ["nonzero", "garbage", "error-json", "timeout"]) {
    const connection = new CliConnection({ command, env: { FAULT: fault }, timeoutMs: fault === "timeout" ? 50 : 2000 });
    expect((await callDraft(connection, sampleRequest())).kind, fault).toBe("unknown");
    expect((await callLookup(connection, "req-1")).kind, fault).toBe("unknown");
  }
});

test("unsupported requests and unsafe IDs never start the CLI", async () => {
  const connection = new CliConnection({ command: ["/nonexistent-mail-cli"] });
  await expect(connection.draft(sampleRequest({ version: 2 }))).rejects.toThrow("Unsupported");
  await expect(connection.draft(sampleRequest({ account: "" }))).rejects.toThrow("account");
  await expect(connection.lookup("req\r\nInjected: yes")).rejects.toThrow("Invalid");
  await expect(connection.lookup("x".repeat(201))).rejects.toThrow("Invalid");
});

test("missing executable is unknown and invalid process timeout is rejected", async () => {
  expect((await callLookup(new CliConnection({ command: ["/nonexistent-mail-cli"] }), "req-1")).kind).toBe("unknown");
  expect(() => new CliConnection({ command, timeoutMs: NaN })).toThrow("timeout");
});

test("an ID already in another account conflicts; an unavailable global lookup prevents creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helm-mail-test-"));
  const capture = join(directory, "capture.json");
  try {
    const connection = new CliConnection({ command, env: { CAPTURE: capture, LOOKUP_ACCOUNT: "account-2" } });
    expect(await callDraft(connection, sampleRequest())).toEqual({ kind: "conflict", id: "draft-existing", account: "account-2" });
    expect(JSON.parse(await readFile(capture, "utf8")).args[1]).toBe("lookup");
    const down = new CliConnection({ command, env: { CAPTURE: capture, FAULT: "unavailable" } });
    expect((await callDraft(down, sampleRequest())).kind).toBe("unknown");
    expect(JSON.parse(await readFile(capture, "utf8")).args[1]).toBe("lookup");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
