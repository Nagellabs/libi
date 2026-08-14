/**
 * M1 regression — derived-file paths must thread `hasAlpha`.
 *
 * `has_alpha` was originally written at exactly one site (`storeFile`); every
 * other row-creating path left it NULL, which every consumer reads as OPAQUE.
 * A `libi.trim_video` on a cutout therefore yielded a row that
 * `FfmpegOverlayBackend` decoded natively → opaque rectangle.
 *
 * These tests pin that the ffmpeg derived-file helpers (`probeMediaInfo` /
 * `insertFileRow` / `trimVideo`) and the base64 `save_asset` path probe and
 * persist alpha honestly — by probing the OUTPUT file, so whatever alpha
 * actually survived the operation is what gets recorded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "./../helpers/test-db";

// Switchable ffprobe mock (callback-style execFile; promisify resolves with
// the single value we pass — same pattern as store-file-skips-proxy tests).
let probeStreams: unknown[] = [];
vi.mock("child_process", () => ({
  // Variadic: probeMedia calls execFile(cmd, args, options, cb) — the
  // callback is always LAST.
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    cb(null, {
      stdout: JSON.stringify({ format: { duration: "3.0" }, streams: probeStreams }),
      stderr: "",
    });
  },
}));

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/ffmpeg/exec", () => ({
  runFfmpeg: vi.fn(),
  resolveFfmpegPath: vi.fn(() => "/usr/bin/ffmpeg"),
  resolveFfprobePath: vi.fn(() => "/usr/bin/ffprobe"),
}));

import { getDb } from "@/lib/db/client";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { probeMediaInfo, insertFileRow, trimVideo } from "@/mcp/tools/ffmpeg-tools";
import { saveAsset } from "@/mcp/tools/file-tools";
import type { ToolContext } from "@/mcp/tools/types";

const ALPHA_STREAM = {
  codec_type: "video",
  codec_name: "vp9",
  width: 720,
  height: 1280,
  pix_fmt: "yuv420p",
  tags: { alpha_mode: "1" },
};
const OPAQUE_STREAM = {
  codec_type: "video",
  codec_name: "h264",
  width: 1920,
  height: 1080,
  pix_fmt: "yuv420p",
};

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-derived-alpha-"));
  process.env.LIBI_HOME = tmp;
  delete process.env.STORAGE_DIR;
  const db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);
  seedPiece(db as never, { id: "p" });
  vi.mocked(runFfmpeg).mockReset();
});
afterEach(() => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("probeMediaInfo — alpha detection", () => {
  it("reports hasAlpha=true for a WebM alpha_mode-tagged stream (pix_fmt lies as yuv420p)", async () => {
    probeStreams = [ALPHA_STREAM];
    const probed = await probeMediaInfo("/x/cutout.webm");
    expect(probed.hasAlpha).toBe(true);
  });

  it("reports hasAlpha=false for a plain opaque stream", async () => {
    probeStreams = [OPAQUE_STREAM, { codec_type: "audio" }];
    const probed = await probeMediaInfo("/x/clip.mp4");
    expect(probed.hasAlpha).toBe(false);
    expect(probed.hasAudio).toBe(true);
  });
});

describe("insertFileRow — hasAlpha persistence", () => {
  it("persists hasAlpha when supplied and leaves it NULL when not", async () => {
    const db = vi.mocked(getDb)();
    const withAlpha = await insertFileRow({
      pieceId: "p",
      filename: "a.webm",
      displayName: "a",
      description: "",
      type: "video",
      contentType: "video/webm",
      storagePath: "p/a.webm",
      size: 1,
      hasAlpha: true,
    });
    const without = await insertFileRow({
      pieceId: "p",
      filename: "b.mp3",
      displayName: "b",
      description: "",
      type: "audio",
      contentType: "audio/mpeg",
      storagePath: "p/b.mp3",
      size: 1,
    });
    const rowA = db.select().from(files).where(eq(files.id, withAlpha)).all()[0];
    const rowB = db.select().from(files).where(eq(files.id, without)).all()[0];
    expect(rowA.hasAlpha).toBe(true);
    expect(rowB.hasAlpha).toBeNull();
  });
});

describe("trimVideo — threads probed output alpha onto the derived row", () => {
  it("a trim whose output still carries alpha lands hasAlpha=true", async () => {
    const db = vi.mocked(getDb)();
    db.insert(files)
      .values({
        id: "src",
        pieceId: "p",
        filename: "cutout.webm",
        name: "cutout",
        description: "",
        type: "video",
        storagePath: "p/cutout.webm",
        contentType: "video/webm",
        size: 1,
        hasAlpha: true,
      })
      .run();
    probeStreams = [ALPHA_STREAM];
    vi.mocked(runFfmpeg).mockImplementation(async (args) => {
      // The output path is the last arg — simulate ffmpeg writing it.
      const out = (args as string[])[(args as string[]).length - 1];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.alloc(8));
      return { stdout: "", stderr: "" };
    });

    const result = await trimVideo({
      pieceId: "p",
      fileId: "src",
      startSeconds: 0,
      endSeconds: 2,
      outputName: "cutout-trim.webm",
    });
    expect(result.success).toBe(true);
    const fileId = (result.data as { fileId: string }).fileId;
    const row = db.select().from(files).where(eq(files.id, fileId)).all()[0];
    expect(row.hasAlpha).toBe(true);
  });

  it("a trim whose output probes opaque lands hasAlpha=false (honest, not inherited)", async () => {
    const db = vi.mocked(getDb)();
    db.insert(files)
      .values({
        id: "src2",
        pieceId: "p",
        filename: "clip.mp4",
        name: "clip",
        description: "",
        type: "video",
        storagePath: "p/clip.mp4",
        contentType: "video/mp4",
        size: 1,
        hasAlpha: false,
      })
      .run();
    probeStreams = [OPAQUE_STREAM];
    vi.mocked(runFfmpeg).mockImplementation(async (args) => {
      const out = (args as string[])[(args as string[]).length - 1];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.alloc(8));
      return { stdout: "", stderr: "" };
    });

    const result = await trimVideo({
      pieceId: "p",
      fileId: "src2",
      startSeconds: 0,
      endSeconds: 2,
    });
    expect(result.success).toBe(true);
    const fileId = (result.data as { fileId: string }).fileId;
    const row = db.select().from(files).where(eq(files.id, fileId)).all()[0];
    expect(row.hasAlpha).toBe(false);
  });
});

describe("saveAsset — probes alpha for base64-saved video", () => {
  it("a video asset with an alpha stream lands hasAlpha=true", async () => {
    const db = vi.mocked(getDb)();
    probeStreams = [ALPHA_STREAM];
    const result = await saveAsset({ pieceId: "p" } as ToolContext, {
      pieceId: "p",
      filename: "gen-cutout.webm",
      name: "gen cutout",
      description: "",
      type: "video",
      contentType: "video/webm",
      data: Buffer.from("webm-bytes").toString("base64"),
    });
    expect(result.success).toBe(true);
    const fileId = (result.data as { fileId: string }).fileId;
    const row = db.select().from(files).where(eq(files.id, fileId)).all()[0];
    expect(row.hasAlpha).toBe(true);
  });

  it("non-video assets stay NULL (no probe)", async () => {
    const db = vi.mocked(getDb)();
    probeStreams = [];
    const result = await saveAsset({ pieceId: "p" } as ToolContext, {
      pieceId: "p",
      filename: "note.txt",
      name: "note",
      description: "",
      type: "document",
      contentType: "text/plain",
      data: Buffer.from("hello").toString("base64"),
    });
    expect(result.success).toBe(true);
    const fileId = (result.data as { fileId: string }).fileId;
    const row = db.select().from(files).where(eq(files.id, fileId)).all()[0];
    expect(row.hasAlpha).toBeNull();
  });
});
