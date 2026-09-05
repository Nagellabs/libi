/** Central Zod schemas for all tool parameters */

// Use Zod v3 compat layer — the MCP SDK's internal schema-to-JSON-Schema
// conversion uses Zod v3 internals (._zod) that don't exist in Zod v4.
import { z } from "zod/v3";
import { aiGenerationMetaSchema } from "@/lib/ai-generation/types";

// ---------------------------------------------------------------------------
// Layer effects schemas (Plan 1 — used by Plan 2 MCP tools and inspector)
// ---------------------------------------------------------------------------

/** One applied effect on one slot. */
const effectRefSchema = z.object({
  effectId: z.string(),
  durationMs: z.number().positive().optional(),
  params: z.record(z.union([z.number(), z.string()])).optional(),
});

/** In/out/loop animation block stored on a layer. */
export const layerEffectsSchema = z.object({
  in: effectRefSchema.optional(),
  out: effectRefSchema.optional(),
  loop: effectRefSchema.optional(),
});

export type LayerEffectsInput = z.infer<typeof layerEffectsSchema>;

export const listEffectsSchema = z.object({
  kind: z.enum(["text", "image", "video", "code", "three", "tracked", "scene", "audio"]).optional()
    .describe("Filter to effects that support this layer kind"),
  phase: z.enum(["in", "out", "loop"]).optional().describe("Filter to effects valid for this slot"),
  family: z.literal("animation").optional(),
});

export const applyLayerEffectSchema = z.object({
  pieceId: z.string(),
  layerId: z.string().describe("Overlay id, base scene id, or audio clip id"),
  phase: z.enum(["in", "out", "loop"]),
  effectId: z.string().describe("A built-in effect id (see libi.list_effects)"),
  durationMs: z.number().positive().optional().describe("in/out window length; omit → effect default"),
  params: z.record(z.union([z.number(), z.string()])).optional(),
});

export const clearLayerEffectSchema = z.object({
  pieceId: z.string(),
  layerId: z.string(),
  phase: z.enum(["in", "out", "loop"]),
});

// ---------------------------------------------------------------------------
// Custom effect package management schemas (Milestone 4).
// PLAIN z.object only — no discriminatedUnion / .refine at the top level (the
// MCP SDK serializes those to an empty {} and the agent can't pass typed args).
// The real manifest shape is validated INSIDE each handler via
// customEffectManifestSchema, which returns a structured error on failure.
// ---------------------------------------------------------------------------

export const installEffectFromGitSchema = z.object({
  url: z.string().url().describe("Git repo URL containing manifest.json + animate.js"),
});

/** A single custom effect param descriptor (kept plain — validated again in the handler). */
const customEffectParamSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string().describe('"number" or "enum"'),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  default: z.union([z.number(), z.string()]).optional(),
  options: z.array(z.string()).optional(),
});

export const addEffectSchema = z.object({
  id: z.string().describe("Lowercase slug, e.g. 'slow-drift'"),
  name: z.string(),
  family: z.string().describe('Must be "animation"'),
  phases: z.array(z.string()).describe('Subset of "in" | "out" | "loop"'),
  supports: z
    .array(z.string())
    .describe('Layer kinds: text | image | video | code | three | tracked | scene | audio'),
  params: z.array(customEffectParamSchema).optional(),
  defaultDurationMs: z.number().positive().optional(),
  source: z
    .string()
    .describe("animate.js body: pure (progress, params) → TransformDelta; math helpers only"),
});

export const updateEffectSchema = z.object({
  id: z.string(),
  source: z.string().optional().describe("New animate.js body (omit to keep existing)"),
  manifest: z
    .object({
      name: z.string().optional(),
      family: z.string().optional(),
      phases: z.array(z.string()).optional(),
      supports: z.array(z.string()).optional(),
      params: z.array(customEffectParamSchema).optional(),
      defaultDurationMs: z.number().positive().optional(),
    })
    .optional()
    .describe("Partial manifest patch (omit to keep existing)"),
});

export const removeEffectSchema = z.object({
  id: z.string(),
});

export const listEffectPackagesSchema = z.object({});

// ---------------------------------------------------------------------------

export const getCompositionSchema = z.object({
  pieceId: z.string().describe("ID of the piece to operate on"),
});

export const updatePieceNameSchema = z.object({
  pieceId: z.string().describe("ID of the piece to operate on"),
  name: z.string().max(100).describe("Short descriptive name for the piece"),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("Brief description of what this video project is about"),
});

export const updatePieceDescriptionSchema = z.object({
  pieceId: z.string().describe("ID of the piece to operate on"),
  description: z.string().max(500).describe("Brief description of what this video project is about"),
});

export const saveAssetSchema = z.object({
  pieceId: z.string().describe("ID of the piece to operate on"),
  filename: z.string().describe("Filename for the asset (with extension)"),
  name: z.string().describe("Human-readable name for the asset"),
  description: z.string().describe("Brief description of what this asset contains"),
  type: z.string().describe("Asset type (e.g. 'audio/voiceover', 'audio/sfx', 'audio/music')"),
  contentType: z.string().optional().describe("MIME type of the asset"),
  data: z.string().describe("Base64-encoded asset data"),
});

export const audioAddClipSchema = z.object({
  pieceId: z.string().describe("ID of the piece to operate on"),
  fileId: z.string().describe(
    "ID of the source file. Audio file or video file (the audio stream is what plays).",
  ),
  kind: z.enum(["inline", "standalone"]).default("standalone").describe(
    "'inline' = bound to a video scene (pass linkedSceneId). 'standalone' = independent.",
  ),
  startTime: z.number().min(0).describe("Composition-global start time in seconds"),
  duration: z.number().positive().optional().describe(
    "Duration in seconds (defaults to source's media duration when omitted)",
  ),
  trimStart: z.number().min(0).default(0).describe(
    "Offset into the source file in seconds (default 0)",
  ),
  volume: z.number().min(0).max(1).default(1).describe("0..1 (default 1)"),
  enabled: z.boolean().default(true).describe("Speaker toggle (default true)"),
  linkedSceneId: z.string().optional().describe("For an inline clip bound to a scene"),
  linkedOverlayId: z.string().optional().describe(
    "For an inline clip bound to a video overlay (not a scene). At most one of linkedSceneId/linkedOverlayId.",
  ),
  label: z.string().optional().describe("Display label, e.g. 'background music'"),
  lengthPolicy: z
    .enum(["extend", "trim"])
    .optional()
    .describe(
      "Required ONLY when the clip would end past the piece's current end and no explicit `duration` is given: 'extend' keeps the asset's full length (the piece grows), 'trim' cuts the clip at the piece's current end. Ask the user which they want before choosing.",
    ),
});

export const audioUpdateClipSchema = z.object({
  pieceId: z.string(),
  clipId: z.string().describe("The clip to update"),
  startTime: z.number().min(0).optional(),
  duration: z.number().positive().optional(),
  trimStart: z.number().min(0).optional(),
  volume: z.number().min(0).max(1).optional(),
  enabled: z.boolean().optional(),
  label: z.string().optional(),
  timelineOrder: z.number().optional(),
});

export const audioRemoveClipSchema = z.object({
  pieceId: z.string(),
  clipId: z.string(),
});

export const audioUnlinkSchema = z.object({
  pieceId: z.string(),
  clipId: z.string().describe(
    "Inline clip to unlink. After unlink it becomes a standalone clip — moves and edits no longer follow the scene.",
  ),
});

export const audioSplitSchema = z.object({
  pieceId: z.string(),
  clipId: z.string(),
  time: z.number().min(0).describe(
    "Composition-global time in seconds where the clip is split. Must lie strictly inside the clip.",
  ),
});

export const audioRelinkOverlaySchema = z.object({
  pieceId: z.string(),
  clipId: z.string().describe("Id of the (standalone) audio clip to relink."),
  overlayId: z.string().describe(
    "Id of the VIDEO overlay to bind the clip to as its inline audio, so the clip moves/trims with that overlay.",
  ),
});

// ── Unified timeline clip operations (cut / delete / duplicate) ──────────────
// `targetId` is ANY timeline entity id — a scene, an overlay, or an audio clip.
// The family is auto-detected (ids are prefix-disjoint: scene_* / <kind>-* / clip_*).

export const splitClipSchema = z.object({
  pieceId: z.string(),
  targetId: z.string().describe(
    "Id of the timeline clip to cut — a scene, overlay, or audio clip. The family is auto-detected.",
  ),
  atTime: z.number().min(0).describe(
    "Composition-global time in seconds where the clip is cut (split) into two. Must lie strictly inside the clip's window.",
  ),
});

export const deleteClipSchema = z.object({
  pieceId: z.string(),
  targetId: z.string().describe(
    "Id of the timeline clip to remove — a scene, overlay, or audio clip. Removes the clip from the timeline only; the SOURCE FILE is never deleted.",
  ),
  ripple: z.boolean().optional().default(false).describe(
    "When true, also closes the hole the deleted clip left: every overlay/audio clip that starts at or after the deleted clip's END time shifts left by its duration, timeline-wide (not scoped to one lane/group). Items that start BEFORE that point are left alone even if they extend past it (e.g. a full-length background). Default false leaves the gap — correct when other layers (a background, captions in another lane) shouldn't be dragged along. No-op when deleting a SCENE: a scene delete already closes its own gap (sequential scene positions + auto-resynced linked audio), so ripple has nothing left to do there.",
  ),
});

export const duplicateClipSchema = z.object({
  pieceId: z.string(),
  targetId: z.string().describe(
    "Id of the timeline clip to duplicate — a scene, overlay, or audio clip. The copy is placed immediately after the original.",
  ),
});

export const masterVolumeSetSchema = z.object({
  pieceId: z.string(),
  volume: z.number().min(0).max(1).describe("0..1"),
});

export const masterVolumeMuteSchema = z.object({
  pieceId: z.string(),
  muted: z.boolean(),
});

export const listFilesSchema = z.object({
  pieceId: z.string().optional().describe("ID of the piece. Required when scope is 'piece'."),
  scope: z.enum(["piece", "global", "all"]).optional().default("piece").describe(
    "Which files to list: 'piece' (files for pieceId, default), 'global' (unassigned files), 'all' (every file across all pieces and global)",
  ),
  query: z.string().optional().describe("Search files by name or filename (case-insensitive partial match)"),
});

export const duplicateFileSchema = z.object({
  fileId: z.string().describe("ID of the source file to duplicate"),
  targetPieceId: z.string().nullable().describe("ID of the piece to duplicate into, or null for global"),
  name: z.string().optional().describe("Optional new name for the duplicate (defaults to source name)"),
});

export const assignFileSchema = z.object({
  fileId: z.string().describe("ID of the file to move"),
  pieceId: z
    .string()
    .nullable()
    .describe(
      "Piece to move the file into, or null to make it unassigned (global). " +
        "Moves the file — it does not copy. Use libi.duplicate_file when the " +
        "original must stay where it is.",
    ),
});

export const updateFileNotesSchema = z.object({
  fileId: z.string().describe("ID of the file whose notes should be updated"),
  notes: z.string().describe("Notes content. In append mode this is the single line to append (a timestamp prefix is added automatically); in replace mode this is the full new notes body."),
  mode: z.enum(["append", "replace"]).default("append").describe("'append' (default) prepends an ISO timestamp and appends a trailing newline; 'replace' overwrites the entire notes field."),
});

export const registerMcpServerSchema = z.object({
  name: z.string().describe("Human-readable name for the MCP server (e.g., 'YouTube Downloader')"),
  type: z.enum(["stdio", "http"]).describe("Transport type: 'stdio' for command-line servers, 'http' for HTTP endpoints"),
  command: z.string().optional().describe("For stdio: the executable command (e.g., 'npx')"),
  args: z.array(z.string()).optional().describe("For stdio: command arguments (e.g., ['@kevinwatt/yt-dlp-mcp'])"),
  url: z.string().optional().describe("For http: the MCP server endpoint URL"),
  headers: z.record(z.string()).optional().describe("For http: headers as key-value pairs"),
  envVars: z.record(z.string()).optional().describe("Environment variables needed by the server (e.g., API keys)"),
  description: z.string().optional().describe("Brief description of what the server does"),
  requireApproval: z.boolean().optional().default(true).describe("Whether the agent must ask the user before calling this server's tools (default true)"),
});

export const updateMcpServerSchema = z.object({
  id: z.string().describe("ID of the MCP server row to update"),
  name: z.string().optional().describe("Human-readable name (custom rows only)"),
  description: z.string().nullable().optional().describe("Brief description (custom rows only). Pass null to clear."),
  command: z.string().optional().describe("Executable command for stdio rows (custom rows only)"),
  args: z.array(z.string()).optional().describe("Command arguments for stdio rows (custom rows only)"),
  url: z.string().optional().describe("Endpoint URL for http rows (custom rows only)"),
  headers: z.record(z.string()).optional().describe("HTTP headers as key-value pairs (custom rows only)"),
  envVars: z.record(z.string()).optional().describe(
    "Environment variables as key-value pairs (allowed on bundled and custom rows). Replaces the full env-var map.",
  ),
  requireApproval: z.boolean().optional().describe(
    "Whether the agent must ask the user before calling this server's tools (allowed on bundled and custom rows)",
  ),
});

export const setMcpServerEnabledSchema = z.object({
  id: z.string().describe("ID of the MCP server row to toggle"),
  enabled: z.boolean().describe("New enabled state. Disabled servers are not surfaced to agents but their definition is preserved."),
});

export const removeMcpServerSchema = z.object({
  id: z.string().describe("ID of the custom MCP server row to permanently remove. Bundled servers cannot be removed."),
});

