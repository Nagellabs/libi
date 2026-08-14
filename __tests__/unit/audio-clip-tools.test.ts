/**
 * Integration: each MCP audio tool reads a fixture manifest, applies
 * the change, and writes it back. Uses a temp piece dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema";

let storageRoot: string;
let pieceDir: string;
const PIECE_ID = "p_test";
const FILE_ID = "f_test";

// Mock storage to use the temp dir
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-audio-tools-"));
  pieceDir = join(storageRoot, "storage", PIECE_ID);
  mkdirSync(pieceDir, { recursive: true });
});

afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true });
});

const ctx = () => ({ pieceId: PIECE_ID });

const writeManifest = (m: object) =>
  writeFileSync(join(pieceDir, "composition.json"), JSON.stringify(m), "utf-8");

const readManifest = () =>
  JSON.parse(readFileSync(join(pieceDir, "composition.json"), "utf-8"));

const baseManifest = {
  sceneOrder: [],
  width: 1920,
  height: 1080,
  fps: 30,
  audioClips: [] as unknown[],
};

import {
  audioAddClip,
  audioUpdateClip,
  audioRemoveClip,
  audioUnlink,
  audioSplit,
} from "@/mcp/tools/audio-clip-tools";

describe("audio clip MCP tools", () => {
  it("audio_add_clip writes a new clip to the manifest", async () => {
    // Seed a piece + file record so audioAddClip can find it
    const db = createTestDb();
    seedPiece(db, { id: PIECE_ID, name: "Test" });
    db.insert(files).values({
      id: FILE_ID,
      pieceId: PIECE_ID,
      filename: "track.mp3",
      name: "Track",
      description: "",
      type: "audio",
      storagePath: `${PIECE_ID}/track.mp3`,
      size: 0,
      mediaDuration: 5,
    }).run();

    writeManifest(baseManifest);
    const result = await audioAddClip(ctx(), {
      pieceId: PIECE_ID,
      fileId: FILE_ID,
      kind: "standalone",
      startTime: 1,
      duration: 5,
      trimStart: 0,
      volume: 0.9,
      enabled: true,
    });
    expect(result.success).toBe(true);
    expect(readManifest().audioClips).toHaveLength(1);
  });

  it("audio_update_clip patches an existing clip", async () => {
    writeManifest({
      ...baseManifest,
      audioClips: [{ id: "c1", kind: "standalone", fileId: FILE_ID, startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true }],
    });
    const result = await audioUpdateClip(ctx(), { pieceId: PIECE_ID, clipId: "c1", volume: 0.3 });
    expect(result.success).toBe(true);
    expect(readManifest().audioClips[0].volume).toBe(0.3);
  });

  it("audio_remove_clip drops a clip", async () => {
    writeManifest({
      ...baseManifest,
      audioClips: [{ id: "c1", kind: "standalone", fileId: FILE_ID, startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true }],
    });
    const result = await audioRemoveClip(ctx(), { pieceId: PIECE_ID, clipId: "c1" });
    expect(result.success).toBe(true);
    expect(readManifest().audioClips).toHaveLength(0);
  });

  it("audio_unlink turns an inline clip into standalone", async () => {
    writeManifest({
      ...baseManifest,
      audioClips: [{ id: "c1", kind: "inline", linkedSceneId: "s1", fileId: FILE_ID, startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true }],
    });
    const result = await audioUnlink(ctx(), { pieceId: PIECE_ID, clipId: "c1" });
    expect(result.success).toBe(true);
    const clip = readManifest().audioClips[0];
    expect(clip.kind).toBe("standalone");
    expect(clip.linkedSceneId).toBeUndefined();
  });

  it("audio_split splits a clip in two", async () => {
    writeManifest({
      ...baseManifest,
      audioClips: [{ id: "c1", kind: "standalone", fileId: FILE_ID, startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true }],
    });
    const result = await audioSplit(ctx(), { pieceId: PIECE_ID, clipId: "c1", time: 4 });
    expect(result.success).toBe(true);
    expect(readManifest().audioClips).toHaveLength(2);
  });

});

