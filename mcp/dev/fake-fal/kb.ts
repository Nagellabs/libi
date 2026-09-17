export type ModelKind = "image" | "video" | "audio";

export interface JsonSchemaLike {
  type: "object";
  properties: Record<
    string,
    {
      type: string;
      description?: string;
      default?: unknown;
      items?: unknown;
      /** Allowed values, when the real fal schema constrains the field to a
       *  fixed set (e.g. V-RMBG 3.0's `background_color` /
       *  `output_container_and_codec`). Mirroring the enum matters: picking
       *  the wrong member silently returns a non-alpha output. */
      enum?: string[];
    }
  >;
  required?: string[];
}

export interface ModelKbEntry {
  endpoint_id: string;
  kind: ModelKind;
  schema: JsonSchemaLike;
  pricing: { amount: number; currency: string; unit: string };
  recommendFor: string[];
  /**
   * Documented-equivalent ID strings that resolve to THIS canonical entry.
   * MUST be live-fal-verified equivalents (an id real fal serves as the same
   * model) — never a guess. Currently none: the 2026-06-05 live-fal check
   * (`npm run skill:eval:audit` + per-id openapi probe) confirmed every
   * candidate alias 404s, so the array is empty. Per-scenario remapping uses
   * `ScenarioConfig.aliasOverrides`, not this field.
   */
  aliases?: string[];
  /** Real fal endpoint, but skills tell the agent not to pick it (still "known"). */
  discouraged?: boolean;
}

export interface ScenarioConfig {
  recommend_model?: { byTaskMatch?: { contains: string; endpoint_id: string }[]; default?: string };
  schemaOverrides?: Record<string, Partial<JsonSchemaLike>>;
  pricingOverrides?: Record<string, { amount: number; currency: string; unit: string }>;
  /** When true, an unknown endpoint_id is rejected with a fal-style 404 instead of placeholdered. */
  strict?: boolean;
  /** Per-scenario alias → canonical overrides, checked after the KB's own aliases. */
  aliasOverrides?: Record<string, string>;
}

const IMAGE_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Text prompt" },
    aspect_ratio: { type: "string", description: "e.g. 9:16, 1:1", default: "1:1" },
    resolution: { type: "string", description: "1K/2K", default: "1K" },
    output_format: { type: "string", description: "jpeg/png", default: "jpeg" },
  },
  required: ["prompt"],
};

const SEEDANCE_I2V_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Motion + action prompt" },
    image_url: { type: "string", description: "Start frame URL" },
    end_image_url: { type: "string", description: "Optional last frame (FLF)" },
    duration: { type: "string", description: "4..15 seconds, or auto" },
    resolution: { type: "string", description: "480p/720p/1080p", default: "480p" },
    aspect_ratio: { type: "string", default: "9:16" },
    generate_audio: { type: "boolean", description: "Native synchronized audio incl. lip-synced speech", default: true },
  },
  required: ["prompt", "image_url"],
};

const SEEDANCE_T2V_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Text prompt describing the scene + motion (no start frame)" },
    duration: { type: "string", description: "4..15 seconds, or auto" },
    resolution: { type: "string", description: "480p/720p/1080p", default: "480p" },
    aspect_ratio: { type: "string", default: "9:16" },
    generate_audio: { type: "boolean", description: "Native synchronized audio incl. lip-synced speech", default: true },
  },
  required: ["prompt"],
};

const SEEDANCE_REF_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Prompt; reference tokens @Image1/@Audio1" },
    image_urls: { type: "array", description: "Up to 9 reference images (@Image1..)", items: { type: "string" } },
    audio_urls: { type: "array", description: "Up to 3 audio refs (@Audio1..), MP3/WAV", items: { type: "string" } },
    duration: { type: "string", description: "4..15 seconds" },
    resolution: { type: "string", default: "480p" },
    aspect_ratio: { type: "string", default: "9:16" },
    generate_audio: { type: "boolean", default: true },
  },
  required: ["prompt"],
};

