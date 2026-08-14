/**
 * I4b regression — `FfmpegOverlayBackend` builds `inputPaths` and
 * `inputOptionArgs` as two parallel arrays across THREE push sites (video
 * base, asset overlays, audio clips). If any site pushes to one array but not
 * the other, per-input option args (e.g. the alpha-preserving
 * `-c:v libvpx-vp9` that must precede an alpha WebM's `-i`) shift onto the
 * WRONG input — silently decoding a cutout opaque or crashing the invocation.
 *
 * This test runs the real backend with runFfmpeg mocked and asserts the final
 * argv: one `-i` per input, in order, each preceded by exactly its own
 * option args.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/ffmpeg/exec", () => ({
  runFfmpeg: vi.fn(),
  resolveFfmpegPath: vi.fn(() => "/usr/bin/ffmpeg"),
  resolveFfprobePath: vi.fn(() => "/usr/bin/ffprobe"),
}));
vi.mock("@/lib/ffmpeg/probe", () => ({
  probeMedia: vi.fn(async () => ({ videoCodec: "vp9", hasAlpha: true })),
}));
vi.mock("@/lib/export/hw-accel", () => ({
  detectAvailableEncoders: vi.fn(async () => ({})),
  pickEncoder: vi.fn(() => "libx264"),
}));

import { getDb } from "@/lib/db/client";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { files } from "@/lib/db/schema/sqlite";
import { FfmpegOverlayBackend } from "@/lib/export/backends/ffmpeg-overlay";
import type { ExportContext } from "@/lib/export/backend";
import type { Composition } from "@/lib/engine/types";

let tmp: string;

function seedVideoFile(
  db: ReturnType<typeof createTestDb>,
  id: string,
  filename: string,
  opts: { type?: string; hasAlpha?: boolean | null } = {},
): void {
  db.insert(files)
    .values({
      id,
      pieceId: "p",
      filename,
      name: filename,
      description: "",
      type: opts.type ?? "video",
      storagePath: `p/${filename}`,
      size: 1,
      hasAlpha: opts.hasAlpha ?? null,
    })
    .run();
}

/** Parse an ffmpeg argv into `{ opts, path }` per `-i` input (stops at -filter_complex). */
function parseInputs(args: string[]): Array<{ opts: string[]; path: string }> {
  const inputs: Array<{ opts: string[]; path: string }> = [];
  let pending: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-filter_complex") break;
    if (a === "-y") continue;
    if (a === "-ss" || a === "-to") {
      i++; // skip global trim opts — not per-input decoder options
      continue;
    }
    if (a === "-i") {
      inputs.push({ opts: pending, path: args[i + 1] });
      pending = [];
      i++;
      continue;
    }
    pending.push(a);
  }
  return inputs;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ffov-args-"));
  process.env.LIBI_HOME = tmp;
  delete process.env.STORAGE_DIR;
  const db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);
  seedPiece(db as never, { id: "p" });
});
afterEach(() => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("FfmpegOverlayBackend — inputOptionArgs stays index-parallel with inputPaths", () => {
  it("emits each input's own option args before ITS -i across base + overlays + audio", async () => {
    const db = vi.mocked(getDb)();
    // Base scene: alpha VP9 WebM → needs -c:v libvpx-vp9 before its -i.
    seedVideoFile(db, "base", "base-cutout.webm", { hasAlpha: true });
    // Video overlay: another alpha WebM → its OWN -c:v libvpx-vp9.
    seedVideoFile(db, "ov-vid", "overlay-cutout.webm", { hasAlpha: true });
    // Image overlay: opaque → no option args.
    seedVideoFile(db, "ov-img", "sticker.png", { type: "image", hasAlpha: null });
    // Audio clip: no video-decoder override ever.
    seedVideoFile(db, "clip-audio", "music.mp3", { type: "audio", hasAlpha: null });

    const composition = {
      id: "c1",
      name: "c",
      width: 1080,
      height: 1920,
      fps: 30,
      scenes: [],
      overlays: [
        {
          id: "s1",
          kind: "video",
          fileId: "base",
          videoUrl: "",
          startTime: 0,
          duration: 4,
          z: 0,
          opacity: 1,
          fit: "cover",
          rect: { x: 0, y: 0, width: 1080, height: 1920 },
        },
        {
          id: "o1",
          kind: "video",
          fileId: "ov-vid",
          startTime: 0,
          duration: 4,
          z: 1,
          rect: { x: 0, y: 0, width: 540, height: 960 },
        },
        {
          id: "o2",
          kind: "image",
          fileId: "ov-img",
          startTime: 0,
          duration: 4,
          z: 2,
          rect: { x: 540, y: 0, width: 540, height: 960 },
        },
      ],
      audioClips: [
        {
          id: "a1",
          kind: "standalone",
          fileId: "clip-audio",
          startTime: 0,
          duration: 4,
          trimStart: 0,
          volume: 1,
          enabled: true,
        },
      ],
    } as unknown as Composition;

    const outputPath = path.join(tmp, "out.mp4");
    vi.mocked(runFfmpeg).mockImplementation(async () => {
      fs.writeFileSync(outputPath, Buffer.alloc(16));
      return { stdout: "", stderr: "" };
    });

    const backend = new FfmpegOverlayBackend();
    await backend.run({
      composition,
      settings: {
        format: "mp4",
        codec: "avc",
        bitrate: 4_000_000,
        width: 1080,
        height: 1920,
        fps: 30,
      },
      outputPath,
    } as ExportContext);

    const args = vi.mocked(runFfmpeg).mock.calls[0][0] as string[];
    const inputs = parseInputs(args);

    // Exactly 4 inputs, in push order: base, video overlay, image overlay, audio clip.
    expect(inputs.map((i) => path.basename(i.path))).toEqual([
      "base-cutout.webm",
      "overlay-cutout.webm",
      "sticker.png",
      "music.mp3",
    ]);
    // Each input carries exactly ITS option args — index-parallel.
    expect(inputs.map((i) => i.opts)).toEqual([
      ["-c:v", "libvpx-vp9"],
      ["-c:v", "libvpx-vp9"],
      [],
      [],
    ]);
  });

  it("opaque-only comps emit no per-input option args at all", async () => {
    const db = vi.mocked(getDb)();
    seedVideoFile(db, "base", "clip.mp4", { hasAlpha: false });
    seedVideoFile(db, "ov-img", "sticker.png", { type: "image", hasAlpha: null });

    const composition = {
      id: "c2",
      name: "c",
      width: 1080,
      height: 1920,
      fps: 30,
      scenes: [],
      overlays: [
        {
          id: "s1", kind: "video", fileId: "base", videoUrl: "",
          startTime: 0, duration: 2, z: 0, opacity: 1, fit: "cover",
          rect: { x: 0, y: 0, width: 1080, height: 1920 },
        },
        {
          id: "o1",
          kind: "image",
          fileId: "ov-img",
          startTime: 0,
          duration: 2,
          z: 1,
          rect: { x: 0, y: 0, width: 200, height: 200 },
        },
      ],
      audioClips: [],
    } as unknown as Composition;

    const outputPath = path.join(tmp, "out2.mp4");
    vi.mocked(runFfmpeg).mockImplementation(async () => {
      fs.writeFileSync(outputPath, Buffer.alloc(16));
      return { stdout: "", stderr: "" };
    });

    const backend = new FfmpegOverlayBackend();
    await backend.run({
      composition,
      settings: {
        format: "mp4",
        codec: "avc",
        bitrate: 4_000_000,
        width: 1080,
        height: 1920,
        fps: 30,
      },
      outputPath,
    } as ExportContext);

    const args = vi.mocked(runFfmpeg).mock.calls[0][0] as string[];
    const inputs = parseInputs(args);
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.opts)).toEqual([[], []]);
  });
});
