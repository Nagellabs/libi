/**
 * Persistence round-trips an inline AudioClip linked to a video OVERLAY
 * (linkedOverlayId) — the field survives saveManifest → loadManifest.
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
} from "@/lib/composition/persistence";
import type {
  PersistedAudioClip,
  CompositionManifest,
} from "@/lib/composition/persistence";

const PIECE_ID = "piece-overlay-audio";

beforeEach(() => {
  store.clear();
  createTestDb();
  return () => resetTestDb();
});

describe("persistence: linkedOverlayId round-trip", () => {
  it("round-trips an inline clip linked to a video overlay", async () => {
    const clip: PersistedAudioClip = {
      id: "clip_ov",
      kind: "inline",
      fileId: "f1",
      startTime: 2,
      duration: 5,
      trimStart: 1,
      volume: 1,
      enabled: true,
      linkedOverlayId: "vid-abc",
    };
    const manifest: CompositionManifest = {
      width: 1920,
      height: 1080,
      fps: 30,
      audioClips: [clip],
    };

    await saveManifest(PIECE_ID, manifest);
    const loaded = await loadManifest(PIECE_ID);

    expect(loaded.audioClips).toHaveLength(1);
    expect(loaded.audioClips![0]).toMatchObject({
      id: "clip_ov",
      kind: "inline",
      linkedOverlayId: "vid-abc",
      startTime: 2,
      duration: 5,
      trimStart: 1,
    });
  });
});
