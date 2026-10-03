/**
 * loadManifest returns a defaulted shape when no file exists. Saving a
 * manifest with audioClips round-trips cleanly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";

let storageRoot: string;
const PIECE_ID = "p_persist";

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-persist-"));
  process.env.LIBI_HOME = storageRoot;
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  rmSync(storageRoot, { recursive: true, force: true });
});

describe("persistence — audioClips", () => {
  it("loadManifest returns a defaulted empty audioClips when no file exists", async () => {
    const m = await loadManifest(PIECE_ID);
    expect(m.audioClips).toEqual([]);
  });

  it("round-trips audioClips through save + load", async () => {
    await saveManifest(PIECE_ID, {
      width: 1920,
      height: 1080,
      fps: 30,
      audioClips: [
        { id: "c1", kind: "standalone", fileId: "f1", startTime: 2, duration: 8, trimStart: 0.5, volume: 0.7, enabled: true },
        { id: "c2", kind: "inline", linkedOverlayId: "vid-1", fileId: "f2", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true },
      ],
    });
    const m = await loadManifest(PIECE_ID);
    expect(m.audioClips).toHaveLength(2);
    expect(m.audioClips![0]).toMatchObject({ id: "c1", kind: "standalone", volume: 0.7 });
    expect(m.audioClips![1]).toMatchObject({ id: "c2", kind: "inline", linkedOverlayId: "vid-1" });
  });

  it("round-trips gainDb, volumeKeyframes and crossfadeMs, and clamps what a hand-edited manifest got wrong on load", async () => {
    await saveManifest(PIECE_ID, {
      width: 1920,
      height: 1080,
      fps: 30,
      audioClips: [
        {
          id: "c1", kind: "standalone", fileId: "f1", startTime: 0, duration: 20, trimStart: 0, volume: 1, enabled: true,
          gainDb: 3.8, crossfadeMs: 80, volumeKeyframes: { keyframes: [{ t: 4, value: 0 }, { t: 6, value: -12, easing: "ease-in-out" }] },
        },
        {
          id: "c2", kind: "standalone", fileId: "f1", startTime: 0, duration: 20, trimStart: 0, volume: 1, enabled: true,
          gainDb: 99, crossfadeMs: -5, volumeKeyframes: { keyframes: [{ t: 9, value: -90 }, { t: 2, value: 1 }, { t: -1, value: 0 }] },
        },
      ],
    });
    const m = await loadManifest(PIECE_ID);
    expect(m.audioClips![0]).toMatchObject({
      gainDb: 3.8, crossfadeMs: 80, volumeKeyframes: { keyframes: [{ t: 4, value: 0 }, { t: 6, value: -12, easing: "ease-in-out" }] },
    });
    expect(m.audioClips![1].gainDb).toBe(12);
    expect(m.audioClips![1].crossfadeMs).toBeUndefined();
    expect(m.audioClips![1].volumeKeyframes).toEqual({ keyframes: [{ t: 2, value: 1 }, { t: 9, value: -60 }] });
  });
});
