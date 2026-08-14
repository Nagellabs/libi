/**
 * DELETE /api/pieces/{pid}/scenes/{sid} removes the scene from the
 * manifest, cascades to its linked AudioClip, and returns the cascaded
 * clip ids in the response body.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let storageRoot: string;
const PIECE_ID = "p_scene_http";

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-scene-route-"));
  process.env.LIBI_HOME = storageRoot;
  mkdirSync(join(storageRoot, "storage", PIECE_ID), { recursive: true });
  // Canvas-typed (not "video") — a video scene self-heals into an overlay on
  // `loadManifest` (see lib/composition/persistence.ts), so a "video" fixture
  // would never reach this route AS a scene (it 404s, since it's no longer in
  // sceneOrder). The scene-delete → linked-clip-cascade mechanism under test
  // is scene-type agnostic; canvas is the only scene type that still
  // round-trips as a scene.
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "scene-s1.json"),
    JSON.stringify({ id: "s1", type: "canvas", name: "S1", duration: 5, drawFunction: "" }),
  );
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "composition.json"),
    JSON.stringify({
      sceneOrder: ["s1"],
      width: 1920, height: 1080, fps: 30,
      audioClips: [
        { id: "c-s1", kind: "inline", linkedSceneId: "s1", fileId: "f1", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true },
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

describe("DELETE /api/pieces/{pid}/scenes/{sid}", () => {
  it("removes the scene + its linked AudioClip and reports both", async () => {
    const { DELETE } = await import("@/app/api/pieces/[pieceId]/scenes/[sceneId]/route");
    const req = new Request("http://test/x", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ pieceId: PIECE_ID, sceneId: "s1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removedClips).toEqual(["c-s1"]);

    const m = readManifest();
    expect(m.sceneOrder).toEqual([]);
    expect(m.audioClips).toEqual([]);
  });

  it("returns 404 for an unknown scene id", async () => {
    const { DELETE } = await import("@/app/api/pieces/[pieceId]/scenes/[sceneId]/route");
    const req = new Request("http://test/x", { method: "DELETE" });
    const res = await DELETE(req, { params: Promise.resolve({ pieceId: PIECE_ID, sceneId: "nope" }) });
    expect(res.status).toBe(404);
  });
});
