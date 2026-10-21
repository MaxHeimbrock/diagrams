import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

const API = process.env.NOTION_API_URL ?? "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const OUT_DIR = "build";
const TOKEN = process.env.NOTION_TOKEN;
const LIBRARY = process.env.NOTION_LIBRARY_PAGE;

if (!TOKEN || !LIBRARY) {
  console.error("NOTION_TOKEN and NOTION_LIBRARY_PAGE must both be set.");
  process.exit(1);
}

async function notion(path, { method = "GET", json, form } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        ...(json ? { "Content-Type": "application/json" } : {}),
      },
      body: json ? JSON.stringify(json) : form,
    });
    // Back off and retry when Notion rate-limits us.
    if (res.status === 429 && attempt < 5) {
      const seconds = Number(res.headers.get("retry-after") ?? attempt);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`${method} ${path} returned ${res.status} ${body.code ?? ""}: ${body.message ?? ""}`);
    }
    return body;
  }
}

// Accepts a page URL or a bare ID, with or without dashes.
function toPageId(ref) {
  const raw = ref.split(/[?#]/)[0].replace(/-/g, "").slice(-32);
  if (!/^[0-9a-f]{32}$/i.test(raw)) throw new Error(`Not a valid page ID or page link: ${ref}`);
  return raw;
}

async function listChildren(blockId) {
  const children = [];
  let cursor;
  do {
    const query = `page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const page = await notion(`/blocks/${blockId}/children?${query}`);
    children.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return children;
}

function plainText(block) {
  return (block[block.type]?.rich_text ?? []).map((t) => t.plain_text ?? t.text?.content ?? "").join("").trim();
}

// The library page holds, per diagram, a heading with the diagram's repo path followed
// by a synced block that contains the image. Copies of the synced block elsewhere in
// Notion show only the image and follow every update.
async function readLibrary(pageId) {
  const entries = new Map();
  const blocks = await listChildren(pageId);
  for (let i = 0; i < blocks.length - 1; i++) {
    const heading = blocks[i];
    const synced = blocks[i + 1];
    if (heading.type !== "heading_3" || synced.type !== "synced_block") continue;
    if (synced.synced_block.synced_from !== null) continue;
    const image = (await listChildren(synced.id)).find((b) => b.type === "image");
    if (image) entries.set(plainText(heading), image.id);
  }
  return entries;
}

function findPngs(dir = OUT_DIR) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findPngs(path));
    else if (entry.name.endsWith(".png")) found.push(path);
  }
  return found;
}

async function uploadPng(pngPath) {
  const filename = basename(pngPath);
  const created = await notion("/file_uploads", {
    method: "POST",
    json: { filename, content_type: "image/png" },
  });
  const form = new FormData();
  form.append("file", new Blob([readFileSync(pngPath)], { type: "image/png" }), filename);
  const sent = await notion(`/file_uploads/${created.id}/send`, { method: "POST", form });
  if (sent.status !== "uploaded") throw new Error(`Upload of ${filename} ended with status ${sent.status}`);
  return created.id;
}

async function updateImage(blockId, uploadId) {
  await notion(`/blocks/${blockId}`, {
    method: "PATCH",
    json: { image: { type: "file_upload", file_upload: { id: uploadId } } },
  });
}

async function addToLibrary(pageId, diagram, uploadId) {
  await notion(`/blocks/${pageId}/children`, {
    method: "PATCH",
    json: {
      children: [
        { type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: diagram } }] } },
        {
          type: "synced_block",
          synced_block: {
            synced_from: null,
            children: [{ type: "image", image: { type: "file_upload", file_upload: { id: uploadId } } }],
          },
        },
      ],
    },
  });
}

const pageId = toPageId(LIBRARY);
const library = await readLibrary(pageId);
const errors = [];

for (const png of findPngs().sort()) {
  const diagram = relative(OUT_DIR, png).split(sep).join("/").replace(/\.png$/, ".excalidraw");
  try {
    const uploadId = await uploadPng(png);
    if (library.has(diagram)) {
      await updateImage(library.get(diagram), uploadId);
      console.log(`Updated ${diagram}`);
    } else {
      await addToLibrary(pageId, diagram, uploadId);
      console.log(`Added ${diagram} to the library page`);
    }
    library.delete(diagram);
  } catch (err) {
    errors.push(`${diagram}: ${err.message}`);
  }
}

for (const orphan of library.keys()) {
  console.warn(`Note: ${orphan} is on the library page but no longer in the repo. Remove it by hand if it's gone for good.`);
}

if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}
console.log("The Notion library page is up to date.");
