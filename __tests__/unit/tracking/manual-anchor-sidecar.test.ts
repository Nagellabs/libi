import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { writeTrack, readTrack } from "@/lib/tracking/storage";
import type { Track, ManualAnchor } from "@/lib/tracking/types";

afterEach(() => { cleanupTempDir(); });

describe("Track.manualAnchors sidecar round-trip", () => {
  it("preserves manualAnchors through writeTrack/readTrack", async () => {
    await createTempStorageDir();
    const anchor: ManualAnchor = { id: "man-1500", time: 1.5, bbox: [10, 20, 30, 40] };
    const track: Track = {
      id: "trk-x", fileId: "f1", method: "yoloe+botsort", framerate: 30,
      durationSec: 2, samples: [],
      segments: [{ id: "seg-0-2000", startTime: 0, endTime: 2, method: "yoloe+botsort", status: "ok", samples: [] }],
      manualAnchors: [anchor],
    };
    await writeTrack("piece-1", track);
    const back = await readTrack("piece-1", "trk-x");
    expect(back?.manualAnchors).toEqual([anchor]);
  });
});
