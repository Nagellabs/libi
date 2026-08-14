/**
 * An overlay carrying additive `keyframes` metadata round-trips through
 * saveManifest → loadManifest byte-identically (plain JSON, like `effects` —
 * NO per-overlay file). Also confirms the `null`-clears-key sentinel in
 * updateOverlayInManifest drops the `keyframes` field cleanly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileStorage } from "@/lib/storage/types";
import { createTestDb, resetTestDb } from "../../helpers/test-db";

const store = new Map<string, Buffer>();

const mockStorage: FileStorage = {
  save: vi.fn(async (pieceId: string, filename: string, data: Buffer) => {
    store.set(filename, data);
    return `storage/${pieceId}/${filename}`;
  }),
  read: vi.fn(async (_pieceId: string, filename: string) => {
    const data = store.get(filename);
    if (!data) throw new Error(`File not found: ${filename}`);
    return data;
  }),
  exists: vi.fn(async (_pieceId: string, filename: string) => store.has(filename)),
  delete: vi.fn(async (_pieceId: string, filename: string) => {
    store.delete(filename);
  }),
  deletePieceDir: vi.fn(),
  list: vi.fn(async () => Array.from(store.keys())),
  remove: vi.fn(async (_pieceId: string | null, filename: string) => {
    store.delete(filename);
  }),
  localPath: vi.fn(),
};

vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => Promise.resolve(mockStorage)),
}));

import {
  saveManifest,
  loadManifest,
  updateOverlayInManifest,
} from "@/lib/composition/persistence";
import type { CompositionManifest, PersistedOverlay } from "@/lib/composition/persistence";

const PIECE_ID = "piece-keyframes";

beforeEach(() => {
  store.clear();
  createTestDb();
  return () => resetTestDb();
});

const KEYFRAMED_OVERLAY: PersistedOverlay = {
  id: "kf-ov",
  kind: "image",
  startTime: 0,
  duration: 4,
  rect: { x: 100, y: 100, width: 200, height: 150 },
  z: 0,
  opacity: 1,
  fileId: "f1",
  // additive keyframe metadata (Phase 2)
  keyframes: {
    rect: {
      keyframes: [
        { t: 0, value: { x: 0, y: 0, width: 200, height: 150 }, easing: "ease-in-out" },
        { t: 1, value: { x: 800, y: 0, width: 200, height: 150 } },
      ],
    },
    opacity: {
      keyframes: [
        { t: 0, value: 0 },
        { t: 1, value: 1 },
      ],
    },
    transform3d: {
      keyframes: [
        { t: 0, value: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } },
        { t: 1, value: { position: { x: 0, y: 0, z: 5 }, rotation: { x: 0, y: 0.5, z: 0 } } },
      ],
    },
  },
} as PersistedOverlay;

describe("persistence: keyframes round-trip", () => {
  it("round-trips an overlay's keyframes through save → load", async () => {
    const manifest: CompositionManifest = {
      sceneOrder: [],
      scenes: [],
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [KEYFRAMED_OVERLAY],
    };
    await saveManifest(PIECE_ID, manifest);
    const loaded = await loadManifest(PIECE_ID);
    const ov = loaded.overlays?.[0] as PersistedOverlay & { keyframes?: unknown };
    expect(ov.keyframes).toEqual(KEYFRAMED_OVERLAY.keyframes);
  });

  it("keyframes are stored inline in composition.json (no per-overlay file)", async () => {
    const manifest: CompositionManifest = {
      sceneOrder: [],
      scenes: [],
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [KEYFRAMED_OVERLAY],
    };
    await saveManifest(PIECE_ID, manifest);
    const raw = store.get("composition.json")!.toString("utf-8");
    expect(raw).toContain('"keyframes"');
    expect(raw).toContain('"ease-in-out"');
  });

  it("updateOverlayInManifest applies a keyframes patch", async () => {
    const manifest: CompositionManifest = {
      sceneOrder: [],
      scenes: [],
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [
        {
          id: "kf-ov",
          kind: "image",
          startTime: 0,
          duration: 4,
          rect: { x: 100, y: 100, width: 200, height: 150 },
          z: 0,
          opacity: 1,
          fileId: "f1",
        } as PersistedOverlay,
      ],
    };
    await saveManifest(PIECE_ID, manifest);

    const ok = await updateOverlayInManifest(PIECE_ID, "kf-ov", {
      keyframes: {
        opacity: { keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
      },
    } as Partial<PersistedOverlay>);
    expect(ok).toBe(true);

    const loaded = await loadManifest(PIECE_ID);
    const ov = loaded.overlays?.[0] as PersistedOverlay & { keyframes?: { opacity?: unknown } };
    expect(ov.keyframes?.opacity).toEqual({ keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] });
  });

  it("null-clears-key sentinel drops the keyframes field", async () => {
    const manifest: CompositionManifest = {
      sceneOrder: [],
      scenes: [],
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [KEYFRAMED_OVERLAY],
    };
    await saveManifest(PIECE_ID, manifest);

    const ok = await updateOverlayInManifest(PIECE_ID, "kf-ov", {
      keyframes: null,
    } as unknown as Partial<PersistedOverlay>);
    expect(ok).toBe(true);

    const loaded = await loadManifest(PIECE_ID);
    const ov = loaded.overlays?.[0] as PersistedOverlay & { keyframes?: unknown };
    expect(ov.keyframes).toBeUndefined();
    // composition.json no longer carries the field
    const raw = store.get("composition.json")!.toString("utf-8");
    expect(raw).not.toContain('"keyframes"');
  });
});
