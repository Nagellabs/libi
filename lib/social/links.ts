import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { socialPostLinks, socialPostIntents, socialAdLinks } from "@/lib/db/schema/sqlite";

/**
 * The local index of piece -> provider-post. The provider (Zernio) is the
 * source of truth for the post itself; this table only answers "which posts
 * came from this piece" and "which piece did this post come from" quickly,
 * since the provider stamps `metadata.libi.pieceId` on the post but cannot
 * filter reads by it. `lastStatus`/`lastStatusAt` are a display cache only.
 */
export interface SocialPostLink {
  providerId: string;
  providerPostId: string;
  pieceId: string;
  exportPath: string | null;
  requestId: string | null;
  createdBy: "agent" | "ui";
  createdAt: Date;
  lastStatus: string | null;
  lastStatusAt: Date | null;
}

/**
 * Idempotent on (providerId, providerPostId): a second insert updates
 * `exportPath`/`requestId` only.
 *
 * **`createdBy` is written once and never rewritten.** It is provenance — the
 * row's chip reads "in libi" or "by agent" — and linking is not authorship: a
 * single idempotent `libi.social_link_post` (or the reindex sweep, which has
 * to assume "agent" for every post it finds) used to flip a post the user had
 * composed in the UI to "by agent" (QA 2026-09-21, finding 9). Whoever created
 * the row created the post; a later linker only says where it belongs.
 */
export function insertLink(l: Omit<SocialPostLink, "createdAt" | "lastStatus" | "lastStatusAt">): void {
  const db = getDb();
  db.insert(socialPostLinks)
    .values(l)
    .onConflictDoUpdate({
      target: [socialPostLinks.providerId, socialPostLinks.providerPostId],
      set: { exportPath: l.exportPath, requestId: l.requestId },
    })
    .run();
}

export function linksForPiece(pieceId: string, providerId: string): SocialPostLink[] {
  return getDb()
    .select()
    .from(socialPostLinks)
    .where(and(eq(socialPostLinks.pieceId, pieceId), eq(socialPostLinks.providerId, providerId)))
    .all();
}

export function linkForPost(providerId: string, providerPostId: string): SocialPostLink | null {
  const [row] = getDb()
    .select()
    .from(socialPostLinks)
    .where(and(eq(socialPostLinks.providerId, providerId), eq(socialPostLinks.providerPostId, providerPostId)))
    .limit(1)
    .all();
  return row ?? null;
}

export function touchLinkStatus(providerId: string, providerPostId: string, status: string): void {
  getDb()
    .update(socialPostLinks)
    .set({ lastStatus: status, lastStatusAt: new Date() })
    .where(and(eq(socialPostLinks.providerId, providerId), eq(socialPostLinks.providerPostId, providerPostId)))
    .run();
}

export function allLinks(providerId: string): SocialPostLink[] {
  return getDb().select().from(socialPostLinks).where(eq(socialPostLinks.providerId, providerId)).all();
}

/**
 * One row per logical post ATTEMPT, written BEFORE the create is sent.
 *
 * `providerPostId` is null for exactly as long as libi does not know whether
 * a post exists — the window this whole mechanism is about.
 */
export interface SocialPostIntent {
  providerId: string;
  requestId: string;
  pieceId: string | null;
  providerPostId: string | null;
  mode: "draft" | "schedule" | "now";
  state: "pending" | "linked" | "unknown";
  createdAt: Date;
  updatedAt: Date | null;
}

/**
 * Claim the intent to create this logical post, and say whether it had been
 * claimed before.
 *
 * `existing: true` is the signal that matters: this `requestId` has already
 * been sent at least once, so the caller must look for the post it may have
 * created before sending another. The row is never overwritten on a repeat —
 * its `createdAt` is what bounds the recovery scan.
 */
export function beginPostIntent(i: {
  providerId: string;
  requestId: string;
  pieceId: string | null;
  mode: SocialPostIntent["mode"];
}): { intent: SocialPostIntent; existing: boolean } {
  const db = getDb();
  const prior = postIntent(i.providerId, i.requestId);
  if (prior) return { intent: prior, existing: true };
  db.insert(socialPostIntents)
    .values({ ...i, providerPostId: null, state: "pending" })
    // A concurrent request that won the race owns the row; keep theirs.
    .onConflictDoNothing()
    .run();
  const stored = postIntent(i.providerId, i.requestId);
  // The read-back cannot be null (we just inserted, or someone else did), but
  // a synthesized row beats a non-null assertion if the DB surprises us.
  return stored
    ? { intent: stored, existing: false }
    : { intent: { ...i, providerPostId: null, state: "pending", createdAt: new Date(), updatedAt: null }, existing: false };
}

