import fs from "fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    await markAudioChunkFailed({ chunkId: c1.id, errorMessage: "ElevenLabs HTTP 500" });

    const result = await getAnalysis({ fileId: fid });
    const t = result.steps.find((s) => s.kind === "transcript");
    expect(t?.status).toBe("failed");
    expect(t?.errorMessage).toContain("1 of 2");
    expect(t?.errorMessage).toContain("HTTP 500");
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
        throw new Error("ELEVENLABS_API_KEY missing");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.readyChunks).toBe(0);
    expect(result.totalChunks).toBe(2);
    expect(result.failedChunks).toHaveLength(2);
    expect(result.failedChunks[0].error).toMatch(/ELEVENLABS_API_KEY/);
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
    // re-queried (no provider switch, no retry) should stay "ready".
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

  it("provider switch forces re-transcription of ready chunks (not silent relabel)", async () => {
    // First pass: explicit provider="whisper". sttFn injects a fake whisper result.
    const { transcribeAudio: t1, chunkAudio } = await import("@/lib/analysis/manager");
    await chunkAudio({ fileId: fid, chunkSeconds: 60, skipExtraction: true });
    let whisperCalls = 0;
    const whisperFn = async () => {
      whisperCalls++;
      return {
        text: "whisper output",
        words: [{ text: "whisper", start: 0, end: 1, type: "word" }],
        language_code: "eng",
      };
    };
    const r1 = await t1({ fileId: fid, provider: "whisper", sttFn: whisperFn });
    expect(r1.status).toBe("ready");
    expect(r1.provider).toBe("whisper");
    expect(whisperCalls).toBe(1);

    // Sanity: the step's metadata should carry provider="whisper" so the
    // second call can see the mismatch and switch.
    const after1 = await getAnalysis({ fileId: fid });
    const step1 = after1.steps.find((s) => s.kind === "transcript");
    expect(step1?.metadata).toBeTruthy();
    const meta1 = JSON.parse(step1!.metadata as unknown as string);
    expect(meta1.provider).toBe("whisper");

    // Second pass: explicit provider="elevenlabs". The ready chunks were
    // produced by whisper; the new call MUST re-run the sttFn (now mimicking
    // elevenlabs), not silently relabel.
    const { transcribeAudio: t2 } = await import("@/lib/analysis/manager");
    let elevenCalls = 0;
    const elevenFn = async () => {
      elevenCalls++;
      return {
        text: "elevenlabs output",
        words: [{ text: "elevenlabs", start: 0, end: 1, type: "word" }],
        language_code: "eng",
      };
    };
    const r2 = await t2({ fileId: fid, provider: "elevenlabs", sttFn: elevenFn });
    expect(r2.status).toBe("ready");
    expect(r2.provider).toBe("elevenlabs");
    // Critical: the new provider's sttFn was actually invoked, NOT skipped.
    expect(elevenCalls).toBe(1);

    // The aggregated transcript now reflects elevenlabs's output, not whisper's.
    const bundle = await getAnalysis({ fileId: fid });
    const t = bundle.steps.find((s) => s.kind === "transcript");
    expect(t?.content).toContain("elevenlabs output");
    expect(t?.content).not.toContain("whisper output");
  });

  it("same provider on re-call does NOT redo work (no spurious re-runs)", async () => {
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
    await transcribeAudio({ fileId: fid, provider: "whisper", sttFn });
    expect(calls).toBe(1);
    // Second call with same provider should be a no-op.
    await transcribeAudio({ fileId: fid, provider: "whisper", sttFn });
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