export const uploadFileSchema = z.object({
  pieceId: z.string().describe("ID of the piece to operate on"),
  filePath: z.string().describe("Absolute path to the file on the local filesystem"),
  name: z.string().optional().describe("Display name (defaults to filename from path)"),
  description: z.string().optional().default("").describe("Brief description of the file"),
  aiGeneration: aiGenerationMetaSchema
    .optional()
    .describe(
      "Optional provenance metadata for AI-generated files. Set when the source of this file is a generation call (fal-ai veo, image-to-video, TTS, etc.). Populates the asset preview Generation tab and enables the Fetch-actual-cost flow. Include provider (e.g. \"fal-ai\"), model, the full engineered prompt, costEstimate, startedAt/completedAt ISO timestamps, durationMs, and providerJobId (the fal request_id). Omit for non-AI uploads.",
    ),
  folderId: z.string().optional().describe(
    "Place the uploaded file inside this asset folder (must match the file's " +
    "scope). Omit to land at the scope root.",
  ),
});

export const UploadFileToFalSchema = z.object({
  fileId: z.string().describe("libi file id to upload to fal storage"),
});
export type UploadFileToFalParams = z.infer<typeof UploadFileToFalSchema>;

export const UploadFontSchema = z.object({
  path: z.string().describe("Absolute local filesystem path to a .ttf/.otf/.woff2 font file"),
  pieceId: z.string().optional().describe("Piece to scope the font to; omit for a global font"),
  name: z.string().optional().describe("Display name for the font asset"),
});
export type UploadFontParams = z.infer<typeof UploadFontSchema>;

export const listFontsSchema = z.object({
  pieceId: z
    .string()
    .optional()
    .describe(
      "Piece to include piece-scoped uploaded fonts for, in addition to global uploads. Omit to list only bundled, system, and globally-uploaded fonts.",
    ),
});
export type ListFontsParams = z.infer<typeof listFontsSchema>;

export const TrimVideoSchema = z.object({
  pieceId: z.string().describe("The piece that owns the source file"),
  fileId: z.string().describe("File ID of the source video"),
  startSeconds: z.number().min(0).describe("Start offset in seconds"),
  endSeconds: z.number().min(0).describe("End offset in seconds (exclusive)"),
  outputName: z
    .string()
    .optional()
    .describe("Optional filename for the trimmed output (defaults to <original>-trim.mp4)"),
});

export const ExtractAudioSchema = z.object({
  pieceId: z.string().describe("The piece that owns the source file"),
  fileId: z.string().describe("File ID of the source video"),
  format: z
    .enum(["mp3", "wav", "copy"])
    .optional()
    .describe(
      "Output audio format. DEFAULT 'mp3' — a fal-safe format: Seedance reference-to-video " +
        "`@Audio1` accepts MP3/WAV ONLY, so the default is already correct for a voice reference. " +
        "'wav' = lossless PCM (also fal-safe). 'copy' = stream-copy the source codec (fast, " +
        "lossless, usually .m4a/AAC) — do NOT use 'copy' for an @Audio1 reference (fal rejects AAC).",
    ),
  startSeconds: z
    .number()
    .min(0)
    .optional()
    .describe("Optional clip start offset in seconds — extract only a segment (e.g. a clean voice sample)."),
  endSeconds: z
    .number()
    .min(0)
    .optional()
    .describe("Optional clip end offset in seconds (exclusive). Requires startSeconds. Keep (end-start) ≤ 15s for a Seedance @Audio1 reference."),
  outputName: z
    .string()
    .optional()
    .describe("Optional filename (defaults to <original>-audio.<ext>, ext per `format`)"),
});

export const GenerateThumbnailsSchema = z.object({
  pieceId: z.string().describe("The piece that owns the source file"),
  fileId: z.string().describe("File ID of the source video"),
  count: z.number().int().min(1).max(50).default(6).describe("Number of thumbnails (default 6)"),
});

export const ConcatVideosSchema = z.object({
  pieceId: z.string().describe("The piece that owns the source files"),
  fileIds: z.array(z.string()).min(2).describe("Ordered list of video file IDs to concatenate"),
  outputName: z.string().optional().describe("Optional output filename (defaults to concat.mp4)"),
});

export const RegenerateProxySchema = z.object({
  fileId: z.string().describe("File ID of the video"),
});

export const DropProxiesSchema = z.object({
  pieceId: z.string().describe("The piece whose proxies should be dropped"),
});

export type GetCompositionParams = z.infer<typeof getCompositionSchema>;
export type UpdatePieceNameParams = z.infer<typeof updatePieceNameSchema>;
export type UpdatePieceDescriptionParams = z.infer<typeof updatePieceDescriptionSchema>;
export type SaveAssetParams = z.infer<typeof saveAssetSchema>;
export type AudioAddClipParams = z.infer<typeof audioAddClipSchema>;
export type AudioUpdateClipParams = z.infer<typeof audioUpdateClipSchema>;
export type AudioRemoveClipParams = z.infer<typeof audioRemoveClipSchema>;
export type AudioUnlinkParams = z.infer<typeof audioUnlinkSchema>;
export type AudioSplitParams = z.infer<typeof audioSplitSchema>;
export type AudioRelinkOverlayParams = z.infer<typeof audioRelinkOverlaySchema>;
export type SplitClipParams = z.infer<typeof splitClipSchema>;
export type DeleteClipParams = z.infer<typeof deleteClipSchema>;
export type DuplicateClipParams = z.infer<typeof duplicateClipSchema>;
export type MasterVolumeSetParams = z.infer<typeof masterVolumeSetSchema>;
export type MasterVolumeMuteParams = z.infer<typeof masterVolumeMuteSchema>;
export const listPiecesSchema = z.object({
  query: z.string().optional().describe("Search pieces by name or description"),
  limit: z.number().optional().default(20).describe("Max results to return"),
  offset: z.number().optional().default(0).describe("Pagination offset"),
});

export const createPieceSchema = z.object({
  name: z.string().max(100).optional().describe("Piece name (defaults to 'New Piece {date}')"),
  description: z.string().max(500).optional().describe("Brief description of the piece"),
});

export const showPieceSchema = z.object({
  pieceId: z.string().describe("ID of the piece to show in the editor"),
});

export const deletePieceSchema = z.object({
  pieceId: z.string().describe("ID of the piece to permanently delete"),
});

export const showAssetSchema = z.object({
  pieceId: z.string().describe("ID of the piece the asset belongs to"),
  fileId: z.string().describe("ID of the file/asset to show"),
});

export const showInChatSchema = z.object({
  fileId: z.string().describe("ID of the file/asset to render inline in the chat"),
  caption: z
    .string()
    .optional()
    .describe("Optional short caption shown under the media in chat"),
});

export const showPreviewSchema = z.object({
  pieceId: z.string().describe("ID of the piece whose timeline/preview should be shown"),
});

export const showStoryboardSchema = z.object({
  pieceId: z.string().describe("ID of the piece whose storyboard should be shown"),
});

export const highlightPropertySchema = z.object({
  pieceId: z.string().describe("ID of the piece the overlay belongs to"),
  overlayId: z.string().describe("ID of the overlay whose inspector field to flash"),
  property: z
    .string()
    .describe(
      "Inspector field key to highlight (e.g. 'background.color', 'content', 'reveal.mode'). Must be a known key.",
    ),
  note: z
    .string()
    .max(200)
    .optional()
    .describe("Optional short callout shown next to the flashed field"),
});

export const highlightEffectSchema = z.object({
  pieceId: z.string(),
  target: z.union([
    z.object({ kind: z.literal("catalog"), effectId: z.string(), phase: z.enum(["in", "out", "loop"]).optional() }),
    z.object({ kind: z.literal("applied"), layerId: z.string(), phase: z.enum(["in", "out", "loop"]) }),
  ]),
  note: z.string().max(200).optional(),
});

export const setComplexityModeSchema = z.object({
  pieceId: z.string().describe("ID of the piece the overlay belongs to"),
  overlayId: z
    .string()
    .describe("ID of the overlay whose inspector tab to switch"),
  mode: z
    .enum(["transform", "style", "text", "3d", "anchors"])
    .describe(
      "Inspector intent group (tab) to switch this overlay's inspector to: 'transform' (placement/size/2D rotate/timing), 'style' (look — color/background/stroke/shadow/reveal), 'text' (content + typography), '3d' (3D extrusion + the orbit-gizmo manual angles), or 'anchors' (tracked only — the manual re-anchor list). If the kind doesn't have that tab, the client clamps to the kind's default.",
    ),
});

export type ListFilesParams = z.infer<typeof listFilesSchema>;
export type DuplicateFileParams = z.infer<typeof duplicateFileSchema>;
export type AssignFileToolParams = z.infer<typeof assignFileSchema>;
export type UploadFileParams = z.infer<typeof uploadFileSchema>;
export type RegisterMcpServerParams = z.infer<typeof registerMcpServerSchema>;
export type UpdateMcpServerParams = z.infer<typeof updateMcpServerSchema>;
export type SetMcpServerEnabledParams = z.infer<typeof setMcpServerEnabledSchema>;
export type RemoveMcpServerParams = z.infer<typeof removeMcpServerSchema>;
export type ListPiecesParams = z.infer<typeof listPiecesSchema>;
export type CreatePieceParams = z.infer<typeof createPieceSchema>;
export type ShowPieceParams = z.infer<typeof showPieceSchema>;
export type DeletePieceParams = z.infer<typeof deletePieceSchema>;
export type ShowAssetParams = z.infer<typeof showAssetSchema>;
export type ShowPreviewParams = z.infer<typeof showPreviewSchema>;
export type ShowStoryboardParams = z.infer<typeof showStoryboardSchema>;
export type HighlightPropertyParams = z.infer<typeof highlightPropertySchema>;
export type SetComplexityModeParams = z.infer<typeof setComplexityModeSchema>;
export type TrimVideoParams = z.infer<typeof TrimVideoSchema>;
export type ExtractAudioParams = z.infer<typeof ExtractAudioSchema>;
export type GenerateThumbnailsParams = z.infer<typeof GenerateThumbnailsSchema>;
export type ConcatVideosParams = z.infer<typeof ConcatVideosSchema>;
export type RegenerateProxyParams = z.infer<typeof RegenerateProxySchema>;
export type DropProxiesParams = z.infer<typeof DropProxiesSchema>;

const OverlayRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const overlayBase = {
  pieceId: z.string(),
  startTime: z.number().min(0),
  duration: z.number().positive(),
  rect: OverlayRectSchema,
  z: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  // `rotation` (degrees) is INPUT SUGAR — the handler converts it to
  // `transform3d.rotation.z` (the single rotation authority). No legacy
  // `rotation` storage field exists.
  rotation: z.number().optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  group: z.string().max(120).optional(),
  effects: layerEffectsSchema.optional(),
};
const overlayAlignEnum = z.enum(["left", "center", "right"]);
const cameraPresetEnum = z.enum(["billboard", "ground", "lowAngle", "highAngle", "angled"]);
/** The 9 point-text anchor names (CaptionAnchor). Shared by update_overlay
 *  (point-text placement) and generate_captions. */
