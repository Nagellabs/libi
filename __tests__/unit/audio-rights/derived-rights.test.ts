/**
 * A file made FROM other files must not lose their rights (final review I1).
 * trim / concat / extract-audio produce a row whose rights are the most
 * restrictive of its inputs'; duplicate_file copies rights and provenance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "./../../helpers/test-db";

vi.mock("child_process", () => ({
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    cb(null, {
      stdout: JSON.stringify({
        format: { duration: "3.0" },
        streams: [{ codec_type: "video", width: 720, height: 1280, pix_fmt: "yuv420p" }, { codec_type: "audio" }],
      }),
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
import { trimVideo, concatVideos, extractAudio } from "@/mcp/tools/ffmpeg-tools";
import { duplicateFile } from "@/mcp/tools/file-tools";
import { derivedRights } from "@/lib/audio-rights/read";
import { parseAudioRights, type AudioRights } from "@/lib/audio-rights/types";
import { getStorage } from "@/lib/storage";

let tmp: string;

const GENERATED: AudioRights = { class: "generated", track: { title: "lofi beat" }, decidedBy: "provenance", decidedAt: "2026-09-01T00:00:00.000Z" };
const COPYRIGHTED: AudioRights = {
  class: "copyrighted",
  track: { title: "Espresso", artist: "Sabrina Carpenter" },
  source: { url: "https://www.youtube.com/watch?v=x", site: "youtube" },
  decidedBy: "provenance",
  decidedAt: "2026-09-01T00:00:00.000Z",
};
const OWNED: AudioRights = { class: "owned", decidedBy: "user", decidedAt: "2026-09-01T00:00:00.000Z" };

function seedFile(id: string, rights: AudioRights | null, extra: Partial<typeof files.$inferInsert> = {}) {
  const db = vi.mocked(getDb)();
  db.insert(files)
    .values({
      id,
      pieceId: "p",
      filename: `${id}.mp4`,
      name: id,
      description: "",
      type: "video",
      storagePath: `p/${id}.mp4`,
      contentType: "video/mp4",
      size: 1,
      hasAudio: true,
      audioRights: rights ? JSON.stringify(rights) : null,
      ...extra,
    })
    .run();
}

function rowRights(fileId: string): AudioRights | null {
  const db = vi.mocked(getDb)();
  const row = db.select().from(files).where(eq(files.id, fileId)).all()[0];
  return parseAudioRights(row.audioRights);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-derived-rights-"));
  process.env.LIBI_HOME = tmp;
  delete process.env.STORAGE_DIR;
  const db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);
  seedPiece(db as never, { id: "p" });
  vi.mocked(runFfmpeg).mockReset();
  vi.mocked(runFfmpeg).mockImplementation(async (args) => {
    const out = (args as string[])[(args as string[]).length - 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.alloc(8));
    return { stdout: "", stderr: "" };
  });
});
afterEach(() => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("derivedRights — the most restrictive input wins", () => {
  const f = (r: AudioRights | null, extra: object = {}) => ({ type: "video", hasAudio: true, audioRights: r ? JSON.stringify(r) : null, ...extra });

  // Owner decision 2026-09-28: an unstamped input reads by provenance — the
  // user's own upload unless it is a legacy download.
  it("an unstamped input counts as the user's own; a legacy download's breadcrumb makes it copyrighted", () => {
    expect(derivedRights([f(OWNED), f(null)])?.class).toBe("owned");
    expect(derivedRights([f(GENERATED), f(null)])?.class).toBe("generated");
    expect(derivedRights([f(GENERATED), f(null, { description: "Downloaded from https://youtu.be/x" })])).toMatchObject({
      class: "copyrighted", source: { url: "https://youtu.be/x", site: "youtu.be" },
    });
  });
  it("generated + owned is generated; owned alone is owned", () => {
    expect(derivedRights([f(GENERATED), f(OWNED)])?.class).toBe("generated");
    expect(derivedRights([f(OWNED)])?.class).toBe("owned");
  });
  it("carries the one copyrighted input's track and source, and nothing when there are two", () => {
    const one = derivedRights([f(GENERATED), f(COPYRIGHTED)]);
    expect(one).toMatchObject({ class: "copyrighted", track: COPYRIGHTED.track, source: COPYRIGHTED.source, decidedBy: "provenance" });
    const two = derivedRights([f(COPYRIGHTED), f({ class: "copyrighted", decidedBy: "provenance", decidedAt: "2026-09-01T00:00:00.000Z" })]);
    expect(two?.class).toBe("copyrighted");
    expect(two?.track).toBeUndefined();
    expect(two?.source).toBeUndefined();
  });
  it("silent inputs do not count; no audio-bearing input → null", () => {
    expect(derivedRights([f(null, { hasAudio: false }), f(GENERATED)])?.class).toBe("generated");
    expect(derivedRights([f(null, { hasAudio: false })])).toBeNull();
  });
});

describe("ffmpeg derivations keep their inputs' rights", () => {
  it("a trim of a generated clip stays generated", async () => {
    seedFile("gen", GENERATED);
    const res = await trimVideo({ pieceId: "p", fileId: "gen", startSeconds: 0, endSeconds: 2 });
    expect(res.success).toBe(true);
    const r = rowRights((res.data as { fileId: string }).fileId);
    expect(r).toMatchObject({ class: "generated", track: { title: "lofi beat" }, decidedBy: "provenance" });
  });

  it("extracting audio from a copyrighted video stays copyrighted, with its track", async () => {
    seedFile("song", COPYRIGHTED);
    const res = await extractAudio({ pieceId: "p", fileId: "song" });
    expect(res.success).toBe(true);
    expect(rowRights((res.data as { fileId: string }).fileId)).toMatchObject({ class: "copyrighted", track: COPYRIGHTED.track });
  });

  it("a concat of generated + copyrighted is copyrighted and carries that track", async () => {
    seedFile("gen", GENERATED);
    seedFile("song", COPYRIGHTED);
    const res = await concatVideos({ pieceId: "p", fileIds: ["gen", "song"] });
    expect(res.success).toBe(true);
    const r = rowRights((res.data as { fileId: string }).fileId);
    expect(r).toMatchObject({ class: "copyrighted", track: COPYRIGHTED.track, source: COPYRIGHTED.source, decidedBy: "provenance" });
  });
});

describe("duplicate_file keeps rights and provenance", () => {
  it("a duplicate of an owned file is owned; aiGeneration is copied", async () => {
    const aiGeneration = JSON.stringify({
      provider: "fal-ai",
      model: "m",
      prompt: "p",
      startedAt: "2026-09-01T00:00:00.000Z",
      completedAt: "2026-09-01T00:00:01.000Z",
      durationMs: 1000,
    });
    seedFile("mine", OWNED, { aiGeneration });
    const storage = await getStorage();
    await storage.save("p", "mine.mp4", Buffer.from("bytes"), "video/mp4");
    const res = await duplicateFile({ fileId: "mine", targetPieceId: "p" });
    expect(res.success).toBe(true);
    const newId = (res.data as { fileId: string }).fileId;
    expect(rowRights(newId)).toEqual(OWNED);
    const db = vi.mocked(getDb)();
    const row = db.select().from(files).where(eq(files.id, newId)).all()[0];
    expect(row.aiGeneration).not.toBeNull();
  });
});
