import { describe, it, expect } from "vitest";
import { applyOverlaySizeStabilization } from "@/hooks/preview/use-overlay-tracks";
import type { Track } from "@/lib/tracking/types";

const spike = Array.from({ length: 20 }, (_, i) => ({
  t: i / 30,
  x: 100,
  y: 100,
  w: 80,
  h: 60,
  confidence: 1,
  visible: true,
}));
spike[10] = { t: 10 / 30, x: 0, y: 0, w: 400, h: 300, confidence: 1, visible: true };
const track = {
  id: "t",
  fileId: "f",
  label: "x",
  method: "m",
  framerate: 30,
  durationSec: 1,
  samples: spike,
  segments: [],
  anchors: [],
} as unknown as Track;

describe("applyOverlaySizeStabilization", () => {
  it("default (no sizeMode) clamps the spike", () => {
    const out = applyOverlaySizeStabilization({ t: track }, { t: {} });
    expect(out.t.samples[10].w).toBeLessThanOrEqual(80 * 1.75 + 1e-6);
  });
  it("sizeMode raw passes the spike through unchanged", () => {
    const out = applyOverlaySizeStabilization({ t: track }, { t: { sizeMode: "raw" } });
    expect(out.t.samples[10].w).toBe(400);
  });
});
