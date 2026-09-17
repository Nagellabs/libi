import fs from "fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import {
  getAnalysis,
  saveTranscript,
  saveSummary,
  saveFrames,
  markStepFailed,
  removeStep,
} from "@/lib/analysis/manager";
import { getDb } from "@/lib/db/client";
import { files, pieces, analysisAudioChunks, analysisSteps } from "@/lib/db/schema";

/** Whether the local Whisper model is on disk. Every other test in this file
 *  injects `sttFn`, which makes `transcribeAudio` skip the install gate
 *  entirely — so the gate, the ONE transcription failure the server can still
 *  produce on its own, had no coverage at all. Defaults to installed so
 *  nothing else in the file changes. */
const isWhisperModelInstalled = vi.fn<(model: string) => boolean>(() => true);
vi.mock("@/lib/whisper/models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whisper/models")>()),
  isWhisperModelInstalled: (model: string) => isWhisperModelInstalled(model),
}));

describe("analysis manager (per-step)", () => {
  let fileId: string;

  beforeEach(async () => {
    createTestDb();
    const db = getDb();
    const [piece] = await db.insert(pieces).values({ name: "test", description: "" }).returning();
    const [file] = await db.insert(files).values({
      pieceId: piece.id,
      filename: "x.mp4",
      name: "x",
      description: "",
      type: "video",
      storagePath: "x.mp4",
    }).returning();
    fileId = file.id;
  });

  afterEach(() => {
    resetTestDb();
  });

  it("returns empty bundle when no steps exist", async () => {
    const result = await getAnalysis({ fileId });
    expect(result.steps).toEqual([]);
    expect(result.keyframes).toEqual([]);
  });

  it("upserts a transcript step", async () => {
    await saveTranscript({ fileId, content: "hello world", metadata: '{"provider":"test"}' });
    const result = await getAnalysis({ fileId });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].kind).toBe("transcript");
    expect(result.steps[0].status).toBe("ready");
    expect(result.steps[0].content).toBe("hello world");

    // Re-save replaces content
    await saveTranscript({ fileId, content: "updated" });
    const result2 = await getAnalysis({ fileId });
    expect(result2.steps).toHaveLength(1);
    expect(result2.steps[0].content).toBe("updated");
  });

  it("upserts a summary step with structured JSON", async () => {
    const summary = {
      schema_version: "video_v1" as const,
      overview: "test video",
      duration: 10,
      subjects: [],
      sections: [],
      recurring_objects: [],
    };
    await saveSummary({ fileId, summary });
    const result = await getAnalysis({ fileId });
    const summaryStep = result.steps.find((s) => s.kind === "summary");
    expect(summaryStep?.status).toBe("ready");
    expect(JSON.parse(summaryStep!.content!).overview).toBe("test video");
  });

  it("save_frames upserts keyframes for the file (existing frames are preserved)", async () => {
    await saveFrames({
      fileId,
      frames: [
        { frameIndex: 1, timestamp: 0.5, filePath: "frame-0001.png", description: '{"scene":"a"}' },
        { frameIndex: 2, timestamp: 1.0, filePath: "frame-0002.png", description: '{"scene":"b"}' },
      ],
    });
    let result = await getAnalysis({ fileId });
    expect(result.keyframes).toHaveLength(2);
    expect(result.steps.find((s) => s.kind === "frames")?.status).toBe("ready");

    // Upsert frame 1 with new description; frame 2 is preserved
    await saveFrames({
      fileId,
      frames: [{ frameIndex: 1, timestamp: 0.5, filePath: "frame-0001.png", description: '{"scene":"x"}' }],
    });
    result = await getAnalysis({ fileId });
    expect(result.keyframes).toHaveLength(2);
    expect(JSON.parse(result.keyframes[0].description!).scene).toBe("x");
    expect(JSON.parse(result.keyframes[1].description!).scene).toBe("b");
  });

  it("save_frames supports skipped frames", async () => {
    await saveFrames({
      fileId,
      frames: [
        { frameIndex: 1, timestamp: 0.5, filePath: "frame-0001.png", skipped: true, skipReason: "black frame" },
      ],
    });
    const result = await getAnalysis({ fileId });
    expect(result.keyframes[0].skipped).toBe(true);
    expect(result.keyframes[0].skipReason).toBe("black frame");
    expect(result.keyframes[0].description).toBeNull();
  });

  it("mark_step_failed records error per kind", async () => {
    await markStepFailed({ fileId, kind: "transcript", errorMessage: "no audio track" });
    const result = await getAnalysis({ fileId });
    const step = result.steps.find((s) => s.kind === "transcript");
    expect(step?.status).toBe("failed");
    expect(step?.errorMessage).toBe("no audio track");
  });

  it("remove_step deletes the row and any cascaded keyframes", async () => {
    await saveFrames({
      fileId,
      frames: [{ frameIndex: 1, timestamp: 0.5, filePath: "frame-0001.png", description: "{}" }],
    });
    await removeStep({ fileId, kind: "frames" });
    const result = await getAnalysis({ fileId });
    expect(result.steps.find((s) => s.kind === "frames")).toBeUndefined();
    expect(result.keyframes).toHaveLength(0);
  });
});

