import { describe, it, expect } from "vitest";
import { matteJobPayload } from "@/lib/tracking/matte-runner";

describe("matteJobPayload", () => {
  it("builds the sidecar stdin job with defaults", () => {
    expect(
      matteJobPayload({
        videoPath: "/v.mp4",
        range: { start: 0, end: 3 },
        outputDir: "/tmp/alpha",
      }),
    ).toEqual({
      method: "matte",
      videoPath: "/v.mp4",
      range: { start: 0, end: 3 },
      outputDir: "/tmp/alpha",
      seedBox: null,
      seedMaskPath: null,
      maxDim: 1080,
      warmup: 10,
    });
  });

  it("passes an explicit seed box through untouched", () => {
    const job = matteJobPayload({
      videoPath: "/v.mp4",
      range: { start: 1, end: 2 },
      outputDir: "/o",
      seedBox: [10, 20, 30, 40],
      maxDim: 720,
    });
    expect(job.seedBox).toEqual([10, 20, 30, 40]);
    expect(job.maxDim).toBe(720);
  });
});
