import { z } from "zod/v3";

export const TextToSpeechSchema = z.object({
  text: z.string(),
  voice_name: z.string().optional(),
  output_directory: z.string().nullable().optional(),
  voice_id: z.string().optional(),
  stability: z.number().optional(),
  similarity_boost: z.number().optional(),
  style: z.number().optional(),
  use_speaker_boost: z.boolean().optional(),
  speed: z.number().optional(),
  language: z.string().optional(),
  output_format: z.string().optional(),
  model_id: z.string().optional(),
});

export const TextToSoundEffectsSchema = z.object({
  text: z.string(),
  duration_seconds: z.number().optional(),
  output_directory: z.string().nullable().optional(),
  output_format: z.string().optional(),
  loop: z.boolean().optional(),
});

export const ComposeMusicSchema = z.object({
  prompt: z.string().optional(),
  output_directory: z.string().nullable().optional(),
  music_length_ms: z.number().optional(),
});

export const IsolateAudioSchema = z.object({
  input_file_path: z.string(),
  output_directory: z.string().nullable().optional(),
});

export const VoiceCloneSchema = z.object({
  name: z.string(),
  files: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
});

export const SpeechToTextSchema = z.object({
  input_file_path: z.string(),
  language_code: z.string().nullable().optional(),
  diarize: z.boolean().optional(),
  save_transcript_to_file: z.boolean().optional(),
  return_transcript_to_client_directly: z.boolean().optional(),
  output_directory: z.string().nullable().optional(),
});