// Veo 3.1 fast — the three operations have THREE DIFFERENT input shapes, and
// one shared `VEO_SCHEMA` used to stand in for all of them plus five unrelated
// endpoints. That was not a rounding error: the FLF operation appeared to have
// no way to pass a last frame at all, so the fake could not serve
// `physical-action-video`'s headline first-last-frame technique, and
// `fal-ai/wan-flf2v` — the other dedicated FLF endpoint — had the same hole.
//
// Every schema below is transcribed from fal's live OpenAPI, fetched
// 2026-09-09 per endpoint:
//   https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>
// Field NAMES and the `required` set are the load-bearing part — an agent that
// reads this schema calls with exactly these keys. Note in particular that Veo
// FLF does NOT use `image_url`/`end_image_url` (those are Seedance's i2v
// spelling); it uses `first_frame_url`/`last_frame_url`, and both are REQUIRED
// alongside the prompt.
const VEO_COMMON = {
  duration: { type: "string", description: "e.g. 4s/6s/8s", default: "8s" },
  resolution: { type: "string", description: "720p/1080p", default: "720p" },
  aspect_ratio: { type: "string", description: "auto/16:9/9:16", default: "auto" },
  generate_audio: { type: "boolean", description: "Native synchronized audio", default: true },
  negative_prompt: { type: "string", description: "What to avoid" },
} as const;

const VEO_I2V_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Motion + action prompt" },
    image_url: { type: "string", description: "Start frame URL" },
    ...VEO_COMMON,
  },
  required: ["prompt", "image_url"],
};

const VEO_FLF_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "The transition between the two frames" },
    first_frame_url: { type: "string", description: "URL of the first frame of the video" },
    last_frame_url: { type: "string", description: "URL of the last frame of the video" },
    ...VEO_COMMON,
  },
  required: ["prompt", "first_frame_url", "last_frame_url"],
};

const VEO_EXTEND_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "What happens in the continuation" },
    video_url: { type: "string", description: "The clip to extend" },
    ...VEO_COMMON,
  },
  required: ["prompt", "video_url"],
};

// Kling o1 i2v — FLF via start/end image params. NOT `@Image1` / `@Image2`:
// those are Kling's prompt-reference tokens on other endpoints, and naming
// them here is what sent the skill references wrong (fixed in the same change).
const KLING_O1_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Motion + action prompt" },
    start_image_url: { type: "string", description: "Start frame URL" },
    end_image_url: { type: "string", description: "Optional last frame (FLF)" },
    duration: { type: "string", description: "seconds" },
  },
  required: ["prompt", "start_image_url"],
};

// Wan's dedicated first-last-frame endpoint. Both frames are required.
const WAN_FLF_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "The transition between the two frames" },
    start_image_url: { type: "string", description: "Start frame URL" },
    end_image_url: { type: "string", description: "Last frame URL" },
    resolution: { type: "string", description: "480p/580p/720p", default: "720p" },
    aspect_ratio: { type: "string", default: "auto" },
    negative_prompt: { type: "string", description: "What to avoid" },
    num_frames: { type: "number", description: "81 default", default: 81 },
    frames_per_second: { type: "number", default: 16 },
  },
  required: ["prompt", "start_image_url", "end_image_url"],
};

// Wan 2.2 animate/replace — swaps the subject of an EXISTING clip for the
// person in a reference image. No prompt at all.
const WAN_ANIMATE_REPLACE_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    video_url: { type: "string", description: "Source clip whose subject is replaced" },
    image_url: { type: "string", description: "Reference image of the replacement subject" },
    resolution: { type: "string", description: "480p/580p/720p", default: "720p" },
    num_inference_steps: { type: "number", default: 20 },
  },
  required: ["video_url", "image_url"],
};

const WAN_V2V_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Target style / content" },
    video_url: { type: "string", description: "Source clip to transform" },
    strength: { type: "number", description: "0-1, how far from the source", default: 0.85 },
    resolution: { type: "string", default: "720p" },
    negative_prompt: { type: "string", description: "What to avoid" },
  },
  required: ["prompt", "video_url"],
};

// Video understanding is an ANALYSIS endpoint, not a generator: a clip plus a
// question in, text out.
const VIDEO_UNDERSTANDING_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    video_url: { type: "string", description: "The clip to analyse" },
    prompt: { type: "string", description: "The question to answer about the clip" },
    detailed_analysis: { type: "boolean", description: "Longer, more thorough answer", default: false },
  },
  required: ["video_url", "prompt"],
};

// Video-to-video restyle: repaints an EXISTING clip in a new style. Input is a
// video_url + a style prompt (no image, no duration — the source sets the length).
const RESTYLE_V2V_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    video_url: { type: "string", description: "Source clip to restyle" },
    prompt: { type: "string", description: "Target style" },
    strength: { type: "number", description: "0-1, how far from the source", default: 0.7 },
  },
  required: ["video_url", "prompt"],
};

