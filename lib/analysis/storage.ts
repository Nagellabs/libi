import fs from "fs";
import path from "path";
import { getLibiStorageDir } from "@/lib/libi-home";

const GLOBAL_BUCKET = "_global";
const ANALYSIS_DIR = "_analysis";
const FRAMES_DIR = "frames";
const AUDIO_FILENAME = "audio.wav";

function bucket(pieceId: string | null): string {
  return pieceId ?? GLOBAL_BUCKET;
}

/** Absolute path to the per-file analysis directory. */
export function getAnalysisDir(pieceId: string | null, fileId: string): string {
  return path.join(getLibiStorageDir(), bucket(pieceId), ANALYSIS_DIR, fileId);
}

/** Absolute path to the keyframes subdirectory. */
export function getFramesDir(pieceId: string | null, fileId: string): string {
  return path.join(getAnalysisDir(pieceId, fileId), FRAMES_DIR);
}

/** Absolute path to the canonical extracted-audio file. */
export function getAudioPath(pieceId: string | null, fileId: string): string {
  return path.join(getAnalysisDir(pieceId, fileId), AUDIO_FILENAME);
}

/**
 * The timeline an `audio.wav` was extracted on, written beside it
 * (`audio.wav.timeline`) once the extract has finished. `extractAudio` pads an
 * audio track that starts after its file (d0e0594c), so an extract made since
 * is on the FILE's timeline; one made before started at the audio's first
 * sample, early by the lead. The sidecar is what tells them apart: an
 * `audio.wav` without it predates it, or was cut short, and is stale.
 */
export const AUDIO_EXTRACT_TIMELINE = "file";

export function getAudioTimelinePath(pieceId: string | null, fileId: string): string {
  return `${getAudioPath(pieceId, fileId)}.timeline`;
}

/** Whether the file's `audio.wav` carries the sidecar that says it is on the file's timeline. */
export function isAudioExtractCurrent(pieceId: string | null, fileId: string): boolean {
  try {
    return fs.readFileSync(getAudioTimelinePath(pieceId, fileId), "utf8").trim() === AUDIO_EXTRACT_TIMELINE;
  } catch {
    return false;
  }
}

/** Idempotent recursive delete of the analysis directory. */
export function removeAnalysisDir(pieceId: string | null, fileId: string): void {
  fs.rmSync(getAnalysisDir(pieceId, fileId), { recursive: true, force: true });
}

/** Create the analysis dir + frames subdir + audio-chunks subdir if missing. */
export function ensureAnalysisDirs(pieceId: string | null, fileId: string): void {
  fs.mkdirSync(getFramesDir(pieceId, fileId), { recursive: true });
  fs.mkdirSync(getAudioChunksDir(pieceId, fileId), { recursive: true });
}

const AUDIO_CHUNKS_DIR = "audio-chunks";

export function getAudioChunksDir(pieceId: string | null, fileId: string): string {
  return path.join(getAnalysisDir(pieceId, fileId), AUDIO_CHUNKS_DIR);
}

export function getAudioChunkPath(pieceId: string | null, fileId: string, chunkIndex: number): string {
  const filename = `chunk-${String(chunkIndex + 1).padStart(4, "0")}.wav`;
  return path.join(getAudioChunksDir(pieceId, fileId), filename);
}
