import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_ID, PACKAGE_VERSION, declaration, readBindings, setup } from "../src/adapter/manifest";

export const ADAPTER_DIR = join(dirname(import.meta.dir), "adapter");

export async function buildAdapter(): Promise<{ "backend.mjs": string; "desk-adapter.json": string }> {
  const built = await Bun.build({
    entrypoints: [join(dirname(import.meta.dir), "src/adapter/backend.ts")],
    target: "node",
    format: "esm",
    minify: false,
    external: ["@the-metafactory/cortex/desk-sdk"],
  });
  if (!built.success || built.outputs.length !== 1) throw new Error(`adapter build failed: ${built.logs.join("; ")}`);
  const backend = await built.outputs[0]!.text();
  const manifest = {
    format: "desk-adapter-package/1",
    packageId: PACKAGE_ID,
    packageVersion: PACKAGE_VERSION,
    deskSdkRange: "^1.6.0",
    domainContractVersion: "1.0.0",
    backend: { entry: "backend.mjs", sha256: createHash("sha256").update(backend).digest("hex") },
    declaration,
    draftingBindings: [],
    readBindings,
    setup,
  };
  return { "backend.mjs": backend, "desk-adapter.json": `${JSON.stringify(manifest, null, 2)}\n` };
}

if (import.meta.main) {
  const files = await buildAdapter();
  if (process.argv.includes("--check")) {
    const stale = Object.entries(files).filter(([name, content]) => {
      try { return readFileSync(join(ADAPTER_DIR, name), "utf8") !== content; } catch { return true; }
    });
    if (stale.length) { console.error(`stale: ${stale.map(([name]) => name).join(", ")} (run bun run build:adapter)`); process.exit(1); }
  } else {
    mkdirSync(ADAPTER_DIR, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(ADAPTER_DIR, name), content);
  }
}
