import fs from "fs";
import path from "path";
import { getLibiModelsDir } from "@/lib/libi-home";

/** kokoro-onnx pip pin + the two model-file URLs. Frozen by the gated
 *  Layer-2 E2E (LIBI_TTS_E2E=1) — bump only if that test fails on
 *  dependency resolution / 404, exactly as Whisper treats its pin. */
export const KOKORO_ONNX_VERSION = "0.4.9";
export const KOKORO_MODEL_URL =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx";
export const KOKORO_VOICES_URL =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";

export interface VoiceDef {
  id: string;
  language: "en-US" | "en-GB";
  gender: "female" | "male";
}

/** Canonical Kokoro v1.0 English voices. Catalog order is surfaced to the
 *  agent as-is. (Non-English voices ship in the same binary but are out of
 *  scope for v1 — see spec.) */
export const KOKORO_VOICES: VoiceDef[] = [
  { id: "af_heart", language: "en-US", gender: "female" },
  { id: "af_alloy", language: "en-US", gender: "female" },
  { id: "af_aoede", language: "en-US", gender: "female" },
  { id: "af_bella", language: "en-US", gender: "female" },
  { id: "af_jessica", language: "en-US", gender: "female" },
  { id: "af_kore", language: "en-US", gender: "female" },
  { id: "af_nicole", language: "en-US", gender: "female" },
  { id: "af_nova", language: "en-US", gender: "female" },
  { id: "af_river", language: "en-US", gender: "female" },
  { id: "af_sarah", language: "en-US", gender: "female" },
  { id: "af_sky", language: "en-US", gender: "female" },
  { id: "am_adam", language: "en-US", gender: "male" },
  { id: "am_echo", language: "en-US", gender: "male" },
  { id: "am_eric", language: "en-US", gender: "male" },
  { id: "am_fenrir", language: "en-US", gender: "male" },
  { id: "am_liam", language: "en-US", gender: "male" },
  { id: "am_michael", language: "en-US", gender: "male" },
  { id: "am_onyx", language: "en-US", gender: "male" },
  { id: "am_puck", language: "en-US", gender: "male" },
  { id: "am_santa", language: "en-US", gender: "male" },
  { id: "bf_alice", language: "en-GB", gender: "female" },
  { id: "bf_emma", language: "en-GB", gender: "female" },
  { id: "bf_isabella", language: "en-GB", gender: "female" },
  { id: "bf_lily", language: "en-GB", gender: "female" },
  { id: "bm_daniel", language: "en-GB", gender: "male" },
  { id: "bm_fable", language: "en-GB", gender: "male" },
  { id: "bm_george", language: "en-GB", gender: "male" },
  { id: "bm_lewis", language: "en-GB", gender: "male" },
];

export const DEFAULT_VOICE = "af_heart";

export function resolveVoice(voice?: string): string {
  if (voice === undefined) return DEFAULT_VOICE;
  if (!KOKORO_VOICES.some((v) => v.id === voice)) {
    throw new Error(
      `unknown voice "${voice}" (expected one of: ${KOKORO_VOICES.map((v) => v.id).join(", ")})`,
    );
  }
  return voice;
}

/** espeak-ng language code Kokoro expects for a voice id. */
export function voiceLang(voice: string): "en-us" | "en-gb" {
  return voice.startsWith("b") ? "en-gb" : "en-us";
}

export function ttsModelsDir(): string {
  return path.join(getLibiModelsDir(), "tts", "kokoro");
}

export function kokoroModelPaths(): { onnxPath: string; voicesPath: string } {
  const dir = ttsModelsDir();
  return {
    onnxPath: path.join(dir, "kokoro-v1.0.int8.onnx"),
    voicesPath: path.join(dir, "voices-v1.0.bin"),
  };
}

/** Installed = both model files present and non-empty. */
export function isKokoroModelInstalled(): boolean {
  const { onnxPath, voicesPath } = kokoroModelPaths();
  try {
    return (
      fs.statSync(onnxPath).size > 0 && fs.statSync(voicesPath).size > 0
    );
  } catch {
    return false;
  }
}

export interface VoiceStatus extends VoiceDef {
  isDefault: boolean;
}

export function listVoiceStatus(): {
  default: string;
  modelInstalled: boolean;
  voices: VoiceStatus[];
} {
  return {
    default: DEFAULT_VOICE,
    modelInstalled: isKokoroModelInstalled(),
    voices: KOKORO_VOICES.map((v) => ({
      ...v,
      isDefault: v.id === DEFAULT_VOICE,
    })),
  };
}
