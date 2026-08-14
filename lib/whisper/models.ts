import fs from "fs";
import path from "path";
import { getLibiModelsDir } from "@/lib/libi-home";

export interface WhisperModelDef {
  id: string;
  approxSize: string;
  note: string;
}

/** Catalog order is intentional — surfaced to the agent in this order. */
export const WHISPER_MODELS: WhisperModelDef[] = [
  { id: "tiny", approxSize: "~75 MB", note: "fastest, lowest accuracy" },
  { id: "base", approxSize: "~145 MB", note: "fast" },
  { id: "small", approxSize: "~480 MB", note: "balanced (default)" },
  { id: "medium", approxSize: "~1.5 GB", note: "higher accuracy, slower" },
  {
    id: "large-v3",
    approxSize: "~3 GB",
    note: "best accuracy, GPU recommended",
  },
];

export const DEFAULT_WHISPER_MODEL = "small";

/** Returns the model id if valid, the default when undefined, throws otherwise. */
export function resolveWhisperModel(model?: string): string {
  if (model === undefined) return DEFAULT_WHISPER_MODEL;
  if (!WHISPER_MODELS.some((m) => m.id === model)) {
    throw new Error(
      `unknown whisper model "${model}" (expected one of: ${WHISPER_MODELS.map((m) => m.id).join(", ")})`,
    );
  }
  return model;
}

/** faster-whisper pulls Systran CT2 conversions; huggingface_hub names the
 *  cache dir `models--<org>--<repo>`. */
export function hfCacheDirName(model: string): string {
  return `models--Systran--faster-whisper-${model}`;
}

/** Where we point faster-whisper's `download_root`. */
export function whisperModelsDir(): string {
  return path.join(getLibiModelsDir(), "whisper");
}

/** Installed = HF cache dir for the model has a non-empty `snapshots/` tree. */
export function isWhisperModelInstalled(model: string): boolean {
  const snapshots = path.join(
    whisperModelsDir(),
    hfCacheDirName(model),
    "snapshots",
  );
  try {
    const revs = fs.readdirSync(snapshots);
    for (const rev of revs) {
      const revDir = path.join(snapshots, rev);
      if (fs.statSync(revDir).isDirectory()) {
        const files = fs.readdirSync(revDir);
        if (files.length > 0) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export interface WhisperModelStatus extends WhisperModelDef {
  installed: boolean;
  isDefault: boolean;
}

export function listWhisperModelStatus(): WhisperModelStatus[] {
  return WHISPER_MODELS.map((m) => ({
    ...m,
    installed: isWhisperModelInstalled(m.id),
    isDefault: m.id === DEFAULT_WHISPER_MODEL,
  }));
}
