import { describe, it, expect, vi, type MockedFunction } from "vitest";

vi.mock("@/lib/tracking/repo", () => ({
  getTrackRow: vi.fn(async () => ({ id: "trk-x", fileId: "f1" })),
}));
vi.mock("@/lib/tracking/storage", () => ({
  readTrack: vi.fn(async () => ({
    id: "trk-x", method: "yoloe+botsort", samples:
      Array.from({ length: 1152 }, (_, i) => ({
        t: i / 30, x: 0, y: 0, w: 0, h: 0, confidence: 0,
        visible: i / 30 < 4.2,
      })),
    segments: [],
  })),
}));
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => [
      { id: "f1", pieceId: "p1", mediaWidth: 608, mediaHeight: 1080, mediaDuration: 38.545 },
    ] }) }) }),
  }),
}));
vi.mock("@/lib/composition/persistence", () => ({
  addOverlayToManifest: vi.fn(async () => undefined),
}));
vi.mock("@/lib/logger", () => {
  const noop = { info: () => {}, warn: () => {}, error: () => {} };
  const logger = { ...noop, child: () => logger };
  return { serverLogger: logger, mcpLogger: logger };
});

import { addTrackedOverlay, BLOCKING_QUALITY_FLAGS_FOR_TEST } from "@/mcp/tools/tracking-tools";
import { readTrack } from "@/lib/tracking/storage";

describe("addTrackedOverlay quality gate", () => {
  const base = {
    pieceId: "p1", trackId: "trk-x", startTime: 0, duration: 38.545,
    rect: { x: 0, y: 0, width: 608, height: 1080 }, z: 10, opacity: 1,
    content: { kind: "emoji", char: "😀" } as const, fit: "tight" as const,
    scale: 1, smoothing: "linear" as const,
  };
  it("refuses a low-visibility track without acknowledgement", async () => {
    const r = await addTrackedOverlay(base as never);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/low_visibility|quality/i);
    }
  });
  it("attaches when explicitly acknowledged", async () => {
    const r = await addTrackedOverlay({ ...base, acknowledgeQualityIssues: true } as never);
    expect(r.success).toBe(true);
  });

  it("appearance_unverified_occlusion alone does NOT block addTrackedOverlay", async () => {
    // A track with only appearance_unverified_occlusion (anchor-asserted low-sim)
    // must attach without acknowledgeQualityIssues — it is non-blocking by design.
    // Build a track: all samples visible (above LOW_VIS_FRACTION), with a
    // sustained low-targetSim run (frames 60-89, t=2.0s–2.97s) covered by a
    // manual anchor at t=2.5. Samples are positioned mid-frame to avoid edge_pinned.
    const nSamples = 120; // 4 seconds at 30fps, all visible
    const anchoredSamples = Array.from({ length: nSamples }, (_, i) => ({
      t: i / 30,
      x: 200, y: 400, w: 60, h: 80, // mid-frame, not edge-pinned
      confidence: 0.9,
      visible: true,
      // frames 60-89 (1.0s, t=2.0–2.97s) are low-sim; covered by anchor at t=2.5
      targetSim: (i >= 60 && i < 90) ? 0.5 : 0.9,
    }));
    (readTrack as MockedFunction<typeof readTrack>).mockResolvedValueOnce({
      id: "trk-x",
      fileId: "f1",
      method: "yoloe+botsort",
      framerate: 30,
      durationSec: 4,
      samples: anchoredSamples,
      segments: [],
      manualAnchors: [{ id: "man-2500", time: 2.5, bbox: [200, 400, 60, 80] }],
    } as never);
    const r = await addTrackedOverlay(base as never);
    // Should attach successfully — appearance_unverified_occlusion is non-blocking
    expect(r.success).toBe(true);
  });

  it("threads the follow offset into the persisted overlay", async () => {
    const { addOverlayToManifest } = await import("@/lib/composition/persistence");
    (addOverlayToManifest as unknown as ReturnType<typeof vi.fn>).mockClear();
    const r = await addTrackedOverlay({
      ...base,
      acknowledgeQualityIssues: true,
      offset: { x: 0, y: -1 },
    } as never);
    expect(r.success).toBe(true);
    const calls = (addOverlayToManifest as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const written = calls[calls.length - 1][1] as { offset?: { x: number; y: number } };
    expect(written.offset).toEqual({ x: 0, y: -1 });
  });
});

describe("BLOCKING_QUALITY_FLAGS includes no_output", () => {
  it("blocks a no_output track from add_tracked_overlay", () => {
    expect(BLOCKING_QUALITY_FLAGS_FOR_TEST.has("no_output")).toBe(true);
  });
});
