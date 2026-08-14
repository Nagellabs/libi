import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * T23 regression: the mediapipe-path track loop must check shouldCancel
 * on a wall-clock cadence (≤1s), not just every 30 frames — at fps=15 the
 * frame-only check slips above the 1.5s SLA.
 *
 * This is a source-level assertion (the loop runs in Playwright Chromium,
 * not Node) and only verifies that the wall-clock branch wasn't removed.
 */
describe("track-entry.ts mediapipe cancel cadence (T23)", () => {
  let src: string;

  it("loads the source file", async () => {
    src = await fs.readFile(
      path.join(process.cwd(), "lib/tracking/track-entry.ts"),
      "utf-8",
    );
    expect(src.length).toBeGreaterThan(0);
  });

  it("declares a wall-clock cancel-poll interval of ≤1000ms", async () => {
    src = await fs.readFile(
      path.join(process.cwd(), "lib/tracking/track-entry.ts"),
      "utf-8",
    );
    // The constant should exist and be ≤1000.
    const match = src.match(/CANCEL_POLL_INTERVAL_MS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    const ms = Number(match![1]);
    expect(ms).toBeLessThanOrEqual(1000);
  });

  it("uses Date.now() based time comparison alongside the i%30 frame check", async () => {
    src = await fs.readFile(
      path.join(process.cwd(), "lib/tracking/track-entry.ts"),
      "utf-8",
    );
    // Wall-clock check must be present and OR'd with the frame check.
    expect(src).toMatch(/cancelByTime/);
    expect(src).toMatch(/i % 30 === 0[\s\S]{0,80}cancelByTime/);
    expect(src).toMatch(/lastCancelPollMs/);
  });
});