const captionAnchorEnum = z.enum([
  "top-left",
  "top-center",
  "top-right",
  "mid-left",
  "mid-center",
  "mid-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);

/**
 * Bounded 3D transform (SP7 Milestone 3) for `three` overlays. Each axis is
 * range-clamped to keep the projected scene sane: position ±10000, rotation
 * ±100 (radians/turns are small in practice), scale 0.001–1000. Identity is the
 * reset, so no null sentinel is needed — omit the field to leave it unchanged.
 */
const positionVec3Schema = z.object({
  x: z.number().min(-10000).max(10000),
  y: z.number().min(-10000).max(10000),
  z: z.number().min(-10000).max(10000),
});
const rotationVec3Schema = z.object({
  x: z.number().min(-100).max(100),
  y: z.number().min(-100).max(100),
  z: z.number().min(-100).max(100),
});
export const transform3dSchema = z.object({
  position: positionVec3Schema,
  rotation: rotationVec3Schema,
});

/**
 * Bounded caption-styling + reveal fields (Milestone 3). All optional —
 * shared verbatim by the `text` member of add_overlay and by update_overlay.
 * Plain JSON; the renderer composes `fontFamily`/`fontSize`/`fontWeight` into
 * the CSS `font` string and applies background/stroke/shadow/reveal.
 */
const captionStyleFields = {
  fontFamily: z.string().max(100).optional(),
  fontSize: z.number().min(4).max(512).optional(),
  fontWeight: z
    .union([z.number().min(100).max(900), z.enum(["normal", "bold", "lighter", "bolder"])])
    .optional(),
  lineHeight: z.number().min(0.5).max(4).optional(),
  background: z
    .object({
      color: z.string().max(64),
      padding: z.number().min(0).max(200).optional(),
      radius: z.number().min(0).max(200).optional(),
    })
    .optional(),
  stroke: z
    .object({ color: z.string().max(64), width: z.number().min(0).max(64) })
    .optional(),
  shadow: z
    .object({
      color: z.string().max(64),
      blur: z.number().min(0).max(200),
      dx: z.number().min(-200).max(200).optional(),
      dy: z.number().min(-200).max(200).optional(),
    })
    .optional(),
  reveal: z
    .object({
      mode: z.enum([
        "none",
        "typewriter",
        "fade-words",
        "slide-up",
        "pop",
        "karaoke",
        "word-current",
        "flythrough",
      ]),
      fraction: z.number().min(0).max(1).optional(),
      // Wall-clock reveal duration (ms) for discovery modes (typewriter /
      // fade-words / slide-up / pop). Wins over `fraction` — the renderer derives
      // fraction from this and the overlay's own duration, so an 800ms typewriter
      // stays 800ms on an 8s clip.
      durationMs: z.number().min(50).max(60000).optional(),
      // Emphasis color for the active word in `karaoke`. CSS color string.
      highlightColor: z.string().max(64).optional(),
      // Paint-on (flythrough, 3D) sweep direction + camera side-offset/angle.
      direction: z.enum(["ltr", "rtl", "through"]).optional(),
      sideOffset: z.number().min(0.3).max(3).optional(),
    })
    .optional(),
  // Faux/real 3D extrusion for the text. Plain JSON; the renderer dispatches a
  // 3D path when present. Absent ⇒ flat 2D.
  threeD: z
    .object({
      depth: z.number().min(0).max(512),
      bevel: z.number().min(0).max(128).optional(),
      frontColor: z.string().max(64).optional(),
      sideColor: z.string().max(64).optional(),
      lighting: z.enum(["studio", "soft", "dramatic", "flat"]).optional(),
      tilt: z
        .enum(["billboard", "ground", "lowAngle", "highAngle", "angled"])
        .optional(),
    })
    .optional(),
};

/**
 * Update-side caption-style fields. Identical to {@link captionStyleFields}
 * except `background`/`stroke`/`shadow`/`reveal` accept an explicit `null`
 * sentinel meaning "clear this key" — the update path DELETEs the key from the
 * persisted overlay. (undefined/absent = leave unchanged; an object = set.)
 * Only the update schema allows null; the add schema never does.
 */
const captionStyleUpdateFields = {
  fontFamily: captionStyleFields.fontFamily,
  fontSize: captionStyleFields.fontSize,
  fontWeight: captionStyleFields.fontWeight,
  lineHeight: captionStyleFields.lineHeight,
  background: captionStyleFields.background.unwrap().nullable().optional(),
  stroke: captionStyleFields.stroke.unwrap().nullable().optional(),
  shadow: captionStyleFields.shadow.unwrap().nullable().optional(),
  reveal: captionStyleFields.reveal.unwrap().nullable().optional(),
  threeD: captionStyleFields.threeD.unwrap().nullable().optional(),
};

/**
 * Consolidated add_overlay schema. A FLAT z.object (NOT a discriminatedUnion) so
 * the MCP SDK can extract `.shape` and advertise typed properties — a union/refine
 * serializes to empty `{properties:{}}`, which breaks the agent's ability to pass
 * numeric/object args (startTime/duration/rect/z/opacity/effects). Per-kind
 * required fields (text→content, image/video→fileId) are enforced in the
 * addOverlay HANDLER, not the schema. For `code`/`three`, the optional `body`
 * seeds the JS draw/scene function (scaffolded from a starter when omitted); the
 * body persists to a per-overlay file the agent then edits. DO NOT add
 * `.superRefine`/`.refine` here — ZodEffects also has no `.shape`.
 */
export const addOverlaySchema = z.object({
  ...overlayBase,
  // Override overlayBase's required rect: for VIDEO overlays an omitted rect
  // defaults to the full composition frame (the handler fills it in). All other
  // kinds still require a rect — enforced in the addOverlay handler.
  rect: OverlayRectSchema.optional(),
  kind: z.enum(["text", "image", "video", "code", "three"]),
  // Timeline track label after the kind. MANDATORY for code/three (enforced in
  // the handler — the flat schema can't express per-kind required); optional for
  // other kinds (text shows its content, image/video show the file name).
  displayName: z.string().max(120).optional(),
  // text — all optional (no .default(): a default would make these REQUIRED in
  // the inferred output type for every kind; the text defaults live in the
  // addOverlay handler instead, so image/video/code/three callers omit them).
  content: z.string().max(5000).optional(),
  font: z.string().max(200).optional(),
  fontFileId: z.string().optional(),
  color: z.string().max(64).optional(),
  align: overlayAlignEnum.optional(),
  ...captionStyleFields,
  // image / video
  fileId: z.string().optional(),
  trim: z.object({ start: z.number(), end: z.number() }).optional(),
  // video — how the source frame fills the rect. Defaults to "cover" in the
  // handler (a full-frame video reads like a base scene).
  fit: z.enum(["cover", "contain"]).optional(),
  // code / three
  body: z.string().max(20000).optional(),
  cameraPreset: cameraPresetEnum.optional(),
  transform3d: transform3dSchema.optional(),
  // video only — `duration` is REQUIRED on this tool, so (unlike audioAddClip)
  // an explicit duration can't mean "already decided". This is the only way
  // through when the overlay would end past the piece's current end.
  lengthPolicy: z
    .enum(["extend", "trim"])
    .optional()
    .describe(
      "VIDEO overlays only. Required ONLY when startTime + duration would run past the piece's current end: 'extend' keeps the requested duration (the piece grows), 'trim' cuts the overlay at the piece's current end. Ask the user which they want before choosing.",
    ),
});
export type AddOverlayParams = z.infer<typeof addOverlaySchema>;

/** Follow offset for tracked overlays — FRACTIONS of the resolved tracked box.
 *  {x:0, y:-1} places the content one box-height ABOVE the tracked point
 *  (e.g. above the head) and rides the subject's scale. {x:0, y:0} clears it.
 *  Does NOT change the track — use re-anchor tools for wrong-subject fixes. */
export const TrackedOffsetSchema = z
  .object({
    x: z.number().min(-10).max(10),
    y: z.number().min(-10).max(10),
  })
  .describe(
    "Follow offset in fractions of the resolved tracked box ({x:0,y:-1} = one box-height above). Rides subject scale. {x:0,y:0} clears. Does NOT modify the track.",
  );

/**
 * update_overlay changes STRUCTURED fields only (timing, rect, z, opacity,
 * text content/font/color/align, three cameraPreset). It never accepts a code
 * body — `code`/`three`/tracked-`code` bodies live in files the agent edits
 * directly.
 */
export const updateOverlaySchema = z.object({
  pieceId: z.string(),
  overlayId: z.string(),
  // Rename the timeline track label (code/three; allowed on any kind). Pass an
  // empty string / null to clear.
  displayName: z.string().max(120).nullable().optional(),
  startTime: z.number().optional(),
  duration: z.number().optional(),
  // VIDEO overlays only — re-trim the source window. Syncs the linked inline
  // audio clip's trimStart (trim.start) when present.
  trim: z.object({ start: z.number(), end: z.number() }).optional(),
  // VIDEO overlays only — how the source frame fills the rect.
  fit: z.enum(["cover", "contain"]).optional(),
  rect: OverlayRectSchema.optional(),
  z: z.number().optional(),
  opacity: z.number().optional(),
  cameraPreset: cameraPresetEnum.optional(),
  transform3d: transform3dSchema.optional(),
  // "Make it 3D" gate. true → overlay enters 3D mode (orbit gizmo / out-of-plane
  // angles apply). false → force-flatten (zeros pitch/yaw + depth, drops text
  // extrusion) so the overlay truly returns to plain 2D.
  place3d: z.boolean().optional(),
  content: z.string().max(5000).optional(),
  font: z.string().max(200).optional(),
  fontFileId: z.string().optional(),
  color: z.string().max(64).optional(),
  align: overlayAlignEnum.optional(),
  ...captionStyleUpdateFields,
  // Point-text placement (TEXT overlays). `anchor` + `position` pin one of the
  // 9 anchor points of the measured text box to a composition-pixel point; the
  // derived `rect` is recomputed on save (placeBoxAtAnchor). `maxWidthPct`
  // (0..1 of frame width) caps the wrap. UI↔MCP parity — mirrors the inspector.
  anchor: captionAnchorEnum.optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  maxWidthPct: z.number().min(0).max(1).optional(),
  // `rotation` (degrees) is INPUT SUGAR — the handler converts it to
  // `transform3d.rotation.z` (the single rotation authority). No legacy storage.
  rotation: z.number().optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  // Layer OFF everywhere (the eye toggle). Persisted authoring state — the
  // overlay stays on the timeline (dimmed) but is not rendered, decoded,
  // audible, or exported. Absent ⇒ leave unchanged.
  hidden: z.boolean().optional(),
  // TRACKED overlays only — the persistent follow offset (see TrackedOffsetSchema).
  offset: TrackedOffsetSchema.optional(),
  // TRACKED overlays only — art size relative to the tracked box (1 = match the
  // fit-derived box). Written by the preview corner handles; same bound as
  // UpdateTrackedOverlaySchema. Sizing for other kinds is `rect`, never this.
  scale: z.number().positive().max(5).optional(),
  group: z.string().max(120).optional(),
  // Attach a source file's transcript word-timings to THIS overlay (any kind —
  // esp. a custom `code`/`three` caption). Reads that file's STT words, windows
  // them to the overlay's [startTime, startTime+duration], converts to
  // element-local seconds, and stores them as `caption.words`. A custom caption
  // body then voice-syncs via the injected helpers (`activeWordIndex(words,
  // time)`, `typewriterRevealedText(words, time)`) instead of embedding timings.
  // The transcript is the source of truth; caption.words is the derived snapshot.
  captionFromFileId: z.string().optional(),
});
export type UpdateOverlayParams = z.infer<typeof updateOverlaySchema>;

export const getOverlaysSchema = z.object({ pieceId: z.string() });
export type GetOverlaysParams = z.infer<typeof getOverlaysSchema>;

export const generateCaptionsSchema = z.object({
  pieceId: z.string(),
  fileId: z.string().describe("Video/audio file whose transcript drives the cues"),
  style: z
    .string()
    .optional()
    .describe(
      "Caption style = reveal mode: 'cumulative' (fade-words, default), 'karaoke', 'word-by-word', 'letter-by-letter', or 'clean'/'static' for no animation",
    ),
  anchor: z
    .enum([
      "top-left",
      "top-center",
      "top-right",
      "mid-left",
      "mid-center",
      "mid-right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ])
    .optional(),
  maxLinesPerCue: z.number().int().min(1).max(3).optional(),
  z: z.number().optional(),
});
export type GenerateCaptionsParams = z.infer<typeof generateCaptionsSchema>;

export const RemoveOverlaySchema = z.object({
  pieceId: z.string(),
  overlayId: z.string(),
});

export const ReorderOverlaysSchema = z.object({
  pieceId: z.string(),
  overlayIdsInZOrder: z.array(z.string()),
});

export type RemoveOverlayParams = z.infer<typeof RemoveOverlaySchema>;
export type ReorderOverlaysParams = z.infer<typeof ReorderOverlaysSchema>;

// ---------------------------------------------------------------------------
// Overlay keyframe animation (Phase 4 — agent authoring)
// ---------------------------------------------------------------------------
// All flat `z.object` (per the schema rule — no discriminatedUnion / .refine at
// the top level). Per-kind + bounds validation happens in the handlers. Callers
// speak SECONDS (wall-clock within the clip); handlers convert to the stored
// normalized `t`.

/**
 * `properties` names which properties to key at `time`. Omit the whole object
 * to snapshot ALL allowed properties at `time`. Each sub-field is optional.
 * `position` moves the rect; `scale` (1 = 100%) scales the rect about its
 * center; `rotation` (degrees) is an in-plane screen-roll; `opacity` 0–1;
 * `rect` / `transform3d` are passed through verbatim for full control.
 */
const keyframePropertiesSchema = z.object({
  opacity: z.number().min(0).max(1).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  scale: z.number().positive().optional(),
  rotation: z.number().optional(),
  rect: OverlayRectSchema.optional(),
  transform3d: transform3dSchema.optional(),
});

export const addKeyframeSchema = z.object({
  pieceId: z.string(),
  overlayId: z.string(),
  time: z.number().min(0).describe("Keyframe time in SECONDS within the overlay window."),
  properties: keyframePropertiesSchema.optional(),
  easing: z
    .string()
    .optional()
    .describe("Easing for the OUTGOING segment: a preset id or a cubic-bezier(a,b,c,d) literal."),
});
export type AddKeyframeParams = z.infer<typeof addKeyframeSchema>;

export const deleteKeyframeSchema = z.object({
  pieceId: z.string(),
  overlayId: z.string(),
  time: z.number().min(0).describe("Keyframe time in SECONDS to remove across all tracks."),
});
export type DeleteKeyframeParams = z.infer<typeof deleteKeyframeSchema>;

export const setKeyframeEasingSchema = z.object({
  pieceId: z.string(),
  overlayId: z.string(),
  time: z.number().min(0).describe("Keyframe time in SECONDS whose OUTGOING segment easing to set."),
  easing: z.string().describe("A preset id (e.g. \"ease-in-out\") or a cubic-bezier(a,b,c,d) literal."),
});
export type SetKeyframeEasingParams = z.infer<typeof setKeyframeEasingSchema>;

export const listKeyframesSchema = z.object({
  pieceId: z.string(),
  overlayId: z.string(),
});
export type ListKeyframesParams = z.infer<typeof listKeyframesSchema>;


export const deleteFileSchema = z.object({
  fileId: z.string().describe(
    "ID of the file to permanently delete. The user MUST have explicitly asked to delete the file (not just 'remove the audio' or 'take out that scene'). When in doubt, ask the user to confirm or use libi.audio_remove_clip / libi.delete_scene instead.",
  ),
  confirm: z.literal(true).describe(
    "Set to true to acknowledge this is a destructive, irreversible operation that erases the source file from disk and cascades to remove every scene, audio clip, and overlay that referenced it. The schema requires this exact value as a guard against accidental invocation.",
  ),
});

export type DeleteFileParams = z.infer<typeof deleteFileSchema>;

export const audioDuckEnableSchema = z.object({
  pieceId: z.string(),
  clipId: z.string().describe("The clip to apply ducking to (typically music)"),
  sidechainClipIds: z.array(z.string()).min(1).optional().describe(
    "The clips whose volume drives the duck (typically every dialogue or VO clip). Pass ALL of them — their levels are summed, so the music dips under whichever voice is speaking. There is no need to bounce several VO lines into one file first.",
  ),
  /** @deprecated Superseded by `sidechainClipIds`; still accepted so older
   *  agent transcripts and skills keep working. */
  sidechainClipId: z.string().optional().describe(
    "Deprecated — use sidechainClipIds. A single sidechain clip id, accepted as an alias for a one-element sidechainClipIds.",
  ),
  thresholdDb: z.number().min(-60).max(0).optional().describe("Sidechain threshold in dBFS, default -30"),
  ratio: z.number().min(1).max(20).optional().describe("Compression ratio, default 4"),
  attackMs: z.number().min(1).max(1000).optional().describe("Attack time in ms, default 50"),
  releaseMs: z.number().min(1).max(5000).optional().describe("Release time in ms, default 250"),
  reductionDb: z.number().min(-60).max(0).optional().describe("Max gain reduction in dB, default -12"),
});

export const audioDuckDisableSchema = z.object({
  pieceId: z.string(),
  clipId: z.string(),
});

export const audioDuckUpdateSchema = z.object({
  pieceId: z.string(),
  clipId: z.string(),
  sidechainClipIds: z.array(z.string()).min(1).optional().describe(
    "Replace the full set of clips driving the duck. Their levels are summed.",
  ),
  /** @deprecated Superseded by `sidechainClipIds`. */
  sidechainClipId: z.string().optional().describe(
    "Deprecated — use sidechainClipIds. Replaces the set with this single clip.",
  ),
  thresholdDb: z.number().min(-60).max(0).optional(),
  ratio: z.number().min(1).max(20).optional(),
  attackMs: z.number().min(1).max(1000).optional(),
  releaseMs: z.number().min(1).max(5000).optional(),
  reductionDb: z.number().min(-60).max(0).optional(),
});

export type AudioDuckEnableParams = z.infer<typeof audioDuckEnableSchema>;
export type AudioDuckDisableParams = z.infer<typeof audioDuckDisableSchema>;
export type AudioDuckUpdateParams = z.infer<typeof audioDuckUpdateSchema>;

// ---------------------------------------------------------------------------
// Analysis (per-step, fileId-keyed)
// ---------------------------------------------------------------------------

import { videoSummarySchema, frameDescriptionSchema } from "@/lib/analysis/schemas";

const ANALYSIS_KIND_ENUM = z.enum(["transcript", "summary", "frames"]);

function decodeJsonStringIfNeeded(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export const analysisGetSchema = z.object({
  fileId: z.string().describe("ID of the video file"),
  frameDetail: z
    .enum(["summary", "full"])
    .optional()
    .describe(
      'How much keyframe data to return. "summary" (default) omits each frame\'s full ' +
        "description to stay within the tool token budget (use libi.analysis_search_frames " +
        'for details); "full" returns every frame\'s complete description.',
    ),
});

export const analysisExtractAudioSchema = z.object({
  fileId: z.string().describe("ID of the video file"),
  sampleRate: z.number().int().positive().optional().describe("Output sample rate (default 16000)"),
});

export const analysisExtractFramesSchema = z.object({
  fileId: z.string().describe("ID of the video file"),
  count: z.coerce.number().int().positive().max(64).optional().describe("Number of evenly-spaced frames (default 8). Pass as a NUMBER, not a string."),
  timestamps: z.array(z.coerce.number().nonnegative()).optional().describe("Explicit timestamps in seconds (overrides count)"),
  width: z.coerce.number().int().positive().optional().describe("Output frame width in pixels (default 640)"),
});


const saveFrameItemSchema = z.object({
  frameIndex: z.coerce.number().int().nonnegative().describe("Zero- or one-based frame ordinal (preserve from extract_frames output)"),
  timestamp: z.coerce.number().nonnegative().describe("Frame timestamp in seconds"),
  filePath: z.string().describe("Frame filename relative to the frames dir, e.g. 'frame-0001.png'"),
  description: z.preprocess(decodeJsonStringIfNeeded, frameDescriptionSchema).optional().describe("Structured FrameDescription (frame_v1). Required unless skipped=true."),
  skipped: z.boolean().optional().describe("Mark this frame as skipped (e.g. black frame). Provide skipReason."),
  skipReason: z.string().optional().describe("Reason this frame was skipped"),
  custom: z.record(z.unknown()).optional().describe("Freeform per-frame custom bag"),
});

export const analysisSaveFramesSchema = z.object({
  fileId: z.string().describe("ID of the video file"),
  frames: z.array(saveFrameItemSchema).describe(
    "Keyframes to save. UPSERT SEMANTICS, matched by frameIndex: a frame whose index already exists is updated; a new index is inserted; frames NOT included in this batch are left untouched (never deleted). Safe to call repeatedly — process long videos in batches of 10–20 frames. To wipe all keyframes before re-extracting at a different density, call analysis_remove_step (kind: 'frames') first.",
  ),
});

export const analysisSaveSummarySchema = z.object({
  fileId: z.string().describe("ID of the video file"),
  summary: z.preprocess(decodeJsonStringIfNeeded, videoSummarySchema).describe(
    "Structured VideoSummary (schema_version: 'video_v1'). Pass as a structured OBJECT, not a JSON string.",
  ),
});

export const analysisTranscribeAudioSchema = z.object({
  fileId: z.string().describe("ID of the video or audio file"),
  retry: z.boolean().optional().describe("If true, only re-process chunks with status='failed' or 'not_started'. Default false."),
  chunkSeconds: z.number().int().positive().optional().describe("Chunk length in seconds. Default 600 (10 minutes)."),
  provider: z.enum(["whisper", "elevenlabs"]).optional().describe("STT provider. Default 'whisper' (local, free). 'elevenlabs' for diarization/audio-events or on explicit user request."),
  model: z.string().optional().describe("Whisper model id (tiny|base|small|medium|large-v3). Ignored for elevenlabs. Default 'small'."),
});

export const analysisChunkAudioSchema = z.object({
  fileId: z.string().describe("ID of the video or audio file"),
  chunkSeconds: z.number().int().positive().optional().describe("Chunk length in seconds. Default 600."),
});

export const analysisSaveAudioChunkSchema = z.object({
  chunkId: z.string().describe("ID returned from libi.analysis_chunk_audio"),
  text: z.string().describe("Transcribed text for this chunk"),
  words: z.array(z.object({
    text: z.string(),
    start: z.number(),
    end: z.number(),
    type: z.string().optional(),
    speaker_id: z.string().nullable().optional(),
  })).describe("Word-level timing entries. Pass chunk-relative timestamps; server offsets them to source audio."),
  language: z.string().optional(),
  languageProbability: z.number().optional(),
});

export const analysisSaveAudioChunkFromFileSchema = z.object({
  chunkId: z.string().describe("ID returned from libi.analysis_chunk_audio"),
  jsonPath: z.string().describe("Absolute path to a JSON file containing { text, words: [...], language_code?, language_probability? }. Same shape as ElevenLabs returns."),
});

export const analysisGetAudioChunksSchema = z.object({
  fileId: z.string().describe("ID of the video or audio file"),
});

export type AnalysisTranscribeAudioParams = z.infer<typeof analysisTranscribeAudioSchema>;
export type AnalysisChunkAudioParams = z.infer<typeof analysisChunkAudioSchema>;
export type AnalysisSaveAudioChunkParams = z.infer<typeof analysisSaveAudioChunkSchema>;
export type AnalysisSaveAudioChunkFromFileParams = z.infer<typeof analysisSaveAudioChunkFromFileSchema>;
export type AnalysisGetAudioChunksParams = z.infer<typeof analysisGetAudioChunksSchema>;

export const analysisMarkStepFailedSchema = z.object({
  fileId: z.string().describe("ID of the video file"),
  kind: ANALYSIS_KIND_ENUM.describe("Which step to mark as failed"),
  errorMessage: z.string().min(1).describe("Why the step failed (shown to the user in the analysis tab)"),
});

export const analysisRemoveStepSchema = z.object({
  fileId: z.string().describe("ID of the video file"),
  kind: ANALYSIS_KIND_ENUM.describe("Which step to delete (cascades keyframes if kind=frames)"),
});

export const analysisSearchFramesSchema = z.object({
  fileId: z.string().describe("ID of the video file"),
  subject: z.string().optional().describe("Match frames where people[*].id equals this value"),
  objects: z.array(z.string()).optional().describe("ALL named objects must appear in description.objects[].name"),
  text_contains: z.string().optional().describe("Case-insensitive substring match against description.text_on_screen[]"),
  tags: z.array(z.string()).optional().describe("ALL tags must appear in description.tags[]"),
  time_range: z.tuple([z.number(), z.number()]).optional().describe("Inclusive [startSec, endSec] range filter on frame timestamp"),
  shot: z.enum(["close-up", "medium", "wide", "extreme-wide"]).optional().describe("Match frames with this camera shot"),
});

export const analysisSearchTranscriptSchema = z.object({
  fileId: z.string().describe("ID of the video file"),
  query: z.string().describe("Substring to match against transcript words. Case-insensitive."),
  limit: z.number().int().positive().max(500).optional().describe("Max matches to return (default 50)"),
});

export const analysisUpdateSummaryCustomSchema = z.object({
  fileId: z.string().describe("ID of the video file"),
  path: z.string().min(1).describe("Key within summary.custom to set"),
  value: z.unknown().describe("Value to assign (any JSON-serializable value)"),
});

export const extraAnalysisModelInputSchema = z.object({
  fileId: z.string().min(1).describe("The video file's id."),
  pieceId: z.string().min(1).optional().describe("Optional piece scope."),
  providerId: z
    .string()
    .min(1)
    .optional()
    .describe("Script provider id (defaults to the first configured provider)."),
  modelId: z
    .string()
    .min(1)
    .optional()
    .describe("Provider-specific model id (defaults to the provider's defaultModelId)."),
  regenerate: z
    .boolean()
    .optional()
    .describe(
      "When true, run a fresh job even if a script for this (providerId, modelId) already exists.",
    ),
  focus: z
    .enum(["script", "captions"])
    .optional()
    .describe(
      "What the analysis should describe. 'script' (default) = full production script. 'captions' = a per-caption recreation spec (words, 3D-vs-flat treatment, motion keyframes, reveal) for mimicking on-screen text.",
    ),
});

export type AnalysisGetParams = z.infer<typeof analysisGetSchema>;
export type AnalysisExtractAudioParams = z.infer<typeof analysisExtractAudioSchema>;
export type AnalysisExtractFramesParams = z.infer<typeof analysisExtractFramesSchema>;
export type AnalysisSaveFramesParams = z.infer<typeof analysisSaveFramesSchema>;
export type AnalysisSaveSummaryParams = z.infer<typeof analysisSaveSummarySchema>;
export type AnalysisMarkStepFailedParams = z.infer<typeof analysisMarkStepFailedSchema>;
export type AnalysisRemoveStepParams = z.infer<typeof analysisRemoveStepSchema>;
export type AnalysisSearchFramesParams = z.infer<typeof analysisSearchFramesSchema>;
export type AnalysisSearchTranscriptParams = z.infer<typeof analysisSearchTranscriptSchema>;
export type AnalysisUpdateSummaryCustomParams = z.infer<typeof analysisUpdateSummaryCustomSchema>;
export type ExtraAnalysisModelParams = z.infer<typeof extraAnalysisModelInputSchema>;

// ---------------------------------------------------------------------------
// Memories + instruction-override tools
// ---------------------------------------------------------------------------

export const updateMemoriesSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(8000)
    .describe("The memory text to append, or the FULL new memories file when mode is 'replace'."),
  mode: z
    .enum(["append", "replace"])
    .optional()
    .describe("append (default) = add one memory at the end; replace = rewrite the whole file."),
});

export type UpdateMemoriesParams = z.infer<typeof updateMemoriesSchema>;

export const overrideInstructionsSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe("The FULL new base-instructions document (markdown), not a diff."),
});

export type OverrideInstructionsParams = z.infer<typeof overrideInstructionsSchema>;

// ---------------------------------------------------------------------------
// MCP status / settings navigation tools
// ---------------------------------------------------------------------------

export const listBundledMcpsSchema = z.object({});

export const showMcpSettingsSchema = z.object({
  mcpId: z.string().optional().describe("Optional bundled MCP id (e.g. 'elevenlabs') to focus and scroll to in the settings page"),
});

export type ListBundledMcpsParams = z.infer<typeof listBundledMcpsSchema>;
export type ShowMcpSettingsParams = z.infer<typeof showMcpSettingsSchema>;

export const retryMcpServerSchema = z.object({
  mcpId: z.string().min(1).describe("ID of the MCP server to re-probe (e.g. 'elevenlabs')"),
});
export type RetryMcpServerParams = z.infer<typeof retryMcpServerSchema>;

// ---------------------------------------------------------------------------
// Tier-2 bundled-MCP install flow tools (agent-driven install)
// ---------------------------------------------------------------------------

export const getInstallPlanSchema = z.object({
  mcpId: z.string().describe("ID of the bundled MCP (e.g. 'youtube-downloader')"),
});

export const updateDepStatusSchema = z.object({
  mcpId: z.string().describe("ID of the bundled MCP being updated"),
  status: z
    .enum(["not_installed", "installing", "installed", "failed", "needs_config"])
    .describe("New install status"),
  version: z.string().optional().describe("Version string ('0.8.4', '2026.03.17')"),
  error: z.string().optional().describe("Error message — only when status='failed'"),
  env: z
    .record(z.string())
    .optional()
    .describe("Env vars to merge into the MCP row (API keys, etc.)"),
});

export const recheckMcpSchema = z.object({
  mcpId: z.string().describe("ID of the bundled MCP to probe"),
});

export const restartAcpSessionSchema = z.object({});

export const diagnoseMcpSchema = z.object({
  mcpId: z.string().describe("ID of the bundled MCP to diagnose (e.g. 'youtube-downloader')"),
});

export const restartMcpServerSchema = z.object({
  mcpId: z.string().describe("ID of the bundled MCP to restart"),
});

export type GetInstallPlanParams = z.infer<typeof getInstallPlanSchema>;
export type UpdateDepStatusParams = z.infer<typeof updateDepStatusSchema>;
export type RecheckMcpParams = z.infer<typeof recheckMcpSchema>;
export type RestartAcpSessionParams = z.infer<typeof restartAcpSessionSchema>;
export type DiagnoseMcpParams = z.infer<typeof diagnoseMcpSchema>;
export type RestartMcpServerParams = z.infer<typeof restartMcpServerSchema>;

// ---------------------------------------------------------------------------
// Canvas dimension tools
// ---------------------------------------------------------------------------

export const retrieveAssetsDimensionsSchema = z.object({
  pieceId: z.string().min(1),
});
export type RetrieveAssetsDimensionsParams = z.infer<typeof retrieveAssetsDimensionsSchema>;

export const updateCompositionDimensionsSchema = z.object({
  pieceId: z.string().min(1),
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(7680),
});
export type UpdateCompositionDimensionsParams = z.infer<typeof updateCompositionDimensionsSchema>;

// ---------------------------------------------------------------------------
// Skill management + MCP discovery tools
// ---------------------------------------------------------------------------

export const listSkillsSchema = z.object({}).describe(
  "List all skills (bundled + user) with enabled state",
);
export type ListSkillsParams = z.infer<typeof listSkillsSchema>;

export const addSkillSchema = z.object({
  name: z.string().min(1).max(64).describe(
    "Kebab-case name (must match SKILL.md frontmatter name)",
  ),
  description: z.string().min(1).describe(
    "One-line description shown in the Settings UI",
  ),
  body: z.string().min(1).describe(
    "Full SKILL.md contents including YAML frontmatter",
  ),
});
export type AddSkillParams = z.infer<typeof addSkillSchema>;

export const updateSkillSchema = z.object({
  name: z.string().min(1).max(64).describe(
    "Kebab-case name of the skill (user or bundled-with-override; must match SKILL.md frontmatter name)",
  ),
  body: z.string().min(1).describe(
    "Full SKILL.md contents including YAML frontmatter — replaces the existing body or creates an override of a bundled skill",
  ),
});
export type UpdateSkillParams = z.infer<typeof updateSkillSchema>;

export const removeSkillSchema = z.object({
  id: z.string().describe(
    "ID of the user skill to remove (bundled skills cannot be removed)",
  ),
});
export type RemoveSkillParams = z.infer<typeof removeSkillSchema>;

export const setSkillEnabledSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
});
export type SetSkillEnabledParams = z.infer<typeof setSkillEnabledSchema>;

