import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import {
  addOverlayToManifest,
  loadManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

// notify is a fire-and-forget SSE hook; stub it so the tool runs without a server.
vi.mock("@/mcp/notify", () => ({ notify: { refreshQuery: vi.fn(), instructionsChanged: vi.fn() } }));

import { applyLayerEffect, clearLayerEffect } from "@/mcp/tools/effect-tools";

const PIECE = "p-clear-reveal";

async function seedKaraokeCaption(): Promise<void> {
  const overlay: PersistedOverlay = {
    id: "ov1",
    kind: "text",
    startTime: 0,
    duration: 2,
    rect: { x: 0, y: 0, width: 400, height: 120 },
    z: 1,
    opacity: 1,
    content: "Hello there world",
    font: "48px Inter",
    color: "#ffffff",
    align: "left",
    reveal: { mode: "karaoke" },
  };
  return addOverlayToManifest(PIECE, overlay);
}

async function revealMode(): Promise<string | undefined> {
  const m = await loadManifest(PIECE);
  const o = m.overlays?.find((x) => x.id === "ov1") as { reveal?: { mode?: string } } | undefined;
  return o?.reveal?.mode;
}

describe("clearLayerEffect — reveal coupling only for the mirror, not real animations", () => {
  beforeEach(async () => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    await seedKaraokeCaption();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("clearing a REAL in-animation (fade) preserves the caption's reveal (the reported bug)", async () => {
    await applyLayerEffect({ pieceId: PIECE, layerId: "ov1", phase: "in", effectId: "fade", durationMs: 500 });
    expect(await revealMode()).toBe("karaoke"); // applying a real fade doesn't touch reveal

    const r = await clearLayerEffect({ pieceId: PIECE, layerId: "ov1", phase: "in" });
    expect(r.success).toBe(true);
    // The FADE is gone (loadManifest re-derives the karaoke mirror into effects.in
    // from the surviving reveal — that's expected hydration, not the fade).
    const m = await loadManifest(PIECE);
    const o = m.overlays?.find((x) => x.id === "ov1") as { effects?: { in?: { effectId?: string } } } | undefined;
    expect(o?.effects?.in?.effectId).not.toBe("fade");
    // …and the reveal SURVIVES (the reported bug: it used to be wiped).
    expect(await revealMode()).toBe("karaoke");
  });

  it("clearing the in-slot when it IS the reveal mirror (no real animation) removes the reveal", async () => {
    // No real in-effect: on load, hydrate mirrors reveal→effects.in=karaoke. Clearing
    // that mirror is the legitimate "remove the reveal" action.
    const r = await clearLayerEffect({ pieceId: PIECE, layerId: "ov1", phase: "in" });
    expect(r.success).toBe(true);
    expect(await revealMode()).toBeUndefined();
  });

  it("clearing a non-in phase (out) never touches the reveal", async () => {
    await applyLayerEffect({ pieceId: PIECE, layerId: "ov1", phase: "out", effectId: "fade", durationMs: 400 });
    await clearLayerEffect({ pieceId: PIECE, layerId: "ov1", phase: "out" });
    expect(await revealMode()).toBe("karaoke");
  });
});
