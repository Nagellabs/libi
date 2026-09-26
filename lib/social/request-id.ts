import { randomUUID } from "node:crypto";
import type { SocialPostLink } from "./links";

/**
 * Low-level primitive only: a fresh random UUID with no idempotency
 * behavior of its own. Do not call this from a retry path — minting a new
 * id there defeats the provider's dedupe-by-id contract and can double-post.
 * Everything that needs a post's request id should go through
 * `requestIdForLink` below instead.
 */
export function newRequestId(): string { return randomUUID(); }

/**
 * The request id to send for a given link: reuses `link.requestId` when one
 * is already stored, mints a fresh one only when there is no link yet (or no
 * id was stored on it). This is the one accessor a compose/retry path should
 * call — never `newRequestId()` directly — so a retry reuses the SAME id
 * instead of silently minting a new one.
 *
 * One UUID per LOGICAL post: minted when a compose flow starts (or when
 * `libi.post_piece` starts), stored on the link row, and reused on every
 * retry.
 *
 * **It is NOT sent as `x-request-id`.** Zernio's REST API documents that
 * header, but the MCP tools this adapter speaks to declare
 * `additionalProperties: false` and expose no `headers` argument at all —
 * passing one is rejected outright ("headers  Unexpected keyword argument")
 * and no post is created (verified live 2026-09-20,
 * `.superpowers/sdd/zernio-live-shapes.md`). The id travels in
 * `metadata.libi.requestId`, which round-trips intact, and the dedupe it
 * buys is libi's own: the local link/intent row is consulted BEFORE a
 * create, and a recovery scan matches the stamp client-side because
 * `posts_list_posts` cannot filter by metadata. That makes it advisory, not
 * atomic — which is exactly why a publish is never auto-retried. A 409 (same
 * content, same account, 24 h) is still treated as success.
 */
export function requestIdForLink(link: SocialPostLink | null): string {
  return link?.requestId ?? newRequestId();
}
