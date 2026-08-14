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
