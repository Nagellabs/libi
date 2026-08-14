import fs from "fs";
import path from "path";
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files, analysisSteps, analysisKeyframes, analysisAudioChunks } from "@/lib/db/schema";
import { serverLogger as logger } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { ensureAnalysisDirs, getAudioPath, getFramesDir, getAnalysisDir } from "./storage";
import { videoSummarySchema, scriptSchema } from "./schemas";
import type { VideoSummary, Script, TranscriptWord } from "./schemas";
import { buildScriptKind, buildCaptionSpecKind } from "./scripts";
import type {
  AnalysisStep,
  AnalysisStepKind,
  AnalysisStepStatus,
  AnalysisKeyframe,
  AnalysisAudioChunk,
  AnalysisBundle,
} from "./types";
import type { Anchor } from "@/lib/tracking/types";
import { getCurrentPort } from "@/lib/libi-home";
import {
  isWhisperModelInstalled,
  resolveWhisperModel,
} from "@/lib/whisper/models";

export function resolveSttProvider(
  provider?: string,
): "whisper" | "elevenlabs" {
  return provider === "elevenlabs" ? "elevenlabs" : "whisper";
}

const log = logger.child({ tag: "analysis" });

// ──────────────────────────────────────────────────────────────────────────────
// Row → domain mappers
// ──────────────────────────────────────────────────────────────────────────────

