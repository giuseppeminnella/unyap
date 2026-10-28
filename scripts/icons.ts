// Renders extension/icon.svg into the extension's PNG icons (extension/static/icons/icon-<size>.png).
// Rerun after changing the SVG: node scripts/icons.ts
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const svg = await readFile(join(root, "extension/icon.svg"), "utf8");
const out = join(root, "extension/static/icons");
// The store asks for 96 px of artwork inside the 128 px icon; small toolbar sizes use the whole square.
const insets: [size: number, inset: number][] = [[16, 0], [32, 1], [48, 3], [128, 16]];

await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [size, inset] of insets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html, body { margin: 0; background: transparent; } svg { display: block; margin: ${inset}px; ` +
      `width: ${size - 2 * inset}px; height: ${size - 2 * inset}px; }</style>${svg}`,
  );
  await page.screenshot({ path: join(out, `icon-${size}.png`), omitBackground: true });
}
await browser.close();
console.log(`Saved ${insets.map(([size]) => `icon-${size}.png`).join(", ")} in ${out}`);
