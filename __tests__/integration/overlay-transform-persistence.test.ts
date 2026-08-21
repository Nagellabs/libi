import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";
import {
  loadManifest,
  saveManifest,
  type CompositionManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";

const PIECE = "piece-transform";

function baseManifest(overlays: PersistedOverlay[]): CompositionManifest {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    overlays,
  };
}

describe("overlay transform persistence round-trip", () => {
  beforeEach(() => createTempStorageDir());
  afterEach(() => cleanupTempDir());

  it("transform3d/flipH/flipV/group survive saveManifest → loadManifest", async () => {
    const t3d = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0.4 } };
    const overlay: PersistedOverlay = {
      id: "t1",
      kind: "text",
      startTime: 0,
      duration: 5,
      rect: { x: 10, y: 20, width: 100, height: 40 },
      z: 0,
      opacity: 1,
      content: "hi",
      font: "48px Inter",
      color: "#fff",
      align: "center",
      transform3d: t3d,
      flipH: true,
      flipV: false,
      group: "captions",
    };
    await saveManifest(PIECE, baseManifest([overlay]));
    const loaded = await loadManifest(PIECE);
    const o = loaded.overlays?.find((x) => x.id === "t1");
    expect(o).toBeDefined();
    expect((o as { transform3d?: typeof t3d }).transform3d).toEqual(t3d);
    expect((o as { flipH?: boolean }).flipH).toBe(true);
    expect((o as { flipV?: boolean }).flipV).toBe(false);
    expect((o as { group?: string }).group).toBe("captions");
  });

  it("a legacy `rotation` (degrees) key is DROPPED on load", async () => {
    // Pre-2026-07 manifests may still carry the deleted legacy field. The reader
    // drops it (no fold, no migration) — transform3d is the single authority.
    const legacy = {
      id: "leg1",
      kind: "text",
      startTime: 0,
      duration: 2,
      rect: { x: 0, y: 0, width: 50, height: 20 },
      z: 0,
      opacity: 1,
      content: "old",
      font: "48px Inter",
      color: "#fff",
      align: "center",
      rotation: 33,
    } as unknown as PersistedOverlay;
    await saveManifest(PIECE, baseManifest([legacy]));
    const loaded = await loadManifest(PIECE);
    const o = loaded.overlays?.find((x) => x.id === "leg1");
    expect(o).toBeDefined();
    expect("rotation" in (o as Record<string, unknown>)).toBe(false);
  });

  it("an overlay WITHOUT transform fields round-trips unchanged", async () => {
    const overlay: PersistedOverlay = {
      id: "img1",
      kind: "image",
      startTime: 0,
      duration: 3,
      rect: { x: 0, y: 0, width: 50, height: 50 },
      z: 1,
      opacity: 1,
      fileId: "f",
    };
    await saveManifest(PIECE, baseManifest([overlay]));
    const loaded = await loadManifest(PIECE);
    const o = loaded.overlays?.find((x) => x.id === "img1");
    expect(o).toBeDefined();
    expect((o as { rotation?: number }).rotation).toBeUndefined();
    expect((o as { group?: string }).group).toBeUndefined();
  });
});