// Lip-sync: drives an EXISTING talking-face video's mouth to a NEW audio track.
// Input is a video_url + audio_url (NOT a text prompt). Used by the
// voice-replacement skill for the talking-face → lip-sync route.
/** Text-to-music. Mirrors fal's live Stable Audio 2.5 text-to-audio input schema
 *  (field names, types and defaults read off the model's API page on 2026-09-09), so a
 *  skill that gets the parameter name wrong fails in test mode the way it would in
 *  production. `seconds_total`, not `duration` — that difference is the point of
 *  mirroring rather than inventing. */
const MUSIC_T2A_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "The prompt to generate audio from" },
    seconds_total: { type: "integer", description: "Length of the clip in seconds", default: 190 },
    num_inference_steps: { type: "integer", description: "Denoising steps", default: 8 },
    guidance_scale: { type: "number", description: "Prompt adherence", default: 1 },
    seed: { type: "integer", description: "Reproducible generation" },
  },
  required: ["prompt"],
};

const LIPSYNC_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    video_url: { type: "string", description: "Source talking-face video to re-sync" },
    audio_url: { type: "string", description: "New voiceover audio the lips should match" },
    model: { type: "string", description: "Lip-sync model variant, e.g. lipsync-2", default: "lipsync-2" },
    sync_mode: { type: "string", description: "loop/bounce/cut_off/silence — silence keeps full video length", default: "silence" },
  },
  required: ["video_url", "audio_url"],
};

// Background removal: isolate the subject, transparent background out.
// Video → alpha WebM; image → transparent PNG. Inputs are source URLs
// (NOT text prompts) — the removing-and-replacing-backgrounds skill sends
// video_url / image_url the agent obtained from its fal MCP's own upload tool.
const VIDEO_BG_REMOVAL_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    video_url: { type: "string", description: "Source video whose background to remove" },
    background_color: { type: "string", description: "Optional solid background; omit for transparent output" },
  },
  required: ["video_url"],
};

// Bria V-RMBG 3.0. Mirrors the live openapi schema (probed 2026-07-19):
// webm_vp9 is the DEFAULT codec and Transparent is an explicit enum value, so
// the transparent-webm combination that crashes the v1 worker is first-class
// here. `background_color` defaults to Black — the skill MUST pass Transparent
// to get an alpha cutout rather than a black-matted video.
const VIDEO_BG_REMOVAL_V3_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    video_url: { type: "string", description: "Input video to remove background from" },
    background_color: {
      type: "string",
      description: "Transparent yields a real alpha cutout; any colour bakes a matte background in",
      default: "Black",
      enum: ["Transparent", "Black", "White", "Gray", "Red", "Green", "Blue", "Yellow", "Cyan", "Magenta", "Orange"],
    },
    output_container_and_codec: {
      type: "string",
      description: "webm_vp9 carries alpha; mp4/h264 variants do NOT",
      default: "webm_vp9",
      enum: ["mp4_h265", "mp4_h264", "webm_vp9", "mov_h265", "mov_proresks", "mkv_h265", "mkv_h264", "mkv_vp9", "gif"],
    },
    preserve_audio: { type: "boolean", description: "Keep the source audio in the output", default: true },
  },
  required: ["video_url"],
};

const IMAGE_BG_REMOVAL_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    image_url: { type: "string", description: "Source image whose background to remove" },
    output_format: { type: "string", description: "png keeps transparency", default: "png" },
  },
  required: ["image_url"],
};

