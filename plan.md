# Plan: Export Excalidraw diagrams to Notion

Every push to `main` renders the `.excalidraw` files in this repo to PNG and uploads
them into fixed image blocks in Notion through the Notion API. Each diagram gets one
permanent image block in Notion, and the action swaps the picture inside it.

Nothing is hosted publicly. The images live in Notion's own storage, so they stay as
private as the Notion pages they appear on.

## Why this approach

- **The repo is private.** Notion only hotlinks external images from public URLs, so
  raw GitHub links won't work.
- **No public hosting.** GitHub Pages or a bucket would make the diagrams reachable by
  anyone with the URL. Uploading through the Notion API avoids that.
- **Faithful rendering.** The exporter runs the official `@excalidraw/utils` package in
  headless Chromium through Playwright. A test on `test1.excalidraw` matched the
  editor exactly, including the Excalifont font and rounded corners. Standalone
  reimplementations fell back to other fonts or dropped details.

## 1. One-time setup

1. **Create a Notion integration.** A workspace owner creates an internal integration
   at https://www.notion.so/profile/integrations, for example "Client Diagrams Bot".
   It only needs the **Read content** and **Update content** capabilities. Copy its
   secret token.
2. **Store the token in GitHub.** Add it to this repo as an Actions secret named
   `NOTION_TOKEN`. Block IDs are not sensitive and live in the repo in plain text.
3. **Give the integration access to the docs pages.** Integrations see nothing by
   default. On the top-level client SDK docs page in Notion, open the `•••` menu,
   choose **Connections**, and add the integration. Child pages inherit access.
4. **Add the repo pieces:**
   - `scripts/export.mjs`: renders each mapped diagram to PNG with Playwright and
     `@excalidraw/utils`.
   - `scripts/upload-to-notion.mjs`: uploads PNGs and updates the mapped blocks.
   - `notion.json`: maps diagram files to Notion image block IDs.
   - `.github/workflows/publish-diagrams.yml`: runs both scripts on push to `main`.

Example `notion.json`. A diagram can map to several blocks if it appears on more than
one page:

```json
{
  "test1.excalidraw": ["2a8f3c1e9b7d4e5f8a6b0c2d4e6f8a1b"],
  "connection-flow.excalidraw": ["5c1d...", "9e3a..."]
}
```

## 2. Adding a new diagram to a Notion page

1. **Draw it.** Create a new `.excalidraw` file in the repo with the VS Code extension
   or excalidraw.com.
2. **Add a placeholder image in Notion.** On the target page, insert an image block
   where the diagram should appear. Any image works as a placeholder.
3. **Copy the block ID.** Hover the image, open its block menu, and choose
   **Copy link to block**. The link ends with `#<block-id>`. That 32-character string
   is the block ID.
4. **Add the mapping.** Add the file name and block ID to `notion.json`, then commit
   and merge to `main`.

The first run after the merge replaces the placeholder with the real diagram. The
block is the anchor, so it can be moved, resized, or captioned in Notion and the
action keeps updating it.

## 3. How a change in the repo reaches Notion

1. **A diagram change is merged to `main`.** The workflow triggers only when an
   `.excalidraw` file or `notion.json` changes.
2. **The action renders PNGs.** It renders every diagram listed in `notion.json` at 2x
   scale for crisp display on high-density screens.
3. **The action uploads each PNG to Notion.** It creates an upload slot, then sends
   the image bytes. A diagram used on several pages reuses one upload for all its
   blocks.
4. **The action updates each mapped block.** It points the image block at the new
   upload.

Core API calls for steps 3 and 4:

```bash
# 1. Create an upload slot
curl -X POST https://api.notion.com/v1/file_uploads \
  -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" -d '{}'

# 2. Send the PNG to the returned upload URL
curl -X POST "$UPLOAD_URL" \
  -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2026-03-11" \
  -F "file=@test1.png"

# 3. Point the existing image block at the upload
curl -X PATCH "https://api.notion.com/v1/blocks/$BLOCK_ID" \
  -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{"image": {"file_upload": {"id": "'"$UPLOAD_ID"'"}}}'
```

