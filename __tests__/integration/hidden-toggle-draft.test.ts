/**
 * Locked decision D3: toggling the eye (persisted `overlay.hidden`) is a REAL
 * draft edit. The write chain the inspector + libi.update_overlay share —
 * `updateOverlayInManifest` → `saveManifest` — must flip `pieces.has_draft`
 * and round-trip the field through the manifest, so commit/discard govern eye
 * toggles like any other edit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import {
  addOverlayToManifest,
  loadManifest,
  updateOverlayInManifest,
} from "@/lib/composition/persistence";

const PIECE_ID = "p-hidden-draft";

function hasDraft(): boolean {
  const [row] = getDb()
    .select({ hasDraft: pieces.hasDraft })
    .from(pieces)
    .where(eq(pieces.id, PIECE_ID))
    .all();
  return row?.hasDraft === true;
}

describe("eye toggle (hidden) is a draft mutation", () => {
  beforeEach(async () => {
    createTestDb();
    createTempStorageDir();
    resetStorage();
    seedPiece(getDb() as never, { id: PIECE_ID });
    await addOverlayToManifest(PIECE_ID, {
      id: "o1",
      kind: "text",
      startTime: 0,
      duration: 2,
      z: 0,
      opacity: 1,
      rect: { x: 0, y: 0, width: 100, height: 50 },
      content: "hi",
    } as never);
    // Simulate a committed (clean) state so the toggle's flip is unambiguous.
    getDb().update(pieces).set({ hasDraft: false }).where(eq(pieces.id, PIECE_ID)).run();
    expect(hasDraft()).toBe(false);
  });

  afterEach(() => {
    cleanupTempDir();
    resetTestDb();
    resetStorage();
  });

  it("toggling hidden flips has_draft and round-trips through the manifest", async () => {
    const ok = await updateOverlayInManifest(PIECE_ID, "o1", { hidden: true } as never);
    expect(ok).toBe(true);
    expect(hasDraft()).toBe(true); // the eye IS a draft edit (locked decision D3)

    const m = await loadManifest(PIECE_ID);
    const o1 = m.overlays?.find((o) => o.id === "o1");
    expect(o1?.hidden).toBe(true);

    // Un-hiding persists too (hidden: false ≡ visible; no delete sentinel).
    await updateOverlayInManifest(PIECE_ID, "o1", { hidden: false } as never);
    const m2 = await loadManifest(PIECE_ID);
    expect(m2.overlays?.find((o) => o.id === "o1")?.hidden).toBe(false);
  });
});
