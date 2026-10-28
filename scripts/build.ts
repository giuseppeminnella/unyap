// Bundles the extension into extension/dist (every extension/src/*.ts entry plus extension/static/*).
// --release leaves the extension's source maps out, for the store package (scripts/package.ts).
import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const release = process.argv.includes("--release");

const extensionSrc = join(root, "extension/src");
const extensionStatic = join(root, "extension/static");
const extensionDist = join(root, "extension/dist");
const entries = (await readdir(extensionSrc).catch(() => [] as string[]))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => join(extensionSrc, file));

await rm(extensionDist, { recursive: true, force: true });
await mkdir(extensionDist, { recursive: true });
if (entries.length > 0) {
  // Content scripts cannot be ES modules, so the extension is bundled as IIFE.
  await build({
    bundle: true, format: "iife", target: "es2022", sourcemap: !release, logLevel: "info",
    entryPoints: entries, outdir: extensionDist,
  });
}
await cp(extensionStatic, extensionDist, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
});
