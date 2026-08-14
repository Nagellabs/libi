import { describe, it, expect } from "vitest";
import { hitTest } from "@/lib/engine/overlays";
import type { Overlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";

const tracked: Overlay = {
  id: "ov1", kind: "tracked", startTime: 0, duration: 10, z: 0, opacity: 1,
  rect: { x: 0, y: 0, width: 50, height: 50 }, // art is NOT here
  trackId: "trk1", content: { kind: "emoji", char: "😀" },
  fit: "tight", scale: 1, smoothing: "linear",
};
const track: Track = {
  id: "trk1", fileId: "f", method: "yoloe+botsort", framerate: 30, durationSec: 10,
  samples: [{ t: 1, x: 800, y: 400, w: 100, h: 100, confidence: 1, visible: true }],
  segments: [{ id: "s", startTime: 0, endTime: 10, method: "yoloe+botsort", status: "ok",
    samples: [{ t: 1, x: 800, y: 400, w: 100, h: 100, confidence: 1, visible: true }] }],
};

describe("hitTest tracked-aware", () => {
  it("hits the tracked overlay over the live art bbox, outside overlay.rect", () => {
    expect(hitTest(850, 450, [tracked], 1, { trk1: track })?.id).toBe("ov1");
  });
  it("misses when the point is only inside the (irrelevant) overlay.rect", () => {
    expect(hitTest(10, 10, [tracked], 1, { trk1: track })).toBeNull();
  });
  it("non-tracked overlays still use overlay.rect (back-compat)", () => {
    const text: Overlay = { id: "t1", kind: "text", startTime: 0, duration: 10, z: 0,
      opacity: 1, rect: { x: 0, y: 0, width: 50, height: 50 }, content: "hi",
      font: "20px Inter", color: "#fff", align: "left" };
    expect(hitTest(10, 10, [text], 1)?.id).toBe("t1");
  });

  it("tracked miss does not shadow a lower-z hittable text overlay", () => {
    const text: Overlay = {
      id: "back", kind: "text", startTime: 0, duration: 10, z: -1,
      opacity: 1, rect: { x: 0, y: 0, width: 100, height: 100 },
      content: "hi", font: "20px Inter", color: "#fff", align: "left",
    };
    const trackedHigh: Overlay = { ...tracked, id: "front", z: 5 };
    // tracked art is at (800,400); clicking (10,10) misses it → must fall
    // through to the lower-z text overlay (proves `continue`, not return null)
    expect(hitTest(10, 10, [text, trackedHigh], 1, { trk1: track })?.id).toBe("back");
  });

  it("invisible sample is not hit", () => {
    const invisTrack: Track = {
      ...track,
      samples: [{ t: 1, x: 800, y: 400, w: 100, h: 100, confidence: 1, visible: false }],
      segments: [
        { ...track.segments![0], samples: [{ t: 1, x: 800, y: 400, w: 100, h: 100, confidence: 1, visible: false }] },
      ],
    };
    expect(hitTest(850, 450, [tracked], 1, { trk1: invisTrack })).toBeNull();
  });
});