Readers see the new diagram as soon as they reload the page. Each update produces a
new file, so there is no caching delay.

## Things to know

- **Uploads must be attached within one hour.** The workflow attaches them right away.
- **Deleted blocks fail loudly.** If someone deletes a mapped image block, the API
  returns an error and the run goes red. Fix it by inserting a new block and updating
  `notion.json`.
- **Runs are serialized.** A `concurrency` group in the workflow keeps two quick merges
  from finishing out of order and leaving an older diagram in place.
- **File size limits.** Free Notion workspaces cap files at 5 MiB. Paid workspaces allow
  much more, and diagram PNGs are typically well under 1 MB.
- **Chromium download.** Playwright's headless Chromium is about 100 MB. The workflow
  caches it between runs.

## Optional extras

- Write the short commit hash into the image caption so readers can tell which version
  they are looking at.
- Render PNGs on pull requests and attach them as a workflow artifact for review,
  without touching Notion.

## Blockers and interim approach: public GitHub Pages

### Blockers found

Every way of authenticating against the Notion API needs permissions we don't have
in the LiveKit workspace today:

| Option | Status | Notes |
| --- | --- | --- |
| Internal integration ("API token") | Blocked | Only workspace owners can create internal connections. |
| Personal access token | Blocked | The workspace policy doesn't let members create tokens. |
| Public OAuth connection | Possible, but fragile | Members can create it. It needs a one-time manual login redirect. Tokens rotate on every refresh, so the action would have to write the new refresh token back into a repo secret using a GitHub token with secrets write access. Notion doesn't publish token lifetimes. |

The Notion API plan above stays the production target. To unblock it, a workspace
owner creates an internal integration named "Client Diagrams Bot" with only the
**Read content** and **Update content** capabilities. Switching to it later only
changes the upload step. The export script stays the same.

### Interim approach

Until we have a Notion integration, the action publishes the PNGs to a public GitHub
Pages site and Notion embeds them by link. This needs no Notion permissions and no
tokens.

**How it works:**

1. A push to `main` that changes an `.excalidraw` file triggers the workflow.
2. The workflow renders every diagram to PNG with the same Playwright exporter.
3. It deploys the PNGs to GitHub Pages with the official Pages actions. Nothing is
   committed back to the repo.
4. Each diagram lives at a fixed address based on its file name:

   ```
   https://livekit.github.io/client-diagrams/test1.png
   ```

**Adding a diagram to a Notion page:**

1. Add the `.excalidraw` file to the repo and merge to `main`.
2. In Notion, insert an image block, choose **Embed link**, and paste the diagram's
   Pages URL.

The link never changes, so the Notion page needs no further edits. There is no
mapping file in this approach.

**How updates reach Notion:**

Each deploy overwrites the file at the same address, and Notion loads external images
live from the source. GitHub Pages tells browsers to cache files for 10 minutes:

```
cache-control: max-age=600
```

So a merged change shows up in Notion within roughly 10 minutes. Notion may also
cache external images on its side. The first test should measure the real delay.

**Known tradeoffs:**

- **The diagrams are public.** The Pages site must be public, because Notion can't
  load images from a private Pages site. Anyone with a link can view the diagrams.
  The repo itself stays private.
- **Renaming a diagram breaks its link.** Keep file names stable, or update the link
  in Notion after a rename.
- **No cache busting.** The cache headers can't be changed on GitHub Pages, and adding
  a version to the URL would break the paste-once setup.
- **The org may block public Pages.** LiveKit's GitHub admins can stop private repos
  from publishing public sites. If that's set, the first deploy fails with a clear
  error.

**Interim checklist:**

- [x] Add the export script and the Pages workflow
- [ ] Enable GitHub Pages for the repo with GitHub Actions as the source and public
      visibility
- [ ] Test end to end with `test1.excalidraw` and measure the update delay
- [ ] Ask a workspace owner for the internal integration

## Status

- [ ] Create Notion integration and copy its token
- [ ] Add `NOTION_TOKEN` repo secret
- [ ] Connect the integration to the client SDK docs page
- [ ] Add export script, upload script, `notion.json`, and workflow
- [ ] Test end to end with `test1.excalidraw`
