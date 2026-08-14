import { describe, it, expect, afterEach } from "vitest";
import {
  UpdateTrackedOverlaySchema,
  AddTrackedOverlaySchema,
} from "@/mcp/tools/schemas";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { saveManifest, loadManifest } from "@/lib/composition/persistence";

describe("tracked overlay position params (mirror of sizeMode)", () => {
  it("accepts positionMode on update", () => {
    const r = UpdateTrackedOverlaySchema.safeParse({
      pieceId: "p",
      overlayId: "o",
      positionMode: "raw",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a bad positionMode", () => {
    expect(
      UpdateTrackedOverlaySchema.safeParse({
        pieceId: "p",
        overlayId: "o",
        positionMode: "wobbly",
      }).success,
    ).toBe(false);
  });

  it("add schema accepts the optional positionMode", () => {
    const base = {
      pieceId: "p",
      trackId: "t",
      startTime: 0,
      duration: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      z: 0,
      opacity: 1,
      content: { kind: "emoji", char: "x" },
      fit: "tight",
      scale: 1,
      smoothing: "linear",
      positionMode: "stabilized",
    };
    expect(AddTrackedOverlaySchema.safeParse(base).success).toBe(true);
  });
});

describe("tracked overlay positionMode persistence", () => {
  afterEach(() => { cleanupTempDir(); });

  it("round-trips an explicit positionMode:'raw' through the manifest", async () => {
    createTempStorageDir();
    const pieceId = "p1";
    await saveManifest(pieceId, {
      sceneOrder: [],
      width: 720,
      height: 1280,
      fps: 30,
      scenes: [],
      overlays: [
        {
          id: "t1",
          kind: "tracked",
          startTime: 0,
          duration: 2,
          rect: { x: 0, y: 0, width: 100, height: 100 },
          z: 5,
          opacity: 1,
          trackId: "track-1",
          content: { kind: "emoji", char: "😀" },
          fit: "tight",
          scale: 1,
          smoothing: "linear",
          positionMode: "raw",
        },
      ],
    });
    const m = await loadManifest(pieceId);
    const o = (m.overlays ?? [])[0] as { positionMode?: "stabilized" | "raw" };
    expect(o.positionMode).toBe("raw");
  });
});
