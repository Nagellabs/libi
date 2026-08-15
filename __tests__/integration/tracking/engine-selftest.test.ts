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

// Reported PASS while asserting nothing when the env was absent: the test
// body opened with `if (env.missing) return;`, so on every machine without a
// provisioned tracking venv — CI included — this file was a green tick over
// zero coverage, which is strictly worse than a skip because nothing in the
// summary distinguishes it. Skip honestly and say why.
if (env.missing) console.info(`[skip] runEngineSelftest — ${env.missing}`);

describe.skipIf(env.missing !== null)("runEngineSelftest", () => {
  it("returns ok + onnxruntime version when the uv env is synced", async () => {
    const r = await runEngineSelftest();
    expect(r.ok).toBe(true);
    expect(r.versions.onnxruntime).toBeTruthy();
  }, 180_000);
});
