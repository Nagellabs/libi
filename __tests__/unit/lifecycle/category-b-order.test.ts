/**
 * Category B's background sweeps run one after another in one async block.
 * The transcript re-time goes FIRST (review round 5, M1): it waits on no job,
 * while the proxy sweeps after it can wait minutes on regenerations, and a
 * transcription started in that window would reuse a pre-fix audio.wav.
 * Read from the source, as the other lifecycle order guards do.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Category B background sweep order", () => {
  it("the first sweep the block awaits is the transcript re-time", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/server/lifecycle/category-b.ts"), "utf8");
    const anchor = src.indexOf("sweepStaleGeneratingProxies");
    expect(anchor).toBeGreaterThan(0);
    const blockStart = src.lastIndexOf("void (async () => {", anchor);
    expect(blockStart).toBeGreaterThan(0);
    const blockEnd = src.indexOf("})();", anchor);
    const block = src.slice(blockStart, blockEnd);
    const calls = [...block.matchAll(/await (sweep\w+)\(/g)].map((m) => m[1]);
    expect(calls[0]).toBe("sweepRetimeAudioLeadTranscripts");
    expect(calls).toContain("sweepStaleGeneratingProxies");
    expect(calls.filter((c) => c === "sweepRetimeAudioLeadTranscripts")).toHaveLength(1);
  });
});
