/**
 * `libi.analysis_transcribe_audio` with no `model` uses `small` when it is
 * installed, else the most accurate installed model — and says which ran.
 *
 * LM review I-1: since LM-3 the Whisper card counts ANY installed model as
 * ready, but the default call still asked for `small`, so a `tiny`-only machine
 * got `needs_install` and a plan asking for a 480 MB download the card said it
 * didn't need.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema";
import { hfCacheDirName, pickWhisperModel, whisperModelsDir } from "@/lib/whisper/models";

// The real Whisper subprocess is not what is under test: record the model it
// is asked to run and answer like it.
const whisperCalls: string[] = [];
vi.mock("@/lib/whisper/transcribe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whisper/transcribe")>()),
  transcribeAudio: vi.fn(async (opts: { audioPath: string; model?: string }) => {
    whisperCalls.push(opts.model ?? "(none)");
    return {
      text: "ask not",
      words: [
        { text: "ask", start: 0, end: 0.4, type: "word" },
        { text: "not", start: 0.4, end: 0.8, type: "word" },
      ],
      language_code: "en",
      language_probability: 0.97,
    };
  }),
}));

// No real media: the audio extract and chunk cuts are ffmpeg's business.
vi.mock("@/lib/ffmpeg/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ffmpeg/exec")>()),
  runFfmpeg: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ffmpeg/probe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ffmpeg/probe")>()),
  probeMedia: vi.fn(async () => ({ audioRead: undefined })),
}));

const savedHome = process.env.LIBI_HOME;
let home: string;
let fileId: string;

function installModel(model: string) {
  const rev = path.join(whisperModelsDir(), hfCacheDirName(model), "snapshots", "rev1");
  fs.mkdirSync(rev, { recursive: true });
  fs.writeFileSync(path.join(rev, "model.bin"), "weights");
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-wdefault-"));
  process.env.LIBI_HOME = home;
  whisperCalls.length = 0;
  createTestDb();
  const db = getDb();
  const [piece] = await db.insert(pieces).values({ name: "p", description: "" }).returning();
  const [file] = await db
    .insert(files)
    .values({
      pieceId: piece.id, filename: "v.mp4", name: "v", description: "",
      type: "video", storagePath: "v.mp4", mediaDuration: 30,
    })
    .returning();
  fileId = file.id;
});
afterEach(() => {
  resetTestDb();
  if (savedHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

async function transcribe(model?: string) {
  const { transcribeAudio, chunkAudio } = await import("@/lib/analysis/manager");
  await chunkAudio({ fileId, chunkSeconds: 60, skipExtraction: true });
  return transcribeAudio({ fileId, ...(model ? { model } : {}) });
}

describe("transcribeAudio with no model", () => {
  it("only `tiny` installed → transcribes with tiny, and says so", async () => {
    installModel("tiny");
    const res = await transcribe();
    expect(res.status).toBe("ready");
    expect(res.model).toBe("tiny");
    expect(whisperCalls).toEqual(["tiny"]);
  });

  it("`small` installed → small, even beside a larger model", async () => {
    installModel("small");
    installModel("large-v3");
    const res = await transcribe();
    expect(res.model).toBe("small");
    expect(whisperCalls).toEqual(["small"]);
  });

  it("no small → the most accurate installed model", async () => {
    installModel("tiny");
    installModel("medium");
    expect((await transcribe()).model).toBe("medium");
  });

  it("nothing installed → needs_install for the default, named in the result", async () => {
    const res = await transcribe();
    expect(res).toMatchObject({ status: "needs_install", model: "small" });
    expect(res.hint).toMatch(/"small" not installed/);
    expect(whisperCalls).toEqual([]);
  });
});

describe("transcribeAudio with an explicit model", () => {
  it("still requires that model: `small` asked for on a tiny-only machine → needs_install", async () => {
    installModel("tiny");
    const res = await transcribe("small");
    expect(res).toMatchObject({ status: "needs_install", model: "small" });
    expect(whisperCalls).toEqual([]);
  });

  it("pickWhisperModel validates an explicit id", () => {
    expect(() => pickWhisperModel("huge")).toThrow(/unknown whisper model/);
  });
});