export const listMcpServersSchema = z.object({}).describe(
  "List enabled MCP servers — names, descriptions, install status (no secrets)",
);
export type ListMcpServersParams = z.infer<typeof listMcpServersSchema>;

export const listSkillPromptsSchema = z.object({
  skillName: z.string().min(1).describe("Kebab-case name of the skill whose prompt files to list"),
});
export type ListSkillPromptsParams = z.infer<typeof listSkillPromptsSchema>;

export const addSkillPromptSchema = z.object({
  skillName: z.string().min(1).describe("Kebab-case name of the USER skill to add a prompt file to"),
  name: z.string().min(1).max(64).describe("Kebab-case prompt file name (no extension, no slashes)"),
  body: z.string().min(1).describe("Markdown contents of the prompt file"),
});
export type AddSkillPromptParams = z.infer<typeof addSkillPromptSchema>;

export const updateSkillPromptSchema = z.object({
  skillName: z.string().min(1).describe("Kebab-case name of the USER skill to update a prompt file on"),
  name: z.string().min(1).max(64).describe("Kebab-case prompt file name (no extension, no slashes)"),
  body: z.string().min(1).describe("New markdown contents of the prompt file"),
});
export type UpdateSkillPromptParams = z.infer<typeof updateSkillPromptSchema>;

