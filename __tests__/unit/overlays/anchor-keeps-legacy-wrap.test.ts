/**
 * An un-anchored (add_overlay / legacy) text overlay gets its wrap width from
 * BUILD-time normalization (normalizeLegacyTextOverlay), which runs only while
 * the stored overlay has no `anchor`. Any update that gives it an anchor — a
 * canvas drag, the caption inspector's or layers panel's anchor pad, the
 * transform fields, or an agent's update_overlay — used to persist the anchor
 * WITHOUT the width, and the caption stopped wrapping. The overlay update path
 * now persists the normalized `maxWidthPct` with the first anchor, once, for
 * every caller.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { addOverlay, updateOverlay } from "@/mcp/tools/overlay-tools";
import { updateOverlaySchema } from "@/mcp/tools/schemas";

const PIECE = "p1";
const LONG = "This caption is long enough that it must wrap in portrait.";

async function portraitText(content: string, width: number): Promise<string> {
  const m = await loadManifest(PIECE);
  await saveManifest(PIECE, { ...m, width: 1080, height: 1920 });
  const add = await addOverlay({
    pieceId: PIECE, kind: "text", content, startTime: 0, duration: 2,
    rect: { x: 90, y: 1300, width, height: 300 },
    font: "700 64px Inter", fontSize: 64, color: "#fff", align: "center", z: 1, opacity: 1,
  });
  expect(add.success).toBe(true);
  return (add.data as { overlayId: string }).overlayId;
}

async function stored(id: string) {
  const m = await loadManifest(PIECE);
  return (m.overlays ?? []).find((o) => o.id === id) as { anchor?: string; maxWidthPct?: number };
}

describe("the first anchor keeps a legacy text's wrap width", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("MCP update_overlay setting anchor persists the wrap the preview drew (rect width / manifest width)", async () => {
    const id = await portraitText(LONG, 900);
    expect((await stored(id)).maxWidthPct).toBeUndefined();
    const upd = await updateOverlay(updateOverlaySchema.parse({
      pieceId: PIECE, overlayId: id, anchor: "mid-center", position: { x: 540, y: 1450 },
    }));
    expect(upd.success).toBe(true);
    const o = await stored(id);
    expect(o.anchor).toBe("mid-center");
    expect(o.maxWidthPct).toBeCloseTo(900 / 1080, 6);
  });

  it("a text that fits on one line gets no wrap width", async () => {
    const id = await portraitText("Short", 900);
    await updateOverlay(updateOverlaySchema.parse({ pieceId: PIECE, overlayId: id, anchor: "top-left", position: { x: 10, y: 10 } }));
    expect((await stored(id)).maxWidthPct).toBeUndefined();
  });

  it("an explicit maxWidthPct in the same patch wins", async () => {
    const id = await portraitText(LONG, 900);
    await updateOverlay(updateOverlaySchema.parse({
      pieceId: PIECE, overlayId: id, anchor: "mid-center", position: { x: 540, y: 1450 }, maxWidthPct: 0.5,
    }));
    expect((await stored(id)).maxWidthPct).toBe(0.5);
  });

  it("an already-anchored text is left alone (no width added)", async () => {
    const id = await portraitText(LONG, 900);
    await updateOverlay(updateOverlaySchema.parse({ pieceId: PIECE, overlayId: id, anchor: "mid-center", maxWidthPct: 0.5 }));
    await updateOverlay({ pieceId: PIECE, overlayId: id, maxWidthPct: null } as never);
    await updateOverlay(updateOverlaySchema.parse({ pieceId: PIECE, overlayId: id, anchor: "top-center", position: { x: 540, y: 100 } }));
    expect((await stored(id)).maxWidthPct).toBeUndefined();
  });

  it("a patch without anchor doesn't normalize", async () => {
    const id = await portraitText(LONG, 900);
    await updateOverlay(updateOverlaySchema.parse({ pieceId: PIECE, overlayId: id, color: "#ff0000" }));
    const o = await stored(id);
    expect(o.anchor).toBeUndefined();
    expect(o.maxWidthPct).toBeUndefined();
  });
});
