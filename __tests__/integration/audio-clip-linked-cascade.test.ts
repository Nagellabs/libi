/**
 * Deleting the file behind a video OVERLAY cascades to BOTH the overlay AND
 * its linked inline AudioClip (a standalone clip on an unrelated file is left
 * alone). Verifies removeReferencesToFile + manifest mutations end to end
 * against a real fs-backed manifest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeReferencesToFile } from "@/lib/composition/persistence";
import { createTestDb, resetTestDb } from "../helpers/test-db";

let storageRoot: string;
const PIECE_ID = "p1";

// Mock storage to use the current temp dir (avoids singleton caching across tests)
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-cascade-"));
  process.env.LIBI_HOME = storageRoot;
  // removeReferencesToFile calls getAnalysis which needs a DB instance.
  createTestDb();
  mkdirSync(join(storageRoot, "storage", PIECE_ID), { recursive: true });

  // Seed: one video overlay + its linked inline AudioClip + a standalone music
  // clip. No scenes — a legacy video-scene fixture isn't relevant here (it
  // would self-heal into a second video overlay on load; see
  // lib/composition/persistence.ts) and this test is specifically about the
  // overlay-based cascade.
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "composition.json"),
    JSON.stringify({
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [
        {
          id: "ov1", kind: "video", fileId: "f1",
          startTime: 0, duration: 5, z: 0, opacity: 1, fit: "cover",
          rect: { x: 0, y: 0, width: 1920, height: 1080 },
        },
      ],
      audioClips: [
        { id: "c-inline", kind: "inline", linkedOverlayId: "ov1", fileId: "f1", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true },
        { id: "c-music", kind: "standalone", fileId: "f-music", startTime: 0, duration: 30, trimStart: 0, volume: 0.5, enabled: true },
      ],
    }),
  );
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  rmSync(storageRoot, { recursive: true, force: true });
  resetTestDb();
});

describe("deleting a file cascades to overlays + linked audio + standalone clips", () => {
  it("removing the video file removes the video OVERLAY AND its linked AudioClip", async () => {
    const result = await removeReferencesToFile(PIECE_ID, "f1");
    expect(result.removedOverlays).toEqual(["ov1"]);
    expect(result.removedClips).toContain("c-inline");

    const manifest = JSON.parse(
      readFileSync(join(storageRoot, "storage", PIECE_ID, "composition.json"), "utf-8"),
    );
    expect(manifest.audioClips.find((c: { id: string }) => c.id === "c-inline")).toBeUndefined();
    expect(manifest.audioClips.find((c: { id: string }) => c.id === "c-music")).toBeDefined();
  });

  it("removing a standalone clip's file removes only that clip", async () => {
    const result = await removeReferencesToFile(PIECE_ID, "f-music");
    expect(result.removedOverlays).toEqual([]);
    expect(result.removedClips).toEqual(["c-music"]);

    const manifest = JSON.parse(
      readFileSync(join(storageRoot, "storage", PIECE_ID, "composition.json"), "utf-8"),
    );
    expect(manifest.audioClips.find((c: { id: string }) => c.id === "c-inline")).toBeDefined();
    expect(manifest.audioClips.find((c: { id: string }) => c.id === "c-music")).toBeUndefined();
  });
});
