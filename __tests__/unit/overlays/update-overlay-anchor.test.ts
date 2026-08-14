/**
 * Task 6.1 — update_overlay sets anchor + position + maxWidthPct (UI↔MCP parity).
 *
 * A text overlay's point-text placement (anchor + position) and wrap cap
 * (maxWidthPct) are now settable through libi.update_overlay, mirroring the UI
 * inspector. After the patch lands, saveManifest's recomputeTextOverlayRect
 * derives the rect from the placement, so the persisted rect is consistent with
 * placeBoxAtAnchor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { loadManifest } from "@/lib/composition/persistence";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import { addOverlay, updateOverlay } from "@/mcp/tools/overlay-tools";
import { updateOverlaySchema } from "@/mcp/tools/schemas";

const PIECE = "p1";

describe("update_overlay — anchor + position + maxWidthPct", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    // Default composition width 1920 (frame width drives the recomputed rect).
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("sets anchor/position/maxWidthPct on a text overlay and derives a consistent rect", async () => {
    const add = await addOverlay({
      pieceId: PIECE,
      kind: "text",
      content: "Hello world",
      startTime: 0,
      duration: 2,
      rect: { x: 0, y: 0, width: 100, height: 20 },
      font: "48px Inter",
      color: "#fff",
      align: "center",
      z: 0,
      opacity: 1,
      fontSize: 48,
    });
    expect(add.success).toBe(true);
    const overlayId = (add.data as { overlayId: string }).overlayId;

    // Validate through the MCP schema first — this is what the agent must be
    // able to pass. Before the schema declared anchor/position/maxWidthPct,
    // Zod would strip them and the agent could never set point-text placement.
    const parsed = updateOverlaySchema.parse({
      pieceId: PIECE,
      overlayId,
      anchor: "top-center",
      position: { x: 960, y: 100 },
      maxWidthPct: 0.7,
    });
    expect(parsed.anchor).toBe("top-center");
    expect(parsed.position).toEqual({ x: 960, y: 100 });
    expect(parsed.maxWidthPct).toBe(0.7);

    const upd = await updateOverlay(parsed);
    expect(upd.success).toBe(true);

    const m = await loadManifest(PIECE);
    const o = (m.overlays ?? [])[0] as {
      anchor?: string;
      position?: { x: number; y: number };
      maxWidthPct?: number;
      rect: { x: number; y: number; width: number; height: number };
    };

    expect(o.anchor).toBe("top-center");
    expect(o.position).toEqual({ x: 960, y: 100 });
    expect(o.maxWidthPct).toBe(0.7);

    // The derived rect must be consistent with placeBoxAtAnchor for top-center:
    //   - top edge of the rect at y ≈ 100 (anchor pins the box top),
    //   - horizontally centered on x = 960 (rect.x + rect.width/2 ≈ 960).
    expect(o.rect.y).toBeCloseTo(100, 5);
    expect(o.rect.x + o.rect.width / 2).toBeCloseTo(960, 5);
  });
});