export const removeSkillPromptSchema = z.object({
  skillName: z.string().min(1).describe("Kebab-case name of the user skill"),
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "Kebab-case prompt name, no slashes").describe("Kebab-case prompt file name (no extension, no slashes)"),
});
export type RemoveSkillPromptParams = z.infer<typeof removeSkillPromptSchema>;

// ─── Catalog (characters + items) ────────────────────────────────────────────
const catalogBbox = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  w: z.number().positive(),
  h: z.number().positive(),
});

export const ListCharactersSchema = z.object({
  query: z.string().optional().describe("Case-insensitive substring of the character name"),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type ListCharactersParams = z.infer<typeof ListCharactersSchema>;

export const GetCharacterSchema = z.object({ id: z.string().min(1) });
export type GetCharacterParams = z.infer<typeof GetCharacterSchema>;

export const CreateCharacterSchema = z.object({
  name: z.string().min(1).describe("Unique name across all characters"),
  description: z.string().optional(),
  nameSetByUser: z.boolean().optional(),
  fromAsset: z
    .object({
      fileId: z.string().min(1),
      bbox: catalogBbox,
      frameTime: z.number().nonnegative().optional().describe("Required when source is a video"),
    })
    .optional()
    .describe("If provided, server crops the bbox region as the representative image"),
  representativeImageFileId: z
    .string()
    .min(1)
    .optional()
    .describe("Use an existing file as the rep image (ignored if fromAsset is set)"),
});
export type CreateCharacterParams = z.infer<typeof CreateCharacterSchema>;

export const UpdateCharacterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  representativeImageFileId: z.string().nullable().optional(),
  nameSetByUser: z.boolean().optional(),
});
export type UpdateCharacterParams = z.infer<typeof UpdateCharacterSchema>;

export const DeleteCharacterSchema = z.object({
  id: z.string().min(1),
  deleteAssets: z.boolean().optional().describe("If true, also delete every linked asset file"),
});
export type DeleteCharacterParams = z.infer<typeof DeleteCharacterSchema>;

export const LinkCharacterToAssetSchema = z.object({
  characterId: z.string().min(1),
  fileId: z.string().min(1),
});
export type LinkCharacterToAssetParams = z.infer<typeof LinkCharacterToAssetSchema>;

export const UnlinkCharacterFromAssetSchema = LinkCharacterToAssetSchema;
export type UnlinkCharacterFromAssetParams = z.infer<typeof UnlinkCharacterFromAssetSchema>;

// ─── Items mirror ────────────────────────────────────────────
export const ListItemsSchema = ListCharactersSchema;
export type ListItemsParams = z.infer<typeof ListItemsSchema>;
export const GetItemSchema = GetCharacterSchema;
export type GetItemParams = z.infer<typeof GetItemSchema>;
export const CreateItemSchema = CreateCharacterSchema;
export type CreateItemParams = z.infer<typeof CreateItemSchema>;
export const UpdateItemSchema = UpdateCharacterSchema;
export type UpdateItemParams = z.infer<typeof UpdateItemSchema>;
export const DeleteItemSchema = DeleteCharacterSchema;
export type DeleteItemParams = z.infer<typeof DeleteItemSchema>;
export const LinkItemToAssetSchema = z.object({ itemId: z.string().min(1), fileId: z.string().min(1) });
export type LinkItemToAssetParams = z.infer<typeof LinkItemToAssetSchema>;
export const UnlinkItemFromAssetSchema = LinkItemToAssetSchema;
export type UnlinkItemFromAssetParams = z.infer<typeof UnlinkItemFromAssetSchema>;


// ---------------------------------------------------------------------------
// Object tracking + tracked overlay tools
// ---------------------------------------------------------------------------

const TrackedContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("emoji"), char: z.string().min(1) }),
  z.object({
    kind: z.literal("text"),
    content: z.string().min(1),
    font: z.string().min(1),
    color: z.string().min(1),
    align: z.enum(["left", "center", "right"]),
  }),
  z.object({ kind: z.literal("image"), fileId: z.string().min(1) }),
  z.object({
    kind: z.literal("video"),
    fileId: z.string().min(1),
    trim: z.object({ start: z.number().nonnegative(), end: z.number().positive() }).optional(),
  }),
  z.object({ kind: z.literal("code"), drawFunction: z.string().min(1) }),
  z.object({ kind: z.literal("effect"), op: z.enum(["blur", "pixelate", "mask"]) }),
]);

const anchorSchema = z.object({
  fileId: z.string().min(1),
  time: z.number().nonnegative(),
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .describe("[x, y, w, h] in source-frame pixels"),
});

// Shared fields between ComputeObjectTrackSchema and ComputeObjectTrackProvidersSchema.
// The only delta between the two schemas is the `provider` field added by the providers variant.
const baseTrackingFields = {
  fileId: z.string().min(1),
  objectKind: z.enum(["face", "object"] as const),
  /**
   * Kept for back-compat with prior callers — informational only. The tracker
   * now identifies the subject from `anchors[]`, not this hint.
   */
  subjectQuery: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Informational free-form hint shown in logs. NOT used to disambiguate detections — pass anchors[] for that.",
    ),
  label: z.string().optional(),
  /** Optional: cap fps for speed; default = source fps. */
  fps: z.number().int().positive().optional(),
  /** Optional link to a character/item catalog row. */
  subjectId: z.string().optional(),
  classes: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional target object class(es). Default ['person']. A non-person " +
        "class (e.g. ['backpack']) auto-routes to the generalized YOLOE-VP " +
        "detector server-side — no method change needed. Identity is still " +
        "from anchors[] + the normal repair loop. " +
        "Applies to compute_object_track (local engine); ignored by external-provider tracking.",
    ),
  anchors: z
    .array(anchorSchema)
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Reference frame(s) of the subject to track in source-frame pixels. " +
        "Optional when derivedFromSubjectName or derivedFromItemName is set — the server then " +
        "derives anchors from analysis keyframes automatically. Accepts up to 100 entries. " +
        "Manual anchors win over derived anchors when times overlap within 0.1s.",
    ),
  derivedFromSubjectName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Derive anchors from analyzed keyframes containing a person with this name. " +
        "Merged with any explicit anchors (manual wins on time collision within 0.1s). " +
        "Requires prior analysis with people[].bbox populated.",
    ),
  derivedFromItemName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Derive anchors from analyzed keyframes containing an object with this name. " +
        "Merged with any explicit anchors (manual wins on time collision within 0.1s). " +
        "Requires prior analysis with objects[].bbox populated.",
    ),
  forceNew: z
    .boolean()
    .optional()
    .describe(
      "If true, ignore any partial/cached result for the same (fileId, anchors, fps) " +
        "and start tracking from frame 0. Default false — the tool resumes from the last " +
        "checkpoint when a prior attempt was interrupted.",
    ),
};

// Shared refine predicate — at least one anchor source must be provided.
export const refineAtLeastOneAnchorSource = (v: {
  anchors?: unknown[];
  derivedFromSubjectName?: string;
  derivedFromItemName?: string;
}) =>
  (v.anchors !== undefined && v.anchors.length > 0) ||
  v.derivedFromSubjectName !== undefined ||
  v.derivedFromItemName !== undefined;

export const REFINE_ANCHOR_MESSAGE =
  "At least one of anchors, derivedFromSubjectName, or derivedFromItemName must be provided.";

const providerField = {
  provider: z
    .enum(["sam2-fal"])
    .describe(
      "External tracking provider. Currently only 'sam2-fal' is supported. " +
        "Requires FAL_KEY configured in Settings → MCP Servers → fal-ai.",
    ),
};

/**
 * RAW SHAPES for MCP tool registration.
 *
 * These MUST be registered as the tool `inputSchema` (NOT the `.refine()`
 * wrapped schemas below). The MCP SDK's `normalizeObjectSchema` only emits a
 * JSON schema when the schema is a raw shape or a ZodObject with `.shape`.
 * A Zod-v3 `.refine()` produces a `ZodEffects` with NO `.shape`, so the SDK
 * silently publishes an EMPTY inputSchema — the agent then sees a
 * parameterless tool and blind-guesses arguments. The cross-field
 * "at least one anchor source" rule is enforced in the tool handlers via
 * `refineAtLeastOneAnchorSource` instead.
 */
export const ComputeObjectTrackShape = baseTrackingFields;
export const ComputeObjectTrackProvidersShape = {
  ...baseTrackingFields,
  ...providerField,
};

// Kept for `z.infer` type derivation and any server-side `.parse()`. Do NOT
// pass these to `server.registerTool({ inputSchema })` — see the note above.
export const ComputeObjectTrackSchema = z
  .object(baseTrackingFields)
  .refine(refineAtLeastOneAnchorSource, { message: REFINE_ANCHOR_MESSAGE });

export const ComputeObjectTrackProvidersSchema = z
  .object({
    ...baseTrackingFields,
    ...providerField,
  })
  .refine(refineAtLeastOneAnchorSource, { message: REFINE_ANCHOR_MESSAGE });

export const AddTrackedOverlaySchema = z.object({
  pieceId: z.string().min(1),
  trackId: z.string().min(1),
  startTime: z.number().nonnegative(),
  duration: z.number().positive(),
  rect: OverlayRectSchema,
  z: z.number().int(),
  opacity: z.number().min(0).max(1),
  content: TrackedContentSchema,
  fit: z.enum(["tight", "head", "rect"]),
  scale: z.number().positive().max(5),
  smoothing: z.enum(["linear", "catmull-rom", "kalman"]).describe(
    "Sub-frame INTERPOLATION between (already position-stabilized) samples — NOT a denoiser; it cannot remove tracker jitter (that is positionMode's job). linear = recommended default; catmull-rom = spline (can overshoot at direction changes); kalman = deprecated, behaves as linear.",
  ),
  offset: TrackedOffsetSchema.optional(),
  sizeMode: z.enum(["stabilized", "raw"]).optional().describe(
    "stabilized (default) damps box-size jitter: clamps outlier boxes AND median-smooths width/height over time (~7 frames) so the overlay neither balloons nor pulses as the detector flaps between tighter/looser boxes; the box edge implied by the offset direction (e.g. the TOP edge when the overlay sits above the subject) is held fixed while resizing, which also removes the vertical bounce the size flap would otherwise inject. raw uses tracker sizes verbatim.",
  ),
  maxBoxScale: z.number().min(1).max(4).optional().describe(
    "Max factor a single frame's box may exceed the track's median size before it is clamped. Lower = stricter. Only used when sizeMode is stabilized. Default 1.75.",
  ),
  positionMode: z.enum(["stabilized", "raw"]).optional().describe(
    "stabilized (default) applies render-time One-Euro smoothing to the tracked box CENTER so the overlay does not bounce with per-frame tracker jitter (steady when the subject is still, no lag on fast motion); raw follows sample positions verbatim (deliberate-bounce escape hatch).",
  ),
  acknowledgeQualityIssues: z
    .boolean()
    .optional()
    .describe(
      "Set true ONLY after you have inspected summary.issues and decided to attach anyway " +
      "(e.g. the lost range was skip_segment'd). Without it, attaching to a flagged track is refused.",
    ),
});