describe("audio chunk save + auto-aggregate", () => {
  let fid: string;
  beforeEach(async () => {
    createTestDb();
    const db = getDb();
    const [piece] = await db.insert(pieces).values({ name: "p", description: "" }).returning();
    const [file] = await db.insert(files).values({
      pieceId: piece.id,
      filename: "x.mp4",
      name: "x",
      description: "",
      type: "video",
      storagePath: "x.mp4",
      mediaDuration: 120,
    }).returning();
    fid = file.id;
  });
  afterEach(() => resetTestDb());

  it("saveAudioChunk inserts a chunk row tied to the transcript step", async () => {
    const { saveAudioChunk } = await import("@/lib/analysis/manager");
    const db = getDb();
    const [step] = await db.insert(analysisSteps).values({
      fileId: fid, kind: "transcript", status: "not_started",
    }).returning();
    const [chunk] = await db.insert(analysisAudioChunks).values({
      fileId: fid, stepId: step.id, chunkIndex: 0,
      startSeconds: 0, endSeconds: 60, filePath: "audio-chunks/chunk-0001.wav",
    }).returning();

    await saveAudioChunk({
      chunkId: chunk.id,
      text: "hello world",
      words: [
        { text: "hello", start: 0.0, end: 0.5, type: "word" },
        { text: "world", start: 0.5, end: 1.0, type: "word" },
      ],
      language: "eng",
      languageProbability: 0.99,
    });

    const updated = await getAnalysis({ fileId: fid });
    expect(updated.audioChunks).toHaveLength(1);
    expect(updated.audioChunks[0].status).toBe("ready");
    expect(updated.audioChunks[0].text).toBe("hello world");

    // Auto-aggregate: only one chunk, all ready ⇒ transcript step now ready.
    const transcriptStep = updated.steps.find((s) => s.kind === "transcript");
    expect(transcriptStep?.status).toBe("ready");
    expect(transcriptStep?.content).toContain("hello world");
    const meta = JSON.parse(transcriptStep!.metadata!);
    expect(meta.words).toHaveLength(2);
  });

  /**
   * `aggregateTranscript` defaults `provider` to `"external"` — right
   * for path B (the agent driving its own STT through
   * `libi.analysis_save_audio_chunk`, which cannot name a vendor), wrong for
   * the server-side Whisper path, which knows exactly what produced the words.
   * `transcribeAudio` used to correct it with a re-stamp AFTER the loop, so
   * the aggregate spent the gap claiming a local on-device transcription came
   * from somewhere external — and a run that never reached the re-stamp left
   * that claim on disk for good.
   */
  it("stamps the provider the caller names, from the first aggregate", async () => {
    const { saveAudioChunk } = await import("@/lib/analysis/manager");
    const db = getDb();
    const [step] = await db.insert(analysisSteps).values({
      fileId: fid, kind: "transcript", status: "not_started",
    }).returning();
    const [chunk] = await db.insert(analysisAudioChunks).values({
      fileId: fid, stepId: step.id, chunkIndex: 0,
      startSeconds: 0, endSeconds: 60, filePath: "audio-chunks/chunk-0001.wav",
    }).returning();

    await saveAudioChunk({
      chunkId: chunk.id,
      text: "hello world",
      words: [{ text: "hello", start: 0, end: 0.5, type: "word" }],
      provider: "whisper",
      model: "base",
    });

    const bundle = await getAnalysis({ fileId: fid });
    const meta = JSON.parse(bundle.steps.find((s) => s.kind === "transcript")!.metadata!);
    expect(meta.provider).toBe("whisper");
    expect(meta.model).toBe("base");
  });

  it("still says external when the caller cannot name one (path B)", async () => {
    const { saveAudioChunk } = await import("@/lib/analysis/manager");
    const db = getDb();
    const [step] = await db.insert(analysisSteps).values({
      fileId: fid, kind: "transcript", status: "not_started",
    }).returning();
    const [chunk] = await db.insert(analysisAudioChunks).values({
      fileId: fid, stepId: step.id, chunkIndex: 0,
      startSeconds: 0, endSeconds: 60, filePath: "audio-chunks/chunk-0001.wav",
    }).returning();

    await saveAudioChunk({
      chunkId: chunk.id,
      text: "hello world",
      words: [{ text: "hello", start: 0, end: 0.5, type: "word" }],
    });

    const bundle = await getAnalysis({ fileId: fid });
    const meta = JSON.parse(bundle.steps.find((s) => s.kind === "transcript")!.metadata!);
    expect(meta.provider).toBe("external");
  });

  it("aggregate stays not_started when chunks split between ready and not_started", async () => {
    const { saveAudioChunk } = await import("@/lib/analysis/manager");
    const db = getDb();
    const [step] = await db.insert(analysisSteps).values({
      fileId: fid, kind: "transcript", status: "not_started",
    }).returning();
    const [chunk0] = await db.insert(analysisAudioChunks).values({
      fileId: fid, stepId: step.id, chunkIndex: 0,
      startSeconds: 0, endSeconds: 60, filePath: "audio-chunks/chunk-0001.wav",
    }).returning();
    await db.insert(analysisAudioChunks).values({
      fileId: fid, stepId: step.id, chunkIndex: 1,
      startSeconds: 59, endSeconds: 120, filePath: "audio-chunks/chunk-0002.wav",
    });

    await saveAudioChunk({
      chunkId: chunk0.id,
      text: "first chunk",
      words: [
        { text: "first", start: 0, end: 1, type: "word" },
        { text: "chunk", start: 1, end: 2, type: "word" },
      ],
    });

    const result = await getAnalysis({ fileId: fid });
    const t = result.steps.find((s) => s.kind === "transcript");
    expect(t?.status).toBe("not_started");
  });

  it("any failed chunk pushes transcript step to failed with summary error", async () => {
    const { saveAudioChunk, markAudioChunkFailed } = await import("@/lib/analysis/manager");
    const db = getDb();
    const [step] = await db.insert(analysisSteps).values({
      fileId: fid, kind: "transcript", status: "not_started",
    }).returning();
    const [c0, c1] = await db.insert(analysisAudioChunks).values([
      { fileId: fid, stepId: step.id, chunkIndex: 0, startSeconds: 0, endSeconds: 60 },
      { fileId: fid, stepId: step.id, chunkIndex: 1, startSeconds: 59, endSeconds: 120 },
    ]).returning();

    await saveAudioChunk({ chunkId: c0.id, text: "ok", words: [{ text: "ok", start: 0, end: 1, type: "word" }] });
    await markAudioChunkFailed({
      chunkId: c1.id,
      // The shape lib/whisper/transcribe.ts actually rejects with.
      errorMessage: "whisper exited 1: RuntimeError: CUDA out of memory",
    });

    const result = await getAnalysis({ fileId: fid });
    const t = result.steps.find((s) => s.kind === "transcript");
    expect(t?.status).toBe("failed");
    expect(t?.errorMessage).toContain("1 of 2");
    expect(t?.errorMessage).toContain("whisper exited 1");
  });
});

