import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runEngineSegment } from "@/lib/tracking/boxmot-runner";
import { probeTrackingEnv, useRealTrackingEnv } from "@/__tests__/helpers/tracking-env";
import { hasFaceFixture, FIXTURE_SKIP_REASON } from "./fixture-guard";

// The global vitest setup overrides LIBI_HOME to a temp dir (so tests can't
// touch the user's real ~/.libi). Everything the sidecar needs derives from
// LIBI_HOME — the uv binary, the tracking venv, and the ONNX models — so under
// isolation this spawned a non-existent `uv` (ENOENT). Point the run at the
// REAL provisioned environment when there is one, and skip honestly when there
// isn't rather than letting `uv run` build a ~1.2 GB torch venv from a test.
//
// A real segment decodes through the ONNX models, so those are required too.
const env = probeTrackingEnv({ requireModels: true });
let restore: (() => void) | null = null;

beforeAll(() => {
  if (!env.missing) restore = useRealTrackingEnv(env);
});

afterAll(() => {
  restore?.();
});

if (!hasFaceFixture) console.info(`[skip] ${FIXTURE_SKIP_REASON}`);

describe.skipIf(!hasFaceFixture)("runEngineSegment", () => {
  it("runs the python sidecar over the fixture and returns samples", async () => {
    if (env.missing) {
      console.warn("SKIP:", env.missing);
      return;
    }
    const progress: number[] = [];
    const out = await runEngineSegment({
      videoPath: "__tests__/fixtures/tracking/non-selfie-face-5s.mp4",
      fps: 5,
      range: { start: 0, end: 1 },
      method: "yoloe+botsort",
      classes: ["person", "face"],
      anchors: [{ time: 0, bbox: [40, 40, 120, 160] }],
      onProgress: (d) => progress.push(d),
      shouldCancel: () => false,
    });
    expect(out.framerate).toBe(5);
    expect(Array.isArray(out.samples)).toBe(true);
    expect(out.samples.every((s) => s.t <= 1.0001)).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
  }, 180_000);
});
