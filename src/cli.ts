import { INTERFACE_VERSION, parseLookupResult, type DraftRequest, type MailConnection } from "./interface";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CliOptions {
  command: readonly [string, ...string[]];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export class CliConnection implements MailConnection {
  readonly version = INTERFACE_VERSION;
  private readonly command: string[];
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;

  constructor(options: CliOptions) {
    if (!options.command.length || !options.command[0]) throw new Error("CLI command is required");
    this.command = [...options.command];
    this.env = { ...process.env, ...options.env };
    this.timeoutMs = options.timeoutMs ?? 4000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("CLI timeout must be positive and finite");
    }
  }

  async draft(request: DraftRequest): Promise<unknown> {
    if (request.version !== INTERFACE_VERSION) throw new Error("Unsupported draft request version");
    this.validateRequestId(request.requestId);
    for (const field of ["account", "messageId", "recipient", "subject"] as const) {
      if (typeof request[field] !== "string" || !request[field]) {
        throw new Error(`Draft ${field} is required`);
      }
    }
    if (typeof request.body !== "string") throw new Error("Draft body must be text");
    const existing = parseLookupResult(await this.lookup(request.requestId));
    if (!existing) throw new Error("Mail CLI returned an unstructured lookup result");
    if (existing.status === "unavailable") throw new Error("Mail CLI draft lookup is unavailable");
    if (existing.status === "found" && existing.account !== request.account) {
      return { status: "conflict", id: existing.id, account: existing.account };
    }
    const directory = await mkdtemp(join(tmpdir(), "helm-mail-"));
    try {
      const bodyFile = join(directory, "body.txt");
      await writeFile(bodyFile, request.body, { mode: 0o600 });
      return await this.run([
        "draft", "create",
        `--request-id=${request.requestId}`,
        `--account=${request.account}`,
        `--in-reply-to=${request.messageId}`,
        `--to=${request.recipient}`,
        `--subject=${request.subject}`,
        `--file=${bodyFile}`,
        "--no-markdown", "--output=json",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async lookup(requestId: string): Promise<unknown> {
    this.validateRequestId(requestId);
    return this.run(["draft", "lookup", "--output=json", "--", requestId]);
  }

  private validateRequestId(requestId: string): void {
    if (typeof requestId !== "string" || !/^[A-Za-z0-9._:@-]{1,200}$/.test(requestId)) {
      throw new Error("Invalid draft request ID");
    }
  }

  private async run(args: string[]): Promise<unknown> {
    const child = Bun.spawn([...this.command, ...args], {
      env: this.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, this.timeoutMs);
    try {
      const [stdout, code] = await Promise.all([
        new Response(child.stdout).text(), child.exited,
      ]);
      if (timedOut) throw new Error("Mail CLI timeout; draft outcome is unknown");
      if (code !== 0) throw new Error(`Mail CLI exited with code ${code}`);
      try {
        return JSON.parse(stdout);
      } catch {
        throw new Error("Mail CLI returned unstructured output");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
