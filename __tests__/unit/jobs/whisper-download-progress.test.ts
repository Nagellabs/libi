/**
 * The whisper download must report progress WHILE it downloads.
 *
 * faster-whisper's downloader ticks once per completed file, and the repo is a
 * few tiny configs plus one large weights file — so a file counter says nothing
 * during the only part that takes time. Measured on published 0.1.2 during the
 * FULL QA run: the bar sat at `0/1 files` with `etaMs: null` for the whole
 * ~5 minute `small` download while 466 MB landed on disk.
 *
 * `trackDirectoryBytes` was written for exactly this in 0.1.2 (for ACE-Step)
 * and simply never wired into this runner. These tests keep it wired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WHISPER_MODELS,
  whisperModelBytes,
} from "@/lib/whisper/models";

describe("whisper model catalogue", () => {
  it("exposes a byte figure for every model", () => {
    for (const m of WHISPER_MODELS) {
      expect(m.approxBytes, m.id).toBeGreaterThan(0);
      expect(whisperModelBytes(m.id), m.id).toBe(m.approxBytes);
    }
  });

  it("throws on an unknown model rather than guessing a size", () => {
    expect(() => whisperModelBytes("nope")).toThrow(/unknown whisper model/);
  });

  // The display string and the byte figure are two hand-maintained copies of
  // one fact. This is the guard that stops them drifting.
  it.each(WHISPER_MODELS.map((m) => [m.id, m.approxSize, m.approxBytes] as const))(
    "%s: approxSize %s agrees with approxBytes",
    (_id, approxSize, approxBytes) => {
      const match = /~?([\d.]+)\s*(MB|GB)/.exec(approxSize);
      expect(match, `unparseable approxSize: ${approxSize}`).not.toBeNull();
      const [, num, unit] = match!;
      const expected =
        Number(num) * (unit === "GB" ? 1_000_000_000 : 1_000_000);
      expect(approxBytes).toBe(expected);
    },
  );
});

describe("whisper_model_download progress", () => {
  let dir: string;
  let reported: Array<{ done: number; total: number; unit: string }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-whisper-prog-"));
    reported = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports growing MB as bytes land, without waiting for a file to finish", async () => {
    const { trackDirectoryBytes } = await import("@/lib/jobs/dir-download-progress");
    const totalBytes = 480_000_000;
    const totalMb = Math.floor(totalBytes / 1_000_000);

    const progress = trackDirectoryBytes({
      dir,
      totalBytes,
      intervalMs: 5,
      onBytes: (bytesDone) => {
        reported.push({
          done: Math.min(Math.floor(bytesDone / 1_000_000), totalMb),
          total: totalMb,
          unit: "MB",
        });
      },
    });

    // Simulate a single large file growing — the case a file counter misses.
    const f = path.join(dir, "model.bin");
    for (const mb of [40, 120, 300]) {
      fs.writeFileSync(f, Buffer.alloc(mb * 1_000_000));
      progress.poke();
      await vi.waitFor(
        () => expect(reported.at(-1)?.done).toBeGreaterThanOrEqual(mb - 1),
        { timeout: 2000 },
      );
    }
    progress.stop();

    expect(reported.length).toBeGreaterThan(1);
    expect(reported.every((r) => r.unit === "MB")).toBe(true);
    expect(reported.every((r) => r.total === totalMb)).toBe(true);
    // Monotonic: a bar that goes backwards is worse than no bar.
    const dones = reported.map((r) => r.done);
    expect([...dones].sort((a, b) => a - b)).toEqual(dones);
    // The actual regression: something between "nothing" and "finished".
    expect(dones.at(-1)).toBeGreaterThan(0);
    expect(dones.at(-1)).toBeLessThan(totalMb);
  });

  it("never reports more than the expected total", async () => {
    const { trackDirectoryBytes } = await import("@/lib/jobs/dir-download-progress");
    const totalBytes = 10_000_000;
    const progress = trackDirectoryBytes({
      dir,
      totalBytes,
      intervalMs: 5,
      onBytes: (bytesDone, bytesTotal) => reported.push({
        done: bytesDone, total: bytesTotal, unit: "bytes",
      }),
    });
    // Overshoot the estimate — an approximate figure WILL sometimes be low.
    fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(15_000_000));
    progress.poke();
    await vi.waitFor(() => expect(reported.length).toBeGreaterThan(0), { timeout: 2000 });
    progress.stop();
    expect(reported.every((r) => r.done <= totalBytes)).toBe(true);
  });
});
