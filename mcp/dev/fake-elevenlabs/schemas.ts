import { z } from "zod/v3";

/**
 * Input schemas of the fake ElevenLabs, mirroring the tools libi's skills use on
 * ElevenLabs' HOSTED MCP (https://api.us.elevenlabs.io/v1/mcp), as listed on
 * 2026-09-25 (docs-local/qa/2026-09-25-elevenlabs-hosted-tools.json). Same names,
 * same parameters, the same REQUIRED `context` on every call, and the same
 * `generations_count` default of 4 — so an agent that forgets to pass 1 is caught
 * by an eval instead of by a user's bill.
 */

/** Every hosted creative tool requires a short "why" for the call. */
const context = z.string().min(1).describe("Why the tool is being called.");

export const SPEECH_MODELS = ["eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_v3", "eleven_v4"] as const;

export const NODE_TYPES = [
  "image-generation", "video-generation", "tts", "sfx", "music", "composition", "image-transform", "llm", "avatar",
  "speech-to-text", "dubbing-audio", "dubbing-video", "voice-changer", "voice-isolator", "video-to-music",
] as const;

/**
 * The audio models of the hosted 96-value model enum, by node type (what
 * `creative_get_flow_node_types` answers for this fake's region). The fake
 * accepts only these: the image / video / llm models are out of scope for libi's
 * ElevenLabs use, and a node of those types is refused as not mirrored.
 */
export const NODE_MODELS: Record<string, readonly string[]> = {
  tts: SPEECH_MODELS,
  sfx: ["eleven_text_to_sound_v2"],
  music: ["eleven_music_v2", "eleven_music_v1"],
  "speech-to-text": ["eleven_scribe_v1"],
  "voice-changer": ["eleven_multilingual_sts_v2"],
  "voice-isolator": ["audio_isolation"],
  "video-to-music": ["eleven_music_v2"],
};

export const AUDIO_MODELS = [...new Set(Object.values(NODE_MODELS).flat())] as [string, ...string[]];

const generationsCount = z.number().int().min(1).max(4).optional().describe("1-4, default 4. Each generation is charged.");
const estimateOnly = z.boolean().optional().describe("Return the cost only; nothing is generated or charged.");

export const ListVoicesSchema = z.object({
  search: z.string().optional(),
  languages: z.array(z.string()).optional(),
  accent: z.string().optional(),
  gender: z.enum(["male", "female", "neutral"]).optional(),
  age: z.enum(["young", "middle_aged", "old"]).optional(),
  use_cases: z.array(z.string()).optional(),
  descriptives: z.array(z.string()).optional(),
  voice_category: z.enum(["professional", "famous", "high_quality"]).optional(),
  sort: z.enum(["trending", "created_date", "cloned_by_count", "usage_character_count_1y"]).optional(),
  context,
});

export const CreateFlowSchema = z.object({
  name: z.string().optional(),
  context,
});

export const GenerateSpeechSchema = z.object({
  prompt: z.string().describe("Text to speak."),
  model_id: z.enum(SPEECH_MODELS),
  voice_id: z.string().describe("Must come from creative_list_voices or the user."),
  flow_id: z.string().optional(),
  generations_count: generationsCount,
  estimate_only: estimateOnly,
  view_state_id: z.string().optional(),
  context,
});

export const GenerateInFlowSchema = z.object({
  prompt: z.string(),
  node_type: z.enum(NODE_TYPES),
  model_id: z.string(),
  flow_id: z.string().optional(),
  connect_from: z.array(z.string()).optional(),
  voice_id: z.string().optional().describe("Required for tts."),
  generations_count: generationsCount,
  estimate_only: estimateOnly,
  view_state_id: z.string().optional(),
  context,
});

export const TranscribeAudioSchema = z.object({
  model_id: z.enum(["eleven_scribe_v1"]),
  connect_from: z.array(z.string()).optional().describe("Required in practice: the audio node on this flow."),
  flow_id: z.string().optional(),
  estimate_only: estimateOnly,
  view_state_id: z.string().optional(),
  context,
});

export const FlowRunStatusSchema = z.object({
  flow_id: z.string(),
  session_ids: z.array(z.string()).min(1).max(20),
  context,
});

export const FlowNodeTypesSchema = z.object({
  flow_id: z.string().optional(),
  context,
});

export const ModelSchemaSchema = z.object({
  node_type: z.enum(NODE_TYPES),
  model_id: z.string(),
  context,
});

export const CreateAssetUploadSchema = z.object({
  name: z.string(),
  mime_type: z.string().describe("Must exactly match the PUT Content-Type."),
  file_size: z.number().int().positive().describe("Exact size in bytes."),
  origin: z.string().optional(),
  context,
});

export const FinalizeAssetUploadSchema = z.object({
  asset_id: z.string(),
  flow_id: z.string().optional(),
  node_id: z.string().optional(),
  context,
});