describe("saveFrames upsert semantics", () => {
  let fid: string;
  beforeEach(async () => {
    createTestDb();
    const db = getDb();
    const [piece] = await db.insert(pieces).values({ name: "p", description: "" }).returning();
    const [file] = await db.insert(files).values({
      pieceId: piece.id, filename: "v.mp4", name: "v", description: "",
      type: "video", storagePath: "v.mp4",
    }).returning();
    fid = file.id;
  });
  afterEach(() => resetTestDb());

  it("preserves existing frames across batch saves", async () => {
    await saveFrames({
      fileId: fid,
      frames: [
        { frameIndex: 1, timestamp: 1, filePath: "frame-0001.png", description: '{"scene":"a"}' },
        { frameIndex: 2, timestamp: 2, filePath: "frame-0002.png", description: '{"scene":"b"}' },
      ],
    });
    await saveFrames({
      fileId: fid,
      frames: [
        { frameIndex: 3, timestamp: 3, filePath: "frame-0003.png", description: '{"scene":"c"}' },
      ],
    });
    const result = await getAnalysis({ fileId: fid });
    expect(result.keyframes).toHaveLength(3);
    expect(result.keyframes.map((k) => k.frameIndex).sort()).toEqual([1, 2, 3]);
  });

  it("upserts existing frame in place", async () => {
    await saveFrames({
      fileId: fid,
      frames: [{ frameIndex: 1, timestamp: 1, filePath: "frame-0001.png", description: '{"scene":"old"}' }],
    });
    await saveFrames({
      fileId: fid,
      frames: [{ frameIndex: 1, timestamp: 1, filePath: "frame-0001.png", description: '{"scene":"new"}' }],
    });
    const result = await getAnalysis({ fileId: fid });
    expect(result.keyframes).toHaveLength(1);
    expect(JSON.parse(result.keyframes[0].description!).scene).toBe("new");
  });
});

