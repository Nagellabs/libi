/**
 * Unit: the `matte_gen` coverage gate actually BLOCKS.
 *
 * Why this exists: `frameCount` is a COUNT, which CLAUDE.md calls "necessary
 * but NOT sufficient". This feature's spike proved the hole — a mask-convention
 * bug produced 181 alpha PNGs that were entirely ZERO, passing every
 * count-based check while the cutout rendered nothing.
 *
 * The sidecar now reports mean alpha `coverage` + `flags`. This test pins the
 * ENFORCEMENT: a flagged matte must throw BEFORE `storeFile`, so a silent
 * no-op can never be handed to the user as a successful cutout. A gate with no
 * test is exactly the untested-chokepoint pattern review flagged previously.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fileRow = {
  id: "file-1",
  pieceId: "piece-1",
  filename: "clip.mp4",
  name: "clip.mp4",
  type: "video",
  mediaDuration: 8,
};

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => ({ all: () => [fileRow] }) }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => ({ run: () => undefined }) }) }),
  }),
}));

vi.mock("@/lib/tracking/not-installed", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tracking/not-installed")>();
  return { ...actual, trackingEngineInstalled: () => true };
});

vi.mock("@/lib/ffmpeg/probe", () => ({
  probeMedia: async () => ({ duration: 8, hasAlpha: false }),
}));

const runMatteSegment = vi.fn();
vi.mock("@/lib/tracking/matte-runner", () => ({
  runMatteSegment: (...a: unknown[]) => runMatteSegment(...a),
}));

const runFfmpeg = vi.fn(async () => ({ stdout: "", stderr: "" }));
vi.mock("@/lib/ffmpeg/exec", () => ({ runFfmpeg: () => runFfmpeg() }));

const storeFile = vi.fn(async () => ({ id: "cutout-1" }));
vi.mock("@/mcp/tools/file-tools", () => ({ storeFile: () => storeFile() }));

// Keep the rest of libi-home intact — lib/logger.ts imports ensureLibiDirs /
// getLibiLogDir from it at module load, so a wholesale replacement breaks the
// import graph before any test runs.
vi.mock("@/lib/libi-home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/libi-home")>();
  return { ...actual, getLibiStorageDir: () => "/tmp/libi-store" };
});
vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: () => undefined },
}));

import fs from "node:fs";
import { matteGenRunner } from "@/lib/jobs/runners/matte-gen";

function ctx() {
  return {
    jobId: "job-1",
    params: { fileId: "file-1", engine: "local" as const, subject: { kind: "auto" as const } },
    reportProgress: () => undefined,
    shouldCancel: () => false,
    checkpoint: async () => undefined,
  };
}

beforeEach(() => {
  runMatteSegment.mockReset();
  runFfmpeg.mockClear();
  storeFile.mockClear();
  // The runner stats the source before matting; pretend it exists.
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  vi.spyOn(fs, "mkdtempSync").mockReturnValue("/tmp/libi-matte-test");
  vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined as never);
  vi.spyOn(fs, "rmSync").mockReturnValue(undefined);
});

describe("matte_gen coverage gate", () => {
  it("REFUSES an empty matte and never stores it", async () => {
    // The spike's exact failure: healthy frameCount, zero alpha everywhere.
    runMatteSegment.mockResolvedValue({
      outputDir: "/tmp/alpha",
      frameCount: 181,
      framerate: 30,
      device: "mps",
      msPerFrame: 100,
      coverage: 0,
      flags: ["empty_matte"],
    });

    await expect(matteGenRunner.run(ctx() as never)).rejects.toThrow(
      /empty_matte/,
    );
    expect(storeFile).not.toHaveBeenCalled();
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("REFUSES a full-frame matte (nothing removed) and never stores it", async () => {
    runMatteSegment.mockResolvedValue({
      outputDir: "/tmp/alpha",
      frameCount: 210,
      framerate: 30,
      device: "mps",
      msPerFrame: 100,
      coverage: 0.999,
      flags: ["full_frame_matte"],
    });

    await expect(matteGenRunner.run(ctx() as never)).rejects.toThrow(
      /full_frame_matte/,
    );
    expect(storeFile).not.toHaveBeenCalled();
  });

  it("lets a healthy matte through to compose + store", async () => {
    // 27.68% is the real measured coverage of a talking-head cutout.
    runMatteSegment.mockResolvedValue({
      outputDir: "/tmp/alpha",
      frameCount: 210,
      framerate: 30,
      device: "mps",
      msPerFrame: 100,
      coverage: 0.2768,
      flags: [],
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("webm"));

    const res = await matteGenRunner.run(ctx() as never);
    expect(res.cutoutFileId).toBe("cutout-1");
    expect(storeFile).toHaveBeenCalled();
  });
});
