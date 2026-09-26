/**
 * One-time boot migration (review round 4, M-f): transcripts made before
 * extractAudio padded an audio lead (d0e0594c) are moved onto the file's
 * timeline once (lib/analysis/retime-audio-lead.ts). Real ffmpeg makes the
 * files; the rows are what chunkAudio / saveAudioChunk / aggregateTranscript
 * leave.
 * - A file whose audio starts 0.4 s in: every chunk and word moves by 0.4 s,
 *   and the transcript is stamped, so a second run changes nothing.
 * - A FLAC-in-MP4 cut (its old extract repeated and skipped frames): the
 *   transcript is removed, to be made again.
 * - A file without a lead, and a transcript already stamped: untouched.
 * - The old audio.wav and chunk files of a moved or removed transcript go.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "../helpers/media";
import { getDb } from "@/lib/db/client";
import { analysisAudioChunks, analysisSteps, files, pieces } from "@/lib/db/schema";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { getAudioPath, getAudioChunksDir } from "@/lib/analysis/storage";
import { aggregateTranscript } from "@/lib/analysis/manager";
import { sweepRetimeAudioLeadTranscripts, AUDIO_LEAD_RETIME_MARKER } from "@/lib/analysis/retime-audio-lead";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

skipIf("re-timing transcripts made before the audio lead was kept (real ffmpeg)", () => {
  let home: string;
  let pieceId: string;
  const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-retime-"));
    process.env.LIBI_HOME = home;
    delete process.env.STORAGE_DIR;
    createTestDb();
    const [piece] = await getDb().insert(pieces).values({ name: "p", description: "" }).returning();
    pieceId = piece.id;
    const dir = path.join(home, "storage", pieceId);
    fs.mkdirSync(dir, { recursive: true });
    const V = ["-f", "lavfi", "-i", "testsrc2=s=32x32:r=25:d=3"];
    const A = (extra: string[] = []) => [...extra, "-f", "lavfi", "-i", "sine=f=440:sample_rate=48000:d=2.5"];
    ff([...V, ...A(["-itsoffset", "0.4"]), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "late.mp4")]);
    ff([...V, ...A(), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "plain.mp4")]);
    ff([...V, ...A(), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", "-c:a", "flac", path.join(dir, "flac-src.mp4")]);
    ff(["-ss", "1.3", "-to", "2.8", "-i", path.join(dir, "flac-src.mp4"), "-c", "copy", path.join(dir, "flac-cut.mp4")]);
  });
  afterEach(() => {
    resetTestDb();
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** A file with a transcript as the Whisper path leaves it: one chunk, its words, the aggregate. */
  async function transcribed(filename: string, id: string, stamp = false) {
    const db = getDb();
    await db.insert(files).values({ id, pieceId, filename, name: filename, description: "", type: "video", storagePath: `${pieceId}/${filename}`, mediaDuration: 3 }).run();
    const [step] = await db.insert(analysisSteps).values({ fileId: id, pieceId, kind: "transcript", status: "not_started" }).returning();
    await db.insert(analysisAudioChunks).values({
      fileId: id, stepId: step.id, chunkIndex: 0, startSeconds: 0, endSeconds: 3, filePath: "audio-chunks/chunk-0001.wav", status: "ready",
      text: "hello there", words: JSON.stringify([{ text: "hello", start: 0.1, end: 0.5 }, { text: "there", start: 0.6, end: 1.0 }]),
    }).run();
    await aggregateTranscript(id, { provider: "whisper" });
    if (!stamp) {
      // As made before the fix: no stamp.
      const [s] = db.select().from(analysisSteps).where(eq(analysisSteps.id, step.id)).all();
      const meta = JSON.parse(s.metadata!);
      delete meta.audioTimeline;
      db.update(analysisSteps).set({ metadata: JSON.stringify(meta) }).where(eq(analysisSteps.id, step.id)).run();
    }
    fs.mkdirSync(getAudioChunksDir(pieceId, id), { recursive: true });
    fs.writeFileSync(getAudioPath(pieceId, id), "old");
    fs.writeFileSync(path.join(getAudioChunksDir(pieceId, id), "chunk-0001.wav"), "old");
  }
  const words = (id: string) => {
    const [s] = getDb().select().from(analysisSteps).where(eq(analysisSteps.fileId, id)).all();
    return s ? (JSON.parse(s.metadata!) as { words: Array<{ start: number; end: number }>; audioTimeline?: string }) : null;
  };
  const chunk = (id: string) => getDb().select().from(analysisAudioChunks).where(eq(analysisAudioChunks.fileId, id)).all()[0];

  it("new transcripts are stamped as on the file's timeline", async () => {
    await transcribed("plain.mp4", "f-new", true);
    expect(words("f-new")!.audioTimeline).toBe("file");
  });

  it("moves a file's transcript by its audio lead, once; leaves the others; removes the FLAC cut's", async () => {
    await transcribed("late.mp4", "f-late");
    await transcribed("plain.mp4", "f-plain");
    await transcribed("flac-cut.mp4", "f-flac");
    await transcribed("late.mp4", "f-stamped", true);

    const r = await sweepRetimeAudioLeadTranscripts();
    expect(r).toEqual({ retimed: 1, removed: 1 });

    const late = words("f-late")!;
    expect(late.audioTimeline).toBe("file");
    // The AAC track starts 0.4 s in (less its 1024-sample priming, which ffmpeg keeps in the stream start).
    expect(late.words[0].start).toBeCloseTo(0.1 + 0.4, 1);
    expect(late.words[0].start - 0.1).toBeCloseTo(late.words[1].start - 0.6, 6);
    const c = chunk("f-late");
    expect(c.startSeconds).toBeCloseTo(late.words[0].start - 0.1, 6);
    expect(JSON.parse(c.words!)[1].end).toBeCloseTo(1.0 + (late.words[0].start - 0.1), 6);
    expect(fs.existsSync(getAudioPath(pieceId, "f-late"))).toBe(false);
    expect(fs.existsSync(getAudioChunksDir(pieceId, "f-late"))).toBe(false);

    expect(words("f-plain")!.words[0].start).toBe(0.1); // no lead: untouched, audio.wav kept
    expect(fs.existsSync(getAudioPath(pieceId, "f-plain"))).toBe(true);
    expect(words("f-stamped")!.words[0].start).toBe(0.1); // stamped: untouched
    expect(words("f-flac")).toBeNull(); // removed, chunks with it
    expect(chunk("f-flac")).toBeUndefined();
    expect(fs.existsSync(getAudioPath(pieceId, "f-flac"))).toBe(false);

    // A second run (marker gone, e.g. cut short before writing it) moves nothing twice.
    fs.rmSync(path.join(home, "state", AUDIO_LEAD_RETIME_MARKER));
    const before = words("f-late")!.words[0].start;
    await sweepRetimeAudioLeadTranscripts();
    expect(words("f-late")!.words[0].start).toBe(before);
  });

  it("runs once: its marker stops it", async () => {
    await sweepRetimeAudioLeadTranscripts();
    await transcribed("late.mp4", "f-after");
    expect(await sweepRetimeAudioLeadTranscripts()).toEqual({ retimed: 0, removed: 0 });
    expect(words("f-after")!.words[0].start).toBe(0.1);
  });
});
