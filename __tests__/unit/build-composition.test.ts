import { describe, it, expect } from "vitest";
import { buildComposition } from "@/lib/composition/build-composition";
import type { FileRecord } from "@/lib/db/schema/types";

function mkFile(id: string, filename: string): FileRecord {
  return {
    id,
    pieceId: "p1",
    filename,
    name: filename,
    description: "",
    type: "video",
    storagePath: `p1/${filename}`,
    contentType: "video/mp4",
    size: 1000,
    proxyFilename: null,
    proxyStatus: "idle",
    proxyGeneratedAt: null,
    mediaDuration: 2,
    mediaWidth: 1920,
    mediaHeight: 1080,
    createdAt: new Date(),
  } as FileRecord;
}

describe("buildComposition", () => {
  function videoOverlay(fileId: string) {
    return [{
      id: "ov1", kind: "video" as const, fileId,
      startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
    }];
  }

  it("builds a video overlay with a videoUrl derived from pickVideoUrl when the file is known", () => {
    const files = new Map([["f1", mkFile("f1", "in.mp4")]]);
    const comp = buildComposition(files, videoOverlay("f1"));
    // Without a proxy ready, pickVideoUrl returns the original /content URL.
    expect((comp!.overlays![0] as { videoUrl?: string }).videoUrl).toBe("/api/files/by-id/f1/content");
  });

  it("falls back to /api/files/by-id/{id}/content when the file is not in the map", () => {
    const comp = buildComposition(new Map(), videoOverlay("unknown"));
    expect((comp!.overlays![0] as { videoUrl?: string }).videoUrl).toBe("/api/files/by-id/unknown/content");
  });

  describe("missing-file detection", () => {
    it("does NOT flag missing without opts (back-compat)", () => {
      const comp = buildComposition(new Map(), videoOverlay("gone"));
      expect((comp!.overlays![0] as { missing?: boolean }).missing).toBeFalsy();
    });

    it("does NOT flag missing while files are still loading (filesResolved false)", () => {
      const comp = buildComposition(new Map(), videoOverlay("gone"), [], {
        knownFileIds: new Set(),
        filesResolved: false,
      });
      expect((comp!.overlays![0] as { missing?: boolean }).missing).toBeFalsy();
    });

    it("flags missing when resolved AND the id is absent from the known set", () => {
      const comp = buildComposition(new Map(), videoOverlay("gone"), [], {
        knownFileIds: new Set(["other"]),
        filesResolved: true,
      });
      expect((comp!.overlays![0] as { missing?: boolean }).missing).toBe(true);
    });

    it("does NOT flag missing for a GLOBAL-file overlay present only in knownFileIds", () => {
      // The file is global (not in the piece-scoped filesById) but exists —
      // knownFileIds carries it, so it must not be treated as deleted.
      const comp = buildComposition(new Map(), videoOverlay("gone"), [], {
        knownFileIds: new Set(["gone"]),
        filesResolved: true,
      });
      expect((comp!.overlays![0] as { missing?: boolean }).missing).toBe(false);
    });
  });

  it("attaches overlays to the resulting Composition", () => {
    const comp = buildComposition(new Map(),
      [
        {
          id: "t1",
          kind: "text",
          content: "hi",
          font: "24px Inter",
          color: "#fff",
          align: "left",
          opacity: 1,
          rect: { x: 0, y: 0, width: 10, height: 10 },
          startTime: 0,
          duration: 1,
          z: 0,
        },
      ],
    );
    expect(comp!.overlays).toHaveLength(1);
    expect(comp!.overlays![0].id).toBe("t1");
  });

  it("passes a three overlay through hydration unchanged", () => {
    const comp = buildComposition(new Map(),
      [
        {
          id: "td1",
          kind: "three",
          sceneFunction: "return ({ progress }) => {};",
          cameraPreset: "ground",
          rect: { x: 0, y: 0, width: 1280, height: 720 },
          startTime: 0,
          duration: 4,
          z: 5,
          opacity: 1,
        },
      ],
    );
    expect(comp!.overlays).toHaveLength(1);
    const o = comp!.overlays![0];
    expect(o.kind).toBe("three");
    expect(o.id).toBe("td1");
    // sceneFunction stays a STRING (compiled later by useOverlayThreeScenes).
    expect((o as { sceneFunction: string }).sceneFunction).toContain("progress");
    expect((o as { cameraPreset?: string }).cameraPreset).toBe("ground");
  });
});