export const MODEL_KB: Record<string, ModelKbEntry> = {
  // `fal-ai/gpt-image-2` is a REAL live alias of this model — probed 200 against
  // fal's openapi endpoint on 2026-07-19, same day an agent emitted it and the
  // KB honestly flagged it `unknown`. Aliased (not added as a separate entry)
  // because it is the same model; per the KB's live-verification policy, an
  // alias is only ever added with a 200 in hand.
  "openai/gpt-image-2": {
    endpoint_id: "openai/gpt-image-2", kind: "image", schema: IMAGE_SCHEMA,
    aliases: ["fal-ai/gpt-image-2"],
    pricing: { amount: 0.04, currency: "USD", unit: "image" },
    recommendFor: ["image", "portrait", "photo", "realism", "keyframe", "still"],
  },
  "openai/gpt-image-2/edit": {
    endpoint_id: "openai/gpt-image-2/edit", kind: "image", schema: IMAGE_SCHEMA,
    pricing: { amount: 0.04, currency: "USD", unit: "image" },
    recommendFor: ["edit", "inpaint", "outpaint", "mask"],
  },
  "fal-ai/nano-banana-2": {
    endpoint_id: "fal-ai/nano-banana-2", kind: "image", schema: IMAGE_SCHEMA,
    pricing: { amount: 0.02, currency: "USD", unit: "image" },
    recommendFor: ["banana"],
  },
  "fal-ai/flux-2-pro": {
    endpoint_id: "fal-ai/flux-2-pro", kind: "image", schema: IMAGE_SCHEMA,
    pricing: { amount: 0.03, currency: "USD", unit: "image" },
    recommendFor: ["flux"],
  },
  "fal-ai/flux-pro/v1.1-ultra": {
    endpoint_id: "fal-ai/flux-pro/v1.1-ultra", kind: "image", schema: IMAGE_SCHEMA,
    pricing: { amount: 0.05, currency: "USD", unit: "image" },
    recommendFor: ["flux-ultra", "raw"],
  },
  "fal-ai/flux/dev": {
    endpoint_id: "fal-ai/flux/dev", kind: "image", schema: IMAGE_SCHEMA,
    pricing: { amount: 0.01, currency: "USD", unit: "image" },
    recommendFor: [], discouraged: true,
  },
  // Seedance 2.0: the bare-namespace ids are canonical and live on fal (200);
  // the fal-ai/bytedance/seedance/v2/pro/* family 404s (verified 2026-06-05),
  // so no aliases here — an agent emitting that string is honestly `unknown`.
  "bytedance/seedance-2.0/image-to-video": {
    endpoint_id: "bytedance/seedance-2.0/image-to-video", kind: "video", schema: SEEDANCE_I2V_SCHEMA,
    pricing: { amount: 0.5, currency: "USD", unit: "clip" },
    recommendFor: ["video", "image-to-video", "i2v", "ugc", "clip", "motion"],
  },
  // text-to-video: a REAL canonical seedance-2.0 operation (live-fal 200, verified
  // 2026-06-05) — the from-scratch path when a beat has NO start frame (e.g. faceless
  // b-roll inserts in a stitch). Surfaced by the dogfood stitch run, which legitimately
  // reached for it; it had been missing from the KB and was being false-flagged unknown.
  "bytedance/seedance-2.0/text-to-video": {
    endpoint_id: "bytedance/seedance-2.0/text-to-video", kind: "video", schema: SEEDANCE_T2V_SCHEMA,
    pricing: { amount: 0.45, currency: "USD", unit: "clip" },
    recommendFor: ["text-to-video", "t2v", "from scratch", "b-roll", "no start frame"],
  },
  "bytedance/seedance-2.0/reference-to-video": {
    endpoint_id: "bytedance/seedance-2.0/reference-to-video", kind: "video", schema: SEEDANCE_REF_SCHEMA,
    pricing: { amount: 0.6, currency: "USD", unit: "clip" },
    recommendFor: ["reference-to-video", "reference", "audio carry", "multi-reference"],
  },
  // REAL cheaper "fast tier" variants — verified against fal OpenAPI 2026-06-06
  // (HTTP 200, distinct Queue schema, same input shape: generate_audio / end_image_url
  // / duration / aspect_ratio). They were missing from the KB, so a real-AI dogfood
  // run that legitimately reached for the fast tier had no canonical entry. NB: the
  // fast i2v endpoint returned a COMPLETED-but-404 *result* via the bundled fal MCP
  // in that run (F8) — that's a fal-client/result-URL issue, NOT "endpoint unknown";
  // the endpoint itself is real. Pricing ~half of standard.
  "bytedance/seedance-2.0/fast/image-to-video": {
    endpoint_id: "bytedance/seedance-2.0/fast/image-to-video", kind: "video", schema: SEEDANCE_I2V_SCHEMA,
    pricing: { amount: 0.25, currency: "USD", unit: "clip" },
    recommendFor: ["fast", "cheap video", "fast image-to-video", "eval clip"],
  },
  "bytedance/seedance-2.0/fast/reference-to-video": {
    endpoint_id: "bytedance/seedance-2.0/fast/reference-to-video", kind: "video", schema: SEEDANCE_REF_SCHEMA,
    pricing: { amount: 0.3, currency: "USD", unit: "clip" },
    recommendFor: ["fast reference-to-video", "fast audio carry", "cheap reference"],
  },
  // Veo 3.1: the canonical reachable ids are the veo3.1/fast/* operations (200).
  // The dashed `fal-ai/veo-3.1` 404s on real fal and no skill referenced it, so
  // it was removed (verified 2026-06-05). "veo" recommend tag lives on the i2v op.
  "fal-ai/veo3.1/fast/image-to-video": {
    endpoint_id: "fal-ai/veo3.1/fast/image-to-video", kind: "video", schema: VEO_I2V_SCHEMA,
    pricing: { amount: 0.4, currency: "USD", unit: "clip" },
    recommendFor: ["veo", "veo-fast", "veo i2v"],
  },
  "fal-ai/veo3.1/fast/first-last-frame-to-video": {
    endpoint_id: "fal-ai/veo3.1/fast/first-last-frame-to-video", kind: "video", schema: VEO_FLF_SCHEMA,
    pricing: { amount: 0.45, currency: "USD", unit: "clip" },
    recommendFor: ["flf", "first-last-frame", "transition"],
  },
  "fal-ai/veo3.1/fast/extend-video": {
    endpoint_id: "fal-ai/veo3.1/fast/extend-video", kind: "video", schema: VEO_EXTEND_SCHEMA,
    pricing: { amount: 0.45, currency: "USD", unit: "clip" },
    recommendFor: ["extend"],
  },
  "fal-ai/kling-video/o1/image-to-video": {
    endpoint_id: "fal-ai/kling-video/o1/image-to-video", kind: "video", schema: KLING_O1_SCHEMA,
    pricing: { amount: 0.5, currency: "USD", unit: "clip" },
    recommendFor: ["kling"],
  },
  "fal-ai/wan/v2.2-14b/animate/replace": {
    endpoint_id: "fal-ai/wan/v2.2-14b/animate/replace", kind: "video", schema: WAN_ANIMATE_REPLACE_SCHEMA,
    pricing: { amount: 0.5, currency: "USD", unit: "clip" },
    recommendFor: ["wan replace", "animate"],
  },
  // Route B (ugc-product-video) cheap restyle default. NOT a `fal-ai/*` id — the
  // vendor prefix is `decart`, which is exactly why `ENDPOINT_VENDORS` in
  // scripts/skill-eval/audit-endpoints.ts must list it: before it did, this id was
  // referenced by a skill, absent from the KB, and invisible to the coverage guard,
  // so a test-mode Path-B run returned `unknown_endpoint`.
  //
  // PRICE VERIFIED 2026-09-09. The $0.01/s here was originally copied from
  // ugc-product-video's own prose, so the fake agreed with the skill whether or not the
  // skill was right — a cost disclosure wrong in the same direction as the skill is
  // undetectable. Checked against fal's live listing
  // (https://fal.ai/models/decart/lucy-restyle, "$0.01 per second") and a second
  // independent summary of the same page. Both agree with the skill; nothing to correct.
  "decart/lucy-restyle": {
    endpoint_id: "decart/lucy-restyle", kind: "video", schema: RESTYLE_V2V_SCHEMA,
    pricing: { amount: 0.01, currency: "USD", unit: "second" },
    recommendFor: ["restyle", "cheap restyle", "video-to-video restyle", "lucy"],
  },
  "fal-ai/wan/v2.2-a14b/video-to-video": {
    endpoint_id: "fal-ai/wan/v2.2-a14b/video-to-video", kind: "video", schema: WAN_V2V_SCHEMA,
    pricing: { amount: 0.5, currency: "USD", unit: "clip" },
    recommendFor: ["wan v2v", "video-to-video"],
  },
  "fal-ai/wan-flf2v": {
    endpoint_id: "fal-ai/wan-flf2v", kind: "video", schema: WAN_FLF_SCHEMA,
    pricing: { amount: 0.45, currency: "USD", unit: "clip" },
    recommendFor: ["wan flf"],
  },
  // The KB's FIRST audio-kind entry. Until it existed, `MODEL_KB` held image and
  // video models only, so `music-creation`'s paid route could not be exercised by any
  // scenario — its fal reference deliberately named no endpoint id, because naming one
  // would have been both un-auditable (the KB could not resolve it) and unreachable (the
  // fake could not serve it), and a guard pinned that absence so at least it was
  // honest. An entire provider kind shipped with zero agent-level coverage.
  //
  // VERIFIED 2026-09-09 against fal's live listing: endpoint id and `$0.2 per audio`
  // (per generation, NOT per second) from https://fal.ai/models/fal-ai/stable-audio-25/
  // text-to-audio, input schema from that model's /api page. Priced per call is itself
  // worth having in the KB — every other entry is per image / clip / second, so a skill
  // that assumes a per-second unit for music now has something to be wrong against.
  "fal-ai/stable-audio-25/text-to-audio": {
    endpoint_id: "fal-ai/stable-audio-25/text-to-audio", kind: "audio", schema: MUSIC_T2A_SCHEMA,
    pricing: { amount: 0.2, currency: "USD", unit: "generation" },
    recommendFor: ["music", "song", "soundtrack", "background music", "audio", "stable audio"],
  },
  "fal-ai/video-understanding": {
    endpoint_id: "fal-ai/video-understanding", kind: "video", schema: VIDEO_UNDERSTANDING_SCHEMA,
    pricing: { amount: 0.1, currency: "USD", unit: "call" },
    recommendFor: ["script", "understanding", "analysis"],
  },
  // Lip-sync (voice-replacement skill, talking-face route). sync.so Lipsync 2 is
  // the hardened default (studio-grade); latentsync is the cheaper open-source
  // alternative. Output is a re-synced video. Priced per second of output.
  "fal-ai/sync-lipsync/v2": {
    endpoint_id: "fal-ai/sync-lipsync/v2", kind: "video", schema: LIPSYNC_SCHEMA,
    pricing: { amount: 0.075, currency: "USD", unit: "second" },
    recommendFor: ["lipsync", "lip-sync", "dub", "re-voice", "talking face", "voice replacement"],
  },
  "fal-ai/latentsync": {
    endpoint_id: "fal-ai/latentsync", kind: "video", schema: LIPSYNC_SCHEMA,
    pricing: { amount: 0.03, currency: "USD", unit: "second" },
    recommendFor: ["cheap lipsync", "latentsync", "open-source lip-sync"],
  },
  // Background removal (removing-and-replacing-backgrounds skill). bria is
  // the paid VIDEO fallback when the free local MatAnyone path can't handle
  // the subject; birefnet is the v1 PHOTO cutout path (local BiRefNet is a
  // fast-follow). Both ids live-fal-verified 2026-07-18 (openapi probe 200;
  // the fal-ai/bria/video/background-removal variant 404s and is excluded).
  // Priced per the fal listing at add time — get_pricing is the runtime
  // disclosure source.
  // V-RMBG 3.0 is THE paid video fallback — bake-off winner on real footage
  // (2026-07-19): temporally aware rather than frame-by-frame, it kept a hand
  // structurally intact where both the local matte and veed degraded, and it
  // is ~33x cheaper than the v1 endpoint and ~5x cheaper than veed.
  // Honest trade-off: the local MatAnyone matte still resolves FINER HAIR
  // detail, which is why local stays the default and this is the fallback.
  "bria/video/background-removal/v3": {
    endpoint_id: "bria/video/background-removal/v3", kind: "video", schema: VIDEO_BG_REMOVAL_V3_SCHEMA,
    pricing: { amount: 0.0042, currency: "USD", unit: "second" },
    recommendFor: ["background removal", "remove background", "video cutout", "video matting", "green screen replace", "transparent video"],
  },
  // v1 — REAL endpoint (probe 200) but its worker crashes server-side on the
  // transparent-webm path (verified 2026-07-19: status COMPLETED, result 500,
  // Python traceback in its logs) and it is priced 33x above v3. Kept so the
  // KB mirrors reality, marked discouraged so nothing routes here.
  "bria/video/background-removal": {
    endpoint_id: "bria/video/background-removal", kind: "video", schema: VIDEO_BG_REMOVAL_SCHEMA,
    pricing: { amount: 0.14, currency: "USD", unit: "second" },
    recommendFor: [], discouraged: true,
  },
  // veed — real and functional, but lost the bake-off on BOTH axes (softer
  // hair, hazier subject edges) at ~5x v3's price.
  "veed/video-background-removal": {
    endpoint_id: "veed/video-background-removal", kind: "video", schema: VIDEO_BG_REMOVAL_SCHEMA,
    pricing: { amount: 0.0225, currency: "USD", unit: "30 frames" },
    recommendFor: [], discouraged: true,
  },
  "fal-ai/birefnet": {
    endpoint_id: "fal-ai/birefnet", kind: "image", schema: IMAGE_BG_REMOVAL_SCHEMA,
    pricing: { amount: 0.02, currency: "USD", unit: "image" },
    recommendFor: ["photo background removal", "image cutout", "transparent png", "product cutout"],
  },
};

