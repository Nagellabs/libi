import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { pieces } from "@/lib/db/schema/sqlite";

/**
 * POST /api/editor/open-piece is the single chokepoint every piece open flows
 * through, which is why the recents list on the "No piece open" panel hangs
 * its `lastOpenedAt` stamp here. Two things must stay true: the stamp lands,
 * and it never disturbs `updatedAt` — merely LOOKING at a piece must not be
 * recorded as having CHANGED it, or the resources tree reorders itself every
 * time someone browses.
 */

let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

const warn = vi.fn();
vi.mock("@/lib/logger", () => ({
  serverLogger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn() },
}));

import { POST } from "@/app/api/editor/open-piece/route";
import { getOpenedPieceId, setOpenedPieceId } from "@/lib/editor-state";

function post(body: unknown) {
  return POST(
    new Request("http://x/api/editor/open-piece", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function row(id: string) {
  const [r] = await testDb.select().from(pieces).where(eq(pieces.id, id));
  return r;
}

beforeEach(() => {
  testDb = createTestDb();
  seedPiece(testDb);
  setOpenedPieceId(null);
  warn.mockClear();
});

describe("POST /api/editor/open-piece", () => {
  it("stamps lastOpenedAt when a piece is opened", async () => {
    expect((await row("test-piece-1")).lastOpenedAt).toBeNull();

    const before = Date.now();
    const res = await post({ pieceId: "test-piece-1" });
    expect(res.status).toBe(200);

    const opened = (await row("test-piece-1")).lastOpenedAt;
    expect(opened).toBeInstanceOf(Date);
    // Second-resolution storage: allow the truncation slack in both directions.
    expect(opened!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(opened!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("leaves updatedAt alone — opening is not editing", async () => {
    const before = (await row("test-piece-1")).updatedAt;
    await post({ pieceId: "test-piece-1" });
    const after = (await row("test-piece-1")).updatedAt;
    expect(after.getTime()).toBe(before.getTime());
  });

  it("still records which piece is open (its original job)", async () => {
    await post({ pieceId: "test-piece-1" });
    expect(getOpenedPieceId()).toBe("test-piece-1");
  });

  it("clears the open piece on close without stamping anything", async () => {
    await post({ pieceId: "test-piece-1" });
    const stamped = (await row("test-piece-1")).lastOpenedAt;

    await post({ pieceId: null });
    expect(getOpenedPieceId()).toBeNull();
    // The close must not re-stamp — it would make every piece look opened
    // "just now" the moment the user navigated away from it.
    expect((await row("test-piece-1")).lastOpenedAt?.getTime()).toBe(
      stamped?.getTime(),
    );
  });

  it("still succeeds when the stamp fails — the open-piece pointer matters more", async () => {
    // A piece id that isn't in the DB is the cheap stand-in for any write
    // failure. The pointer feeds the proxy LRU's open-piece protection;
    // losing a recents timestamp must never take that down with it.
    const res = await post({ pieceId: "no-such-piece" });
    expect(res.status).toBe(200);
    expect(getOpenedPieceId()).toBe("no-such-piece");
  });

  it("rejects malformed JSON", async () => {
    const res = await POST(
      new Request("http://x/api/editor/open-piece", { method: "POST", body: "{" }),
    );
    expect(res.status).toBe(400);
  });
});
