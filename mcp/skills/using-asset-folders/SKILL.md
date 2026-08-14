---
name: using-asset-folders
description: Use when generating or uploading MULTIPLE related assets — an extend chain, several concept/style variations of one image or video, or a batch of takes — and you want them grouped instead of flooding the piece with loose files. Teaches the one-file-one-asset model plus asset folders. There are no "options" or a "default file" anymore.
when_to_use: When you produce several related assets in one flow (an extend chain, concept/style variants, a batch of takes), or when the user asks to organize, group, move, or clean up a piece's assets.
---

# Using Asset Folders

Every uploaded or generated file is its own **asset**. There is no "options" slot and no "default file" — that model is gone. To keep related assets together, group them into **folders**.

## Core principles

1. **One asset = one file.** Each generated or uploaded file is a standalone asset. Never try to recreate "options" or a "default file" — those concepts no longer exist.
2. **A single standalone asset stays at the scope root** (no folder). Don't create a folder for a lone file.
3. **Group related assets into a folder** whenever you produce MULTIPLE related assets in one flow — an extend chain, several concept/style variations of one image or video, a batch of takes. Create the folder ONCE, then upload each file with that `folderId`.

## Workflow: producing multiple related assets

When a flow will generate more than one related asset (an extend chain, 2–3 style variants, a batch of takes):

1. Create the folder once:
   ```
   libi.create_asset_folder({ pieceId, name: "<beat / product / concept name>" })
     → returns { folderId }
   ```
2. Upload each produced file into it:
   ```
   libi.upload_file({ pieceId, filePath, folderId, aiGeneration, ... })
   ```
   (`folderId` replaces the old `attachToAssetId` argument.)

The folder is just an organizational container — the composition still references whichever individual file you chose, by `fileId`.

## Browsing & reorganizing

- **List one level:** `libi.list_assets({ pieceId, folderId? })` → `{ folders, assets }`. Omit `folderId` (or pass the top level) to see the scope root; pass a `folderId` to see that folder's contents.
- **Move an asset:** `libi.move_asset({ fileId, folderId })`. `folderId: null` moves it back to the scope root. (Scope-validated — an asset can only move within its own piece / the global pool.)
- **Move a folder:** `libi.move_asset_folder({ folderId, parentFolderId })`. `parentFolderId: null` moves it to the top level. (Cycle-checked — a folder can't become its own descendant.)
- **Rename a folder:** `libi.rename_asset_folder({ folderId, name })`.
- **Navigate the editor to an asset:** `libi.show_asset({ pieceId, fileId })` (unchanged).

## Deleting a folder

`libi.delete_asset_folder({ folderId, mode?, confirm? })`:

- **`mode: "orphan"` (default, safe)** — deletes only the folder; its contents are reparented to the folder's parent (or the scope root). Nothing is lost.
- **`mode: "cascade"` (destructive)** — deletes the folder AND every asset inside it. Requires `confirm: true`.

Default to `orphan`. Only `cascade` on explicit user intent ("delete that folder and everything in it").

## Global assets

The same tools operate on the global file pool — pass `pieceId: null`. Folders, listing, moving, and deletion all work identically for global assets.

## Out-of-scope

- **There is no "default" / "active" file** — if the user wants a different version used in the composition, swap the `fileId` the scene/overlay/clip references directly (via the relevant scene/overlay/audio tool). Don't look for a `set_default_option` — it doesn't exist.
- **Variations of a file** (trimming, EQ, color grade) produce a NEW asset, not a new version of the same one. Group them in a folder if related.

All asset-folder tools live under the `libi.` MCP namespace.