describe("chunkAudio", () => {
  let fid: string;
  beforeEach(async () => {
    createTestDb();
    const db = getDb();
    const [piece] = await db.insert(pieces).values({ name: "p", description: "" }).returning();
    const [file] = await db.insert(files).values({
      pieceId: piece.id, filename: "v.mp4", name: "v", description: "",
      type: "video", storagePath: "v.mp4", mediaDuration: 30,
    }).returning();
    fid = file.id;
  });
  afterEach(() => resetTestDb());

  it("creates one chunk row when duration <= chunkSeconds", async () => {
    const { chunkAudio } = await import("@/lib/analysis/manager");
    const result = await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].chunkIndex).toBe(0);
    expect(result.chunks[0].startSeconds).toBe(0);
    expect(result.chunks[0].endSeconds).toBe(30);

    const bundle = await getAnalysis({ fileId: fid });
    expect(bundle.audioChunks).toHaveLength(1);
    expect(bundle.audioChunks[0].status).toBe("not_started");
  });

  it("creates N chunks with overlap when duration > chunkSeconds", async () => {
    const db = getDb();
    await db.update(files).set({ mediaDuration: 200 }).where(eq(files.id, fid));
    const { chunkAudio } = await import("@/lib/analysis/manager");
    const result = await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });
    // Plan boundaries: [0,60], [59,120], [119,180], [179,200]
    expect(result.chunks).toHaveLength(4);
    expect(result.chunks[0].endSeconds).toBe(60);
    expect(result.chunks[1].startSeconds).toBe(59);
    expect(result.chunks[3].endSeconds).toBe(200);
  });

  it("is idempotent — re-calling returns existing chunks", async () => {
    const { chunkAudio } = await import("@/lib/analysis/manager");
    await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });
    const second = await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });
    expect(second.chunks).toHaveLength(1);
    const bundle = await getAnalysis({ fileId: fid });
    expect(bundle.audioChunks).toHaveLength(1);
  });
});

