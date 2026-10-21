import { chromium } from "playwright";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUT_DIR = "build";
const SCALE = 2;
const PADDING = 20;
const UTILS_VERSION = "0.1.5";
const SKIP_DIRS = new Set([".git", "node_modules", OUT_DIR]);

function findDiagrams(dir = ".") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findDiagrams(path));
    else if (entry.name.endsWith(".excalidraw")) found.push(path);
  }
  return found;
}

// Loads the official Excalidraw export code into the page.
// EXCALIDRAW_ASSET_PATH tells it where to fetch fonts from.
const PAGE = `<!doctype html><html><body><script type="module">
  window.EXCALIDRAW_ASSET_PATH = "https://unpkg.com/@excalidraw/utils@${UTILS_VERSION}/dist/prod/";
  import * as ExcalidrawUtils from "https://esm.sh/@excalidraw/utils@${UTILS_VERSION}";
  window.ExcalidrawUtils = ExcalidrawUtils;
  window.ready = true;
</script></body></html>`;

const diagrams = findDiagrams();
if (diagrams.length === 0) {
  console.log("No .excalidraw files found.");
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (err) => console.error("[page error]", err.message));
await page.setContent(PAGE);
await page.waitForFunction(() => window.ready === true, null, { timeout: 60_000 });

let failed = false;
for (const input of diagrams) {
  const output = join(OUT_DIR, input.replace(/\.excalidraw$/, ".png"));
  try {
    const scene = JSON.parse(readFileSync(input, "utf8"));
    const base64 = await page.evaluate(
      async ({ scene, scale, padding }) => {
        const blob = await window.ExcalidrawUtils.exportToBlob({
          data: {
            elements: scene.elements,
            appState: { ...scene.appState, exportBackground: true },
            files: scene.files ?? {},
          },
          config: { mimeType: "image/png", scale, padding },
        });
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      },
      { scene, scale: SCALE, padding: PADDING },
    );
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, Buffer.from(base64, "base64"));
    console.log(`Rendered ${input} -> ${output}`);
  } catch (err) {
    failed = true;
    console.error(`Failed to render ${input}: ${err.message}`);
  }
}

await browser.close();
process.exit(failed ? 1 : 0);