export const UpdateTrackedOverlaySchema = z.object({
  pieceId: z.string().min(1),
  overlayId: z.string().min(1),
  startTime: z.number().nonnegative().optional(),
  duration: z.number().positive().optional(),
  rect: OverlayRectSchema.optional(),
  z: z.number().int().optional(),
  opacity: z.number().min(0).max(1).optional(),
  trackId: z.string().min(1).optional(),
  content: TrackedContentSchema.optional(),
  fit: z.enum(["tight", "head", "rect"]).optional(),
  scale: z.number().positive().max(5).optional(),
  smoothing: z.enum(["linear", "catmull-rom", "kalman"]).optional().describe(
    "Sub-frame INTERPOLATION between (already position-stabilized) samples — NOT a denoiser; it cannot remove tracker jitter (that is positionMode's job). linear = recommended default; catmull-rom = spline (can overshoot at direction changes); kalman = deprecated, behaves as linear.",
  ),
  offset: TrackedOffsetSchema.optional(),
  sizeMode: z.enum(["stabilized", "raw"]).optional().describe(
    "stabilized (default) damps box-size jitter: clamps outlier boxes AND median-smooths width/height over time (~7 frames) so the overlay neither balloons nor pulses as the detector flaps between tighter/looser boxes; the box edge implied by the offset direction (e.g. the TOP edge when the overlay sits above the subject) is held fixed while resizing, which also removes the vertical bounce the size flap would otherwise inject. raw uses tracker sizes verbatim.",
  ),
  maxBoxScale: z.number().min(1).max(4).optional().describe(
    "Max factor a single frame's box may exceed the track's median size before it is clamped. Lower = stricter. Only used when sizeMode is stabilized. Default 1.75.",
  ),
  positionMode: z.enum(["stabilized", "raw"]).optional().describe(
    "stabilized (default) applies render-time One-Euro smoothing to the tracked box CENTER so the overlay does not bounce with per-frame tracker jitter (steady when the subject is still, no lag on fast motion); raw follows sample positions verbatim (deliberate-bounce escape hatch).",
  ),
});

export const DeleteTrackSchema = z.object({ trackId: z.string().min(1) });
export const ListTracksSchema = z.object({ fileId: z.string().min(1) });

export const UpdateTrackResultSchema = z.object({
  fileId: z.string().min(1).describe(
    "Source file the samples were tracked against. The file must be assigned to a piece.",
  ),
  trackId: z.string().min(1).optional().describe(
    "Pre-existing track to replace. If omitted, a fresh trackId is allocated and returned. v1 semantics are replace-only — calling with the same trackId twice discards the prior samples.",
  ),
  label: z.string().optional(),
  subjectId: z.string().optional(),
  method: z.string().min(1).describe(
    "Free-form identifier for the tracker that produced these samples (e.g. 'sam2-local', 'external-mcp:my-tracker'). Stored as-is in the track row.",
  ),
  framerate: z.number().positive(),
  samples: z.array(z.object({
    t: z.number().nonnegative(),
    x: z.number(),
    y: z.number(),
    w: z.number().nonnegative(),
    h: z.number().nonnegative(),
    confidence: z.number().min(0).max(1).default(1),
    visible: z.boolean(),
    subjectId: z.string().nullable().optional(),
  })).min(1).describe(
    "Per-frame samples in pixel coordinates. The samples array shape mirrors libi's internal TrackSample type so it's identical to what compute_object_track produces.",
  ),
  anchors: z.array(anchorSchema).optional().describe(
    "Optional anchor reference list — what the external tracker used as input.",
  ),
});

export type ComputeObjectTrackParams = z.infer<typeof ComputeObjectTrackSchema>;
export type ComputeObjectTrackProvidersParams = z.infer<typeof ComputeObjectTrackProvidersSchema>;
export type AddTrackedOverlayParams = z.infer<typeof AddTrackedOverlaySchema>;
export type UpdateTrackedOverlayParams = z.infer<typeof UpdateTrackedOverlaySchema>;
export type DeleteTrackParams = z.infer<typeof DeleteTrackSchema>;
export type ListTracksParams = z.infer<typeof ListTracksSchema>;
export type UpdateTrackResultParams = z.infer<typeof UpdateTrackResultSchema>;

// ---------------------------------------------------------------------------
// Per-segment composable tracking tools
// ---------------------------------------------------------------------------

const SegRangeSchema = z
  .object({ start: z.number().nonnegative(), end: z.number().positive() })
  .refine((r) => r.end > r.start, { message: "range.end must be > range.start" });

const SegAnchorsSchema = z
  .array(
    z.object({
      fileId: z.string().min(1),
      time: z.number().nonnegative(),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    }),
  )
  .min(1)
  .max(100);

export const ComputeTrackSegmentSchema = z.object({
  fileId: z.string().min(1),
  trackId: z.string().min(1).optional(),
  range: SegRangeSchema,
  method: z.enum(["yoloe+botsort", "yoloe-text", "sot"]),
  classes: z.array(z.string().min(1)).optional(),
  anchors: SegAnchorsSchema,
  objectKind: z
    .enum(["face", "object"])
    .optional()
    .describe(
      "'face' → keep the robust person track for identity but emit the HEAD " +
        "sub-region derived from the person's segmentation silhouette (stable " +
        "through dance/raised arms, never the torso/body). Default 'object'.",
    ),
  fps: z.number().int().positive().optional(),
  label: z.string().optional(),
  subjectId: z.string().optional(),
  forceNew: z.boolean().optional(),
});

export const SkipSegmentSchema = z.object({
  trackId: z.string().min(1),
  range: SegRangeSchema,
  reason: z.string().min(1),
});

export const ListTrackSegmentsSchema = z.object({ trackId: z.string().min(1) });

export type ComputeTrackSegmentParams = z.infer<typeof ComputeTrackSegmentSchema>;
export type SkipSegmentParams = z.infer<typeof SkipSegmentSchema>;
export type ListTrackSegmentsParams = z.infer<typeof ListTrackSegmentsSchema>;

// ---------------------------------------------------------------------------
// Identity-candidate disambiguation (list + pick)
// ---------------------------------------------------------------------------

export const ListIdentityCandidatesSchema = z.object({
  trackId: z.string().min(1),
  range: SegRangeSchema,
});
export type ListIdentityCandidatesParams = z.infer<typeof ListIdentityCandidatesSchema>;

export const PickCandidateSchema = z.object({
  trackId: z.string().min(1),
  range: SegRangeSchema,
  candidateId: z.number().int(),
});
export type PickCandidateParams = z.infer<typeof PickCandidateSchema>;

export const RefineTrackWithSam2Schema = z.object({
  trackId: z.string().min(1).describe("ID of the existing track to refine with SAM2 masks."),
  range: z
    .object({
      start: z.number().nonnegative().describe("Start time in seconds"),
      end: z.number().positive().describe("End time in seconds"),
    })
    .optional()
    .describe(
      "Optional time range to refine. If omitted, refines the entire visible span of the track.",
    ),
});
export type RefineTrackWithSam2Params = z.infer<typeof RefineTrackWithSam2Schema>;

// ---------------------------------------------------------------------------
// Stage-0 grounding (set-of-marks)
// ---------------------------------------------------------------------------

export const GroundTargetSchema = z.object({
  fileId: z.string().min(1).describe("ID of the video file to probe"),
  time: z.number().nonnegative().describe("Timestamp in seconds at which to detect candidate objects"),
  classes: z.array(z.string().min(1)).optional().describe("Object classes to detect (default: [\"person\"])"),
});
export type GroundTargetParams = z.infer<typeof GroundTargetSchema>;

// Background removal (cutout generation)
// ---------------------------------------------------------------------------

// PLAIN z.object only (no .refine / discriminatedUnion at top level — those
// serialize to an empty {properties:{}} through the MCP SDK). Cross-field
// rules (box required when kind:"box") are enforced in the handler.
export const RemoveBackgroundSchema = z.object({
  fileId: z.string().min(1).describe("Video file to cut out (photos use the fal birefnet path — see the removing-and-replacing-backgrounds skill)"),
  engine: z
    .enum(["local", "fal"])
    .optional()
    .describe("local (default) = free MatAnyone matte on this machine. fal = paid provider path; NOT run by this tool — it returns the agent-driven fal instructions instead"),
  subject: z
    .object({
      kind: z.enum(["auto", "box"]).describe("auto = largest person instance; box = an explicit subject box"),
      box: z
        .tuple([z.number(), z.number(), z.number(), z.number()])
        .optional()
        .describe("[x, y, w, h] in frame pixels — take it from a libi.ground_target candidate, never hand-guess"),
    })
    .optional()
    .describe("Subject seed. Omit for auto (single obvious person)"),
  range: z
    .object({
      start: z.number().nonnegative(),
      end: z.number().positive(),
    })
    .optional()
    .describe("Time window in seconds; omit for the whole clip"),
  forceNew: z
    .boolean()
    .optional()
    .describe("Skip job dedupe and recompute (e.g. after the source changed)"),
});
export type RemoveBackgroundParams = z.infer<typeof RemoveBackgroundSchema>;

// Tracking engine install verification
// ---------------------------------------------------------------------------

export const VerifyInstallSchema = z.object({});
export type VerifyInstallParams = z.infer<typeof VerifyInstallSchema>;

export const installTrackingEngineSchema = z.object({
  force: z
    .boolean()
    .optional()
    .describe(
      "Re-run the installer even though the engine already looks installed. Normally unnecessary — every artifact is sha-pinned and the installer is idempotent, so a plain re-call resumes/repairs a partial install on its own. If an install is ALREADY running this attaches to it and reports its progress instead of restarting; cancel that job first (libi.cancel_job) if you genuinely mean to start over.",
    ),
});
export type InstallTrackingEngineParams = z.infer<
  typeof installTrackingEngineSchema
>;

// Background jobs — generic status + cancel
// ---------------------------------------------------------------------------

export const GetJobStatusSchema = z.object({
  jobId: z.string().min(1),
});
export type GetJobStatusParams = z.infer<typeof GetJobStatusSchema>;

export const CancelJobSchema = z.object({
  jobId: z.string().min(1),
});
export type CancelJobParams = z.infer<typeof CancelJobSchema>;

export const ListJobsSchema = z.object({
  status: z
    .enum(["running", "queued", "completed", "failed", "cancelled"])
    .optional()
    .describe(
      "Filter by lifecycle state. Omit for all. Use 'running' to answer 'is anything still working?'",
    ),
  kind: z
    .string()
    .optional()
    .describe(
      "Filter by runner kind, e.g. 'music_model_download', 'export_render', 'tracking'.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max rows, newest first. Defaults to 20."),
});
export type ListJobsParams = z.infer<typeof ListJobsSchema>;

// ===== Snapshot / Draft tools =====

export const getPieceStateSchema = z.object({
  pieceId: z.string().describe("ID of the piece to query"),
});
export type GetPieceStateParams = z.infer<typeof getPieceStateSchema>;

export const commitDraftSchema = z.object({
  pieceId: z.string().describe("ID of the piece whose draft should become the new snapshot"),
  summary: z.string().optional().describe("Short one-line description of what changed. If omitted, a default is used."),
  acknowledgeUnvalidated: z
    .boolean()
    .optional()
    .describe(
      "Override the validation gate. Commit refuses by default when AI-generated video clips on the timeline have no completed analysis (extract frames → vision-read → save_frames → save_summary). Set true ONLY when the user has explicitly accepted committing un-validated generated clips.",
    ),
});
export type CommitDraftParams = z.infer<typeof commitDraftSchema>;

export const discardDraftSchema = z.object({
  pieceId: z.string().describe("ID of the piece whose draft should be discarded"),
  confirm: z.literal(true).describe("Must be true to confirm the destructive action"),
});
export type DiscardDraftParams = z.infer<typeof discardDraftSchema>;

export const restoreSnapshotSchema = z.object({
  pieceId: z.string().describe("ID of the piece"),
  snapshotId: z.string().describe("ID of the snapshot to restore (from getPieceState.recentSnapshots)"),
  confirm: z.literal(true).describe("Must be true to confirm the destructive action"),
});
export type RestoreSnapshotParams = z.infer<typeof restoreSnapshotSchema>;

export const compareStatesSchema = z.object({
  pieceId: z.string().describe("ID of the piece"),
});
export type CompareStatesParams = z.infer<typeof compareStatesSchema>;

// Verify tracked overlay
// ---------------------------------------------------------------------------

const VerifyContentSchema = z.union([
  z.object({ kind: z.literal("emoji"), char: z.string().min(1) }),
  z.object({
    kind: z.literal("text"),
    content: z.string(),
    font: z.string().optional(),
    color: z.string().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
  }),
  z.object({ kind: z.literal("image"), fileId: z.string().min(1) }),
  z.object({ kind: z.literal("video"), fileId: z.string().min(1) }),
  z.object({ kind: z.literal("code"), drawFunction: z.string() }),
  z.object({ kind: z.literal("effect"), op: z.enum(["blur", "pixelate", "mask"]) }),
]);

const VerifyRangeSchema = z
  .object({ start: z.number().nonnegative(), end: z.number().positive() })
  .refine((r) => r.end > r.start, { message: "focusRange.end must be > start" });

/** RAW SHAPE for MCP registration — see the note above ComputeObjectTrackShape:
 *  a top-level `.refine()` is a ZodEffects with no `.shape`, which the SDK
 *  silently publishes as an EMPTY inputSchema. The pre/post-attach XOR is
 *  enforced by the refined schema below AND by the verify-render route
 *  (app/api/tracking/verify-render/route.ts) which returns a clear 400. */
