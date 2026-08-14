import { describe, it, expect, vi } from "vitest";
import type { EngineSegmentOpts } from "@/lib/tracking/boxmot-runner";
import { listIdentityCandidates } from "@/lib/tracking/identity-candidates";

describe("listIdentityCandidates", () => {
  it("runs the sidecar in candidates mode and returns ranked tracklets", async () => {
    const fakeRun = async () => ({
      samples: [],
      framerate: 30,
      candidateTracklets: [
        { candidateId: 7, perFrame: [{ t: 20, bbox: [10, 10, 30, 40] as [number, number, number, number] }],
          meanTargetSim: 0.41, frameCount: 1 },
        { candidateId: 3, perFrame: [{ t: 20, bbox: [200, 50, 35, 45] as [number, number, number, number] }],
          meanTargetSim: 0.88, frameCount: 1 },
      ],
    });
    const out = await listIdentityCandidates(
      { videoPath: "/tmp/x.mp4", fps: 30,
        range: { start: 20, end: 25 }, anchors: [] },
      { runEngineSegment: fakeRun as typeof import("@/lib/tracking/boxmot-runner").runEngineSegment },
    );
    expect(out.map((c) => c.candidateId)).toEqual([3, 7]); // best sim first
    expect(out[0].perFrame[0].bbox).toEqual([200, 50, 35, 45]);
  });

  it("returns [] when the sidecar reports no competing tracklets", async () => {
    const fakeRun = async () => ({ samples: [], framerate: 30, candidateTracklets: [] });
    const out = await listIdentityCandidates(
      { videoPath: "/tmp/x.mp4", fps: 30,
        range: { start: 0, end: 1 }, anchors: [] },
      { runEngineSegment: fakeRun as typeof import("@/lib/tracking/boxmot-runner").runEngineSegment },
    );
    expect(out).toEqual([]);
  });

  it("passes the exact EngineSegmentOpts shape to runEngineSegment (no fileId/pieceId/fileUrl)", async () => {
    const spy = vi.fn(async (_opts: EngineSegmentOpts) => ({
      samples: [],
      framerate: 30,
      candidateTracklets: [],
    }));
    const anchors: { time: number; bbox: [number, number, number, number] }[] = [
      { time: 5, bbox: [10, 20, 30, 40] },
    ];
    await listIdentityCandidates(
      { videoPath: "/tmp/test.mp4", fps: 25, range: { start: 0, end: 10 }, anchors },
      { runEngineSegment: spy },
    );
    expect(spy).toHaveBeenCalledOnce();
    const received = spy.mock.calls[0][0];
    // Must contain the exact production shape
    expect(received).toEqual({
      videoPath: "/tmp/test.mp4",
      fps: 25,
      range: { start: 0, end: 10 },
      method: "candidates",
      classes: ["person"],
      anchors,
    });
    // Must NOT carry fileId, pieceId, or fileUrl
    expect(received).not.toHaveProperty("fileId");
    expect(received).not.toHaveProperty("pieceId");
    expect(received).not.toHaveProperty("fileUrl");
  });
});