/**
 * How far back an unresolved intent is still worth adopting. Past it the row
 * can no longer help: the provider's own duplicate rejection (same content,
 * same account) also expires at 24 h, and a recovery scan over a day-old
 * window is not evidence of anything.
 */
export const OPEN_INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * This piece's most recent post attempt whose outcome libi never established
 * — `pending` or `unknown`, with no provider post id.
 *
 * It is what a REOPENED composer must adopt its `requestId` from. A composer
 * that minted a fresh id per mount would start a new logical post after a
 * publish-now whose answer never arrived, and the adapter's intent check
 * (`beginPostIntent` -> recovery scan -> `needs_confirmation`) would never
 * fire — leaving only the provider's 24 h identical-content rejection
 * between the user and a second post.
 */
export function openPostIntent(providerId: string, pieceId: string, now: Date = new Date()): SocialPostIntent | null {
  const [row] = getDb()
    .select()
    .from(socialPostIntents)
    .where(
      and(
        eq(socialPostIntents.providerId, providerId),
        eq(socialPostIntents.pieceId, pieceId),
        isNull(socialPostIntents.providerPostId),
        gte(socialPostIntents.createdAt, new Date(now.getTime() - OPEN_INTENT_MAX_AGE_MS)),
      ),
    )
    .orderBy(desc(socialPostIntents.createdAt))
    .limit(1)
    .all();
  return row ?? null;
}

export function postIntent(providerId: string, requestId: string): SocialPostIntent | null {
  const [row] = getDb()
    .select()
    .from(socialPostIntents)
    .where(and(eq(socialPostIntents.providerId, providerId), eq(socialPostIntents.requestId, requestId)))
    .limit(1)
    .all();
  return row ?? null;
}

/** The post is known: record its id so no later attempt can create a second one. */
export function resolvePostIntent(providerId: string, requestId: string, providerPostId: string): void {
  getDb()
    .update(socialPostIntents)
    .set({ providerPostId, state: "linked", updatedAt: new Date() })
    .where(and(eq(socialPostIntents.providerId, providerId), eq(socialPostIntents.requestId, requestId)))
    .run();
}

/**
 * The attempt failed WITHOUT establishing whether the provider created the
 * post. Recorded rather than deleted: the row is what makes the next attempt
 * look before it leaps.
 */
export function markPostIntentUnknown(providerId: string, requestId: string): void {
  getDb()
    .update(socialPostIntents)
    .set({ state: "unknown", updatedAt: new Date() })
    .where(and(eq(socialPostIntents.providerId, providerId), eq(socialPostIntents.requestId, requestId)))
    .run();
}

/**
 * The local index of piece -> provider-AD, for ads that were never organic
 * posts. An ad that BOOSTS a post needs no row: the provider itself knows
 * (`effectiveInstagramMediaId` matches that post's target `platformPostId`),
 * so it is discovered on every read. This is only the case the provider cannot
 * answer — a piece published straight to an ad account as a dark post.
 */
export interface SocialAdLink {
  providerId: string;
  providerAdId: string;
  platformAdId: string | null;
  pieceId: string;
  createdBy: "agent" | "ui";
  createdAt: Date;
}

/**
 * Idempotent on (providerId, providerAdId). Like `insertLink`, `createdBy` is
 * provenance and is written once: linking is not authorship.
 */
export function insertAdLink(l: Omit<SocialAdLink, "createdAt">): void {
  getDb()
    .insert(socialAdLinks)
    .values(l)
    .onConflictDoUpdate({
      target: [socialAdLinks.providerId, socialAdLinks.providerAdId],
      set: { platformAdId: l.platformAdId },
    })
    .run();
}

/** Every ad this piece was linked to, newest first. */
export function adLinksForPiece(providerId: string, pieceId: string): SocialAdLink[] {
  return getDb()
    .select()
    .from(socialAdLinks)
    .where(and(eq(socialAdLinks.providerId, providerId), eq(socialAdLinks.pieceId, pieceId)))
    .orderBy(desc(socialAdLinks.createdAt))
    .all();
}

/** Every ad link for this provider — the Social page's Ads tab places ads on
 *  their pieces with it. */
export function allAdLinks(providerId: string): SocialAdLink[] {
  return getDb().select().from(socialAdLinks).where(eq(socialAdLinks.providerId, providerId)).all();
}

/** Drop one link. The AD is untouched — libi never deletes provider objects. */
export function removeAdLink(providerId: string, providerAdId: string): void {
  getDb()
    .delete(socialAdLinks)
    .where(and(eq(socialAdLinks.providerId, providerId), eq(socialAdLinks.providerAdId, providerAdId)))
    .run();
}
