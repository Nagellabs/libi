import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import {
  addOverlayToManifest,
  loadManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";
import { applyEffectToLayer, clearEffectOnLayer } from "@/lib/effects/apply";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const PIECE = "p-effects-apply";

function seedOverlay(): Promise<void> {
  const overlay: PersistedOverlay = {
    id: "ov1",
    kind: "text",
    startTime: 0,
    duration: 2,
    rect: { x: 0, y: 0, width: 400, height: 120 },
    z: 1,
    opacity: 1,
    content: "Hello",
    font: "48px Inter",
    color: "#ffffff",
    align: "left",
  };
  return addOverlayToManifest(PIECE, overlay);
}

describe("applyEffectToLayer / clearEffectOnLayer", () => {
  beforeEach(async () => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    await seedOverlay();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("writes effects.in onto an overlay and is readable", async () => {
    await applyEffectToLayer({
      pieceId: PIECE,
      layerId: "ov1",
      phase: "in",
      ref: { effectId: "fade", durationMs: 400 },
    });
    const m = await loadManifest(PIECE);
    const ov = m.overlays!.find((o) => o.id === "ov1") as {
      effects?: { in?: { effectId: string } };
    };
    expect(ov.effects!.in!.effectId).toBe("fade");
  });

  it("clear removes only that phase, leaving others", async () => {
    await applyEffectToLayer({
      pieceId: PIECE,
      layerId: "ov1",
      phase: "in",
      ref: { effectId: "fade", durationMs: 400 },
    });
    await applyEffectToLayer({
      pieceId: PIECE,
      layerId: "ov1",
      phase: "loop",
      ref: { effectId: "pulse" },
    });
    await clearEffectOnLayer({ pieceId: PIECE, layerId: "ov1", phase: "in" });
    const m = await loadManifest(PIECE);
    const ov = m.overlays!.find((o) => o.id === "ov1") as {
      effects?: { in?: unknown; loop?: unknown };
    };
    expect(ov.effects!.in).toBeUndefined();
    expect(ov.effects!.loop).toBeDefined();
  });

  it("removes the effects block entirely when the last slot is cleared", async () => {
    await applyEffectToLayer({
      pieceId: PIECE,
      layerId: "ov1",
      phase: "loop",
      ref: { effectId: "pulse" },
    });
    await clearEffectOnLayer({ pieceId: PIECE, layerId: "ov1", phase: "loop" });
    const m = await loadManifest(PIECE);
    const ov = m.overlays!.find((o) => o.id === "ov1") as { effects?: unknown };
    expect(ov.effects).toBeUndefined();
  });

  it("returns layerKind:null for an unknown layerId", async () => {
    const r = await applyEffectToLayer({
      pieceId: PIECE,
      layerId: "nope",
      phase: "in",
      ref: { effectId: "fade" },
    });
    expect(r.layerKind).toBeNull();
  });

  it("reports the overlay kind in layerKind", async () => {
    const r = await applyEffectToLayer({
      pieceId: PIECE,
      layerId: "ov1",
      phase: "in",
      ref: { effectId: "fade" },
    });
    expect(r.layerKind).toBe("overlay-text");
  });
});
