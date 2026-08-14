/**
 * Task 3.1 — `anchor?` is shared across all overlay kinds (BaseOverlay) and the
 * per-kind default is centralized in `defaultAnchorForKind`.
 *
 *  - `defaultAnchorForKind` returns "bottom-center" for text and "mid-center"
 *    for every other kind (the canonical CaptionAnchor center value).
 *  - An explicit `anchor` on a NON-text overlay (here `anchor:"top-left"`) survives
 *    a saveManifest → loadManifest round-trip, proving the shared field persists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import { defaultAnchorForKind } from "@/lib/overlays/anchor-default";
import {
  addOverlayToManifest,
  loadManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";

const PIECE = "anchor-default-piece";

describe("defaultAnchorForKind", () => {
  it("returns bottom-center for text", () => {
    expect(defaultAnchorForKind("text")).toBe("bottom-center");
  });

  it("returns mid-center for every non-text kind", () => {
    for (const kind of ["image", "video", "code", "three", "tracked"] as const) {
      expect(defaultAnchorForKind(kind)).toBe("mid-center");
    }
  });
});

describe("anchor round-trips on a non-text overlay", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("an image overlay with anchor:'top-left' survives saveManifest → loadManifest", async () => {
    const overlay: PersistedOverlay = {
      id: "img1",
      kind: "image",
      startTime: 0,
      duration: 2,
      rect: { x: 0, y: 0, width: 100, height: 50 },
      z: 0,
      opacity: 1,
      anchor: "top-left",
      fileId: "f1",
    };
    await addOverlayToManifest(PIECE, overlay);

    const manifest = await loadManifest(PIECE);
    const round = manifest.overlays?.find((o) => o.id === "img1");
    expect(round).toBeDefined();
    expect((round as { anchor?: string }).anchor).toBe("top-left");
  });
});
