import fs from "fs";
import path from "path";
import { getLibiModelsDir } from "@/lib/libi-home";

export interface WhisperModelDef {
  id: string;
  /** Human-readable, shown to the agent and the user. */
  approxSize: string;
  /**
   * The same figure in bytes, used to drive the download progress bar.
   *
   * Kept beside `approxSize` rather than parsed out of it: a display string is
   * free to become "about half a gig" without anyone thinking they have broken
   * arithmetic. A test asserts the two agree, so they cannot drift apart.
   */
  approxBytes: number;
  note: string;
}

/** Catalog order is intentional — surfaced to the agent in this order. */
export const WHISPER_MODELS: WhisperModelDef[] = [
  { id: "tiny", approxSize: "~75 MB", approxBytes: 75_000_000, note: "fastest, lowest accuracy" },
  { id: "base", approxSize: "~145 MB", approxBytes: 145_000_000, note: "fast" },
  {
    id: "small",
    approxSize: "~480 MB",
    // Measured at 466 MB on disk during the 0.1.2 QA run; the catalogue's
    // ~480 MB is the download figure and is what the bar should aim at.
    approxBytes: 480_000_000,
    note: "balanced (default)",
  },
  {
    id: "medium",
    approxSize: "~1.5 GB",
    approxBytes: 1_500_000_000,
    note: "higher accuracy, slower",
  },
  {
    id: "large-v3",
    approxSize: "~3 GB",
    approxBytes: 3_000_000_000,
    note: "best accuracy, GPU recommended",
  },
];

/** Expected download size in bytes for `model`, for progress reporting. */
export function whisperModelBytes(model: string): number {
  const def = WHISPER_MODELS.find((m) => m.id === model);
  if (!def) throw new Error(`unknown whisper model: ${model}`);
  return def.approxBytes;
}

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

/** Every catalogue model that is on disk, in catalogue order. */
export function installedWhisperModels(): string[] {
  return WHISPER_MODELS.filter((m) => isWhisperModelInstalled(m.id)).map((m) => m.id);
}

/**
 * The model a transcription runs with.
 *
 * An explicit `requested` is honoured (and validated) as it always was — a
 * caller who asks for `small` gets `small`, or `needs_install` for it.
 *
 * With none, the default when it is on disk, else the most accurate model that
 * is (catalogue order runs small → large). The Whisper card counts ANY
 * installed model as ready (0.1.16 F8), so a default call on a `tiny`-only
 * machine must transcribe with `tiny` — not ask for a 480 MB `small` download
 * the card says is not needed. With nothing installed it stays the default, so
 * the install gate names the model the plan proposes.
 */
export function pickWhisperModel(requested?: string): string {
  if (requested !== undefined) return resolveWhisperModel(requested);
  if (isWhisperModelInstalled(DEFAULT_WHISPER_MODEL)) return DEFAULT_WHISPER_MODEL;
  const installed = installedWhisperModels();
  return installed.length > 0 ? installed[installed.length - 1] : DEFAULT_WHISPER_MODEL;
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
