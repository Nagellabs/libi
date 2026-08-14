/**
 * Milestone 1, Task 1.2 — the flat-caption guardrail is applied on the
 * update→save chokepoint.
 *
 * A FLAT text caption (no `threeD`) must never persist a 3D X/Y plane rotation
 * that would turn the glyphs edge-on. When `update_overlay` writes a
 * `transform3d` whose `rotation.y` (or `.x`) is non-zero onto a flat caption,
 * the merge-before-save chokepoint (`updateOverlayInManifest` →
 * `flattenCaption`) must zero those axes while preserving the in-plane z-roll.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay, updateOverlay } from "@/mcp/tools/overlay-tools";
import { loadManifest } from "@/lib/composition/persistence";

const baseRect = { x: 0, y: 0, width: 100, height: 50 };

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const pieceId = "piece-flat-guard-applied";

describe("flat-guard applied on the save path", () => {
  beforeEach(() => { tempDir = createTempStorageDir(); });
  afterEach(() => cleanupTempDir(tempDir));

  it("zeroes a stray 3D X/Y rotation when a FLAT caption is updated", async () => {
    const add = await addOverlay({
      pieceId,
      kind: "text",
      startTime: 0,
      duration: 3,
      rect: baseRect,
      z: 1,
      opacity: 1,
      content: "hello world",
      font: "100px Inter",
      color: "#ffffff",
      align: "center",
    });
    expect(add.success).toBe(true);
    const overlayId = (add.data as { overlayId: string }).overlayId;

    // Author a transform3d with a stray edge-on rotation on a flat caption (the bug state).
    const t3d = {
      position: { x: 0, y: 1, z: 0 },
      rotation: { x: -0.0349, y: 1.5533, z: 0.5 },
      scale: { x: 1, y: 1, z: 1 },
    };
    const up = await updateOverlay({ pieceId, overlayId, transform3d: t3d });
    expect(up.success).toBe(true);

    const manifest = await loadManifest(pieceId);
    const o = manifest.overlays?.find((ov) => ov.id === overlayId) as {
      threeD?: unknown;
      transform3d: { rotation: { x: number; y: number; z: number } };
    };
    expect(o).toBeDefined();
    // Flat caption: no 3D extrusion present.
    expect(o.threeD).toBeUndefined();
    // X/Y plane rotation must be zeroed by the guardrail.
    expect(o.transform3d.rotation.x).toBe(0);
    expect(o.transform3d.rotation.y).toBe(0);
    // In-plane z-roll is preserved.
    expect(o.transform3d.rotation.z).toBe(0.5);
  });

  it("PRESERVES a 3D X/Y rotation when a place3d caption is updated (regression)", async () => {
    // The reported bug: a "Make it 3D" (place3d) caption WITHOUT extrusion had
    // its pitch/yaw silently zeroed on save, so the Pose grid / dial never stuck.
    // Mirror the real flow: add → toggle "Make it 3D" (place3d) → set a pose.
    const add = await addOverlay({
      pieceId,
      kind: "text",
      startTime: 0,
      duration: 3,
      rect: baseRect,
      z: 1,
      opacity: 1,
      content: "tilt me",
      font: "100px Inter",
      color: "#ffffff",
      align: "center",
    });
    expect(add.success).toBe(true);
    const overlayId = (add.data as { overlayId: string }).overlayId;

    // Step 1: the "Make it 3D" toggle.
    expect((await updateOverlay({ pieceId, overlayId, place3d: true })).success).toBe(true);

    // Step 2: a Pose / dial edit writes an out-of-plane rotation.
    const t3d = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0.55, y: 0.3, z: 0.017 },
      scale: { x: 1.2, y: 1.2, z: 1 },
    };
    const up = await updateOverlay({ pieceId, overlayId, transform3d: t3d });
    expect(up.success).toBe(true);

    const manifest = await loadManifest(pieceId);
    const o = manifest.overlays?.find((ov) => ov.id === overlayId) as {
      transform3d: { rotation: { x: number; y: number; z: number } };
    };
    expect(o).toBeDefined();
    // Pitch + yaw survive on a place3d caption.
    expect(o.transform3d.rotation.x).toBeCloseTo(0.55, 6);
    expect(o.transform3d.rotation.y).toBeCloseTo(0.3, 6);
    expect(o.transform3d.rotation.z).toBeCloseTo(0.017, 6);
  });
});