export const VerifyTrackedOverlayShape = {
  // pre-attach
  fileId: z.string().min(1).optional(),
  trackId: z.string().min(1).optional(),
  content: VerifyContentSchema.optional(),
  fit: z.enum(["tight", "head", "rect"]).optional(),
  scale: z.number().positive().optional(),
  smoothing: z.enum(["linear", "catmull-rom", "kalman"]).optional().describe(
    "Sub-frame INTERPOLATION between (already position-stabilized) samples — NOT a denoiser; it cannot remove tracker jitter (that is positionMode's job). linear = recommended default; catmull-rom = spline (can overshoot at direction changes); kalman = deprecated, behaves as linear.",
  ),
  // Pre-attach follow-offset spot-check — the SAME shape/bounds as the
  // persisted overlay `offset` (fractions of the resolved box, ±10), so the
  // agent can vision-verify an offset placement BEFORE committing it via
  // add_tracked_overlay. Post-attach: the overlay's own offset wins.
  offset: TrackedOffsetSchema.optional(),
  // Pre-attach box-size-policy spot-check — PRE-ATTACH ONLY: post-attach the
  // overlay's own sizeMode/maxBoxScale win (the verify-render route overrides
  // with the persisted overlay's values). Defaults match add_tracked_overlay
  // ("stabilized", 1.75).
  sizeMode: z.enum(["stabilized", "raw"]).optional(),
  maxBoxScale: z.number().positive().optional(),
  // Pre-attach position-policy spot-check — PRE-ATTACH ONLY: post-attach the
  // overlay's own positionMode wins (the verify-render route overrides with
  // the persisted overlay's value). Default "stabilized".
  positionMode: z.enum(["stabilized", "raw"]).optional(),
  // post-attach
  pieceId: z.string().min(1).optional(),
  overlayId: z.string().min(1).optional(),
  // shared
  focusRange: VerifyRangeSchema.optional(),
  extraTimes: z.array(z.number().nonnegative()).max(24).optional(),
  persist: z.array(z.number().nonnegative()).max(8).optional(),
};

// Kept for `z.infer` type derivation and validation in tests/callers. Do NOT
// pass this to `server.registerTool({ inputSchema })` — register the raw
// VerifyTrackedOverlayShape above instead.
export const VerifyTrackedOverlaySchema = z
  .object(VerifyTrackedOverlayShape)
  .refine(
    (v) => {
      const pre = !!(v.fileId && v.trackId && v.content && v.fit);
      const post = !!(v.pieceId && v.overlayId);
      return (pre || post) && !(pre && post);
    },
    {
      message:
        "provide EITHER {fileId,trackId,content,fit} (pre-attach) OR {pieceId,overlayId} (post-attach), not both",
    },
  );
export type VerifyTrackedOverlayParams = z.infer<typeof VerifyTrackedOverlaySchema>;

// ---------------------------------------------------------------------------
// Whisper / TTS / Music schemas
// ---------------------------------------------------------------------------

export const whisperListModelsSchema = z.object({});
export type WhisperListModelsParams = z.infer<typeof whisperListModelsSchema>;

export const whisperDownloadModelSchema = z.object({
  model: z
    .enum(["tiny", "base", "small", "medium", "large-v3"])
    .describe("Whisper model size to download into ~/.libi/models/whisper/."),
  forceNew: z
    .boolean()
    .optional()
    .describe(
      "Force a fresh download job, bypassing paramsHash dedup. Use after asking the user whether to start over instead of attaching to a running download or reusing a cached install-already-done result.",
    ),
});
export type WhisperDownloadModelParams = z.infer<
  typeof whisperDownloadModelSchema
>;

export const ttsListVoicesSchema = z.object({});
export type TtsListVoicesParams = z.infer<typeof ttsListVoicesSchema>;

export const ttsDownloadModelSchema = z.object({
  forceNew: z
    .boolean()
    .optional()
    .describe(
      "Force a fresh download job, bypassing paramsHash dedup. Use after asking the user whether to start over instead of attaching to a running download or reusing a cached install-already-done result.",
    ),
});
export type TtsDownloadModelParams = z.infer<typeof ttsDownloadModelSchema>;

export const generateSpeechSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(5000)
    .describe("The text to speak (1..5000 chars)."),
  voice: z
    .string()
    .optional()
    .describe(
      "Kokoro voice id (see libi.tts_list_voices). Defaults to af_heart.",
    ),
  speed: z
    .number()
    .min(0.5)
    .max(2.0)
    .optional()
    .describe("Speaking rate, 0.5..2.0 (default 1.0)."),
  withTimestamps: z
    .boolean()
    .optional()
    .describe(
      "When true, also return approximate per-word { text, start, end } timings for caption/timeline alignment.",
    ),
  pieceId: z
    .string()
    .nullable()
    .optional()
    .describe("Piece to store the audio under; null/omitted = global."),
});
export type GenerateSpeechParams = z.infer<typeof generateSpeechSchema>;

export const musicListStylesSchema = z.object({});
export type MusicListStylesParams = z.infer<typeof musicListStylesSchema>;

export const musicDownloadModelSchema = z.object({
  force: z
    .boolean()
    .optional()
    .describe(
      "Discard whatever is on disk and re-download from scratch (~8.3 GB) — for corrupt/partial recovery or a version bump. Ask the user first. If a download is ALREADY running this attaches to it and reports its progress instead of restarting; cancel that job first if you really mean to start over.",
    ),
  /** @deprecated Alias of `force`. Two knobs for one action is how a retry
   *  ended up creating a second job over the same directory; kept only so an
   *  agent that learned the old name still works. */
  forceNew: z
    .boolean()
    .optional()
    .describe("Deprecated alias of `force`."),
});
export type MusicDownloadModelParams = z.infer<typeof musicDownloadModelSchema>;

export const generateMusicSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(1000)
    .describe("Style/genre/mood description of the music to generate."),
  durationSeconds: z
    .number()
    .min(1)
    .max(240)
    .optional()
    .describe("Track length in seconds (default ~30, max 240)."),
  lyrics: z
    .string()
    .max(2000)
    .optional()
    .describe("Optional sung lyrics. When set, ACE-Step generates vocals."),
  instrumental: z
    .boolean()
    .optional()
    .describe("Force an instrumental track (ignore lyrics)."),
  seed: z
    .number()
    .int()
    .optional()
    .describe("Reproducibility seed."),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Set true after telling the user the estimated generation time. Without it, long requests return status:\"confirm_duration\" instead of running.",
    ),
  pieceId: z
    .string()
    .nullable()
    .optional()
    .describe("Piece to store the audio under; null/omitted = global."),
  forceNew: z
    .boolean()
    .optional()
    .describe(
      "If true, bypass the server's paramsHash dedup and always start a fresh " +
        "generation job. Default false — the server may attach to a still-running " +
        "match (returns attachedToRunning:true) or surface a cached terminal row " +
        "(returns matchedExisting:true) instead of doing the work again.",
    ),
});
export type GenerateMusicParams = z.infer<typeof generateMusicSchema>;

// --- Music analysis tools (added 2026-05-20) ---
export const musicDetectBeatsSchema = z.object({
  fileId: z.string().min(1),
  minBpm: z.number().min(20).max(400).optional(),
  maxBpm: z.number().min(20).max(400).optional(),
  startSec: z.number().min(0).optional(),
  endSec: z.number().min(0).max(3600).optional(),
});
export type MusicDetectBeatsParams = z.infer<typeof musicDetectBeatsSchema>;

export const musicProfileSchema = z.object({
  fileId: z.string().min(1),
  includeBeats: z.boolean().optional(),
  bandEnvelopes: z.boolean().optional(),
  envelopeHz: z.number().min(1).max(60).optional(),
  startSec: z.number().min(0).optional(),
  endSec: z.number().min(0).max(3600).optional(),
});
export type MusicProfileParams = z.infer<typeof musicProfileSchema>;

export const musicInstallAnalysisDepsSchema = z.object({});
export type MusicInstallAnalysisDepsParams = z.infer<typeof musicInstallAnalysisDepsSchema>;

// ===== Asset Folder tools =====

export const listAssetsSchema = z.object({
  pieceId: z.string().nullable().describe("Piece id, or null for the global file pool."),
  folderId: z.string().optional().describe("Folder to list; omit for the scope root."),
});
export type ListAssetsParams = z.infer<typeof listAssetsSchema>;

export const createAssetFolderSchema = z.object({
  pieceId: z.string().nullable().describe("Piece id, or null for a global asset folder."),
  name: z.string().min(1),
  parentFolderId: z.string().optional().describe("Parent folder; omit for a top-level folder."),
});
export type CreateAssetFolderParams = z.infer<typeof createAssetFolderSchema>;

export const renameAssetFolderSchema = z.object({
  folderId: z.string(),
  name: z.string().min(1),
});
export type RenameAssetFolderParams = z.infer<typeof renameAssetFolderSchema>;

export const deleteAssetFolderSchema = z.object({
  folderId: z.string(),
  mode: z.enum(["orphan", "cascade"]).default("orphan").describe(
    "orphan: move contents to the parent then delete this folder. " +
    "cascade: delete this folder AND every asset + subfolder inside it (destructive).",
  ),
  confirm: z.boolean().optional().describe("Required true for cascade."),
});
export type DeleteAssetFolderParams = z.infer<typeof deleteAssetFolderSchema>;

export const moveAssetFolderSchema = z.object({
  folderId: z.string(),
  parentFolderId: z.string().nullable().describe("New parent; null = top level. Cycle-checked."),
});
export type MoveAssetFolderParams = z.infer<typeof moveAssetFolderSchema>;

export const moveAssetSchema = z.object({
  fileId: z.string(),
  folderId: z.string().nullable().describe("Target folder; null = scope root. Scope-validated."),
});
export type MoveAssetParams = z.infer<typeof moveAssetSchema>;

// ── Folder tools ────────────────────────────────────────────────────

export const createFolderSchema = {
  name: z.string().min(1).describe("Display name for the new folder."),
  parentFolderId: z
    .string()
    .optional()
    .describe("Parent folder id. Omit for a top-level folder."),
};

export const renameFolderSchema = {
  folderId: z.string().describe("Id of the folder to rename."),
  name: z.string().min(1).describe("New display name."),
};

export const moveFolderSchema = {
  folderId: z.string().describe("Id of the folder to move."),
  parentFolderId: z
    .string()
    .nullable()
    .optional()
    .describe("New parent folder id. null or omitted moves it to the top level."),
};

export const movePieceToFolderSchema = {
  pieceId: z.string().describe("Id of the piece to move."),
  folderId: z
    .string()
    .nullable()
    .optional()
    .describe("Destination folder id. null or omitted moves the piece to the root."),
};

export const deleteFolderSchema = {
  folderId: z.string().describe("Id of the folder to delete."),
  mode: z
    .enum(["orphan", "cascade"])
    .describe(
      "orphan: move contained pieces/sub-folders up to the parent, then delete the folder. cascade: delete the folder AND every piece and sub-folder inside it.",
    ),
  confirm: z
    .boolean()
    .optional()
    .describe("Required true when mode is 'cascade' — guards destructive deletion."),
};

export const listFoldersSchema = {};

export const showFolderSchema = {
  folderId: z.string().describe("Id of the folder to reveal in the resources panel."),
};

// ── Duplication tools ───────────────────────────────────────────────

export const duplicatePieceSchema = {
  pieceId: z.string().describe("Id of the piece to duplicate."),
  name: z.string().optional().describe("Name for the copy. Defaults to '<source> (copy)'."),
  source: z
    .enum(["draft", "snapshot"])
    .optional()
    .describe("Which view to copy: 'draft' (current working copy, default) or 'snapshot' (last commit)."),
  folderId: z
    .string()
    .nullable()
    .optional()
    .describe("Folder to place the copy in. Omit to use the source piece's folder; null for root."),
};

export const duplicateFolderSchema = {
  folderId: z.string().describe("Id of the folder to duplicate (with everything inside it)."),
  name: z.string().optional().describe("Name for the copied folder. Defaults to '<source> (copy)'."),
  source: z
    .enum(["draft", "snapshot"])
    .optional()
    .describe("Which view of each piece to copy: 'draft' (default) or 'snapshot'."),
};

export const sleepSchema = z.object({
  seconds: z
    .number()
    .int()
    .min(1)
    .max(1800)
    .describe(
      "Duration to sleep, in seconds. Range 1-1800 (max 30 minutes). Use to wait between polls of long-running external operations (e.g. between fal-ai check_job calls, between elevenlabs job status checks, between any provider-side queue polling). Prefer this over Terminal 'sleep' or self-scheduling wakeups — this tool is AbortSignal-aware (the agent can cancel mid-sleep), emits progress notifications every 5 s, and won't hit Terminal-shell tool-call timeouts.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Optional — short reason for the wait, surfaced in progress notifications + logs. Example: 'waiting for fal-ai/veo3.1/fast/extend-video to finish', 'polling elevenlabs voice clone'. Helps the user understand what the agent is waiting on.",
    ),
});

export type SleepParams = z.infer<typeof sleepSchema>;

export const setSkillsEnabledByTagSchema = z.object({
  tags: z
    .array(z.string().min(1))
    .min(1)
    .describe("Tags to match (a skill matches if it has ANY of these)"),
  enabled: z
    .boolean()
    .describe("New enabled state for every matching skill"),
});
export type SetSkillsEnabledByTagParams = z.infer<typeof setSkillsEnabledByTagSchema>;

export const exportVideoSchema = {
  pieceId: z.string().describe("ID of the piece to export."),
  source: z
    .enum(["draft", "snapshot"])
    .optional()
    .describe("Which view to export: 'draft' (default) — the working copy — or 'snapshot' — the last committed state."),
  filename: z
    .string()
    .optional()
    .describe("Filename stem (no extension). Defaults to the piece's name. Sanitized + auto-numbered against the destination folder."),
  format: z
    .enum(["mp4", "webm"])
    .optional()
    .describe("Output container. Defaults to the user's export-defaults setting (MP4 unless changed)."),
  quality: z
    .enum(["source", "1080p", "1440p", "4k", "custom"])
    .optional()
    .describe("Target resolution preset. 'source' (default) preserves the composition's native dimensions. 'custom' requires customWidth + customHeight."),
  customWidth: z.number().int().positive().optional().describe("Custom output width in pixels (only when quality='custom')."),
  customHeight: z.number().int().positive().optional().describe("Custom output height (only when quality='custom')."),
  destFolder: z.string().optional().describe("Absolute path to write to. Defaults to the user's configured export folder (Settings → Export). Always confirm with the user before overriding."),
};

