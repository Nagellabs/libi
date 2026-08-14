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
