import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces, socialPostLinks } from "@/lib/db/schema/sqlite";
import { insertLink, linksForPiece, linkForPost, touchLinkStatus, beginPostIntent, postIntent, resolvePostIntent, markPostIntentUnknown, openPostIntent, OPEN_INTENT_MAX_AGE_MS } from "@/lib/social/links";

beforeEach(() => {
  createTestDb();
});
afterEach(() => {
  resetTestDb();
});

describe("social_post_links", () => {
  it("inserts, reads by piece and by provider post, touches status", () => {
    const db = getDb();
    const [p] = db.insert(pieces).values({ name: "Cutdown v3" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: "post_1", pieceId: p.id, exportPath: "/x/export.mp4", requestId: "r1", createdBy: "ui" });
    expect(linksForPiece(p.id, "zernio").map((l) => l.providerPostId)).toEqual(["post_1"]);
    expect(linkForPost("zernio", "post_1")?.pieceId).toBe(p.id);
    touchLinkStatus("zernio", "post_1", "scheduled");
    expect(linkForPost("zernio", "post_1")?.lastStatus).toBe("scheduled");
  });
  it("is deleted with its piece (FK cascade)", () => {
    const db = getDb();
    const [p] = db.insert(pieces).values({ name: "gone" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: "post_2", pieceId: p.id, exportPath: null, requestId: null, createdBy: "agent" });
    db.delete(pieces).where(eq(pieces.id, p.id)).run();
    expect(db.select().from(socialPostLinks).where(eq(socialPostLinks.providerPostId, "post_2")).all()).toEqual([]);
  });
  it("same provider post twice is one row (composite PK) — insert is idempotent", () => {
    const db = getDb();
    const [p] = db.insert(pieces).values({ name: "twice" }).returning().all();
    insertLink({ providerId: "zernio", providerPostId: "post_3", pieceId: p.id, exportPath: null, requestId: null, createdBy: "ui" });
    insertLink({ providerId: "zernio", providerPostId: "post_3", pieceId: p.id, exportPath: "/later.mp4", requestId: null, createdBy: "ui" });
    expect(linksForPiece(p.id, "zernio")).toHaveLength(1);
  });
});

/**
 * The write-ahead half of the dedupe contract. `social_post_links` cannot hold
 * it: that table is keyed by a provider post id, and the whole point of an
 * intent is to exist BEFORE one does.
 */
describe("social_post_intents", () => {
  it("claims an intent once, and says on every later call that it already existed", () => {
    const db = getDb();
    const [p] = db.insert(pieces).values({ name: "compose" }).returning().all();
    const first = beginPostIntent({ providerId: "zernio", requestId: "r1", pieceId: p.id, mode: "now" });
    expect(first).toMatchObject({ existing: false, intent: { providerPostId: null, state: "pending", mode: "now" } });

    const second = beginPostIntent({ providerId: "zernio", requestId: "r1", pieceId: p.id, mode: "now" });
    expect(second.existing).toBe(true);
    // The original row survives — its createdAt is what bounds a recovery scan.
    expect(second.intent.createdAt).toEqual(first.intent.createdAt);
  });

  it("records the id once it is known, and records 'unknown' when it never is", () => {
    const db = getDb();
    const [p] = db.insert(pieces).values({ name: "outcome" }).returning().all();
    beginPostIntent({ providerId: "zernio", requestId: "r1", pieceId: p.id, mode: "schedule" });
    resolvePostIntent("zernio", "r1", "post_1");
    expect(postIntent("zernio", "r1")).toMatchObject({ providerPostId: "post_1", state: "linked" });

    beginPostIntent({ providerId: "zernio", requestId: "r2", pieceId: p.id, mode: "now" });
    markPostIntentUnknown("zernio", "r2");
    expect(postIntent("zernio", "r2")).toMatchObject({ providerPostId: null, state: "unknown" });
  });

  it("openPostIntent answers the piece's most recent UNRESOLVED attempt, and nothing else", () => {
    const db = getDb();
    const [p] = db.insert(pieces).values({ name: "reopen" }).returning().all();
    const [other] = db.insert(pieces).values({ name: "elsewhere" }).returning().all();

    // Nothing open yet.
    expect(openPostIntent("zernio", p.id)).toBeNull();

    // A resolved attempt is NOT open: that post exists, and a composer opened
    // now is composing a different one.
    beginPostIntent({ providerId: "zernio", requestId: "r-linked", pieceId: p.id, mode: "draft" });
    resolvePostIntent("zernio", "r-linked", "post_1");
    expect(openPostIntent("zernio", p.id)).toBeNull();

    // A publish-now whose outcome libi never learned IS open — this is what a
    // reopened composer must adopt rather than minting a new identity.
    beginPostIntent({ providerId: "zernio", requestId: "r-unknown", pieceId: p.id, mode: "now" });
    markPostIntentUnknown("zernio", "r-unknown");
    expect(openPostIntent("zernio", p.id)?.requestId).toBe("r-unknown");

    // Another piece's open attempt is never this piece's.
    beginPostIntent({ providerId: "zernio", requestId: "r-other", pieceId: other.id, mode: "now" });
    expect(openPostIntent("zernio", p.id)?.requestId).toBe("r-unknown");
    // Nor another provider's.
    expect(openPostIntent("other-provider", p.id)).toBeNull();

    // Past the window the row can no longer help: the provider's own
    // duplicate rejection has expired too.
    const later = new Date(Date.now() + OPEN_INTENT_MAX_AGE_MS + 60_000);
    expect(openPostIntent("zernio", p.id, later)).toBeNull();
  });

  it("is deleted with its piece (FK cascade), and a piece-less intent is still allowed", () => {
    const db = getDb();
    const [p] = db.insert(pieces).values({ name: "gone" }).returning().all();
    beginPostIntent({ providerId: "zernio", requestId: "r1", pieceId: p.id, mode: "draft" });
    beginPostIntent({ providerId: "zernio", requestId: "r-orphan", pieceId: null, mode: "draft" });
    db.delete(pieces).where(eq(pieces.id, p.id)).run();
    expect(postIntent("zernio", "r1")).toBeNull();
    expect(postIntent("zernio", "r-orphan")).not.toBeNull();
  });
});