export function rowToStep(row: typeof analysisSteps.$inferSelect): AnalysisStep {
  return {
    id: row.id,
    fileId: row.fileId,
    pieceId: row.pieceId,
    kind: row.kind as AnalysisStepKind,
    status: row.status as AnalysisStepStatus,
    content: row.content,
    metadata: row.metadata,
    errorMessage: row.errorMessage,
    sourceModifiedAt: row.sourceModifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToKeyframe(row: typeof analysisKeyframes.$inferSelect): AnalysisKeyframe {
  return {
    id: row.id,
    fileId: row.fileId,
    stepId: row.stepId,
    filePath: row.filePath,
    frameIndex: row.frameIndex,
    timestamp: row.timestamp,
    description: row.description,
    skipped: row.skipped,
    skipReason: row.skipReason,
    custom: row.custom,
    sourceModifiedAt: row.sourceModifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToAudioChunk(row: typeof analysisAudioChunks.$inferSelect): AnalysisAudioChunk {
  return {
    id: row.id,
    fileId: row.fileId,
    stepId: row.stepId,
    chunkIndex: row.chunkIndex,
    startSeconds: row.startSeconds,
    endSeconds: row.endSeconds,
    filePath: row.filePath,
    status: row.status as AnalysisStepStatus,
    text: row.text,
    words: row.words,
    language: row.language,
    languageProbability: row.languageProbability,
    errorMessage: row.errorMessage,
    sourceModifiedAt: row.sourceModifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────────────────────────────────────

export async function getAnalysis(params: { fileId: string }): Promise<AnalysisBundle> {
  const db = getDb();
  const stepRows = db
    .select()
    .from(analysisSteps)
    .where(eq(analysisSteps.fileId, params.fileId))
    .all();
  const keyframeRows = db
    .select()
    .from(analysisKeyframes)
    .where(eq(analysisKeyframes.fileId, params.fileId))
    .orderBy(asc(analysisKeyframes.frameIndex))
    .all();
  const audioChunkRows = db
    .select()
    .from(analysisAudioChunks)
    .where(eq(analysisAudioChunks.fileId, params.fileId))
    .orderBy(asc(analysisAudioChunks.chunkIndex))
    .all();

  // Staleness: compare each keyframe's sourceModifiedAt to the current file mtime.
  const [file] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
  let currentMtime: Date | null = null;
  if (file) {
    try {
      const storage = await getStorage();
      const fullPath = storage.localPath(file.pieceId, file.filename);
      const stat = fs.statSync(fullPath);
      currentMtime = stat.mtime;
    } catch {
      currentMtime = null;
    }
  }

  const staleKeyframeIds: string[] = [];
  if (currentMtime) {
    for (const kf of keyframeRows) {
      if (kf.sourceModifiedAt && kf.sourceModifiedAt.getTime() < currentMtime.getTime()) {
        staleKeyframeIds.push(kf.id);
      }
    }
  }

  return {
    steps: stepRows.map(rowToStep),
    keyframes: keyframeRows.map(rowToKeyframe),
    audioChunks: audioChunkRows.map(rowToAudioChunk),
    staleKeyframeIds,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function getPieceIdForFile(fileId: string): Promise<string | null> {
  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!file) throw new Error(`file ${fileId} not found`);
  return file.pieceId;
}

async function captureSourceModifiedAt(pieceId: string | null, filename: string): Promise<Date | null> {
  try {
    const storage = await getStorage();
    const fullPath = storage.localPath(pieceId, filename);
    return fs.statSync(fullPath).mtime;
  } catch {
    return null;
  }
}

async function upsertStep(params: {
  fileId: string;
  kind: AnalysisStepKind;
  status: AnalysisStepStatus;
  content?: string | null;
  metadata?: string | null;
  errorMessage?: string | null;
}): Promise<AnalysisStep> {
  const db = getDb();
  const pieceId = await getPieceIdForFile(params.fileId);

  const [file] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
  const sourceModifiedAt = file ? await captureSourceModifiedAt(file.pieceId, file.filename) : null;

  const [existing] = db
    .select()
    .from(analysisSteps)
    .where(and(eq(analysisSteps.fileId, params.fileId), eq(analysisSteps.kind, params.kind)))
    .limit(1)
    .all();

  if (existing) {
    const [updated] = await db
      .update(analysisSteps)
      .set({
        status: params.status,
        content: params.content ?? null,
        metadata: params.metadata ?? null,
        errorMessage: params.errorMessage ?? null,
        sourceModifiedAt,
        updatedAt: new Date(),
      })
      .where(eq(analysisSteps.id, existing.id))
      .returning();
    log.info({ fileId: params.fileId, kind: params.kind, status: params.status }, "analysis.step.upsert");
    return rowToStep(updated);
  }

  const [inserted] = await db
    .insert(analysisSteps)
    .values({
      fileId: params.fileId,
      pieceId,
      kind: params.kind,
      status: params.status,
      content: params.content ?? null,
      metadata: params.metadata ?? null,
      errorMessage: params.errorMessage ?? null,
      sourceModifiedAt,
    })
    .returning();
  log.info({ fileId: params.fileId, kind: params.kind, status: params.status }, "analysis.step.insert");
  return rowToStep(inserted);
}

// ──────────────────────────────────────────────────────────────────────────────
// Save tools
// ──────────────────────────────────────────────────────────────────────────────

export async function saveTranscript(params: {
  fileId: string;
  content: string;
  metadata?: string | Record<string, unknown> | null;
}): Promise<AnalysisStep> {
  const metadataStr = typeof params.metadata === "string"
    ? params.metadata
    : params.metadata != null
      ? JSON.stringify(params.metadata)
      : null;
  return upsertStep({
    fileId: params.fileId,
    kind: "transcript",
    status: "ready",
    content: params.content,
    metadata: metadataStr,
  });
}

export async function saveSummary(params: {
  fileId: string;
  summary: VideoSummary | string;
}): Promise<AnalysisStep> {
  const validated = typeof params.summary === "string"
    ? videoSummarySchema.parse(JSON.parse(params.summary))
    : videoSummarySchema.parse(params.summary);
  return upsertStep({
    fileId: params.fileId,
    kind: "summary",
    status: "ready",
    content: JSON.stringify(validated),
  });
}

export async function saveScript(params: {
  fileId: string;
  providerId: string;
  modelId: string;
  script: Script;
}): Promise<AnalysisStep> {
  const validated = scriptSchema.parse(params.script);
  const kind = buildScriptKind(params.providerId, params.modelId);
  return upsertStep({
    fileId: params.fileId,
    kind,
    status: "ready",
    content: JSON.stringify(validated),
    metadata: JSON.stringify({
      providerId: params.providerId,
      modelId: params.modelId,
      generatedAt: validated.provider.generatedAt,
    }),
  });
}

export async function saveCaptionSpec(params: {
  fileId: string;
  providerId: string;
  modelId: string;
  text: string;
}): Promise<AnalysisStep> {
  const kind = buildCaptionSpecKind(params.providerId, params.modelId);
  return upsertStep({
    fileId: params.fileId,
    kind,
    status: "ready",
    content: params.text,
    metadata: JSON.stringify({
      providerId: params.providerId,
      modelId: params.modelId,
      focus: "captions",
      generatedAt: new Date().toISOString(),
    }),
  });
}

export interface SaveFrameInput {
  frameIndex: number;
  timestamp: number;
  filePath: string;
  description?: string | Record<string, unknown> | null;
  skipped?: boolean;
  skipReason?: string | null;
  custom?: Record<string, unknown> | null;
}

export async function saveFrames(params: {
  fileId: string;
  frames: SaveFrameInput[];
}): Promise<{ step: AnalysisStep; keyframes: AnalysisKeyframe[] }> {
  const db = getDb();
  const step = await upsertStep({
    fileId: params.fileId,
    kind: "frames",
    status: "ready",
  });

  const [file] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
  const sourceModifiedAt = file ? await captureSourceModifiedAt(file.pieceId, file.filename) : null;

  if (params.frames.length === 0) {
    const existing = db.select().from(analysisKeyframes).where(eq(analysisKeyframes.fileId, params.fileId)).all();
    return { step, keyframes: existing.map(rowToKeyframe) };
  }

  // Upsert each frame by (file_id, frame_index).
  for (const f of params.frames) {
    const [existingRow] = db
      .select()
      .from(analysisKeyframes)
      .where(and(eq(analysisKeyframes.fileId, params.fileId), eq(analysisKeyframes.frameIndex, f.frameIndex)))
      .limit(1)
      .all();

    const description = f.description == null
      ? null
      : typeof f.description === "string"
        ? f.description
        : JSON.stringify(f.description);
    const customStr = f.custom == null ? null : JSON.stringify(f.custom);

    if (existingRow) {
      await db
        .update(analysisKeyframes)
        .set({
          stepId: step.id,
          filePath: f.filePath,
          timestamp: f.timestamp,
          description,
          skipped: f.skipped ?? false,
          skipReason: f.skipReason ?? null,
          custom: customStr,
          sourceModifiedAt,
          updatedAt: new Date(),
        })
        .where(eq(analysisKeyframes.id, existingRow.id));
    } else {
      await db.insert(analysisKeyframes).values({
        fileId: params.fileId,
        stepId: step.id,
        filePath: f.filePath,
        frameIndex: f.frameIndex,
        timestamp: f.timestamp,
        description,
        skipped: f.skipped ?? false,
        skipReason: f.skipReason ?? null,
        custom: customStr,
        sourceModifiedAt,
      });
    }
  }

  const all = db
    .select()
    .from(analysisKeyframes)
    .where(eq(analysisKeyframes.fileId, params.fileId))
    .orderBy(asc(analysisKeyframes.frameIndex))
    .all();

  log.info({ fileId: params.fileId, frameCount: all.length, batchSize: params.frames.length }, "analysis.frames.upsert");
  return { step, keyframes: all.map(rowToKeyframe) };
}

export async function markStepFailed(params: {
  fileId: string;
  kind: AnalysisStepKind;
  errorMessage: string;
}): Promise<AnalysisStep> {
  return upsertStep({
    fileId: params.fileId,
    kind: params.kind,
    status: "failed",
    errorMessage: params.errorMessage,
  });
}

export async function removeStep(params: {
  fileId: string;
  kind: AnalysisStepKind;
}): Promise<{ removed: boolean }> {
  const db = getDb();
  const result = await db
    .delete(analysisSteps)
    .where(and(eq(analysisSteps.fileId, params.fileId), eq(analysisSteps.kind, params.kind)))
    .returning();
  log.info({ fileId: params.fileId, kind: params.kind, removed: result.length }, "analysis.step.remove");
  return { removed: result.length > 0 };
}

// ──────────────────────────────────────────────────────────────────────────────
// Audio chunks
// ──────────────────────────────────────────────────────────────────────────────

export interface SaveAudioChunkInput {
  chunkId: string;
  text: string;
  words: Array<{ text: string; start: number; end: number; type?: string; speaker_id?: string | null }>;
  language?: string;
  languageProbability?: number;
}

export async function saveAudioChunk(input: SaveAudioChunkInput): Promise<AnalysisAudioChunk> {
  const db = getDb();
  const [chunk] = db.select().from(analysisAudioChunks).where(eq(analysisAudioChunks.id, input.chunkId)).limit(1).all();
  if (!chunk) throw new Error(`saveAudioChunk: chunk ${input.chunkId} not found`);

  const [updated] = await db
    .update(analysisAudioChunks)
    .set({
      status: "ready",
      text: input.text,
      words: JSON.stringify(input.words),
      language: input.language ?? null,
      languageProbability: input.languageProbability ?? null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(analysisAudioChunks.id, input.chunkId))
    .returning();

  log.info({ chunkId: input.chunkId, fileId: chunk.fileId, words: input.words.length }, "analysis.audio_chunk.save");

  await aggregateTranscript(chunk.fileId);

  return rowToAudioChunk(updated);
}

export async function markAudioChunkFailed(input: {
  chunkId: string;
  errorMessage: string;
}): Promise<AnalysisAudioChunk> {
  const db = getDb();
  const [chunk] = db.select().from(analysisAudioChunks).where(eq(analysisAudioChunks.id, input.chunkId)).limit(1).all();
  if (!chunk) throw new Error(`markAudioChunkFailed: chunk ${input.chunkId} not found`);

  const [updated] = await db
    .update(analysisAudioChunks)
    .set({
      status: "failed",
      errorMessage: input.errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(analysisAudioChunks.id, input.chunkId))
    .returning();

  log.info({ chunkId: input.chunkId, fileId: chunk.fileId, error: input.errorMessage }, "analysis.audio_chunk.failed");

  await aggregateTranscript(chunk.fileId);

  return rowToAudioChunk(updated);
}

/**
 * Re-evaluate the transcript step row based on current chunk states.
 * - All chunks `ready` → assemble aggregate, transcript step `ready`.
 * - Any chunk `failed`  → transcript step `failed` with summary message.
 * - Otherwise            → transcript step `not_started`.
 */
export async function aggregateTranscript(
  fileId: string,
  opts?: { provider?: string; model?: string | null },
): Promise<void> {
  const db = getDb();
  const chunks = db
    .select()
    .from(analysisAudioChunks)
    .where(eq(analysisAudioChunks.fileId, fileId))
    .orderBy(asc(analysisAudioChunks.chunkIndex))
    .all();

  if (chunks.length === 0) return;

  const failed = chunks.filter((c) => c.status === "failed");
  const notStarted = chunks.filter((c) => c.status === "not_started");
  const ready = chunks.filter((c) => c.status === "ready");

  if (failed.length > 0) {
    const summary = failed
      .slice(0, 5)
      .map((c) => `chunk ${c.chunkIndex}: ${(c.errorMessage ?? "unknown").slice(0, 100)}`)
      .join("; ");
    await upsertStep({
      fileId,
      kind: "transcript",
      status: "failed",
      errorMessage: `${failed.length} of ${chunks.length} audio chunks failed (${summary}). Call libi.analysis_transcribe_audio({ fileId, retry: true }) for the ElevenLabs path, or libi.analysis_get_audio_chunks for details.`,
    });
    return;
  }

  if (notStarted.length > 0) {
    await upsertStep({ fileId, kind: "transcript", status: "not_started" });
    return;
  }

  // All ready. Merge.
  const mergedWords: unknown[] = [];
  const textParts: string[] = [];
  let language: string | null = null;
  let languageProbability: number | null = null;
  for (const c of ready) {
    if (c.text) textParts.push(c.text);
    if (c.words) {
      try {
        const parsed = JSON.parse(c.words) as unknown[];
        mergedWords.push(...parsed);
      } catch {
        // skip malformed
      }
    }
    if (!language && c.language) language = c.language;
    if (languageProbability == null && c.languageProbability != null) languageProbability = c.languageProbability;
  }

  const metadata = {
    schema_version: "transcript_v1",
    provider: opts?.provider ?? "elevenlabs",
    model: opts?.model ?? undefined,
    language,
    languageProbability,
    words: mergedWords,
  };

  await upsertStep({
    fileId,
    kind: "transcript",
    status: "ready",
    content: textParts.join(" ").replace(/\s+/g, " ").trim(),
    metadata: JSON.stringify(metadata),
  });

  log.info({ fileId, chunks: chunks.length, words: mergedWords.length }, "analysis.transcript.aggregated");
}

export async function updateSummaryCustom(params: {
  fileId: string;
  path: string;
  value: unknown;
}): Promise<AnalysisStep> {
  const db = getDb();
  const [existing] = db
    .select()
    .from(analysisSteps)
    .where(and(eq(analysisSteps.fileId, params.fileId), eq(analysisSteps.kind, "summary")))
    .limit(1)
    .all();
  if (!existing || !existing.content) {
    throw new Error("updateSummaryCustom: summary step missing or empty");
  }
  const summary = JSON.parse(existing.content) as VideoSummary;
  summary.custom = { ...(summary.custom ?? {}), [params.path]: params.value };
  return upsertStep({
    fileId: params.fileId,
    kind: "summary",
    status: "ready",
    content: JSON.stringify(summary),
    metadata: existing.metadata,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Material extraction (no DB writes — material to disk only)
// ──────────────────────────────────────────────────────────────────────────────

export async function extractAudio(params: {
  fileId: string;
  sampleRate?: number;
}): Promise<{ audioPath: string }> {
  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
  if (!file) throw new Error(`extractAudio: file ${params.fileId} not found`);

  const storage = await getStorage();
  const inputPath = storage.localPath(file.pieceId, file.filename);
  ensureAnalysisDirs(file.pieceId, params.fileId);
  const audioPath = getAudioPath(file.pieceId, params.fileId);
  const sr = params.sampleRate ?? 16000;

  await runFfmpeg(
    ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", String(sr), "-f", "wav", audioPath],
    { op: "analysis_extract_audio", context: { fileId: params.fileId, pieceId: file.pieceId } },
  );
  return { audioPath };
}

export interface ExtractedFrame {
  frameIndex: number;
  timestamp: number;
  /** Relative to frames dir, e.g. "frame-0001.png". */
  filePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
}

export async function extractFrames(params: {
  fileId: string;
  count?: number;
  timestamps?: number[];
  width?: number;
}): Promise<{ frames: ExtractedFrame[] }> {
  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
  if (!file) throw new Error(`extractFrames: file ${params.fileId} not found`);
  const duration = file.mediaDuration;
  if (!duration) throw new Error(`extractFrames: file ${params.fileId} has no mediaDuration`);

  const timestamps: number[] = params.timestamps ?? (() => {
    const n = params.count ?? 8;
    const step = duration / (n + 1);
    return Array.from({ length: n }, (_, i) => step * (i + 1));
  })();

  const storage = await getStorage();
  const inputPath = storage.localPath(file.pieceId, file.filename);
  ensureAnalysisDirs(file.pieceId, params.fileId);
  const framesDir = getFramesDir(file.pieceId, params.fileId);
  const width = params.width ?? 640;

  const out: ExtractedFrame[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const filePath = `frame-${String(i + 1).padStart(4, "0")}.png`;
    const absolutePath = `${framesDir}/${filePath}`;
    await runFfmpeg(
      ["-y", "-ss", String(t), "-i", inputPath, "-frames:v", "1", "-vf", `scale=${width}:-1`, absolutePath],
      { op: "analysis_extract_frames", context: { fileId: params.fileId, pieceId: file.pieceId, frameIndex: i + 1, timestamp: t } },
    );
    out.push({ frameIndex: i + 1, timestamp: t, filePath, absolutePath });
  }
  return { frames: out };
}

// ──────────────────────────────────────────────────────────────────────────────
// Search (kept; signatures changed to fileId)
// ──────────────────────────────────────────────────────────────────────────────

export interface SearchFramesParams {
  fileId: string;
  subject?: string;
  objects?: string[];
  text_contains?: string;
  tags?: string[];
  time_range?: [number, number];
  shot?: "close-up" | "medium" | "wide" | "extreme-wide";
}

export interface SearchFramesMatch {
  keyframeId: string;
  frameIndex: number;
  timestamp: number;
}

/** The slice of a STORED frame description the search/anchor paths read.
 *  Stored rows are unvalidated JSON (older writes predate the current
 *  frameDescriptionSchema), so this deliberately types only the fields we
 *  touch, all optional. */
interface StoredFrameDescription {
  people?: Array<{ id?: string; name?: unknown; bbox?: unknown }>;
  objects?: Array<{ name?: unknown; bbox?: unknown }>;
  tags?: string[];
  shot?: string;
  text_on_screen?: string[];
}

export async function searchFrames(params: SearchFramesParams): Promise<SearchFramesMatch[]> {
  const db = getDb();
  const rows = db
    .select()
    .from(analysisKeyframes)
    .where(eq(analysisKeyframes.fileId, params.fileId))
    .all();
  const matches: SearchFramesMatch[] = [];
  for (const row of rows) {
    if (!row.description) continue;
    let desc: StoredFrameDescription;
    try {
      desc = JSON.parse(row.description) as StoredFrameDescription;
    } catch {
      continue;
    }
    if (params.subject && !desc.people?.some((p) => p.id === params.subject)) continue;
    if (params.objects && !params.objects.every((o) => desc.objects?.some((d) => d.name === o))) continue;
    if (params.tags && !params.tags.every((t) => desc.tags?.includes(t))) continue;
    if (params.shot && desc.shot !== params.shot) continue;
    if (params.text_contains) {
      const needle = params.text_contains.toLowerCase();
      const haystack = (desc.text_on_screen ?? []).map((s: string) => s.toLowerCase());
      if (!haystack.some((s: string) => s.includes(needle))) continue;
    }
    if (params.time_range) {
      const [s, e] = params.time_range;
      if (row.timestamp < s || row.timestamp > e) continue;
    }
    matches.push({ keyframeId: row.id, frameIndex: row.frameIndex, timestamp: row.timestamp });
  }
  return matches;
}

export interface SearchTranscriptParams {
  fileId: string;
  query: string;
  limit?: number;
}

export interface SearchTranscriptMatch {
  start: number;
  end: number;
  text: string;
}

export async function searchTranscript(params: SearchTranscriptParams): Promise<SearchTranscriptMatch[]> {
  const db = getDb();
  const [step] = db
    .select()
    .from(analysisSteps)
    .where(and(eq(analysisSteps.fileId, params.fileId), eq(analysisSteps.kind, "transcript")))
    .limit(1)
    .all();
  if (!step?.metadata) return [];
  let meta: { words?: TranscriptWord[] };
  try {
    meta = JSON.parse(step.metadata) as { words?: TranscriptWord[] };
  } catch {
    return [];
  }
  const words = meta.words ?? [];
  const needle = params.query.toLowerCase();
  const matches: SearchTranscriptMatch[] = [];
  // Naive: scan word array, return ±2-word window around hits.
  for (let i = 0; i < words.length; i++) {
    if (words[i].text?.toLowerCase().includes(needle)) {
      const start = Math.max(0, i - 2);
      const end = Math.min(words.length - 1, i + 2);
      const slice = words.slice(start, end + 1);
      matches.push({
        start: slice[0].start,
        end: slice[slice.length - 1].end,
        text: slice.map((w) => w.text).join(""),
      });
      if (matches.length >= (params.limit ?? 50)) break;
    }
  }
  return matches;
}

// ──────────────────────────────────────────────────────────────────────────────
// chunkAudio — plan + extract per-chunk WAVs (idempotent)
// ──────────────────────────────────────────────────────────────────────────────

export interface AudioChunkPlan {
  chunkId: string;
  chunkIndex: number;
  audioPath: string;
  startSeconds: number;
  endSeconds: number;
}

export async function chunkAudio(params: {
  fileId: string;
  chunkSeconds?: number;
  /** Test-only: skip ffmpeg extraction (chunk rows still created). */
  skipExtraction?: boolean;
}): Promise<{ chunks: AudioChunkPlan[] }> {
  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
  if (!file) throw new Error(`chunkAudio: file ${params.fileId} not found`);
  const duration = file.mediaDuration;
  if (!duration) throw new Error(`chunkAudio: file ${params.fileId} has no mediaDuration`);

  const chunkSeconds = params.chunkSeconds ?? 600;
  const overlap = duration > chunkSeconds ? 1.0 : 0;

  type Plan = { chunkIndex: number; startSeconds: number; endSeconds: number; filePath: string };
  const plans: Plan[] = [];
  if (duration <= chunkSeconds) {
    plans.push({ chunkIndex: 0, startSeconds: 0, endSeconds: duration, filePath: "audio-chunks/chunk-0001.wav" });
  } else {
    let i = 0;
    let t = 0;
    while (t < duration) {
      const start = i === 0 ? 0 : t - overlap;
      const end = Math.min(t + chunkSeconds, duration);
      plans.push({
        chunkIndex: i,
        startSeconds: start,
        endSeconds: end,
        filePath: `audio-chunks/chunk-${String(i + 1).padStart(4, "0")}.wav`,
      });
      i++;
      t = end;
      if (end >= duration) break;
    }
  }

  // Ensure the transcript step row exists (parent of chunks).
  const transcriptStep = await upsertStep({
    fileId: params.fileId,
    kind: "transcript",
    status: "not_started",
  });

  // Idempotent insert.
  const existing = db
    .select()
    .from(analysisAudioChunks)
    .where(eq(analysisAudioChunks.fileId, params.fileId))
    .all();
  const existingIndices = new Set(existing.map((c) => c.chunkIndex));

  for (const p of plans) {
    if (existingIndices.has(p.chunkIndex)) continue;
    await db.insert(analysisAudioChunks).values({
      fileId: params.fileId,
      stepId: transcriptStep.id,
      chunkIndex: p.chunkIndex,
      startSeconds: p.startSeconds,
      endSeconds: p.endSeconds,
      filePath: p.filePath,
      status: "not_started",
    });
  }

  // Re-read to capture IDs.
  const allChunks = db
    .select()
    .from(analysisAudioChunks)
    .where(eq(analysisAudioChunks.fileId, params.fileId))
    .orderBy(asc(analysisAudioChunks.chunkIndex))
    .all();

  const chunks: AudioChunkPlan[] = allChunks.map((c) => ({
    chunkId: c.id,
    chunkIndex: c.chunkIndex,
    audioPath: c.filePath ? path.resolve(getAnalysisDir(file.pieceId, params.fileId), c.filePath) : "",
    startSeconds: c.startSeconds,
    endSeconds: c.endSeconds,
  }));

  if (params.skipExtraction) return { chunks };

  // Extract per-chunk audio via ffmpeg from the canonical audio.wav.
  const inputAudioPath = getAudioPath(file.pieceId, params.fileId);
  if (!fs.existsSync(inputAudioPath)) {
    await extractAudio({ fileId: params.fileId });
  }
  ensureAnalysisDirs(file.pieceId, params.fileId);

  for (const c of allChunks) {
    if (!c.filePath) continue;
    const absOut = path.resolve(getAnalysisDir(file.pieceId, params.fileId), c.filePath);
    if (fs.existsSync(absOut)) continue;
    const dur = c.endSeconds - c.startSeconds;
    await runFfmpeg(
      [
        "-y",
        "-ss", String(c.startSeconds),
        "-t", String(dur),
        "-i", inputAudioPath,
        "-acodec", "copy",
        absOut,
      ],
      { op: "analysis_chunk_audio", context: { fileId: params.fileId, chunkIndex: c.chunkIndex } },
    );
  }

  return { chunks };
}

// ─────────────────────────────────────────────────────────────────────────────
// transcribeAudio — ElevenLabs server path with retry support
// ──────────────────────────────────────────────────────────────────────────────

export interface TranscribeAudioResult {
  status: "ready" | "partial" | "failed" | "needs_install";
  totalChunks: number;
  readyChunks: number;
  failedChunks: Array<{ chunkIndex: number; error: string }>;
  durationSeconds: number;
  wordCount: number;
  language: string | null;
  /** Set on needs_install and on success — the resolved provider. */
  provider?: "whisper" | "elevenlabs";
  /** Set on needs_install. */
  hint?: string;
}

export async function transcribeAudio(params: {
  fileId: string;
  retry?: boolean;
  chunkSeconds?: number;
  /** Test seam — inject a mock STT for the ElevenLabs call. */
  sttFn?: (audioPath: string) => Promise<{
    text: string;
    words: Array<{ text: string; start: number; end: number; type?: string; speaker_id?: string | null }>;
    language_code?: string;
    language_probability?: number;
  }>;
  provider?: "whisper" | "elevenlabs";
  model?: string;
}): Promise<TranscribeAudioResult> {
  const resolvedProvider = resolveSttProvider(params.provider);
  const resolvedModel =
    resolvedProvider === "whisper"
      ? resolveWhisperModel(params.model)
      : null;
  // An injected sttFn supplies the transcription itself, so the local
  // whisper model is irrelevant — skip the install gate in that case.
  if (
    resolvedProvider === "whisper" &&
    !params.sttFn &&
    !isWhisperModelInstalled(resolvedModel as string)
  ) {
    return {
      status: "needs_install",
      totalChunks: 0,
      readyChunks: 0,
      failedChunks: [],
      durationSeconds: 0,
      wordCount: 0,
      language: null,
      provider: "whisper",
      hint: `Whisper model "${resolvedModel}" not installed. Call libi.get_install_plan({ mcpId: "whisper" }) and follow it (it calls libi.whisper_download_model), then retry.`,
    };
  }

  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
  if (!file) throw new Error(`transcribeAudio: file ${params.fileId} not found`);
  const duration = file.mediaDuration ?? 0;

  // Detect provider switch BEFORE any state mutation. chunkAudio (called next)
  // upserts the transcript step with metadata=null, wiping prior provider
  // metadata — so we must capture the existing provider here. If the caller
  // explicitly requested a provider AND the existing transcript step's
  // metadata.provider differs, we'll treat ALL ready chunks as needing
  // reprocessing below. Otherwise we'd silently keep the cached chunks
  // (produced by the old provider) and relabel the aggregated metadata with
  // the new provider — that lies about the data origin.
  let providerSwitch = false;
  if (params.provider) {
    const [existingStep] = db
      .select()
      .from(analysisSteps)
      .where(
        and(
          eq(analysisSteps.fileId, params.fileId),
          eq(analysisSteps.kind, "transcript"),
        ),
      )
      .limit(1)
      .all();
    if (existingStep?.metadata) {
      try {
        const meta = JSON.parse(existingStep.metadata) as { provider?: string };
        if (meta.provider && meta.provider !== resolvedProvider) {
          providerSwitch = true;
        }
      } catch {
        /* malformed metadata — fall through */
      }
    }
  }

  // Plan + extract chunks (idempotent). When sttFn is injected, callers usually
  // also pre-call chunkAudio with skipExtraction; the line below is a noop in that case.
  await chunkAudio({
    fileId: params.fileId,
    chunkSeconds: params.chunkSeconds,
    skipExtraction: !!params.sttFn,
  });

  const allRows = db
    .select()
    .from(analysisAudioChunks)
    .where(eq(analysisAudioChunks.fileId, params.fileId))
    .orderBy(asc(analysisAudioChunks.chunkIndex))
    .all();

  let toProcess: typeof allRows;
  if (providerSwitch) {
    // Re-run every chunk against the newly requested provider.
    toProcess = allRows;
  } else if (params.retry) {
    // Retry only what hasn't successfully completed yet (failed + not_started).
    toProcess = allRows.filter((c) => c.status !== "ready");
  } else {
    toProcess = allRows.filter((c) => c.status === "not_started");
  }

  const sttFn =
    params.sttFn ??
    (resolvedProvider === "whisper"
      ? async (audioPath: string) => {
          const { transcribeAudio: whisperTranscribe } = await import(
            "@/lib/whisper/transcribe"
          );
          const r = await whisperTranscribe({
            audioPath,
            model: resolvedModel ?? undefined,
          });
          return {
            text: r.text,
            words: r.words,
            language_code: r.language_code,
            language_probability: r.language_probability,
          };
        }
      : async (audioPath: string) => {
          const { transcribeAudio: elevenLabsTranscribe } = await import(
            "@/lib/elevenlabs/transcribe"
          );
          const r = await elevenLabsTranscribe({ audioPath, diarize: true });
          return {
            text: r.text,
            words: r.words,
            language_code: r.language_code,
            language_probability: r.language_probability,
          };
        });

  // Loop body persists every outcome to the DB (saveAudioChunk for success,
  // markAudioChunkFailed for the catch). The `finalRows` re-select below
  // is the single source of truth for the result envelope — no parallel
  // in-memory tally needed.
  for (const chunk of toProcess) {
    if (!chunk.filePath) continue;
    const absChunkPath = path.resolve(getAnalysisDir(file.pieceId, params.fileId), chunk.filePath);
    try {
      const r = await sttFn(absChunkPath);
      const offsetWords = r.words.map((w) => ({
        ...w,
        start: w.start + chunk.startSeconds,
        end: w.end + chunk.startSeconds,
      }));
      await saveAudioChunk({
        chunkId: chunk.id,
        text: r.text,
        words: offsetWords,
        language: r.language_code,
        languageProbability: r.language_probability,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markAudioChunkFailed({ chunkId: chunk.id, errorMessage: msg });
    }
  }

  const finalRows = db
    .select()
    .from(analysisAudioChunks)
    .where(eq(analysisAudioChunks.fileId, params.fileId))
    .orderBy(asc(analysisAudioChunks.chunkIndex))
    .all();
  const ready = finalRows.filter((c) => c.status === "ready");
  const totalWords = ready.reduce((sum, c) => {
    if (!c.words) return sum;
    try {
      return sum + (JSON.parse(c.words) as unknown[]).length;
    } catch {
      return sum;
    }
  }, 0);
  const language = ready.find((c) => c.language)?.language ?? null;

  // Status + failure-surface decisions MUST be derived from `finalRows`
  // (the post-loop DB state) rather than only the local `failedChunks`
  // counter, which is empty whenever `toProcess` was empty. Previously,
  // a re-call with chunks already in status="failed" from a prior attempt
  // returned `{ status: "ready", readyChunks: 0, failedChunks: [] }` —
  // a literal lie about a fully-failed transcript. Discovered during QA
  // when the agent tried provider="elevenlabs" on a file with a stale
  // failed chunk and got an upbeat success-shaped result.
  const failedRows = finalRows.filter((c) => c.status === "failed");
  const allFailedChunks: Array<{ chunkIndex: number; error: string }> =
    failedRows.map((c) => ({
      chunkIndex: c.chunkIndex,
      error: c.errorMessage ?? "unknown",
    }));

  let status: "ready" | "partial" | "failed";
  if (finalRows.length === 0) {
    // No chunks planned (e.g. zero-duration file). Preserve historical
    // "ready" default — there's nothing to fail at.
    status = "ready";
  } else if (ready.length === finalRows.length) {
    status = "ready";
  } else if (ready.length > 0) {
    status = "partial";
  } else {
    status = "failed";
  }

  // Re-aggregate with the real provider/model. saveAudioChunk already fired
  // aggregateTranscript with the elevenlabs default; this idempotent call
  // stamps the resolved provider on the transcript_v1 metadata.
  await aggregateTranscript(params.fileId, {
    provider: resolvedProvider,
    model: resolvedModel,
  });

  return {
    status,
    provider: resolvedProvider,
    totalChunks: finalRows.length,
    readyChunks: ready.length,
    failedChunks: allFailedChunks,
    durationSeconds: duration,
    wordCount: totalWords,
    language,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// saveAudioChunkFromFile — BYO STT path: read JSON transcript from file
// ──────────────────────────────────────────────────────────────────────────────

export async function saveAudioChunkFromFile(params: {
  chunkId: string;
  jsonPath: string;
}): Promise<AnalysisAudioChunk> {
  if (!fs.existsSync(params.jsonPath)) {
    throw new Error(`saveAudioChunkFromFile: file not found ${params.jsonPath}`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(params.jsonPath, "utf-8");
  } catch (err) {
    throw new Error(`saveAudioChunkFromFile: read failed ${params.jsonPath}: ${err instanceof Error ? err.message : err}`);
  }
  let parsed: {
    text?: string;
    words?: Array<{ text: string; start: number; end: number; type?: string; speaker_id?: string | null }>;
    language_code?: string;
    language?: string;
    language_probability?: number;
  };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`saveAudioChunkFromFile: JSON parse failed: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof parsed.text !== "string" || !Array.isArray(parsed.words)) {
    throw new Error(`saveAudioChunkFromFile: invalid shape — need { text: string, words: array, ... }`);
  }
  return saveAudioChunk({
    chunkId: params.chunkId,
    text: parsed.text,
    words: parsed.words,
    language: parsed.language_code ?? parsed.language,
    languageProbability: parsed.language_probability,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// deriveAnchors — convert analysis keyframe bboxes to tracker anchors
// ──────────────────────────────────────────────────────────────────────────────

export interface DeriveAnchorsParams {
  fileId: string;
  subjectName?: string;
  itemName?: string;
}

export interface DerivedAnchorsResult {
  anchors: Anchor[];
  rejectedCount: number;
}

function isValidNormalizedBbox(
  bbox: unknown,
  kind: "person" | "item",
): bbox is [number, number, number, number] {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const [x, y, w, h] = bbox as unknown as [unknown, unknown, unknown, unknown];
  // Check type and finite before any comparison — NaN passes all inequality checks.
  if (
    typeof x !== "number" || !isFinite(x) ||
    typeof y !== "number" || !isFinite(y) ||
    typeof w !== "number" || !isFinite(w) ||
    typeof h !== "number" || !isFinite(h)
  ) return false;
  if (w <= 0.01 || h <= 0.01) return false;
  if (x < 0 || y < 0 || x + w > 1.001 || y + h > 1.001) return false; // allow 0.1% fp slack at frame edges
  if (kind === "person") {
    const aspect = w / h;
    // Coarse sanity net only — degenerate slivers are already caught by w/h <= 0.01 above.
    if (aspect < 0.05 || aspect > 20.0) return false;
  }
  return true;
}

// Test-only export so unit tests can assert on the validation function directly
// without touching the production API surface.
export const isValidNormalizedBboxForTest = isValidNormalizedBbox;

export async function deriveAnchors(params: DeriveAnchorsParams): Promise<DerivedAnchorsResult> {
  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
  if (!file) throw new Error(`deriveAnchors: file not found: ${params.fileId}`);
  if (file.mediaWidth == null || file.mediaHeight == null) {
    throw new Error(
      `deriveAnchors: file ${params.fileId} is missing mediaWidth/mediaHeight — cannot convert normalized bbox to pixels. Re-upload or probe the file first.`,
    );
  }

  const { mediaWidth, mediaHeight } = file;

  const rows = db
    .select()
    .from(analysisKeyframes)
    .where(eq(analysisKeyframes.fileId, params.fileId))
    .orderBy(asc(analysisKeyframes.timestamp))
    .all();

  const anchors: Anchor[] = [];
  let rejectedCount = 0;
  // Timestamps of frames where the subject is named but has no usable bbox —
  // either null/absent or failing validation. We'll try the one-frame detector
  // as a best-effort fallback after the main loop (person subjects only).
  const needsDetector: number[] = [];

  for (const row of rows) {
    if (!row.description) continue;
    let desc: StoredFrameDescription;
    try {
      desc = JSON.parse(row.description) as StoredFrameDescription;
    } catch {
      continue;
    }

    const candidates: Array<{ name: string; bbox: unknown; kind: "person" | "item" }> = [];
    // Track whether this frame had the named subject at all (even without bbox)
    let namedSubjectPresent = false;

    if (params.subjectName) {
      const name = params.subjectName.trim().toLowerCase();
      for (const p of desc.people ?? []) {
        if (typeof p.name === "string" && p.name.trim().toLowerCase() === name) {
          namedSubjectPresent = true;
          if (p.bbox != null) {
            candidates.push({ name: p.name, bbox: p.bbox, kind: "person" });
          }
        }
      }
    }

    if (params.itemName) {
      const name = params.itemName.trim().toLowerCase();
      for (const o of desc.objects ?? []) {
        if (typeof o.name === "string" && o.name.trim().toLowerCase() === name && o.bbox != null) {
          candidates.push({ name: o.name, bbox: o.bbox, kind: "item" });
        }
      }
    }

    let addedAnchorForRow = false;
    for (const c of candidates) {
      if (!isValidNormalizedBbox(c.bbox, c.kind)) {
        log.warn(
          {
            op: "derive_anchors.reject",
            fileId: params.fileId,
            frameIndex: row.frameIndex,
            bbox: c.bbox,
            reason: "failed normalized bbox validation",
          },
          "Rejected derived anchor",
        );
        rejectedCount++;
        // Fall through to detector fallback for person frames below
        continue;
      }

      const [nx, ny, nw, nh] = c.bbox;
      anchors.push({
        fileId: params.fileId,
        time: row.timestamp,
        bbox: [
          nx * mediaWidth,
          ny * mediaHeight,
          nw * mediaWidth,
          nh * mediaHeight,
        ],
      });
      addedAnchorForRow = true;
      break; // one anchor per keyframe — first valid candidate wins
    }

    // If the subject was named in this frame but we got no valid anchor from
    // analysis data (null bbox or failed validation), queue for detector synth.
    // Only for person/subject frames — items don't have a matching detector path.
    if (params.subjectName && !addedAnchorForRow && namedSubjectPresent) {
      needsDetector.push(row.timestamp);
    }
  }

  // Detector fallback: synthesize anchors for name-only / invalid-bbox frames
  // by running the one-frame YOLOE detector at each queued timestamp.
  // This is safe here because deriveAnchors executes in the MCP child process
  // (called from mcp/tools/tracking-tools.ts) where runJobViaServer (the
  // MCP→Next HTTP client) is the correct invocation path.
  if (needsDetector.length > 0) {
    log.info(
      {
        op: "derive_anchors.detector_fallback",
        fileId: params.fileId,
        subjectName: params.subjectName,
        frameCount: needsDetector.length,
      },
      "deriveAnchors: queuing name-only frames for detector synthesis",
    );

    if (file.pieceId != null) {
      const { groundCandidates } = await import("@/lib/tracking/ground");
      // Must be an absolute http URL — cv2.VideoCapture (the tracking sidecar) cannot
      // open bare paths. Matches the fileUrlFor() pattern in mcp/tools/tracking-tools.ts:70-74.
      const url = `http://127.0.0.1:${getCurrentPort()}/api/files/by-id/${params.fileId}/content`;
      // Sequential per-timestamp sidecar calls are intentional — detector fallback is
      // a small-N uncommon path; batching adds complexity for negligible gain here.
      for (const t of needsDetector) {
        try {
          const cands = await groundCandidates(url, t, ["person"], file.pieceId, params.fileId);
          if (cands.length > 0) {
            const best = cands.reduce((a, b) => (b.conf > a.conf ? b : a));
            // best.bbox from groundCandidates is already source-pixel [x,y,w,h] —
            // push it directly without any normalized→pixel conversion.
            anchors.push({ fileId: params.fileId, time: t, bbox: best.bbox as [number, number, number, number] });
            log.info(
              {
                op: "derive_anchors.detector_synthesized",
                fileId: params.fileId,
                timestamp: t,
                bbox: best.bbox,
                conf: best.conf,
                label: best.label,
              },
              "deriveAnchors: synthesized anchor via detector",
            );
          } else {
            log.info(
              {
                op: "derive_anchors.detector_no_candidates",
                fileId: params.fileId,
                timestamp: t,
              },
              "deriveAnchors: detector returned no candidates for frame",
            );
          }
        } catch (err) {
          // Best-effort: a missed frame is just a sparser anchor set.
          log.warn(
            { op: "derive_anchors.detector_error", fileId: params.fileId, timestamp: t, err },
            "deriveAnchors: detector fallback failed for frame",
          );
        }
      }
      anchors.sort((a, b) => a.time - b.time);
    } else {
      log.warn(
        {
          op: "derive_anchors.detector_skipped",
          fileId: params.fileId,
          reason: "file has no pieceId — cannot invoke groundCandidates",
          frameCount: needsDetector.length,
        },
        "deriveAnchors: skipping detector fallback for global/unassigned file",
      );
    }
  }

  log.info(
    {
      op: "derive_anchors.done",
      fileId: params.fileId,
      subjectName: params.subjectName,
      itemName: params.itemName,
      derived: anchors.length,
      rejectedCount,
      detectorFrames: needsDetector.length,
    },
    "deriveAnchors complete",
  );

  return { anchors, rejectedCount };
}

// ──────────────────────────────────────────────────────────────────────────────
// mergeAnchors — combine manual + derived anchors (manual wins on collision)
// ──────────────────────────────────────────────────────────────────────────────

const MERGE_EPSILON_S = 0.1;

export function mergeAnchors(manual: Anchor[], derived: Anchor[]): Anchor[] {
  const manualTimes = manual.map((a) => a.time);
  const merged = [...manual];
  for (const a of derived) {
    const collision = manualTimes.some((t) => Math.abs(t - a.time) < MERGE_EPSILON_S);
    if (!collision) merged.push(a);
  }
  merged.sort((a, b) => a.time - b.time);
  return merged;
}
