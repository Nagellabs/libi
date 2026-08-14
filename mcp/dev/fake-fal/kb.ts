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

const VEO_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    image_url: { type: "string", description: "Optional start frame" },
    duration: { type: "string", description: "4/6/8 seconds" },
    generate_audio: { type: "boolean", default: true },
    aspect_ratio: { type: "string", default: "9:16" },
  },
  required: ["prompt"],
};

// Lip-sync: drives an EXISTING talking-face video's mouth to a NEW audio track.
// Input is a video_url + audio_url (NOT a text prompt). Used by the
// voice-replacement skill for the talking-face → lip-sync route.
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
// video_url / image_url from libi.upload_file_to_fal.
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
    endpoint_id: "fal-ai/veo3.1/fast/image-to-video", kind: "video", schema: VEO_SCHEMA,
    pricing: { amount: 0.4, currency: "USD", unit: "clip" },
    recommendFor: ["veo", "veo-fast", "veo i2v"],
  },
  "fal-ai/veo3.1/fast/first-last-frame-to-video": {
    endpoint_id: "fal-ai/veo3.1/fast/first-last-frame-to-video", kind: "video", schema: VEO_SCHEMA,
    pricing: { amount: 0.45, currency: "USD", unit: "clip" },
    recommendFor: ["flf", "first-last-frame", "transition"],
  },
  "fal-ai/veo3.1/fast/extend-video": {
    endpoint_id: "fal-ai/veo3.1/fast/extend-video", kind: "video", schema: VEO_SCHEMA,
    pricing: { amount: 0.45, currency: "USD", unit: "clip" },
    recommendFor: ["extend"],
  },
  "fal-ai/kling-video/o1/image-to-video": {
    endpoint_id: "fal-ai/kling-video/o1/image-to-video", kind: "video", schema: VEO_SCHEMA,
    pricing: { amount: 0.5, currency: "USD", unit: "clip" },
    recommendFor: ["kling"],
  },
  "fal-ai/wan/v2.2-14b/animate/replace": {
    endpoint_id: "fal-ai/wan/v2.2-14b/animate/replace", kind: "video", schema: VEO_SCHEMA,
    pricing: { amount: 0.5, currency: "USD", unit: "clip" },
    recommendFor: ["wan replace", "animate"],
  },
  "fal-ai/wan/v2.2-a14b/video-to-video": {
    endpoint_id: "fal-ai/wan/v2.2-a14b/video-to-video", kind: "video", schema: VEO_SCHEMA,
    pricing: { amount: 0.5, currency: "USD", unit: "clip" },
    recommendFor: ["wan v2v", "video-to-video"],
  },
  "fal-ai/wan-flf2v": {
    endpoint_id: "fal-ai/wan-flf2v", kind: "video", schema: VEO_SCHEMA,
    pricing: { amount: 0.45, currency: "USD", unit: "clip" },
    recommendFor: ["wan flf"],
  },
  "fal-ai/video-understanding": {
    endpoint_id: "fal-ai/video-understanding", kind: "video", schema: VEO_SCHEMA,
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
