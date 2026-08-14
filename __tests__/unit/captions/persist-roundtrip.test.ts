import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { saveManifest, loadManifest } from "@/lib/composition/persistence";

afterEach(() => { cleanupTempDir(); });

describe("caption group persistence", () => {
  it("round-trips caption.groupId + useTrackStyle + highlightColor", async () => {
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
          id: "c1",
          kind: "text",
          startTime: 0,
          duration: 1.4,
          z: 10,
          opacity: 1,
          rect: { x: 40, y: 1000, width: 640, height: 120 },
          content: "Chase the horizon",
          font: "48px Inter",
          color: "#fff",
          align: "center",
          caption: { groupId: "g1", styleRef: "pop", useTrackStyle: true },
          highlightColor: "#ffcf33",
        },
      ],
    });
    const m = await loadManifest(pieceId);
    const o = (m.overlays ?? [])[0] as {
      caption?: { groupId: string; styleRef?: string; useTrackStyle: boolean };
      highlightColor?: string;
    };
    expect(o.caption?.groupId).toBe("g1");
    expect(o.caption?.styleRef).toBe("pop");
    expect(o.caption?.useTrackStyle).toBe(true);
    expect(o.highlightColor).toBe("#ffcf33");
  });
});
