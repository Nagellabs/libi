/**
 * Deleting a video scene via removeSceneAndUpdateManifest must also
 * remove any AudioClip with linkedSceneId pointing at that scene.
 * Standalone clips and linked clips for OTHER scenes are untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeSceneAndUpdateManifest } from "@/lib/composition/persistence";

let storageRoot: string;
const PIECE_ID = "p_scene_del";

// Mock storage to use the current temp dir (avoids singleton caching across tests)
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-scene-del-"));
  process.env.LIBI_HOME = storageRoot;
  mkdirSync(join(storageRoot, "storage", PIECE_ID), { recursive: true });

  // Two scenes, each with a linked inline AudioClip + one standalone clip.
  // Canvas-typed (not "video") — a video scene self-heals into an overlay on
  // `loadManifest` (see lib/composition/persistence.ts), so a "video" fixture
  // here would never reach removeSceneAndUpdateManifest AS a scene. The
  // scene-delete → linked-clip-cascade mechanism under test is scene-type
  // agnostic; canvas is the only scene type that still round-trips as a scene.
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "scene-s1.json"),
    JSON.stringify({ id: "s1", type: "canvas", name: "S1", duration: 5, drawFunction: "" }),
  );
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "scene-s2.json"),
    JSON.stringify({ id: "s2", type: "canvas", name: "S2", duration: 5, drawFunction: "" }),
  );
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "composition.json"),
    JSON.stringify({
      sceneOrder: ["s1", "s2"],
      width: 1920, height: 1080, fps: 30,
      audioClips: [
        { id: "c-s1", kind: "inline", linkedSceneId: "s1", fileId: "f1", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true },
        { id: "c-s2", kind: "inline", linkedSceneId: "s2", fileId: "f2", startTime: 5, duration: 5, trimStart: 0, volume: 1, enabled: true },
        { id: "c-music", kind: "standalone", fileId: "f-music", startTime: 0, duration: 30, trimStart: 0, volume: 0.5, enabled: true },
      ],
    }),
  );
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  rmSync(storageRoot, { recursive: true, force: true });
});

const readManifest = () =>
  JSON.parse(readFileSync(join(storageRoot, "storage", PIECE_ID, "composition.json"), "utf-8"));

describe("removeSceneAndUpdateManifest cascade", () => {
  it("removes the linked AudioClip when the scene is deleted", async () => {
    const result = await removeSceneAndUpdateManifest(PIECE_ID, "s1");
    expect(result.removedClips).toEqual(["c-s1"]);

    const m = readManifest();
    expect(m.audioClips.find((c: { id: string }) => c.id === "c-s1")).toBeUndefined();
    // Other scene's linked clip + the standalone music clip stay put.
    expect(m.audioClips.find((c: { id: string }) => c.id === "c-s2")).toBeDefined();
    expect(m.audioClips.find((c: { id: string }) => c.id === "c-music")).toBeDefined();
  });

  it("re-syncs the surviving scene's linked clip position after the delete", async () => {
    // s1 (5s) sits at t=0, s2 at t=5 — so c-s2.startTime is 5.
    // Deleting s1 shifts s2 to t=0, so its linked clip MUST follow.
    // Regression: a video downloaded into a fresh piece (which seeds a 5s
    // placeholder scene) then deleting that placeholder left the video's
    // audio frozen at startTime=5 → audio played 5s late.
    await removeSceneAndUpdateManifest(PIECE_ID, "s1");

    const m = readManifest();
    const cS2 = m.audioClips.find((c: { id: string }) => c.id === "c-s2");
    expect(cS2.startTime).toBe(0);
    expect(cS2.duration).toBe(5);
    // Standalone clips are never re-derived.
    const music = m.audioClips.find((c: { id: string }) => c.id === "c-music");
    expect(music.startTime).toBe(0);
  });

  it("returns empty removedClips when the scene had no linked AudioClip", async () => {
    // Drop the linked clip first so s1 has no audio link.
    const m0 = readManifest();
    m0.audioClips = m0.audioClips.filter((c: { id: string }) => c.id !== "c-s1");
    writeFileSync(join(storageRoot, "storage", PIECE_ID, "composition.json"), JSON.stringify(m0));

    const result = await removeSceneAndUpdateManifest(PIECE_ID, "s1");
    expect(result.removedClips).toEqual([]);
  });
});
