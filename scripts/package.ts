// Builds the extension without source maps and zips extension/dist to release/unyap-<version>.zip for the
// Chrome Web Store. Fails when the build holds anything but the files the store package should contain.
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { zip } from "./zip.ts";

const root = join(import.meta.dirname, "..");
const dist = join(root, "extension/dist");
const expected = [
  "background.js", "content.js", "icons/icon-128.png", "icons/icon-16.png", "icons/icon-32.png",
  "icons/icon-48.png", "manifest.json", "options.html", "options.js", "page.js", "styles.css",
];

execFileSync(process.execPath, [join(root, "scripts/build.ts"), "--release"], { stdio: "inherit" });

const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => relative(dist, join(entry.parentPath, entry.name)).split("\\").join("/"))
  .sort();
const missing = expected.filter((file) => !files.includes(file));
const extra = files.filter((file) => !expected.includes(file));
if (missing.length > 0 || extra.length > 0) {
  console.error(`extension/dist does not match the package list. Missing: ${missing.join(", ") || "none"}; ` +
    `unexpected: ${extra.join(", ") || "none"}.`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8")) as { version: string };
const entries = await Promise.all(files.map(async (name) => ({ name, data: await readFile(join(dist, name)) })));
const out = join(root, "release", `unyap-${manifest.version}.zip`);
await mkdir(join(root, "release"), { recursive: true });
await writeFile(out, zip(entries));
console.log(`Saved ${relative(root, out)} (${files.length} files)`);
