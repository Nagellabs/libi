/**
 * Integration: exercise every overlay tool end-to-end — the handler writes
 * through to the manifest, the log event fires, and the next read sees
 * the persisted overlay.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { loadManifest } from "@/lib/composition/persistence";
import { files } from "@/lib/db/schema";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import {
  addOverlay,
  updateOverlay,
  removeOverlayTool,
  reorderOverlays,
} from "@/mcp/tools/overlay-tools";

const PIECE = "p1";

describe("overlay tools", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    // add_overlay now validates fileId ownership (piece ∪ global) — seed the
    // rows the image/video fixtures reference.
    for (const [id, type, ct] of [["f1", "image", "image/png"], ["f2", "video", "video/mp4"]] as const) {
      testDb.insert(files).values({
        id, pieceId: PIECE, filename: `${id}`, name: id, description: "",
        type, storagePath: `p1/${id}`, contentType: ct, size: 1,
      }).run();
    }
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("add_overlay text persists a text overlay", async () => {
    const res = await addOverlay({
      pieceId: PIECE, kind: "text", content: "hi", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 100, height: 20 },
      font: "16px Inter", color: "#fff", align: "center", z: 0, opacity: 1,
    });
    expect(res.success).toBe(true);
    const m = await loadManifest(PIECE);
    expect(m.overlays).toHaveLength(1);
    expect(m.overlays?.[0].kind).toBe("text");
    if (m.overlays?.[0].kind === "text") {
      expect(m.overlays[0].content).toBe("hi");
    }
  });

  it("rejects a text overlay with no content", async () => {
    const r = await addOverlay({
      pieceId: PIECE, kind: "text", startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    } as never);
    expect(r.success).toBe(false);
    expect(r.error).toBe("missing_field");
  });

  it("rejects an image overlay with no fileId", async () => {
    const r = await addOverlay({
      pieceId: PIECE, kind: "image", startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    } as never);
    expect(r.success).toBe(false);
    expect(r.error).toBe("missing_field");
  });

  it("update_overlay patches a field", async () => {
    const add = await addOverlay({
      pieceId: PIECE, kind: "text", content: "before", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      font: "", color: "", align: "left", z: 0, opacity: 1,
    });
    const overlayId = (add.data as { overlayId: string }).overlayId;

    const upd = await updateOverlay({
      pieceId: PIECE, overlayId, content: "after",
    });
    expect(upd.success).toBe(true);
    const m = await loadManifest(PIECE);
    const t = m.overlays?.[0];
    if (t?.kind === "text") expect(t.content).toBe("after");
  });

  it("update_overlay returns success:false for missing id", async () => {
    const res = await updateOverlay({
      pieceId: PIECE, overlayId: "does-not-exist", content: "x",
    });
    expect(res.success).toBe(false);
  });

  it("add_overlay image persists an image overlay with fileId", async () => {
    const res = await addOverlay({
      pieceId: PIECE, kind: "image", fileId: "f1", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 50, height: 50 }, z: 1, opacity: 0.8,
    });
    expect(res.success).toBe(true);
    const m = await loadManifest(PIECE);
    const o = m.overlays?.[0];
    expect(o?.kind).toBe("image");
    if (o?.kind === "image") expect(o.fileId).toBe("f1");
  });

  it("add_overlay video persists optional trim", async () => {
    const res = await addOverlay({
      pieceId: PIECE, kind: "video", fileId: "f2", startTime: 0, duration: 2,
      rect: { x: 0, y: 0, width: 50, height: 50 },
      trim: { start: 1, end: 3 }, z: 0, opacity: 1,
    });
    expect(res.success).toBe(true);
    const m = await loadManifest(PIECE);
    const o = m.overlays?.[0];
    if (o?.kind === "video") expect(o.trim).toEqual({ start: 1, end: 3 });
  });

  it("add_overlay code persists the drawFunction string", async () => {
    const res = await addOverlay({
      pieceId: PIECE, kind: "code", displayName: "Test", body: "ctx.fillRect(0,0,10,10)",
      startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 20, height: 20 }, z: 0, opacity: 1,
    });
    expect(res.success).toBe(true);
    const m = await loadManifest(PIECE);
    const o = m.overlays?.[0];
    if (o?.kind === "code") expect(o.drawFunction).toBe("ctx.fillRect(0,0,10,10)");
  });

  it("add_overlay code rejects dangerous draw functions (validateDrawFunction)", async () => {
    const res = await addOverlay({
      pieceId: PIECE, kind: "code", displayName: "Test", body: "fetch('https://evil.example')",
      startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 20, height: 20 }, z: 0, opacity: 1,
    });
    expect(res.success).toBe(false);
    // Nothing persisted.
    const m = await loadManifest(PIECE);
    expect(m.overlays ?? []).toHaveLength(0);
  });

  it("removeOverlayTool drops the matching overlay", async () => {
    const add = await addOverlay({
      pieceId: PIECE, kind: "text", content: "x", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      font: "", color: "", align: "left", z: 0, opacity: 1,
    });
    const overlayId = (add.data as { overlayId: string }).overlayId;

    const rm = await removeOverlayTool({ pieceId: PIECE, overlayId });
    expect(rm.success).toBe(true);
    const m = await loadManifest(PIECE);
    expect(m.overlays ?? []).toHaveLength(0);
  });

  it("reorderOverlays sets z by position in the supplied order", async () => {
    const a = await addOverlay({
      pieceId: PIECE, kind: "text", content: "a", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      font: "", color: "", align: "left", z: 10, opacity: 1,
    });
    const b = await addOverlay({
      pieceId: PIECE, kind: "text", content: "b", startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      font: "", color: "", align: "left", z: 20, opacity: 1,
    });
    const aId = (a.data as { overlayId: string }).overlayId;
    const bId = (b.data as { overlayId: string }).overlayId;

    await reorderOverlays({ pieceId: PIECE, overlayIdsInZOrder: [bId, aId] });
    const m = await loadManifest(PIECE);
    const byId = Object.fromEntries((m.overlays ?? []).map((o) => [o.id, o.z]));
    expect(byId[bId]).toBe(0);
    expect(byId[aId]).toBe(1);
  });

  it("add_overlay persists an effects block", async () => {
    const r = await addOverlay({
      pieceId: PIECE, kind: "text", content: "Hi", startTime: 0, duration: 2, z: 0,
      rect: { x: 10, y: 10, width: 100, height: 40 },
      font: "24px Inter", color: "#fff", align: "left", opacity: 1,
      effects: { in: { effectId: "fade", durationMs: 400 } },
    });
    expect(r.success).toBe(true);
    const m = await loadManifest(PIECE);
    const ov = m.overlays!.find(
      (o) => o.id === (r.data as { overlayId: string }).overlayId,
    ) as { effects?: { in?: { effectId: string } } };
    expect(ov.effects!.in!.effectId).toBe("fade");
  });

  it("add_overlay rejects an unknown effectId", async () => {
    const r = await addOverlay({
      pieceId: PIECE, kind: "text", content: "Hi", startTime: 0, duration: 2, z: 0,
      rect: { x: 10, y: 10, width: 100, height: 40 },
      font: "24px Inter", color: "#fff", align: "left", opacity: 1,
      effects: { in: { effectId: "nope" } },
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe("unknown_effect");
  });
});