describe("transcribeAudio (with mock STT)", () => {
  let fid: string;
  beforeEach(async () => {
    createTestDb();
    const db = getDb();
    const [piece] = await db.insert(pieces).values({ name: "p", description: "" }).returning();
    const [file] = await db.insert(files).values({
      pieceId: piece.id, filename: "v.mp4", name: "v", description: "",
      type: "video", storagePath: "v.mp4", mediaDuration: 30,
    }).returning();
    fid = file.id;
  });
  afterEach(() => resetTestDb());

  it("aggregates transcript when all chunks succeed", async () => {
    const { transcribeAudio, chunkAudio } = await import("@/lib/analysis/manager");
    await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });

    const sttFn = async (_audioPath: string) => ({
      text: "hello world",
      words: [
        { text: "hello", start: 0, end: 0.5, type: "word" },
        { text: "world", start: 0.5, end: 1.0, type: "word" },
      ],
      language_code: "eng",
      language_probability: 0.99,
    });

    const result = await transcribeAudio({ fileId: fid, sttFn });
    expect(result.status).toBe("ready");
    expect(result.readyChunks).toBe(1);
    expect(result.wordCount).toBe(2);
    expect(result.language).toBe("eng");

    const bundle = await getAnalysis({ fileId: fid });
    const t = bundle.steps.find((s) => s.kind === "transcript");
    expect(t?.status).toBe("ready");
    expect(t?.content).toContain("hello world");
    // …and the provenance is whisper's own, not the "external" default — now
    // written by the chunk save itself rather than by the trailing re-stamp.
    const meta = JSON.parse(t!.metadata!);
    expect(meta.provider).toBe("whisper");
    expect(typeof meta.model).toBe("string");
    expect(meta.model.length).toBeGreaterThan(0);
  });

  it("returns partial when one chunk fails", async () => {
    const db = getDb();
    await db.update(files).set({ mediaDuration: 200 }).where(eq(files.id, fid));
    const { transcribeAudio, chunkAudio } = await import("@/lib/analysis/manager");
    await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });

    let callCount = 0;
    const sttFn = async (_audioPath: string) => {
      callCount++;
      if (callCount === 2) throw new Error("HTTP 500");
      return {
        text: `chunk ${callCount}`,
        words: [{ text: `chunk${callCount}`, start: 0, end: 1, type: "word" }],
        language_code: "eng",
      };
    };

    const result = await transcribeAudio({ fileId: fid, chunkSeconds: 60, sttFn });
    expect(result.status).toBe("partial");
    expect(result.failedChunks).toHaveLength(1);
    expect(result.failedChunks[0].error).toContain("HTTP 500");
  });

  it("returns failed (NOT ready) when every chunk failed", async () => {
    // First pass: every chunk throws → all rows persisted as status=failed.
    const db = getDb();
    await db.update(files).set({ mediaDuration: 120 }).where(eq(files.id, fid));
    const { transcribeAudio, chunkAudio } = await import("@/lib/analysis/manager");
    await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });
    const result = await transcribeAudio({
      fileId: fid,
      chunkSeconds: 60,
      sttFn: async () => {
        // lib/whisper/transcribe.ts#runUv's non-zero-exit rejection, verbatim
        // in shape — the only STT failure the server side can now produce.
        throw new Error("whisper exited 1: Could not load model small");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.readyChunks).toBe(0);
    expect(result.totalChunks).toBe(2);
    expect(result.failedChunks).toHaveLength(2);
    expect(result.failedChunks[0].error).toMatch(/whisper exited 1/);
  });

  it("re-calling on all-failed chunks (no retry) reports failed, not ready", async () => {
    // Regression for QA-FIX-4: previously, when toProcess was empty (because
    // all rows had status=failed from a prior call), the local
    // `failedChunks` array stayed empty and the status fell through to
    // "ready" — a literal lie about a fully-failed transcript. The agent
    // caught this during the ElevenLabs comparison test mid-QA.
    const db = getDb();
    await db.update(files).set({ mediaDuration: 60 }).where(eq(files.id, fid));
    const { transcribeAudio, chunkAudio } = await import("@/lib/analysis/manager");
    await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });
    // Force every chunk to fail on the first call.
    await transcribeAudio({
      fileId: fid,
      chunkSeconds: 60,
      sttFn: async () => {
        throw new Error("upstream down");
      },
    });
    // Re-call without retry — should still surface the failure honestly.
    const result = await transcribeAudio({
      fileId: fid,
      chunkSeconds: 60,
      sttFn: async () => {
        // Never invoked because toProcess is empty (no not_started rows).
        return { text: "should not appear", words: [] };
      },
    });
    expect(result.status).toBe("failed");
    expect(result.readyChunks).toBe(0);
    expect(result.failedChunks.length).toBeGreaterThan(0);
    expect(result.failedChunks[0].error).toMatch(/upstream down/);
  });

  it("re-calling on already-ready chunks returns ready, not partial", async () => {
    // The inverse fairness check: a fully-succeeded transcript that gets
    // re-queried (no retry) should stay "ready".
    const db = getDb();
    await db.update(files).set({ mediaDuration: 60 }).where(eq(files.id, fid));
    const { transcribeAudio, chunkAudio } = await import("@/lib/analysis/manager");
    await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });
    await transcribeAudio({
      fileId: fid,
      chunkSeconds: 60,
      sttFn: async () => ({
        text: "hi",
        words: [{ text: "hi", start: 0, end: 1, type: "word" }],
      }),
    });
    const result = await transcribeAudio({
      fileId: fid,
      chunkSeconds: 60,
      sttFn: async () => ({ text: "ignored", words: [] }),
    });
    expect(result.status).toBe("ready");
    expect(result.readyChunks).toBe(result.totalChunks);
    expect(result.failedChunks).toHaveLength(0);
  });

  it("retry: true only re-processes failed chunks", async () => {
    const db = getDb();
    await db.update(files).set({ mediaDuration: 200 }).where(eq(files.id, fid));
    const { transcribeAudio, chunkAudio } = await import("@/lib/analysis/manager");
    await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });

    let firstPassCalls = 0;
    await transcribeAudio({
      fileId: fid,
      chunkSeconds: 60,
      sttFn: async () => {
        firstPassCalls++;
        if (firstPassCalls === 2) throw new Error("first fail");
        return { text: `c${firstPassCalls}`, words: [{ text: `c${firstPassCalls}`, start: 0, end: 1, type: "word" }] };
      },
    });

    let retryCalls = 0;
    const result = await transcribeAudio({
      fileId: fid,
      chunkSeconds: 60,
      retry: true,
      sttFn: async () => {
        retryCalls++;
        return { text: "retry-success", words: [{ text: "retry", start: 0, end: 1, type: "word" }] };
      },
    });

    expect(retryCalls).toBe(1);
    expect(result.status).toBe("ready");
  });

  it("re-call on ready chunks does NOT redo work (no spurious re-runs)", async () => {
    const { transcribeAudio, chunkAudio } = await import("@/lib/analysis/manager");
    await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });
    let calls = 0;
    const sttFn = async () => {
      calls++;
      return {
        text: "ok",
        words: [{ text: "ok", start: 0, end: 1, type: "word" }],
        language_code: "eng",
      };
    };
    await transcribeAudio({ fileId: fid, sttFn });
    expect(calls).toBe(1);
    // Second call should be a no-op — every chunk is already ready.
    await transcribeAudio({ fileId: fid, sttFn });
    expect(calls).toBe(1);
  });
});

