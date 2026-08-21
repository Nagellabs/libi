import type { QueryClient } from "@tanstack/react-query";
import { pieceKeys } from "@/lib/queries/pieces";
import { fileKeys } from "@/lib/queries/files";
import { storyboardKeys } from "@/lib/queries/storyboard";
import { trackKeys } from "@/lib/queries/tracks";
import { snapshotKeys } from "@/lib/queries/snapshots";
import { assetFolderKeys } from "@/lib/queries/asset-folders";
import { folderKeys } from "@/lib/queries/folders";
import { terminalKeys } from "@/lib/queries/terminals";
import { effectsCatalogKeys } from "@/lib/queries/effects-catalog";
import { characterKeys, itemKeys } from "@/lib/queries/catalog";

/**
 * Pure data-cache invalidation switch for `refresh_query` SSE events.
 *
 * Returns `true` when the event was handled (caller should stop), `false`
 * when the caller needs to handle it further. Composition events return
 * `false` because the editor page combines invalidation with navigation
 * side effects (auto-show seek, tab switch) that don't belong in a pure
 * data dispatcher.
 *
 * Behavior:
 *   - `analysis` (with fileId) — invalidate `["analysis", "file", fileId]`.
 *   - `pieces`                 — invalidate `pieceKeys.all`.
 *   - `files`                  — invalidate `fileKeys.global()`, plus
 *                                `fileKeys.forPiece(pieceId)` when set.
 *   - `piece` (with pieceId)   — invalidate `pieceKeys.detail`,
 *                                `pieceKeys.all`, `fileKeys.forPiece`
 *                                in that exact order (downstream tests
 *                                may assert on it).
 *   - `storyboard` (with pieceId) — invalidate `storyboardKeys.detail(pieceId)`.
 *   - `piece-state` (with pieceId) — invalidate `snapshotKeys.state` and
 *                                   `snapshotKeys.compare` for the piece.
 *   - `track` (with trackId)   — invalidate `trackKeys.detail(trackId)`.
 *   - `asset-folders`          — invalidate `assetFolderKeys.scope(pieceId)`
 *                                (scope is `"global"` when pieceId absent).
 *   - `folders`                — invalidate `folderKeys.all`.
 *   - `terminal-sessions`      — invalidate `terminalKeys.all`.
 *   - `caption-styles`         — invalidate `["caption-styles"]`.
 *   - `effects-custom`         — invalidate `effectsCatalogKeys.custom`
 *                                (`["effects","custom"]`) so a custom effect the
 *                                agent just authored/edited/removed lands in the
 *                                effects panel's Custom tab live (no reload).
 */
export function dispatchRefreshQueryData(
  event: {
    queryKey: string;
    pieceId?: string;
    fileId?: string;
    trackId?: string;
  },
  queryClient: QueryClient,
): boolean {
  if (event.queryKey === "analysis") {
    if (!event.fileId) return false;
    queryClient.invalidateQueries({
      queryKey: ["analysis", "file", event.fileId],
    });
    return true;
  }

  if (event.queryKey === "pieces") {
    queryClient.invalidateQueries({ queryKey: pieceKeys.all });
    return true;
  }

  if (event.queryKey === "files") {
    queryClient.invalidateQueries({ queryKey: fileKeys.global() });
    if (event.pieceId) {
      queryClient.invalidateQueries({
        queryKey: fileKeys.forPiece(event.pieceId),
      });
    }
    return true;
  }

  if (event.queryKey === "piece") {
    if (!event.pieceId) return false;
    queryClient.invalidateQueries({
      queryKey: pieceKeys.detail(event.pieceId),
    });
    queryClient.invalidateQueries({ queryKey: pieceKeys.all });
    queryClient.invalidateQueries({
      queryKey: fileKeys.forPiece(event.pieceId),
    });
    return true;
  }

  if (event.queryKey === "storyboard") {
    if (!event.pieceId) return false;
    queryClient.invalidateQueries({
      queryKey: storyboardKeys.detail(event.pieceId),
    });
    return true;
  }

  if (event.queryKey === "piece-state") {
    if (!event.pieceId) return false;
    queryClient.invalidateQueries({
      queryKey: snapshotKeys.state(event.pieceId),
    });
    queryClient.invalidateQueries({
      queryKey: snapshotKeys.compare(event.pieceId),
    });
    return true;
  }

  if (event.queryKey === "asset-folders") {
    queryClient.invalidateQueries({
      queryKey: assetFolderKeys.scope(event.pieceId ?? null),
    });
    return true;
  }

  if (event.queryKey === "track") {
    if (!event.trackId) return false;
    queryClient.invalidateQueries({ queryKey: trackKeys.detail(event.trackId) });
    return true;
  }

  if (event.queryKey === "folders") {
    queryClient.invalidateQueries({ queryKey: folderKeys.all });
    return true;
  }

  if (event.queryKey === "terminal-sessions") {
    queryClient.invalidateQueries({ queryKey: terminalKeys.all });
    return true;
  }

  if (event.queryKey === "caption-styles") {
    queryClient.invalidateQueries({ queryKey: ["caption-styles"] });
    return true;
  }

  if (event.queryKey === "effects-custom") {
    queryClient.invalidateQueries({ queryKey: effectsCatalogKeys.custom });
    return true;
  }

  if (event.queryKey === "characters") {
    queryClient.invalidateQueries({ queryKey: characterKeys.all });
    // The catalog tools emit `{ queryKey: "characters" }` with no pieceId,
    // so invalidate every per-piece query (`["pieces", <id>, "characters"]`)
    // that the merged Objects tab reads.
    queryClient.invalidateQueries({
      predicate: (q) =>
        q.queryKey[0] === "pieces" && q.queryKey[2] === "characters",
    });
    return true;
  }

  if (event.queryKey === "items") {
    queryClient.invalidateQueries({ queryKey: itemKeys.all });
    queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "pieces" && q.queryKey[2] === "items",
    });
    return true;
  }

  return false;
}
