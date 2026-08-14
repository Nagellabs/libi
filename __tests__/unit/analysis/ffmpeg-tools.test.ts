// __tests__/unit/analysis/ffmpeg-tools.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsModule from "fs";
import os from "os";
import path from "path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { files } from "@/lib/db/schema";

// Mock the ffmpeg + storage boundaries before importing the tools.
vi.mock("@/lib/ffmpeg/exec", () => ({
  runFfmpeg: vi.fn(),
  resolveFfmpegPath: () => "ffmpeg",
  resolveFfprobePath: () => "ffprobe",
}));
vi.mock("@/lib/storage", () => ({
  getStorage: async () => ({
    localPath: (pieceId: string | null, filename: string) =>
      `/fake/${pieceId ?? "_global"}/${filename}`,
  }),
}));

// Mock fs so analysisExtractFrames can call statSync on the fake input path.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  const FAKE_MTIME_MS = 1_700_000_000_000;
  const mockedStatSync = vi.fn((filePath: import("fs").PathLike, ...rest: Parameters<typeof actual.statSync>) => {
    if (String(filePath).startsWith("/fake/")) {
      return { mtimeMs: FAKE_MTIME_MS, size: 1 } as ReturnType<typeof actual.statSync>;
    }
    // Real paths — delegate to the actual implementation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (actual.statSync as any)(filePath, ...(rest as unknown[]));
  });
  const patchedDefault = Object.create(actual as object);
  patchedDefault.statSync = mockedStatSync;
  return { ...actual, statSync: mockedStatSync, default: patchedDefault };
});

import { runFfmpeg } from "@/lib/ffmpeg/exec";
import {
  analysisExtractAudio,
  analysisExtractFrames,
} from "@/mcp/tools/analysis-tools";

let tmp: string;

beforeEach(() => {
  tmp = fsModule.mkdtempSync(path.join(os.tmpdir(), "libi-ffmpeg-test-"));
  vi.stubEnv("LIBI_HOME", tmp);

  vi.mocked(runFfmpeg).mockReset();
  // Default: succeed and write a 1-byte file at the output path so fs.statSync works.
  vi.mocked(runFfmpeg).mockImplementation(async (args) => {
    const out = args[args.length - 1];
    fsModule.mkdirSync(path.dirname(out), { recursive: true });
    fsModule.writeFileSync(out, Buffer.from([0]));
    return { stdout: "", stderr: "" };
  });
  const db = createTestDb();
  seedPiece(db, { id: "p1" });
  db.insert(files).values({
    id: "f1",
    pieceId: "p1",
    filename: "clip.mp4",
    name: "Clip",
    description: "",
    type: "video",
    storagePath: "/x",
    size: 1,
    mediaDuration: 12,
  }).run();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetTestDb();
  fsModule.rmSync(tmp, { recursive: true, force: true });
});

describe("analysisExtractAudio", () => {
  it("succeeds and returns the audio path", async () => {
    const result = await analysisExtractAudio({ fileId: "f1" });
    expect(result.success).toBe(true);
    expect(String((result.data as { audioPath: string }).audioPath)).toMatch(/audio\.wav$/);
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
  });

  it("returns error when ffmpeg throws", async () => {
    vi.mocked(runFfmpeg).mockRejectedValueOnce(new Error("decode error"));
    const result = await analysisExtractAudio({ fileId: "f1" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/decode error/);
  });

  it("returns error when file is missing", async () => {
    const result = await analysisExtractAudio({ fileId: "no-such" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not found/);
  });
});

describe("analysisExtractFrames", () => {
  it("count=4 extracts 4 frames", async () => {
    const result = await analysisExtractFrames({ fileId: "f1", count: 4 });
    expect(result.success).toBe(true);
    const frames = (result.data as { frames: unknown[] }).frames;
    expect(frames).toHaveLength(4);
    expect(runFfmpeg).toHaveBeenCalledTimes(4);
  });

  it("timestamps strategy uses the provided values", async () => {
    const result = await analysisExtractFrames({
      fileId: "f1",
      timestamps: [1.0, 5.0, 9.0],
    });
    expect(result.success).toBe(true);
    const frames = (result.data as { frames: { timestamp: number }[] }).frames;
    expect(frames.map((f) => f.timestamp)).toEqual([1.0, 5.0, 9.0]);
  });

  it("returns error when mediaDuration is missing", async () => {
    const db = createTestDb();
    seedPiece(db, { id: "p2" });
    db.insert(files).values({
      id: "f-no-dur", pieceId: "p2", filename: "clip.mp4", name: "Clip", description: "",
      type: "video", storagePath: "/x", size: 1,
    }).run();
    const result = await analysisExtractFrames({ fileId: "f-no-dur", count: 4 });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/mediaDuration/);
  });

  it("returns error when file is missing", async () => {
    const result = await analysisExtractFrames({ fileId: "no-such", count: 2 });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not found/);
  });

  it("ffmpeg failure short-circuits and returns error", async () => {
    vi.mocked(runFfmpeg)
      .mockImplementationOnce(async (args) => {
        const out = args[args.length - 1];
        fsModule.mkdirSync(path.dirname(out), { recursive: true });
        fsModule.writeFileSync(out, Buffer.from([0]));
        return { stdout: "", stderr: "" };
      })
      .mockRejectedValueOnce(new Error("frame error"));

    const result = await analysisExtractFrames({ fileId: "f1", count: 4 });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/frame error/);
  });
});