describe("saveAudioChunkFromFile", () => {
  let fid: string;
  let chunkId: string;
  beforeEach(async () => {
    createTestDb();
    const db = getDb();
    const [piece] = await db.insert(pieces).values({ name: "p", description: "" }).returning();
    const [file] = await db.insert(files).values({
      pieceId: piece.id, filename: "v.mp4", name: "v", description: "",
      type: "video", storagePath: "v.mp4", mediaDuration: 30,
    }).returning();
    fid = file.id;
    const [step] = await db.insert(analysisSteps).values({ fileId: fid, kind: "transcript", status: "not_started" }).returning();
    const [chunk] = await db.insert(analysisAudioChunks).values({
      fileId: fid, stepId: step.id, chunkIndex: 0, startSeconds: 0, endSeconds: 30,
    }).returning();
    chunkId = chunk.id;
  });
  afterEach(() => resetTestDb());

  it("reads JSON from disk and saves the chunk", async () => {
    const tmp = `/tmp/chunk-test-${Date.now()}.json`;
    fs.writeFileSync(tmp, JSON.stringify({
      text: "hello from file",
      words: [{ text: "hello", start: 0, end: 1, type: "word" }],
      language_code: "eng",
    }));
    try {
      const { saveAudioChunkFromFile } = await import("@/lib/analysis/manager");
      await saveAudioChunkFromFile({ chunkId, jsonPath: tmp });
      const bundle = await getAnalysis({ fileId: fid });
      expect(bundle.audioChunks[0].status).toBe("ready");
      expect(bundle.audioChunks[0].text).toBe("hello from file");
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("rejects malformed JSON cleanly", async () => {
    const tmp = `/tmp/chunk-test-bad-${Date.now()}.json`;
    fs.writeFileSync(tmp, "not json");
    try {
      const { saveAudioChunkFromFile } = await import("@/lib/analysis/manager");
      await expect(saveAudioChunkFromFile({ chunkId, jsonPath: tmp })).rejects.toThrow();
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// The transcription failures this file pinned were an injected
// `ELEVENLABS_API_KEY missing` — a string no code in the tree can produce
// since the ElevenLabs STT client was deleted. The injected ones now carry
// Whisper's real rejection shape, and the block below covers the only
// transcription failure `transcribeAudio` raises by itself: the local model
// is not installed.
// ---------------------------------------------------------------------------
describe("transcribeAudio — the local Whisper install gate", () => {
  let fid: string;
  beforeEach(async () => {
    createTestDb();
    const db = getDb();
    const [piece] = await db.insert(pieces).values({ name: "p", description: "" }).returning();
    const [file] = await db.insert(files).values({
      pieceId: piece.id, filename: "v.mp4", name: "v", description: "",
      type: "video", storagePath: "v.mp4", mediaDuration: 30,
    }).returning();
    fid = file.id;
    isWhisperModelInstalled.mockClear();
    isWhisperModelInstalled.mockReturnValue(true);
  });
  afterEach(() => {
    isWhisperModelInstalled.mockReturnValue(true);
    resetTestDb();
  });

  it("answers needs_install — not a throw, and never 'ready' — when the model is absent", async () => {
    isWhisperModelInstalled.mockReturnValue(false);
    const { transcribeAudio } = await import("@/lib/analysis/manager");

    const result = await transcribeAudio({ fileId: fid });

    expect(result.status).toBe("needs_install");
    expect(result.provider).toBe("whisper");
    // The hint is the agent's whole next move; a hint that names no tool
    // leaves it guessing, which is how this path used to dead-end.
    expect(result.hint).toContain('libi.get_install_plan({ mcpId: "whisper" })');
    expect(result.hint).toContain("libi.whisper_download_model");
    // Nothing was chunked or extracted — the gate returns before any work.
    expect(result.totalChunks).toBe(0);
    expect(result.readyChunks).toBe(0);
    expect(result.failedChunks).toEqual([]);
    const bundle = await getAnalysis({ fileId: fid });
    expect(bundle.audioChunks).toEqual([]);
  });

  it("names the model it looked for, so a wrong `model` argument is diagnosable", async () => {
    isWhisperModelInstalled.mockReturnValue(false);
    const { transcribeAudio } = await import("@/lib/analysis/manager");
    const result = await transcribeAudio({ fileId: fid, model: "large-v3" });
    expect(isWhisperModelInstalled).toHaveBeenCalledWith("large-v3");
    expect(result.hint).toContain('"large-v3"');
  });

  it("skips the gate entirely when an sttFn is injected (the seam every other test uses)", async () => {
    isWhisperModelInstalled.mockReturnValue(false);
    const { transcribeAudio, chunkAudio } = await import("@/lib/analysis/manager");
    await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });
    const result = await transcribeAudio({
      fileId: fid,
      sttFn: async () => ({ text: "hi", words: [{ text: "hi", start: 0, end: 1, type: "word" }] }),
    });
    expect(result.status).toBe("ready");
    expect(isWhisperModelInstalled).not.toHaveBeenCalled();
  });
});
