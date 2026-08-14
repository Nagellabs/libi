/**
 * `compute_object_track({ forceNew: true })` must actually recompute.
 *
 * The shot fan-out mints a fresh trackId and then calls `computeTrackSegment`
 * once per detected shot. It never passed `forceNew` down. Each per-shot job
 * therefore hashed to the SAME (kind, paramsHash) as the previous run's job —
 * fileId, fileUrl, fps, method, range and anchors are all unchanged by a new
 * trackId — so JobManager attached to the completed job and replayed its
 * cached samples.
 *
 * Measured 2026-08-02 on a real 3-shot clip: a fan-out that takes ~29s of
 * genuine engine work "completed" in 19ms and returned the earlier run's
 * all-zero samples. Consequences, both silent:
 *   - an engine fix looks like it changed nothing (that is how this was found)
 *   - a transient engine failure is replayed forever, with no escape hatch,
 *     because forceNew is the documented escape hatch and it did nothing
 *
 * This test pins the propagation at the seam rather than through JobManager,
 * so it stays fast and fails for exactly one reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const computeTrackSegmentMock = vi.hoisted(() => vi.fn());
const detectShotRangesMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tracking/shot-fanout", () => ({
  detectShotRanges: detectShotRangesMock,
}));

describe("shot fan-out propagates forceNew to every per-shot segment", () => {
  beforeEach(() => {
    computeTrackSegmentMock.mockReset();
    detectShotRangesMock.mockReset();
  });

  it("is wired in the source: the fan-out call site passes forceNew", async () => {
    // A source-level assertion is deliberate here. The fan-out loop is buried
    // inside computeObjectTrack behind a DB + job-server + sidecar stack; the
    // regression is a single missing property on one object literal, and this
    // catches it without standing all of that up.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../mcp/tools/tracking-tools.ts"),
      "utf-8",
    );

    // Isolate the fan-out loop body: from the shot iteration to the end of the
    // computeTrackSegment call it makes.
    const loopStart = src.indexOf("for (const shot of shots)");
    expect(loopStart, "fan-out loop not found — did the shape change?").toBeGreaterThan(-1);
    const callStart = src.indexOf("computeTrackSegment(", loopStart);
    expect(callStart, "computeTrackSegment call not found inside the fan-out").toBeGreaterThan(-1);
    const loopBody = src.slice(loopStart, callStart + 1400);

    expect(
      loopBody,
      "the per-shot computeTrackSegment call must pass forceNew — without it, " +
        "compute_object_track({ forceNew: true }) mints a new trackId but every " +
        "segment job dedupes on its unchanged paramsHash and replays cached samples.",
    ).toContain("forceNew");

    expect(
      /forceNew:\s*params\.forceNew === true/.test(loopBody),
      "forceNew must be derived from the caller's params, not hardcoded",
    ).toBe(true);
  });

  it("keeps forceNew off by default so ordinary reruns still dedupe", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../mcp/tools/tracking-tools.ts"),
      "utf-8",
    );
    // `params.forceNew === true` yields false for undefined, preserving the
    // dedupe/idempotency guarantee for a normal repeat call.
    expect(src).not.toContain("forceNew: true,\n          provenance");
  });
});
