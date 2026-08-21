import { describe, expect, it } from "vitest";
import { buildComposition } from "@/lib/composition/build-composition";
import type { FileRecord } from "@/lib/db/schema/types";
import type { Overlay } from "@/lib/engine/types";

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

const videoOverlay: Overlay = {
  id: "vid-1",
  kind: "video",
  fileId: "gone",
  startTime: 0,
  duration: 5,
  z: 0,
  opacity: 1,
  rect: { x: 0, y: 0, width: 100, height: 100 },
};

describe("video overlay missing-file flag", () => {
  it("does NOT flag missing without opts (back-compat)", () => {
    const comp = buildComposition(new Map(), [videoOverlay]);
    const o = comp.overlays!.find((x) => x.id === "vid-1") as { missing?: boolean };
    expect(o.missing).toBeFalsy();
  });

  it("does NOT flag missing while files are still loading (filesResolved false)", () => {
    const comp = buildComposition(new Map(), [videoOverlay], [], {
      knownFileIds: new Set(),
      filesResolved: false,
    });
    const o = comp.overlays!.find((x) => x.id === "vid-1") as { missing?: boolean };
    expect(o.missing).toBeFalsy();
  });

  it("flags missing when resolved AND the id is absent from the known set", () => {
    const comp = buildComposition(new Map(), [videoOverlay], [], {
      knownFileIds: new Set(["other"]),
      filesResolved: true,
    });
    const o = comp.overlays!.find((x) => x.id === "vid-1") as { missing?: boolean };
    expect(o.missing).toBe(true);
  });

  it("does not mark one whose file is present (piece-scoped filesById)", () => {
    const files = new Map([["f1", mkFile("f1", "a.mp4")]]);
    const overlay: Overlay = { ...videoOverlay, fileId: "f1" };
    const comp = buildComposition(files, [overlay], [], {
      knownFileIds: new Set(["f1"]),
      filesResolved: true,
    });
    const o = comp.overlays!.find((x) => x.id === "vid-1") as { missing?: boolean };
    expect(o.missing).toBeFalsy();
  });

  it("does NOT flag missing for a GLOBAL-file overlay present only in knownFileIds", () => {
    // The file is global (not in the piece-scoped filesById) but exists —
    // knownFileIds carries it, so it must not be treated as deleted.
    const overlay: Overlay = { ...videoOverlay, fileId: "global-1" };
    const comp = buildComposition(new Map(), [overlay], [], {
      knownFileIds: new Set(["global-1"]),
      filesResolved: true,
    });
    const o = comp.overlays!.find((x) => x.id === "vid-1") as { missing?: boolean };
    expect(o.missing).toBe(false);
  });
});