export function recommendModel(task: string, cfg: ScenarioConfig | null): { endpoint_id: string; rationale: string } {
  const t = task.toLowerCase();
  for (const rule of cfg?.recommend_model?.byTaskMatch ?? []) {
    if (t.includes(rule.contains.toLowerCase())) {
      return { endpoint_id: rule.endpoint_id, rationale: `scenario override (matched "${rule.contains}")` };
    }
  }
  const wantsVideo = ["video", "i2v", "image-to-video", "clip", "motion", "veo", "seedance"].some((k) => t.includes(k));
  if (wantsVideo) {
    return { endpoint_id: "bytedance/seedance-2.0/image-to-video", rationale: "default video pick (test-mode KB)" };
  }
  if (cfg?.recommend_model?.default) {
    return { endpoint_id: cfg.recommend_model.default, rationale: "scenario default" };
  }
  // ADVERSARIAL ON PURPOSE — mirror real fal, not an idealized fal. Real fal's
  // recommend/search surface pushes the trendy photoreal model (nano-banana) for
  // UGC-portrait/realism intents. `ai-asset-generation` Step 6.5 hard-pins
  // `openai/gpt-image-2` precisely to OVERRIDE that. If this default returned
  // gpt-image-2, the skill-eval assertion `{ gpt-image-2 present, nano-banana
  // absent }` would be a tautology — an agent that blindly trusts recommend_model
  // (the real-mode failure observed 2026-06-06) would pass it just like an obedient
  // one. Returning nano-banana here gives that assertion teeth: only an agent that
  // overrides the recommendation to gpt-image-2 passes. A scenario that genuinely
  // needs recommend_model→gpt-image-2 can set `recommend_model.byTaskMatch`/`default`.
  return { endpoint_id: "fal-ai/nano-banana-2", rationale: "default realism-image pick (test-mode KB mirrors real fal — skill must override to gpt-image-2)" };
}

