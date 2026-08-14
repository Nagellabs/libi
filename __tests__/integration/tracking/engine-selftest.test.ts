import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runEngineSelftest } from "@/lib/tracking/engine-selftest";
import { probeTrackingEnv, useRealTrackingEnv } from "@/__tests__/helpers/tracking-env";

// The global vitest setup overrides LIBI_HOME to a temp dir (so tests can't
// touch the user's real ~/.libi). The uv binary, the tracking venv and the
// ONNX models all derive from LIBI_HOME, so under isolation this test spawned
// a non-existent `uv` (ENOENT). Point the run at the REAL provisioned
// environment when there is one — and skip honestly when there isn't, rather
// than letting `uv run` build a ~1.2 GB torch venv from a test.
//
// --selftest only imports the inference libraries, so models are not required.
const env = probeTrackingEnv();
let restore: (() => void) | null = null;

beforeAll(() => {
  if (!env.missing) restore = useRealTrackingEnv(env);
});

afterAll(() => {
  restore?.();
});

describe("runEngineSelftest", () => {
  it("returns ok + onnxruntime version when the uv env is synced", async () => {
    if (env.missing) {
      console.warn("SKIP:", env.missing);
      return;
    }
    const r = await runEngineSelftest();
    expect(r.ok).toBe(true);
    expect(r.versions.onnxruntime).toBeTruthy();
  }, 180_000);
});
