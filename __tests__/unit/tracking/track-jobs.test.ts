import { describe, it, expect, beforeEach } from "vitest";
import {
  createTrackJob,
  getTrackJob,
  resolveTrackJob,
  rejectTrackJob,
  getTrackJobTokenByJobId,
  __resetTrackRegistryForTests,
} from "@/lib/tracking/track-jobs";

beforeEach(() => __resetTrackRegistryForTests());

describe("track-jobs registry", () => {
  it("createTrackJob returns jobId + token + done promise", () => {
    const h = createTrackJob({
      pieceId: "p",
      payload: { fileId: "f", fileUrl: "/x", fps: 30, objectKind: "face" },
    });
    expect(h.jobId).toBeTruthy();
    expect(h.token).toBeTruthy();
    expect(h.done).toBeInstanceOf(Promise);
  });

  it("resolveTrackJob settles done with the right payload", async () => {
    const h = createTrackJob({
      pieceId: "p",
      payload: { fileId: "f", fileUrl: "/x", fps: 30, objectKind: "face" },
    });
    const samples = [
      { t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 0.9, visible: true },
    ];
    const ok = resolveTrackJob(h.jobId, h.token, {
      samples,
      framerate: 30,
      method: "mediapipe-face",
    });
    expect(ok).toBe(true);
    const r = await h.done;
    expect(r.samples).toEqual(samples);
  });

  it("rejectTrackJob settles done with error", async () => {
    const h = createTrackJob({
      pieceId: "p",
      payload: { fileId: "f", fileUrl: "/x", fps: 30, objectKind: "face" },
    });
    rejectTrackJob(h.jobId, h.token, "boom");
    await expect(h.done).rejects.toThrow("boom");
  });

  it("getTrackJob rejects wrong token", () => {
    const h = createTrackJob({
      pieceId: "p",
      payload: { fileId: "f", fileUrl: "/x", fps: 30, objectKind: "face" },
    });
    expect(getTrackJob(h.jobId, "wrong")).toBeNull();
  });

  it("getTrackJobTokenByJobId returns the token for unsettled jobs", () => {
    const h = createTrackJob({
      pieceId: "p",
      payload: { fileId: "f", fileUrl: "/x", fps: 30, objectKind: "face" },
    });
    expect(getTrackJobTokenByJobId(h.jobId)?.token).toBe(h.token);
  });
});
