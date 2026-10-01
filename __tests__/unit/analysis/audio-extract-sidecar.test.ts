/**
 * An audio.wav is on the file's timeline only when its sidecar
 * (`audio.wav.timeline` = "file") says so (review round 5, M1). One without
 * it predates the audio-lead fix (d0e0594c), or was cut short, and is early by
 * the audio's lead: chunkAudio extracts it again, with the chunk files cut from
 * it, instead of reusing it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { files } from "@/lib/db/schema";

vi.mock("@/lib/ffmpeg/exec", () => ({
  runFfmpeg: vi.fn(),
  resolveFfmpegPath: () => "ffmpeg",
  resolveFfprobePath: () => "ffprobe",
}));
vi.mock("@/lib/ffmpeg/probe", () => ({ probeMedia: vi.fn(async () => ({})) }));

import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { chunkAudio, extractAudio } from "@/lib/analysis/manager";
import { getAudioChunksDir, getAudioPath, getAudioTimelinePath, isAudioExtractCurrent } from "@/lib/analysis/storage";

const ops = () => vi.mocked(runFfmpeg).mock.calls.map((c) => (c[1] as { op: string }).op);

describe("audio.wav timeline sidecar", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-audio-sidecar-"));
    vi.stubEnv("LIBI_HOME", tmp);
    vi.stubEnv("STORAGE_DIR", path.join(tmp, "storage"));
    vi.mocked(runFfmpeg).mockReset().mockImplementation(async (args: string[]) => {
      const out = args[args.length - 1];
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, "new");
      return { stdout: "", stderr: "" };
    });
    const db = createTestDb();
    seedPiece(db, { id: "p1" });
    db.insert(files).values({ id: "f1", pieceId: "p1", filename: "v.mp4", name: "v.mp4", description: "", type: "video", storagePath: "p1/v.mp4", mediaDuration: 3 }).run();
  });
  afterEach(() => {
    resetTestDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function plantOldExtract(withSidecar: boolean) {
    fs.mkdirSync(getAudioChunksDir("p1", "f1"), { recursive: true });
    fs.writeFileSync(getAudioPath("p1", "f1"), "old");
    fs.writeFileSync(path.join(getAudioChunksDir("p1", "f1"), "chunk-0001.wav"), "old");
    if (withSidecar) fs.writeFileSync(getAudioTimelinePath("p1", "f1"), "file\n");
  }

  it("extractAudio writes the sidecar once the extract has finished", async () => {
    await extractAudio({ fileId: "f1" });
    expect(isAudioExtractCurrent("p1", "f1")).toBe(true);
  });

  it("an extract that fails leaves no sidecar, even where one was before", async () => {
    plantOldExtract(true);
    vi.mocked(runFfmpeg).mockRejectedValueOnce(new Error("ffmpeg died"));
    await expect(extractAudio({ fileId: "f1" })).rejects.toThrow("ffmpeg died");
    expect(isAudioExtractCurrent("p1", "f1")).toBe(false);
  });

  it("chunkAudio re-extracts an audio.wav without a sidecar, and re-cuts its chunks", async () => {
    plantOldExtract(false);
    await chunkAudio({ fileId: "f1" });
    expect(ops()).toEqual(["analysis_extract_audio", "analysis_chunk_audio"]);
    expect(fs.readFileSync(getAudioPath("p1", "f1"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(getAudioChunksDir("p1", "f1"), "chunk-0001.wav"), "utf8")).toBe("new");
    expect(isAudioExtractCurrent("p1", "f1")).toBe(true);
  });

  it("chunkAudio reuses an audio.wav whose sidecar says it is on the file's timeline", async () => {
    plantOldExtract(true);
    await chunkAudio({ fileId: "f1" });
    expect(ops()).toEqual([]); // audio.wav and its chunk file both reused
    expect(fs.readFileSync(getAudioPath("p1", "f1"), "utf8")).toBe("old");
  });
});
