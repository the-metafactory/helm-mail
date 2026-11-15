import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAdapter } from "./build-adapter";
import { declaration } from "../src/adapter-actions/manifest";

export const ACTION_ADAPTER_DIR = join(import.meta.dir, "../adapter-actions");
export async function buildActions() {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/adapter-actions/backend.ts")], target: "node", format: "esm", minify: false, external: ["@the-metafactory/cortex/desk-sdk"] });
  if (!built.success || built.outputs.length !== 1) throw new Error(`Action adapter build failed: ${built.logs.join("; ")}`);
  const backend = await built.outputs[0]!.text();
  const readManifest = JSON.parse((await buildAdapter())["desk-adapter.json"]);
  const manifest = { ...readManifest, deskSdkRange: "^1.13.0", backend: { entry: "backend.mjs", sha256: createHash("sha256").update(backend).digest("hex") }, declaration };
  return { "backend.mjs": backend, "desk-adapter.json": `${JSON.stringify(manifest, null, 2)}\n` };
}
if (import.meta.main) {
  const files = await buildActions();
  if (process.argv.includes("--check")) {
    for (const [name, content] of Object.entries(files)) if (readFileSync(join(ACTION_ADAPTER_DIR, name), "utf8") !== content) throw new Error(`Stale action adapter: ${name}`);
  } else {
    mkdirSync(ACTION_ADAPTER_DIR, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(ACTION_ADAPTER_DIR, name), content);
  }
}
