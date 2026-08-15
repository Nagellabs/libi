import { describe, it, expect } from "vitest";
import path from "path";

const RUN = process.env.LIBI_TEST_INTEGRATION === "1";

if (!RUN)
  console.info(
    "[skip] analyze.py roundtrip — set LIBI_TEST_INTEGRATION=1 to run (needs the provisioned librosa env)",
  );

(RUN ? describe : describe.skip)("analyze.py roundtrip (real librosa)", () => {
  const FIX = path.resolve("__tests__/fixtures/music/test-clip-12s.wav");

  it("detectBeats returns a plausible tempo + non-empty beats", async () => {
    const { detectBeats } = await import("@/lib/music/analyze");
    const r = await detectBeats({ inPath: FIX });
    expect(r.tempo).toBeGreaterThan(40);
    expect(r.tempo).toBeLessThan(240);
    expect(r.beatTimes.length).toBeGreaterThan(0);
    expect(r.durationSeconds).toBeGreaterThan(5);
    expect(r.truncated).toBe(false);
  }, 120_000);

  it("profile returns a non-empty suggestedPrompt with key + bpm", async () => {
    const { profile } = await import("@/lib/music/analyze");
    const r = await profile({ inPath: FIX });
    expect(r.suggestedPrompt).toMatch(/\d+\s*BPM/i);
    expect(r.keyEstimate.tonic).toMatch(/^[A-G]#?$/);
    expect(r.descriptors.length).toBeGreaterThan(2);
  }, 120_000);
});