export function getSchema(endpointId: string, cfg: ScenarioConfig | null): JsonSchemaLike {
  const canonical = resolveEndpoint(endpointId, cfg).canonical ?? endpointId;
  const base = MODEL_KB[canonical]?.schema ?? { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] };
  const override = cfg?.schemaOverrides?.[endpointId];
  if (!override) return base;
  return { ...base, ...override, properties: { ...base.properties, ...(override.properties ?? {}) } };
}

export function getPricing(endpointId: string, cfg: ScenarioConfig | null): { amount: number; currency: string; unit: string } {
  const canonical = resolveEndpoint(endpointId, cfg).canonical ?? endpointId;
  return cfg?.pricingOverrides?.[endpointId] ?? MODEL_KB[canonical]?.pricing ?? { amount: 0, currency: "USD", unit: "call" };
}

export interface EndpointResolution {
  /** Canonical endpoint_id, or null when the id is unknown to the KB. */
  canonical: string | null;
  /** True when the match came through an alias (KB alias or scenario override). */
  viaAlias: boolean;
}

export function resolveEndpoint(endpointId: string, cfg: ScenarioConfig | null): EndpointResolution {
  if (MODEL_KB[endpointId]) return { canonical: endpointId, viaAlias: false };
  for (const entry of Object.values(MODEL_KB)) {
    if (entry.aliases?.includes(endpointId)) return { canonical: entry.endpoint_id, viaAlias: true };
  }
  const override = cfg?.aliasOverrides?.[endpointId];
  if (override && MODEL_KB[override]) return { canonical: override, viaAlias: true };
  return { canonical: null, viaAlias: false };
}

export function kindFor(endpointId: string): ModelKind {
  const canonical = resolveEndpoint(endpointId, null).canonical ?? endpointId;
  return MODEL_KB[canonical]?.kind ?? "image";
}
