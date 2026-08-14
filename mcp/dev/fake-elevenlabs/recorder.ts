import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLibiHome } from "@/lib/libi-home";

export interface ElevenLabsCall {
  tool: string;
  /** Raw voice_id arg (text_to_speech) or synthetic id (voice_clone). */
  voice_id?: string;
  /** Raw voice_name arg (text_to_speech). */
  voice_name?: string;
  /** Effective model_id (text_to_speech). */
  model_id?: string;
  /** Input path (isolate_audio / speech_to_text). */
  input_file_path?: string;
  /** Absolute path written (tts / sfx / music / iso / stt-save). */
  output_path?: string;
  text?: string;
  prompt?: string;
  name?: string;
}

export function elevenlabsRecordPath(): string {
  return join(getLibiHome(), "test-mode", "elevenlabs-calls.jsonl");
}

/** Append one JSON line per fake-elevenlabs tool call. Best-effort; never throws. */
export function recordCall(call: ElevenLabsCall): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...call }) + "\n";
  try {
    mkdirSync(join(getLibiHome(), "test-mode"), { recursive: true });
    appendFileSync(elevenlabsRecordPath(), line);
  } catch {
    // recording is diagnostic; swallow so a generation never fails on it
  }
}