export const forkSkillSchema = z.object({
  id: z.string().describe("ID of the bundled skill to fork into an editable user copy"),
});
export type ForkSkillParams = z.infer<typeof forkSkillSchema>;

export const diffSkillOverrideSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Name (kebab-case) of a bundled skill that has a user override"),
});
export type DiffSkillOverrideParams = z.infer<typeof diffSkillOverrideSchema>;

// ---------------------------------------------------------------------------
// Remote file import
// ---------------------------------------------------------------------------

export const importRemoteFilesSchema = z.object({
  urls: z.array(z.string()).min(1).max(20).describe("Public http(s) URLs to download"),
  pieceId: z.string().nullable().describe("Piece to attach files to, or null for global"),
  autoUpload: z
    .boolean()
    .optional()
    .describe("Default true: register downloads as piece files. False: download to a temp path only."),
});
export type ImportRemoteFilesParams = z.infer<typeof importRemoteFilesSchema>;

// ---------------------------------------------------------------------------
// Onboarding + API-config navigation tools
// ---------------------------------------------------------------------------

export const startOnboardingSchema = z.object({});
export type StartOnboardingParams = z.infer<typeof startOnboardingSchema>;

export const showApiConfigSchema = z.object({
  mcpId: z.string().describe("Bundled MCP id needing a key (e.g. 'fal-ai', 'elevenlabs')"),
});
export type ShowApiConfigParams = z.infer<typeof showApiConfigSchema>;

export const buildOnboardingPieceSchema = z.object({
  version: z
    .string()
    .optional()
    .describe("Definition version to build. Defaults to the current one (v1)."),
  force: z
    .boolean()
    .optional()
    .describe("Build a fresh copy even if this version was already built."),
});
export type BuildOnboardingPieceParams = z.infer<typeof buildOnboardingPieceSchema>;

// ---------------------------------------------------------------------------
// Storyboard tools
// ---------------------------------------------------------------------------

export const storyboardGetSchema = {
  pieceId: z.string().describe("The piece whose storyboard to fetch."),
};

const storyboardBlockSchema = z.object({
  id: z.string(),
  kind: z.enum(["subject", "prop", "text", "inset", "bg"]),
  glyph: z.string().optional(),
  label: z.string(),
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  z: z.number(),
});

export const addStoryboardCardSchema = {
  pieceId: z.string(),
  card: z
    .object({
      id: z.string().optional().describe("Stable card id (e.g. \"s1-hook\"). Auto-generated if omitted."),
      title: z.string(),
      role: z.string().optional().describe("Scene role, e.g. hook / reveal / b-roll. Default \"scene\"."),
      kind: z.string().optional().describe("Default \"ai-video\"."),
      durationSec: z.number().optional().describe("Default 5."),
      description: z.string().optional(),
      voiceover: z.object({ line: z.string(), voice: z.string().optional() }).optional(),
      camera: z
        .object({
          shot: z.enum(["extreme-wide", "wide", "medium", "close", "extreme-close"]),
          motion: z
            .enum(["static", "push-in", "pull-out", "pan-left", "pan-right", "tilt-up", "tilt-down", "handheld", "orbit"])
            .optional(),
        })
        .optional()
        .describe("Default { shot: \"medium\" }."),
      promptFragment: z.string().optional().describe("Tier-2 keyframe prompt seed. Defaults to description/title."),
      blocks: z.array(storyboardBlockSchema).optional().describe("Tier-1 blocking boxes (normalized 0..1 rects) the default render unit draws."),
      render: z
        .object({ kind: z.enum(["satori", "svg", "canvas"]), file: z.string() })
        .optional()
        .describe("Render unit ref. Defaults to { kind: \"satori\", file: \"render.jsx\" } with a block-driven body written for you."),
    })
    .describe("The new card. Only `title` is required; the rest default sensibly."),
  overview: z.string().optional().describe("Sets the storyboard overview (use on the first card of a new board)."),
  budgetUsd: z.number().optional().describe("Sets the storyboard USD budget (use on the first card)."),
};

export const approveStoryboardStageSchema = {
  pieceId: z.string(),
  cardId: z.string(),
  stage: z.enum(["schematic", "keyframe", "clip"]).describe(
    "Which tier to approve. Keyframe/clip generation is agent-driven (the agent calls fal via ai-asset-generation/ai-video-models, then attaches the file); approving keyframe/clip only advances the stage (clip approval places the scene on the timeline). Both require the previous tier approved.",
  ),
};

export const attachStoryboardKeyframeSchema = {
  pieceId: z.string(),
  cardId: z.string(),
  fileId: z.string().describe("The libi file id of the generated keyframe image."),
  costUsd: z.number().optional().describe("Recorded USD cost of the keyframe generation."),
};

export const attachStoryboardClipSchema = {
  pieceId: z.string(),
  cardId: z.string(),
  fileId: z.string().describe("The libi file id of the generated clip video."),
  costUsd: z.number().optional().describe("Recorded USD cost of the clip generation."),
};

// ---------------------------------------------------------------------------
// Model-schema cache tools
// ---------------------------------------------------------------------------

const genFieldDefSchema = z.object({
  key: z.string(),
  type: z.enum(["text", "number", "boolean", "url", "enum", "image", "video", "audio", "svg", "pdf"]),
  required: z.boolean().optional(),
  options: z.array(z.union([z.string(), z.number()])).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  multiple: z.boolean().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const getModelSchemaCacheSchema = {
  apiUrl: z.string().describe("Full endpoint URL / fal endpoint id."),
  model: z.string().describe("Model id."),
};

export const saveModelSchemaCacheSchema = {
  apiUrl: z.string().describe("Full endpoint URL / fal endpoint id (cache key)."),
  model: z.string().describe("Model id (cache key)."),
  fields: z.array(genFieldDefSchema).describe("Normalized parameter field defs for this endpoint."),
  source: z.string().optional().describe("Provider/MCP that produced the schema (informational)."),
};

export const invalidateModelSchemaCacheSchema = {
  apiUrl: z.string(),
  model: z.string(),
};

export const setStoryboardGenerationSchema = {
  pieceId: z.string(),
  cardId: z.string(),
  tier: z.enum(["keyframe", "clip"]),
  spec: z.object({
    apiUrl: z.string(),
    model: z.string(),
    params: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  }).describe("Chosen generation params. Validated against the cached endpoint schema."),
};

export const selectStoryboardTakeSchema = {
  pieceId: z.string(),
  cardId: z.string(),
  takeId: z.string(),
};

export const hideStoryboardTakeSchema = {
  pieceId: z.string(),
  cardId: z.string(),
  takeId: z.string(),
};

export const setStoryboardReferenceSchema = {
  pieceId: z.string(),
  cardId: z.string(),
  paramKey: z.string().describe("Generation param key the reference fills, e.g. reference_video."),
  fromCardId: z.string().describe("Source card whose selected take is linked live."),
};

export const editStoryboardCardSchema = {
  pieceId: z.string(),
  cardId: z.string(),
  addSketch: z
    .object({
      role: z.enum(["start", "end", "reference"]),
      paramKey: z.string().describe("The clip-gen param this sketch conditions, e.g. start_frame / end_frame / a reference param from the cached schema."),
      label: z.string().optional().describe("Reference label, e.g. \"hand close-up\"."),
    })
    .optional()
    .describe("Append a role-tagged sketch slot; scaffolds a default render unit you then refine by editing the returned unit file."),
  removeSketch: z.object({ slotId: z.string() }).optional().describe("Remove a sketch slot (leaves the bound clip-gen param untouched)."),
  reorderSketches: z.object({ order: z.array(z.string()) }).optional().describe("Reorder sketch slots by id."),
  editSketch: z
    .object({
      slotId: z.string(),
      paramKey: z.string().optional().describe("Re-key the slot to the model's REAL clip-gen param it conditions (e.g. image_url / end_image_url from the cached schema). The card's sketch→image pairing joins on this exact key, so it MUST match the param you set in clipGen via set_storyboard_generation."),
      role: z.enum(["start", "end", "reference"]).optional(),
      label: z.string().optional(),
    })
    .optional()
    .describe("Edit an existing sketch slot in place (re-key its paramKey to a real model param, or change role/label). Use to align the default start slot's paramKey with the chosen model's actual keyframe param."),
  fields: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      promptFragment: z.string().optional(),
      durationSec: z.number().optional(),
      role: z.string().optional(),
      voiceover: z.object({ line: z.string(), voice: z.string().optional() }).optional(),
      camera: z
        .object({
          shot: z.enum(["extreme-wide", "wide", "medium", "close", "extreme-close"]),
          motion: z.enum(["static", "push-in", "pull-out", "pan-left", "pan-right", "tilt-up", "tilt-down", "handheld", "orbit"]).optional(),
        })
        .optional(),
    })
    .optional()
    .describe("Scalar card-field edits."),
};

export const renderOverlayFramesSchema = z.object({
  pieceId: z.string().min(1).describe("The piece whose composition to render."),
  atTimes: z
    .array(z.number().min(0))
    .min(1)
    .max(8)
    .optional()
    .describe("Composition timestamps (seconds) to rasterize. 1–8 times. If omitted, provide overlayId and the tool renders that overlay's start / middle / end."),
  overlayId: z
    .string()
    .min(1)
    .optional()
    .describe("Convenience: if given and atTimes is omitted, renders 3 frames across this overlay's [start, mid, end] window."),
  source: z
    .enum(["draft", "snapshot"])
    .optional()
    .describe("Which composition state to render. Default 'draft'."),
  contactSheet: z
    .boolean()
    .optional()
    .describe(
      "When true, ALSO compose the rendered frames into one labelled JPEG grid and return its path as `contactSheet` — one image to look at instead of N. Prefer this: it is the cheap way to make looking a habit.",
    ),
});
export type RenderOverlayFramesParams = z.infer<typeof renderOverlayFramesSchema>;

// ── Overlay presets (SP2) ────────────────────────────────────────────────────
export const saveOverlayPresetSchema = z.object({
  pieceId: z.string(),
  overlayId: z.string(),
  name: z.string().min(1).max(80),
  override: z
    .boolean()
    .optional()
    .describe(
      "Replace an existing user preset of the same name. Without this, a taken name returns preset_name_exists.",
    ),
});
export type SaveOverlayPresetParams = z.infer<typeof saveOverlayPresetSchema>;

export const listOverlayPresetsSchema = z.object({
  kind: z.enum(["text", "image", "video", "code", "three", "tracked"]).optional(),
});
export type ListOverlayPresetsParams = z.infer<typeof listOverlayPresetsSchema>;

export const applyOverlayPresetSchema = z.object({
  pieceId: z.string(),
  overlayId: z.string(),
  presetId: z.string(),
});
export type ApplyOverlayPresetParams = z.infer<typeof applyOverlayPresetSchema>;

export const deleteOverlayPresetSchema = z.object({ presetId: z.string() });
export type DeleteOverlayPresetParams = z.infer<typeof deleteOverlayPresetSchema>;

// ── Caption styles (agent-authored static looks) ─────────────────────────────
// A caption STYLE is a static look (color + optional stroke/shadow/background +
// font) the user picks from the Style tab. The agent can mint new ones from a
// user's example via `create_caption_style`; they persist and show in the list.
export const createCaptionStyleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .describe("Display name shown on the style tile, e.g. 'Sunset Pop'."),
  color: z
    .string()
    .min(1)
    .describe("Main text fill — hex ('#ffd400') or rgba()."),
  fontFamily: z
    .enum([
      "Inter",
      "Roboto",
      "Montserrat",
      "Oswald",
      "Arial",
      "Helvetica",
      "Georgia",
      "Times New Roman",
      "Courier New",
      "Impact",
    ])
    .optional()
    .describe("One of the safe caption fonts. Omit for the default."),
  fontWeight: z
    .number()
    .optional()
    .describe("400 | 500 | 600 | 700 | 900."),
  stroke: z
    .object({ color: z.string(), width: z.number() })
    .optional()
    .describe("Outline around glyphs; width in px (4–14 typical)."),
  shadow: z
    .object({
      color: z.string(),
      blur: z.number(),
      dx: z.number().optional(),
      dy: z.number().optional(),
    })
    .optional()
    .describe("Drop shadow / glow (glow = colored blur with dx:0,dy:0)."),
  background: z
    .object({
      color: z.string(),
      padding: z.number().optional(),
      radius: z.number().optional(),
    })
    .optional()
    .describe("Text plate behind glyphs (highlighter/marker look)."),
  override: z
    .boolean()
    .optional()
    .describe(
      "Replace an existing user style of the same name. Without this, a taken name returns style_name_exists.",
    ),
});
export type CreateCaptionStyleParams = z.infer<typeof createCaptionStyleSchema>;

export const listCaptionStylesSchema = z.object({});
export type ListCaptionStylesParams = z.infer<typeof listCaptionStylesSchema>;

export const deleteCaptionStyleSchema = z.object({ styleId: z.string() });
export type DeleteCaptionStyleParams = z.infer<typeof deleteCaptionStyleSchema>;

// ---------------------------------------------------------------------------
// Dev-only: deterministic slow job for chat-UI QA (fast+slow, same-name
// concurrency, stop buttons, ETA). Registered only outside production builds.
// Plain object map of zod fields (per the "MCP tool schema must be plain
// object" rule) — passed straight as inputSchema.
// ---------------------------------------------------------------------------
export const devSlowJobSchema = {
  seconds: z.number().int().min(1).max(600).describe("How long the job runs"),
  label: z.string().optional().describe("Optional label echoed in the result"),
  quietAfter: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe(
      "Stop reporting progress after N ticks while continuing to work — reproduces a job whose remaining work sits inside one opaque unit (a multi-GB single file). Use to inspect the decaying/withdrawn ETA and the 'no progress for Xm' line.",
    ),
};
