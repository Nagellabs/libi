/**
 * RC-D: path-traversal guard for `pieceId`.
 *
 * `pieceId` is used to build on-disk storage paths (`<storage>/<pieceId>/…`).
 * Without validation, a `pieceId` like `"../agent"` escapes the storage root and
 * lets an attacker overwrite arbitrary files (agent CLAUDE.md → takeover,
 * `../..` → ~/.zshrc → shell RCE). Real piece ids are `crypto.randomUUID()`
 * (hex + hyphens), so a strict character allowlist is both safe and
 * non-regressing for every legitimate id.
 *
 * `null` is the GLOBAL scope (files stored under `_global/`) and is always safe.
 */

/** Allowed characters for a non-null piece id. UUIDs (hex + `-`) and any
 *  underscore-bearing id pass; anything with a path separator, dot, whitespace,
 *  or control byte is rejected. */
const SAFE_PIECE_ID = /^[A-Za-z0-9_-]+$/;

/** True when `pieceId` is safe to use as a storage path segment. `null` (global
 *  scope) is safe. Any other value must match the strict allowlist. */
export function isSafePieceId(pieceId: string | null): boolean {
  if (pieceId === null) return true;
  return SAFE_PIECE_ID.test(pieceId);
}

/** Throws `Error("unsafe_piece_id")` when `pieceId` is not safe. No-op for
 *  `null` (global scope) and valid ids. */
export function assertSafePieceId(pieceId: string | null): void {
  if (!isSafePieceId(pieceId)) {
    throw new Error("unsafe_piece_id");
  }
}

/**
 * Same guard, for a `trackId`. Track ids are concatenated into an on-disk
 * filename (`<storage>/<pieceId>/_tracks/<trackId>.json`), so a `trackId` like
 * `"../../evil"` escapes the piece directory exactly as an unsafe `pieceId`
 * would. Real track ids are `trk-<uuid-segment>` (hex + hyphens), so the same
 * strict allowlist is safe and non-regressing. Unlike `pieceId`, a `trackId` is
 * never null.
 */
export function isSafeTrackId(trackId: string): boolean {
  return SAFE_PIECE_ID.test(trackId);
}

/** Throws `Error("unsafe_track_id")` when `trackId` is not safe. */
export function assertSafeTrackId(trackId: string): void {
  if (!isSafeTrackId(trackId)) {
    throw new Error("unsafe_track_id");
  }
}

/**
 * Guard for a storyboard card or sketch-slot id — taken from a URL (the sketch route) or
 * supplied by an agent creating a card (`addStoryboardCard`). Both name folders and files
 * under the piece (`storyboard/cards/<cardId>/sketches/<slotId>.png`). They are generated —
 * `card_<n>` and `sk_<n>` — or an agent's own card id (`s1-hook`), so the piece-id alphabet plus
 * INTERIOR dots is enough: no leading or trailing dot, no `..`, no `%`, `:`, space or separator.
 */
const SAFE_STORYBOARD_ID = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export function isSafeStoryboardId(id: string): boolean {
  return typeof id === "string" && SAFE_STORYBOARD_ID.test(id);
}
