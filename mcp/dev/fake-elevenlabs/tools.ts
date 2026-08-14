import { createHash } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod/v3";
import { recordCall } from "./recorder";
import { writeAudioPlaceholder } from "./placeholders";
import { resolveOutputDir, makeOutputFileName } from "./output";
import type {
  TextToSpeechSchema, TextToSoundEffectsSchema, ComposeMusicSchema,
  IsolateAudioSchema, VoiceCloneSchema, SpeechToTextSchema,
} from "./schemas";

type ToolResult = { content: { type: "text"; text: string }[]; error?: string };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const errorResult = (msg: string): ToolResult => ({ content: [{ type: "text", text: msg }], error: msg });

const DEFAULT_VOICE_ID = "cgSgspJ2msm6clMCkdW9";
const PLACEHOLDER_TRANSCRIPT = "[fake-elevenlabs] This is a placeholder transcript generated in test mode.";

function effectiveModelId(modelId: string | undefined, language: string | undefined): string {
  if (modelId) return modelId;
  return ["hu", "no", "vi"].includes(language ?? "en") ? "eleven_flash_v2_5" : "eleven_multilingual_v2";
}

/** Faithful to elevenlabs-mcp handle_input_file: absolute + exists + is a file. */
function requireInputFile(p: string): ToolResult | null {
  if (!existsSync(p)) return errorResult(`File (${p}) does not exist`);
  if (!statSync(p).isFile()) return errorResult(`File (${p}) is not a file`);
  return null;
}

export async function text_to_speech(args: z.infer<typeof TextToSpeechSchema>): Promise<ToolResult> {
  if (args.text === "") return errorResult("Text is required.");
  if (args.voice_id !== undefined && args.voice_name !== undefined) {
    return errorResult("voice_id and voice_name cannot both be provided.");
  }
  const voiceLabel = args.voice_id ?? args.voice_name ?? DEFAULT_VOICE_ID;
  const modelId = effectiveModelId(args.model_id, args.language);
  const fullPath = await writeAudioPlaceholder({ tool: "tts", text: args.text, outputDirectory: args.output_directory });
  recordCall({
    tool: "text_to_speech", voice_id: args.voice_id, voice_name: args.voice_name,
    model_id: modelId, text: args.text, output_path: fullPath,
  });
  return ok(`Success. File saved as: ${fullPath}. Voice used: ${voiceLabel}`);
}

export async function text_to_sound_effects(args: z.infer<typeof TextToSoundEffectsSchema>): Promise<ToolResult> {
  const dur = args.duration_seconds ?? 2.0;
  if (dur < 0.5 || dur > 5) return errorResult("Duration must be between 0.5 and 5 seconds");
  const fullPath = await writeAudioPlaceholder({ tool: "sfx", text: args.text, durationSeconds: dur, outputDirectory: args.output_directory });
  recordCall({ tool: "text_to_sound_effects", text: args.text, output_path: fullPath });
  return ok(`Success. File saved as: ${fullPath}`);
}

export async function compose_music(args: z.infer<typeof ComposeMusicSchema>): Promise<ToolResult> {
  if (args.prompt === undefined) {
    return errorResult("Either prompt or composition_plan must be provided. Prompt: None");
  }
  const dur = args.music_length_ms ? Math.max(1, Math.round(args.music_length_ms / 1000)) : 8;
  const fullPath = await writeAudioPlaceholder({ tool: "music", text: "", durationSeconds: dur, outputDirectory: args.output_directory });
  recordCall({ tool: "compose_music", prompt: args.prompt, output_path: fullPath });
  return ok(`Success. File saved as: ${fullPath}`);
}

export async function isolate_audio(args: z.infer<typeof IsolateAudioSchema>): Promise<ToolResult> {
  const err = requireInputFile(args.input_file_path);
  if (err) return err;
  const fullPath = await writeAudioPlaceholder({ tool: "iso", text: args.input_file_path.split("/").pop() ?? "iso", outputDirectory: args.output_directory });
  recordCall({ tool: "isolate_audio", input_file_path: args.input_file_path, output_path: fullPath });
  return ok(`Success. File saved as: ${fullPath}`);
}

export function voice_clone(args: z.infer<typeof VoiceCloneSchema>): ToolResult {
  // Divergence (documented): does NOT validate that `files` exist.
  const voiceId = "fakevoice" + createHash("sha1").update(args.name).digest("hex").slice(0, 11);
  recordCall({ tool: "voice_clone", name: args.name, voice_id: voiceId });
  return ok(
    `Voice cloned successfully: Name: ${args.name}\n        ID: ${voiceId}\n        Category: cloned\n        Description: ${args.description ?? "N/A"}`,
  );
}

export function speech_to_text(args: z.infer<typeof SpeechToTextSchema>): ToolResult {
  const err = requireInputFile(args.input_file_path);
  if (err) return err;
  if (args.return_transcript_to_client_directly) {
    recordCall({ tool: "speech_to_text", input_file_path: args.input_file_path });
    return ok(PLACEHOLDER_TRANSCRIPT);
  }
  // Default: save a .txt to the output dir, but (faithfully) reference the INPUT path in the message.
  const dir = resolveOutputDir(args.output_directory);
  const name = makeOutputFileName("stt", args.input_file_path.split("/").pop() ?? "stt", "txt");
  const outPath = join(dir, name);
  writeFileSync(outPath, PLACEHOLDER_TRANSCRIPT);
  recordCall({ tool: "speech_to_text", input_file_path: args.input_file_path, output_path: outPath });
  return ok(`Transcription saved to ${args.input_file_path}`);
}
