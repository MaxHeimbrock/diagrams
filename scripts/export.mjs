// Renders every .excalidraw file in the repo to PNG with the official
// @excalidraw/utils bundle running in headless Chromium.
//
// Usage: node scripts/export.mjs [outDir]   (default: dist)
// Output keeps the repo's folder layout: docs/Overview.excalidraw -> dist/docs/Overview.png

import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";

const SCALE = 2;
const PADDING = 20;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist"]);

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outDir = path.resolve(root, process.argv[2] ?? "dist");

async function findDiagrams(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findDiagrams(full)));
    else if (entry.name.endsWith(".excalidraw")) found.push(full);
  }
  return found.sort();
}

// Serves the self-contained utils bundle so the page can import it as an ES module.
async function serveUtilsBundle() {
  const require = createRequire(import.meta.url);
  const bundle = await readFile(require.resolve("@excalidraw/utils"));
  const server = createServer((req, res) => {
    if (req.url === "/utils.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(bundle);
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body></body></html>");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

function renderInPage({ scene, scale, padding }) {
  return (async () => {
    const { exportToBlob } = await import("/utils.js");
    const blob = await exportToBlob({
      data: {
        elements: (scene.elements ?? []).filter((el) => !el.isDeleted),
        files: scene.files ?? {},
        appState: {
          exportBackground: true,
          viewBackgroundColor: "#ffffff",
          ...scene.appState,
        },
      },
      config: { mimeType: "image/png", padding, scale },
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  })();
}

const diagrams = await findDiagrams(root);
if (diagrams.length === 0) {
  console.log("No .excalidraw files found.");
  process.exit(0);
}

const { server, url } = await serveUtilsBundle();
const browser = await chromium.launch();
const exported = [];
let failed = 0;

try {
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.error(`  page error: ${err.message}`));
  await page.goto(url);

  for (const file of diagrams) {
    const rel = path.relative(root, file);
    const target = path.join(outDir, rel.replace(/\.excalidraw$/, ".png"));
    try {
      const scene = JSON.parse(await readFile(file, "utf8"));
      const base64 = await page.evaluate(renderInPage, { scene, scale: SCALE, padding: PADDING });
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(base64, "base64"));
      exported.push(path.relative(outDir, target).split(path.sep).join("/"));
      console.log(`✓ ${rel} -> ${path.relative(root, target)}`);
    } catch (err) {
      failed++;
      console.error(`✗ ${rel}: ${err.message}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}

// Index page so the public URL of each diagram is easy to find and copy.
const items = exported
  .map((p) => `<li><a href="${encodeURI(p)}">${p}</a><br><img src="${encodeURI(p)}" alt="${p}"></li>`)
  .join("\n");
await writeFile(
  path.join(outDir, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diagrams</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:960px;padding:0 1rem}
li{margin-bottom:2rem}img{max-width:100%;border:1px solid #ddd;margin-top:.5rem}</style>
</head><body><h1>Diagrams</h1><ul>
${items}
</ul></body></html>
`,
);

if (failed > 0) process.exit(1);
