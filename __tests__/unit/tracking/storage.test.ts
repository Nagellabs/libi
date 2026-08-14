import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Track } from "@/lib/tracking/types";
import { normalizeTrack } from "@/lib/tracking/segments";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "libi-track-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  delete process.env.LIBI_HOME;
});

describe("track storage", () => {
  it("writes and reads back a track JSON sidecar", async () => {
    const mod = await import("@/lib/tracking/storage");
    const t: Track = {
      id: "trk-1",
      fileId: "file-1",
      method: "mediapipe-face",
      framerate: 30,
      durationSec: 1,
      samples: [
        { t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 0.9, visible: true },
      ],
    };
    await mod.writeTrack("piece-1", t);
    const back = await mod.readTrack("piece-1", "trk-1");
    // readTrack now normalizes on read (adds the legacy segment + derived
    // samples) — the round-trip preserves all original data in normalized form.
    expect(back).toEqual(normalizeTrack(t));
  });

  it("returns null when the track file is missing", async () => {
    const mod = await import("@/lib/tracking/storage");
    expect(await mod.readTrack("piece-x", "nope")).toBeNull();
  });

  it("deleteTrack removes the file", async () => {
    const mod = await import("@/lib/tracking/storage");
    const t: Track = {
      id: "trk-2",
      fileId: "f",
      method: "manual",
      framerate: 1,
      durationSec: 0,
      samples: [],
    };
    await mod.writeTrack("piece-1", t);
    await mod.deleteTrack("piece-1", "trk-2");
    expect(await mod.readTrack("piece-1", "trk-2")).toBeNull();
  });
});
