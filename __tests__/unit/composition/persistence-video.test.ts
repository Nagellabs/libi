import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FileStorage } from "@/lib/storage/types";
import { createTestDb, resetTestDb } from "../../helpers/test-db";

// In-memory mock storage
const store = new Map<string, Buffer>();

const mockStorage: FileStorage = {
  save: vi.fn(async (_pieceId: string, filename: string, data: Buffer) => {
    store.set(filename, data);
    return `storage/${_pieceId}/${filename}`;
  }),
  read: vi.fn(async (_pieceId: string, filename: string) => {
    const data = store.get(filename);
    if (!data) throw new Error(`File not found: ${filename}`);
    return data;
  }),
  exists: vi.fn(async (_pieceId: string, filename: string) => {
    return store.has(filename);
  }),
  delete: vi.fn(async (_pieceId: string, filename: string) => {
    store.delete(filename);
  }),
  deletePieceDir: vi.fn(),
  list: vi.fn(async (_pieceId: string | null) => {
    return Array.from(store.keys());
  }),
  remove: vi.fn(async (_pieceId: string | null, filename: string) => {
    store.delete(filename);
  }),
  localPath: vi.fn(),
};

vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => Promise.resolve(mockStorage)),
}));

import {
  removeReferencesToFile,
  loadScene,
  saveScene,
  saveManifest,
  loadManifest,
  saveSceneAndUpdateManifest,
} from "@/lib/composition/persistence";
import type {
  PersistedCanvasScene,
  CompositionManifest,
} from "@/lib/composition/persistence";

const PIECE_ID = "piece-test";

function makeManifest(overrides: Partial<CompositionManifest> = {}): CompositionManifest {
  return {
    sceneOrder: [],
    width: 1920,
    height: 1080,
    fps: 30,
    ...overrides,
  };
}


describe("removeReferencesToFile", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    // removeReferencesToFile calls getAnalysis which needs a real DB instance.
    createTestDb();
  });

  afterEach(() => {
    resetTestDb();
  });

  it("removes audio clips with matching fileId", async () => {
    const manifest = makeManifest({
      sceneOrder: [],
      audioClips: [
        { id: "track_1", kind: "standalone", fileId: "file-to-remove", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true },
        { id: "track_2", kind: "standalone", fileId: "other-file", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true },
      ],
    });
    store.set(
      "composition.json",
      Buffer.from(JSON.stringify(manifest), "utf-8"),
    );

    const result = await removeReferencesToFile(PIECE_ID, "file-to-remove");

    expect(result.removedClips).toEqual(["track_1"]);

    const updated = JSON.parse(store.get("composition.json")!.toString("utf-8"));
    expect(updated.audioClips).toHaveLength(1);
    expect(updated.audioClips[0].id).toBe("track_2");
  });

  it("removes video overlays referencing the file, cascading their inline audio", async () => {
    // A video is an OVERLAY now, and its own audio is an inline clip bound by
    // `linkedOverlayId`. Deleting the source file must drop both.
    const manifest = makeManifest({
      sceneOrder: [],
      overlays: [
        {
          id: "ov_video", kind: "video", fileId: "file-to-remove",
          startTime: 0, duration: 10, z: 0, opacity: 1, fit: "cover",
          rect: { x: 0, y: 0, width: 1920, height: 1080 },
        },
        {
          id: "ov_keep", kind: "text", content: "hi", font: "40px sans-serif",
          color: "#fff", align: "center",
          startTime: 0, duration: 10, z: 1, opacity: 1,
          rect: { x: 0, y: 0, width: 100, height: 20 },
        },
      ],
      audioClips: [
        {
          id: "clip_inline", kind: "inline", fileId: "file-to-remove",
          startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true,
          linkedOverlayId: "ov_video",
        },
        {
          id: "clip_music", kind: "standalone", fileId: "other-file",
          startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true,
        },
      ],
    });
    store.set(
      "composition.json",
      Buffer.from(JSON.stringify(manifest), "utf-8"),
    );

    const result = await removeReferencesToFile(PIECE_ID, "file-to-remove");

    expect(result.removedOverlays).toEqual(["ov_video"]);
    expect(result.removedClips).toEqual(["clip_inline"]);

    const updated = JSON.parse(store.get("composition.json")!.toString("utf-8"));
    expect(updated.overlays.map((o: { id: string }) => o.id)).toEqual(["ov_keep"]);
    expect(updated.audioClips.map((c: { id: string }) => c.id)).toEqual(["clip_music"]);
  });

  it("returns empty arrays when no references found", async () => {
    const manifest = makeManifest({
      sceneOrder: [],
      audioClips: [{ id: "track_1", kind: "standalone" as const, fileId: "other-file", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true }],
    });
    store.set(
      "composition.json",
      Buffer.from(JSON.stringify(manifest), "utf-8"),
    );

    const result = await removeReferencesToFile(PIECE_ID, "file-not-referenced");

    expect(result.removedClips).toEqual([]);
    expect(result.removedOverlays).toEqual([]);
  });

});

describe("loadScene backward compatibility", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it("defaults type to 'canvas' for scenes without type field", async () => {
    // Store a scene without the type field (old format)
    const oldScene = {
      id: "scene_old",
      name: "Old Scene",
      duration: 5,
      drawFunction: "// legacy",
    };
    store.set(
      "scene-scene_old.json",
      Buffer.from(JSON.stringify(oldScene), "utf-8"),
    );

    const scene = await loadScene(PIECE_ID, "scene_old");

    expect(scene).not.toBeNull();
    expect(scene!.type).toBe("canvas");
    expect(scene!.name).toBe("Old Scene");
  });

  it("returns null when scene file does not exist", async () => {
    const scene = await loadScene(PIECE_ID, "nonexistent");

    expect(scene).toBeNull();
  });
});
