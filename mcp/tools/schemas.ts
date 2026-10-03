/** Central Zod schemas for all tool parameters */

// Use Zod v3 compat layer — the MCP SDK's internal schema-to-JSON-Schema
// conversion uses Zod v3 internals (._zod) that don't exist in Zod v4.
import { z } from "zod/v3";
import { aiGenerationMetaSchema } from "@/lib/ai-generation/types";
import { PROSE_EXAMPLE_SECTION_KEYS } from "@/mcp/manual-sections";
import { TEMPLATE_KEY_RE, TEMPLATE_LIMITS } from "@/lib/templates/scaffold";
import { APPLY_OPS_ALLOWED } from "@/lib/agents/apply-ops-allowlist";

/**
 * The one place `mcpId` / `extensionId` is collapsed to a single id.
 *
 * Lives here, next to the schemas that declare both keys, so a tool can never
 * accept the alias in its schema and then read only `mcpId` in its body.
 * Returns null when neither was supplied — the caller owns the error text,
 * because a useful one names that tool's own known ids.
 */
export function resolveExtensionId(input: {
  mcpId?: string;
  extensionId?: string;
}): string | null {
  const id = input.extensionId ?? input.mcpId;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

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
  // `scene` is the retired base-scene layer kind: nothing resolves to it any
  // more (every video is a video overlay), so it is no longer advertised.
  // A caller that still sends it gets the video overlay's effects.
  kind: z
    .preprocess(
      (v) => (v === "scene" ? "video" : v),
      z.enum(["text", "image", "video", "code", "three", "tracked", "audio"]).optional(),
    )
    .describe("Filter to effects that support this layer kind"),
  phase: z.enum(["in", "out", "loop"]).optional().describe("Filter to effects valid for this slot"),
  family: z.literal("animation").optional(),
});

export const applyLayerEffectSchema = z.object({
  pieceId: z.string(),
  layerId: z.string().describe("Overlay id or audio clip id"),
  phase: z.enum(["in", "out", "loop"]),
  effectId: z.string().describe("A built-in effect id (see libi.effect action list)"),
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
    .describe('Layer kinds: text | image | video | code | three | tracked | audio'),
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
  pieceId: z.string().optional().describe("ID of the piece to operate on"),
  pieceIds: z.array(z.string()).min(1).max(24).optional().describe("Several pieces (timeline view); lines that differ from the first are marked."),
  folderId: z.string().optional().describe("A folder's pieces (timeline view)."),
  view: z.enum(["full", "timeline"]).optional().describe("full (default): the manifest. timeline: one compact line per layer."),
});

export const updatePieceSchema = z.object({
  pieceId: z.string().describe("ID of the piece to operate on"),
  name: z.string().max(100).optional().describe(
    "Short descriptive name for the piece. Ignored when the user already named it by hand (nameSetByUser): their name is never overwritten.",
  ),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("Brief description of what this video project is about"),
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

const gainDbField = z
  .number()
  .min(-60)
  .max(12)
  .describe("Static gain in dB (-60..+12, default 0), on top of `volume`: boosts past what 0..1 allows (+3.8 dB is x1.55). -60 is silent. 0 clears it.");

export const audioAddClipSchema = z.object({
  pieceId: z.string().describe("ID of the piece to operate on"),
  fileId: z.string().describe(
    "ID of the source file. Audio file or video file (the audio stream is what plays).",
  ),
  kind: z.enum(["inline", "standalone"]).default("standalone").describe(
    "'inline' = bound to a video overlay (pass linkedOverlayId). 'standalone' = independent.",
  ),
  startTime: z.number().min(0).describe("Composition-global start time in seconds"),
  duration: z.number().positive().optional().describe(
    "Duration in seconds (defaults to source's media duration when omitted)",
  ),
  trimStart: z.number().min(0).default(0).describe(
    "Offset into the source file in seconds (default 0)",
  ),
  volume: z.number().min(0).max(1).default(1).describe("0..1 (default 1)"),
  gainDb: gainDbField.optional(),
  enabled: z.boolean().default(true).describe("Speaker toggle (default true)"),
  // Legacy: video scenes are gone, so this binds nothing. Still ACCEPTED (it
  // satisfies the inline-needs-a-link check, as it always did) but not
  // advertised — mcp/tools/legacy-inputs.ts.
  linkedSceneId: z.string().optional(),
  linkedOverlayId: z.string().optional().describe(
    "For an inline clip: the video overlay it is bound to.",
  ),
  label: z.string().optional().describe("Display label, e.g. 'background music'"),
  lengthPolicy: z
    .enum(["extend", "trim"])
    .optional()
    .describe(
      "Required ONLY when the clip would end past the piece's end and no `duration` is given: 'extend' keeps the asset's full length (the piece grows), 'trim' cuts at the piece's end. Ask the user which. Not needed on an EMPTY piece (the first asset sets its length).",
    ),
  rights: z
    .object({
      class: z.enum(["copyrighted", "generated"]),
      track: z.object({ title: z.string().min(1).max(200), artist: z.string().max(200).optional() }).strict().optional(),
    })
    .strict()
    .optional()
    .describe(
      "What this song IS, when you know it (you downloaded it, or the user named it). 'copyrighted' + track { title, artist } stamps the file and matches it on every connected platform that can attach a licensed copy (relay the result's `music.summary`). 'generated' ONLY for your own generation tool's output from this turn. 'owned' is not accepted: only the user can mark a track as their own.",
    ),
});

export const audioUpdateClipSchema = z.object({
  pieceId: z.string(),
  clipId: z.string().describe("The clip to update"),
  startTime: z.number().min(0).optional(),
  duration: z.number().positive().optional(),
  trimStart: z.number().min(0).optional(),
  volume: z.number().min(0).max(1).optional(),
  gainDb: gainDbField.optional(),
  crossfadeMs: z
    .number()
    .min(0)
    .max(5000)
    .optional()
    .describe(
      "Crossfade (ms) over the EARLIER clip of the same file that overlaps this clip's start: this one fades in as that one fades out, over min(crossfadeMs, the overlap). Place the clips overlapping by the length you want. 0 clears it.",
    ),
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
    "Inline clip to unlink. After unlink it becomes a standalone clip — moves and edits no longer follow the overlay.",
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
// `targetId` is ANY timeline entity id — an overlay or an audio clip.
// The family is auto-detected (ids are prefix-disjoint: <kind>-* / clip_*).

export const splitClipSchema = z.object({
  pieceId: z.string(),
  targetId: z.string().describe(
    "Id of the timeline clip to cut — an overlay or audio clip. The family is auto-detected.",
  ),
  atTime: z.number().min(0).describe(
    "Composition-global time in seconds where the clip is cut (split) into two. Must lie strictly inside the clip's window.",
  ),
});

export const deleteClipSchema = z.object({
  pieceId: z.string(),
  targetId: z.string().describe(
    "Id of the timeline clip to remove — an overlay or audio clip. Removes the clip from the timeline only; the SOURCE FILE is never deleted.",
  ),
  ripple: z.boolean().optional().default(false).describe(
    "true also closes the gap: every overlay/audio clip starting at or after the deleted clip's end shifts left by its duration, timeline-wide; clips that started before are left alone. Default false leaves the gap (right when a background or captions in another lane should stay).",
  ),
});

export const duplicateClipSchema = z.object({
  pieceId: z.string(),
  targetId: z.string().describe(
    "Id of the timeline clip to duplicate — an overlay or audio clip. The copy is placed immediately after the original.",
  ),
});

export const insertTimeSchema = z.object({
  pieceId: z.string(),
  at: z.number().min(0).describe(
    "Composition seconds where the time goes in. Everything starting at or after it moves right by `seconds`.",
  ),
  seconds: z.number().gt(0).max(3600).describe("How much time to insert."),
  stretch: z.preprocess(
    (v) => (typeof v === "string" ? [v] : v),
    z.array(z.string()),
  ).optional().describe(
    "Layers that start before `at` and run past it. Omitted: the full-length ones (to the end of the overlays, or of the audio) grow by `seconds`; a caption or narration that merely straddles it is left. [\"spanning\"]: all of them grow. [\"none\"]: none. Else the ids (overlay or audio clip) that grow, exactly those.",
  ),
  extendTarget: z.string().optional().describe(
    "An overlay to lengthen by `seconds` at its end, e.g. the intro; its trim and inline audio extend too. It must start before `at` and end at `at` or later. A video needs that much footage left in its file, else the call is refused and says how much there is.",
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

/** The most pieces one `list_files` call groups (the ceiling `upload_file` and `apply_ops` share). */
export const LIST_FILES_MAX_PIECES = 50;

export const listFilesSchema = z.object({
  pieceId: z.string().optional().describe("ID of the piece. Required when scope is 'piece' (or name pieceIds / pieceFolderId instead)."),
  pieceIds: z
    .array(z.string())
    .min(1)
    .max(LIST_FILES_MAX_PIECES)
    .optional()
    .describe(
      "Several pieces in this ONE call (up to 50), never one list per piece. The answer is grouped by piece with compact file rows; with `query` and exactly one match in each piece it also carries `perPiece` = { pieceId: { fileId } }, which an apply_ops op takes as its `perPiece` (the song already in every copy).",
    ),
  pieceFolderId: z.string().optional().describe("Same, for every piece in this piece folder (name order)."),
  recursive: z.boolean().optional().describe("With pieceFolderId: include subfolders' pieces."),
  scope: z.enum(["piece", "global", "all"]).optional().default("piece").describe(
    "Which files to list: 'piece' (files for pieceId, default), 'global' (unassigned files), 'all' (every file across all pieces and global)",
  ),
  query: z.string().optional().describe("Search files by name or filename (case-insensitive partial match)"),
});

export const duplicateFileSchema = z.object({
  fileId: z.string().describe("ID of the source file to duplicate"),
  targetPieceId: z
    .string()
    .nullable()
    .optional()
    .describe("ID of the piece to duplicate into, or null for global. Exactly one of targetPieceId, targetPieceIds, targetPieceFolderId."),
  targetPieceIds: z
    .array(z.string())
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Copy the file into each of these pieces (up to 50) in this one call; each gets its own file with the source's rights and provenance. The result's `perPiece` is { pieceId: { fileId } }: pass it as an apply_ops op's `perPiece`. A target that is the source's own piece is not copied (it keeps the source file, which perPiece names).",
    ),
  targetPieceFolderId: z
    .string()
    .optional()
    .describe("Same, for every piece in this piece folder (libi.piece_folder action list shows the ids)."),
  recursive: z.boolean().optional().describe("With targetPieceFolderId: include subfolders' pieces."),
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

export const setAudioRightsSchema = z.object({
  pieceId: z.string().describe("The piece the file belongs to."),
  fileId: z.string().describe("The audio (or video-with-audio) file."),
  class: z
    .enum(["copyrighted", "generated", "owned"])
    .optional()
    .describe("'generated' ONLY for a file you imported from your own generation tool's output in this turn. 'owned' is refused (only the user can set it), and so is a class the user set (user_decided): ask them."),
  track: z
    .object({ title: z.string().min(1).max(200), artist: z.string().max(200).optional(), album: z.string().max(200).optional(), isrc: z.string().max(20).optional() })
    .optional()
    .describe("The song's identity once the user confirmed it (title, artist). Merged into the known track: album / isrc you leave out are kept."),
});
export type SetAudioRightsParams = z.infer<typeof setAudioRightsSchema>;

export const updateMcpServerSchema = z.object({
  id: z.string().describe("libi-owned MCP row id, e.g. 'libi-tracking'"),
  requireApproval: z
    .boolean()
    .optional()
    .describe("true = prompt the user before every tool this extension owns. false is refused: only the user turns a prompt off."),
});

const AI_GENERATION_DESC =
  "Provenance of an AI-generated file (omit for plain uploads): { provider (catalog id, e.g. \"fal\"), model, prompt (the full engineered prompt), costEstimate?: { amount, currency }, startedAt, completedAt (ISO), durationMs, providerJobId? }. Fills the asset's Generation tab and the cost lookup; the ai-asset-generation skill has the recipe.";

export const uploadFileSchema = z.object({
  pieceId: z.string().optional().describe("The piece to upload into. Exactly one of pieceId, pieceIds, pieceFolderId."),
  pieceIds: z
    .array(z.string())
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Store the file once in each of these pieces (up to 50), in this one call; each gets its own file. The result's `perPiece` is { pieceId: { fileId } }: pass it as an apply_ops op's `perPiece`.",
    ),
  pieceFolderId: z
    .string()
    .optional()
    .describe("Same, for every piece in this piece folder (libi.piece_folder action list shows the ids)."),
  recursive: z.boolean().optional().describe("With pieceFolderId: include subfolders' pieces."),
  filePath: z.string().describe("Absolute path to the file on the local filesystem"),
  name: z.string().optional().describe("Display name (defaults to filename from path)"),
  description: z.string().optional().default("").describe("Brief description of the file"),
  aiGeneration: aiGenerationMetaSchema
    .optional()
    .describe(AI_GENERATION_DESC),
  folderId: z.string().optional().describe(
    "Place the uploaded file inside this ASSET folder of the piece (must match the file's " +
    "scope; not with pieceIds / pieceFolderId). Omit to land at the scope root.",
  ),
  derivedFromFileId: z.string().optional().describe(
    "The libi file this one was made from (an ffmpeg render, a re-encode, a mix of a song). " +
    "It inherits that file's audio rights: copyrighted stays copyrighted, generated stays generated. You can never make a file owned this way.",
  ),
});

/**
 * What `libi.upload_file` advertises: `aiGeneration` as a loose object (its full JSON schema is ~1.6 KB and the
 * ai-asset-generation skill documents the shape). The handler still validates the call against `uploadFileSchema`.
 */
export const uploadFileAdvertisedSchema = uploadFileSchema.extend({
  aiGeneration: z.record(z.unknown()).optional().describe(AI_GENERATION_DESC),
});

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
      "DEFAULT 'mp3' (fal-safe: an @Audio1 voice reference takes MP3/WAV only); 'wav' = lossless PCM; 'copy' = stream-copy of the source codec (fast, usually AAC): NOT usable as an @Audio1 reference.",
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
export type UpdatePieceParams = z.infer<typeof updatePieceSchema>;
export type UpdatePieceNameParams = UpdatePieceParams & { name: string };
export type UpdatePieceDescriptionParams = UpdatePieceParams & { description: string };
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
export type InsertTimeParams = z.infer<typeof insertTimeSchema>;
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

export const downloadVideoSchema = z.object({
  url: z
    .string()
    .optional()
    .describe(
      "Video page URL. YouTube playlist/radio parameters (list, start_radio, index, pp, t) are stripped automatically — pass the URL as the user gave it. Exactly one of url, search.",
    ),
  search: z
    .string()
    .optional()
    .describe(
      "Words to find instead of a URL, e.g. \"fleetwood mac dreams official audio\": libi takes the first YouTube result and returns it as `picked` { title, url, durationSec }; check it is the right one. With `candidates: true` it downloads NOTHING and lists the top results instead.",
    ),
  candidates: z
    .boolean()
    .optional()
    .describe(
      "With search: list the top results [{ title, url, durationSec, uploader }] WITHOUT downloading, so you can confirm the right one with the user and then download it by its url. Use it when the wrong track would waste a download (a song with covers, live versions and remasters).",
    ),
  count: z.number().int().min(1).max(10).optional().describe("With candidates: how many results, default 5."),
  pieceId: z
    .string()
    .nullable()
    .optional()
    .describe("Piece to import the file into, or null for the unassigned library. Required to download; not used by candidates."),
  audioOnly: z
    .boolean()
    .default(false)
    .describe("Download and extract audio only (mp3) instead of the muxed mp4."),
});
export type DownloadVideoParams = z.infer<typeof downloadVideoSchema>;

export const showPreviewSchema = z.object({
  pieceId: z.string().describe("ID of the piece whose timeline/preview should be shown"),
});

export const showStoryboardSchema = z.object({
  pieceId: z.string().describe("ID of the piece whose storyboard should be shown"),
});

export const showExportSchema = z.object({
  pieceId: z.string().describe("ID of the piece the export belongs to"),
  exportId: z.string().describe("ID of the export to open in the piece's Exports tab (from libi.list_exports or libi.export_video)"),
});

export const highlightPropertySchema = z.object({
  pieceId: z.string().describe("ID of the piece the overlay belongs to"),
  overlayId: z.string().describe("ID of the overlay whose inspector field to flash"),
  property: z
    .string()
    .describe(
      "Inspector field key to highlight (e.g. 'background.color', 'content', 'fontSize'). Must be a known key; text reveal is not one (Effects panel, Reveal tab).",
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
      "Inspector tab: 'transform' (placement/size/rotate/timing), 'style' (color/background/stroke/shadow/reveal), 'text' (content + typography), '3d' (extrusion + orbit angles) or 'anchors' (tracked only). A kind without that tab falls back to its default.",
    ),
});

export type ListFilesParams = z.infer<typeof listFilesSchema>;
export type DuplicateFileParams = z.infer<typeof duplicateFileSchema>;
export type AssignFileToolParams = z.infer<typeof assignFileSchema>;
export type UploadFileParams = z.infer<typeof uploadFileSchema>;
export type UpdateMcpServerParams = z.infer<typeof updateMcpServerSchema>;
export type ListPiecesParams = z.infer<typeof listPiecesSchema>;
export type CreatePieceParams = z.infer<typeof createPieceSchema>;
export type ShowPieceParams = z.infer<typeof showPieceSchema>;
export type DeletePieceParams = z.infer<typeof deletePieceSchema>;
export type ShowAssetParams = z.infer<typeof showAssetSchema>;
export type ShowPreviewParams = z.infer<typeof showPreviewSchema>;
export type ShowStoryboardParams = z.infer<typeof showStoryboardSchema>;
export type ShowExportParams = z.infer<typeof showExportSchema>;
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
    .optional()
    .describe(
      "A number from 100 to 900 (400 regular, 700 bold, 800 extra-bold, 900 black) or normal | bold | lighter | bolder.",
    ),
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
 * `include` on add_overlay / update_overlay: copy top-level declarations of another code overlay of the
 * SAME piece into this body (lib/overlays/code-include.ts). Nested object, so unknown keys are refused here too.
 */
export const codeIncludeSchema = z
  .object({
    fromOverlayId: z.string().describe("Overlay of THIS piece to copy from (same body kind)."),
    names: z
      .array(z.string().max(80))
      .max(60)
      .optional()
      .describe("Declarations to copy. Omit: what the body reads but never declares."),
  })
  .strict();
const INCLUDE_DESC =
  "code/three only: copy top-level declarations (and what they need) from another overlay of this piece into the body, under a banner. The body's own names win. Never copy a kit by hand.";

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
  include: codeIncludeSchema.optional().describe(INCLUDE_DESC),
  cameraPreset: cameraPresetEnum.optional(),
  transform3d: transform3dSchema.optional(),
  // video only — `duration` is REQUIRED on this tool, so (unlike audioAddClip)
  // an explicit duration can't mean "already decided". This is the only way
  // through when the overlay would end past the piece's current end.
  lengthPolicy: z
    .enum(["extend", "trim"])
    .optional()
    .describe(
      "VIDEO overlays only. Required ONLY when startTime + duration runs past the piece's end: 'extend' keeps the duration (the piece grows), 'trim' cuts at the piece's end. Ask the user which. Not needed on an EMPTY piece (the first asset sets its length).",
    ),
});
export type AddOverlayParams = z.infer<typeof addOverlaySchema>;

/**
 * The `smoothing` input of the tracked-overlay tools. `kalman` was a
 * placeholder that always behaved as `linear`, so it is no longer advertised
 * (the JSON schema lists linear | catmull-rom); a caller that still sends it is
 * accepted and gets `linear`. A FIELD-level preprocess — never wrap the whole
 * object (the SDK would emit an empty schema, see the zod-v3 rule in AGENTS.md).
 */
const SMOOTHING_DESC =
  "Sub-frame INTERPOLATION, NOT a denoiser (jitter is positionMode's job). linear = default; catmull-rom = spline (can overshoot).";
const toLinearIfKalman = (v: unknown) => (v === "kalman" ? "linear" : v);
const SMOOTHING_MODES = z.enum(["linear", "catmull-rom"]);
const smoothingRequired = z.preprocess(toLinearIfKalman, SMOOTHING_MODES).describe(SMOOTHING_DESC);
const smoothingOptional = z.preprocess(toLinearIfKalman, SMOOTHING_MODES.optional()).describe(SMOOTHING_DESC);

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
  // IMAGE / VIDEO overlays — repoint the layer at another file of this piece.
  // The handler has always gated this patch (`validateOverlayFileId`); the
  // schema exposes it because `libi.apply_template` leaves an unfilled media
  // slot as a placeholder layer and tells the agent to fill it exactly this way
  // (`lib/templates/materialize.ts`) — without the field zod stripped it and
  // the fill silently did nothing.
  fileId: z.string().optional().describe("Image/video overlays — point the layer at another file of this piece."),
  include: codeIncludeSchema.optional().describe(INCLUDE_DESC + " Prepends to the existing body."),
  rect: OverlayRectSchema.optional(),
  // What a `rect` change does to the overlay's keyframed rects: they follow (translate, and scale with a
  // resize) unless "pin" keeps them where they were. See keyframesFollowRect in overlay-tools.ts.
  keyframes: z
    .enum(["follow", "pin"])
    .optional()
    .describe(
      "With `rect` (or a text `position`): 'follow' (default) moves and scales the overlay's keyframed rects with it; 'pin' leaves them at the old layout.",
    ),
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
  // The transcript is the source of truth; caption.words is the derived snapshot.
  captionFromFileId: z
    .string()
    .optional()
    .describe(
      "Attach a file's transcript word timings to THIS overlay (any kind: a text cue, or a custom code/three caption), windowed to the overlay's timeline window and stored as caption.words (a custom caption body syncs via activeWordIndex(words, time) / typewriterRevealedText(words, time)). A text overlay gets the words its text says; a cue of a generate_captions track keeps its track and style, and a text overlay with no caption yet joins that file's track (use it to re-split cues). A code/three overlay, or a cue of another file's track, gets its own group cap-<fileId>-custom.",
    ),
});
export type UpdateOverlayParams = z.infer<typeof updateOverlaySchema>;

/**
 * Names an agent reaches for when it means a code/three overlay's JS source.
 * `drawFunction` / `sceneFunction` are the STORED names (and `drawFunction` is a
 * real field of tracked-code content), which is why they get sent here — but
 * add_overlay's field is `body`, and update_overlay takes no code at all.
 * Compared lowercase.
 */
const CODE_FIELD_ALIASES = new Set([
  "body", "drawfunction", "scenefunction", "draw", "drawfn", "drawfunc", "scene",
  "scenefn", "scenefunc", "code", "sourcecode", "source", "script", "js", "jsx",
  "javascript", "function", "func", "fn", "render", "renderfn", "renderfunction",
  "program", "drawcode", "scenecode", "codebody", "drawbody",
]);

/** Names an agent reaches for when it means the timeline label (seen live: `name`, `label`). */
const LABEL_FIELD_ALIASES = new Set(["name", "label", "title", "trackname", "tracklabel"]);

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = Math.min(up + 1, row[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length]!;
}

/** The tool field a misspelled key most likely meant (≤2 edits, keys of 4+ chars). */
function nearestField(key: string, fields: readonly string[]): string | undefined {
  if (key.length < 4) return undefined;
  let best: string | undefined;
  let bestDistance = 3;
  for (const field of fields) {
    const d = editDistance(key.toLowerCase(), field.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [field, d];
  }
  return best;
}

/**
 * Enforce the `additionalProperties: false` a tool's JSON Schema already
 * advertises. zod's default `strip` drops an unknown key silently, so a
 * misnamed field used to "succeed" with the field ignored — add_overlay with
 * `drawFunction` wrote the scaffolded starter and returned success:true. The
 * refusal names each unknown key and what to send instead; the handler never
 * runs, so nothing is written. `.strict()` keeps the advertised schema
 * byte-identical and `.shape` intact (no refine — see addOverlaySchema).
 *
 * Only the MCP registration uses these. The editor's PATCH route parses
 * `updateOverlaySchema` itself and keeps stripping.
 */
function refuseUnknownFields<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  hintFor: (key: string, fields: readonly string[]) => string,
  outcome: string,
) {
  const fields = Object.keys(schema.shape);
  return z
    .object(schema.shape, {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.unrecognized_keys
          ? {
              message: `Unknown field${issue.keys.length > 1 ? "s" : ""}: ${issue.keys
                .map((k) => `\`${k}\` — ${hintFor(k, fields)}`)
                .join(" ")} ${outcome}`,
            }
          : { message: ctx.defaultError },
    })
    .strict();
}

function didYouMean(key: string, fields: readonly string[]): string {
  if (LABEL_FIELD_ALIASES.has(key.toLowerCase())) return "the timeline label is `displayName`.";
  const near = nearestField(key, fields);
  return near ? `did you mean \`${near}\`?` : "not a field of this tool; see its input schema.";
}

/** The two guesses an agent makes most on the overlay tools: the words of a
 *  text overlay as `text` (the field is `content`), and a top-level
 *  `width`/`height` (size lives in `rect`). Exact keys only. */
function overlayGuessHint(key: string): string | null {
  if (key === "text") return "a text overlay's words go in `content`.";
  if (key === "width" || key === "height") return "size goes in `rect: { x, y, width, height }`.";
  return null;
}

/** add_overlay as registered on MCP: unknown fields are refused, not dropped. */
export const addOverlayToolSchema = refuseUnknownFields(
  addOverlaySchema,
  (key, fields) => {
    if (CODE_FIELD_ALIASES.has(key.toLowerCase())) {
      return "a code or three overlay's JS source goes in `body`.";
    }
    const guess = overlayGuessHint(key);
    if (guess) return guess;
    // `overlayId` is update_overlay's key, not a settable field; `Object.hasOwn`
    // keeps prototype names (`constructor`, `toString`) out of this branch.
    if (key === "overlayId") {
      return "add_overlay assigns the id and returns it as `overlayId`; do not send one.";
    }
    if (Object.hasOwn(updateOverlaySchema.shape, key)) {
      return "set it with libi.update_overlay once the overlay exists; add_overlay does not take it.";
    }
    return didYouMean(key, fields);
  },
  "Nothing was created. Resend with the correct field names.",
);

/** update_overlay as registered on MCP: unknown fields (and any code) are refused. */
export const updateOverlayToolSchema = refuseUnknownFields(
  updateOverlaySchema,
  (key, fields) => {
    if (CODE_FIELD_ALIASES.has(key.toLowerCase())) {
      return "update_overlay never takes code. Edit the file at the overlay's `codeFilePath` (from libi.add_overlay or libi.get_overlays) with your file tools; to reuse another overlay's helpers pass `include`.";
    }
    return overlayGuessHint(key) ?? didYouMean(key, fields);
  },
  "Nothing was changed.",
);

/** Canvas-size guesses on create_piece: a piece is created at the default
 *  frame and resized afterwards. `fps` is NOT one of them: no tool sets a
 *  piece's frame rate (update_composition_dimensions takes width/height only
 *  and would silently drop it), so its hint says so. */
const CANVAS_FIELD_GUESSES = new Set(["width", "height", "aspect", "dimensions"]);

/**
 * create_piece as registered on MCP: unknown fields are refused, not dropped.
 * `create_piece({ width, height })` used to make a 1080×1920 piece and report
 * success with the size silently gone (CH-2). Made strict because that field
 * produced a visibly wrong result — the other tools stay lenient on purpose
 * (a global strict mode would fail every harmless extra an older skill copy
 * sends). The editor's REST route does not use this.
 */
export const createPieceToolSchema = refuseUnknownFields(
  createPieceSchema,
  (key, fields) => {
    if (CANVAS_FIELD_GUESSES.has(key)) {
      return "set the canvas with libi.update_composition_dimensions({ pieceId, width, height }) after creating the piece.";
    }
    if (key === "fps") {
      return "a piece's frame rate can't be set: a new piece is 30 fps and no libi tool changes it. Create the piece without `fps`, and tell the user it stays at 30 fps.";
    }
    return didYouMean(key, fields);
  },
  "Nothing was created.",
);

export const getOverlaysSchema = z.object({ pieceId: z.string() });
export type GetOverlaysParams = z.infer<typeof getOverlaysSchema>;

/** `libi.code_outline`: a code overlay's top-level functions, constants and fonts, parsed and never run. */
export const codeOutlineSchema = z.object({
  pieceId: z.string(),
  overlayId: z.string().describe("A code, three or tracked-code overlay (ids: libi.get_overlays)"),
  includeSource: z
    .object({
      from: z.number().int().min(1).describe("First line, 1-based"),
      to: z.number().int().min(1).describe("Last line, inclusive (at most 300 lines come back)"),
    })
    .optional()
    .describe("Also return these lines of the body file, so you read a range instead of the whole file"),
  outline: z.boolean().optional().describe("false: skip the outline and return only the line counts (and includeSource)"),
});
export type CodeOutlineParams = z.infer<typeof codeOutlineSchema>;

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
  volumeDb: z
    .number()
    .min(-60)
    .max(12)
    .optional()
    .describe("AUDIO clips only (clipId): the volume at `time` as a dB OFFSET on top of the clip's gainDb; 0 = unchanged, -60 = silent."),
});

// A keyframe targets an overlay (overlayId) or an audio clip (clipId): exactly one, checked in the handler
// (the schema stays a flat object).
const keyframeTargetShape = {
  overlayId: z.string().optional().describe("The overlay to key. Give overlayId OR clipId."),
  clipId: z.string().optional().describe("The AUDIO clip to key (its volume envelope). Give overlayId OR clipId."),
};

export const addKeyframeSchema = z.object({
  pieceId: z.string(),
  ...keyframeTargetShape,
  time: z.number().min(0).describe("Keyframe time in SECONDS within the overlay or clip window."),
  properties: keyframePropertiesSchema.optional(),
  easing: z
    .string()
    .optional()
    .describe("Easing for the OUTGOING segment: a preset id or a cubic-bezier(a,b,c,d) literal."),
});
export type AddKeyframeParams = z.infer<typeof addKeyframeSchema>;

export const deleteKeyframeSchema = z.object({
  pieceId: z.string(),
  ...keyframeTargetShape,
  time: z.number().min(0).describe("Keyframe time in SECONDS to remove across all tracks."),
});
export type DeleteKeyframeParams = z.infer<typeof deleteKeyframeSchema>;

export const setKeyframeEasingSchema = z.object({
  pieceId: z.string(),
  ...keyframeTargetShape,
  time: z.number().min(0).describe("Keyframe time in SECONDS whose OUTGOING segment easing to set."),
  easing: z.string().describe("A preset id (e.g. \"ease-in-out\") or a cubic-bezier(a,b,c,d) literal."),
});
export type SetKeyframeEasingParams = z.infer<typeof setKeyframeEasingSchema>;

export const listKeyframesSchema = z.object({
  pieceId: z.string(),
  ...keyframeTargetShape,
});
export type ListKeyframesParams = z.infer<typeof listKeyframesSchema>;


export const deleteFileSchema = z.object({
  fileId: z.string().describe(
    "The file to permanently delete; only when the user explicitly asked to delete it (not 'remove the audio' or 'take out that clip'). When in doubt ask, or use libi.audio_clip (action remove) / libi.remove_overlay.",
  ),
  confirm: z.literal(true).describe(
    "Must be true: guards the irreversible erase of the source file and every clip and overlay using it.",
  ),
});

export type DeleteFileParams = z.infer<typeof deleteFileSchema>;

export const audioDuckEnableSchema = z.object({
  pieceId: z.string(),
  clipId: z.string().describe("The clip to apply ducking to (typically music)"),
  sidechainClipIds: z.array(z.string()).min(1).optional().describe(
    "The clips whose volume drives the duck (typically every dialogue or VO clip). Pass ALL of them — their levels are summed, so the music dips under whichever voice is speaking. There is no need to bounce several VO lines into one file first.",
  ),
  /** Legacy singular spelling of `sidechainClipIds`: still ACCEPTED so older
   *  transcripts and skills keep working, not advertised (mcp/tools/legacy-inputs.ts). */
  sidechainClipId: z.string().optional(),
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
  /** Legacy singular spelling — accepted, not advertised (mcp/tools/legacy-inputs.ts). */
  sidechainClipId: z.string().optional(),
  thresholdDb: z.number().min(-60).max(0).optional(),
  ratio: z.number().min(1).max(20).optional(),
  attackMs: z.number().min(1).max(1000).optional(),
  releaseMs: z.number().min(1).max(5000).optional(),
  reductionDb: z.number().min(-60).max(0).optional(),
});

// ---------------------------------------------------------------------------
// Audio analysis: libi.audio_analyze (measure | report | align)
// ---------------------------------------------------------------------------

/** The pieces `audio_analyze` measure / report may name at once: each is a job's worth of ffmpeg or a decode. */
export const AUDIO_ANALYZE_MAX_PIECES = 24;

/** `pieceId | pieceIds | pieceFolderId` (+ recursive), shared by measure and report; align is one piece. */
const audioAnalyzeTargets = {
  pieceId: z.string().optional().describe("One piece. Exactly one of pieceId, pieceIds, pieceFolderId."),
  pieceIds: z
    .array(z.string())
    .min(1)
    .max(AUDIO_ANALYZE_MAX_PIECES)
    .optional()
    .describe("Several pieces in this ONE call (up to 24), never one call per piece: the same question on each. The result is grouped by piece: the first in full, a piece matching it within 0.5 dB as `sameAsFirst`, a differing one in full, and a `summary` line."),
  pieceFolderId: z.string().optional().describe("Same, for every piece in this piece folder (name order; the first is the reference)."),
  recursive: z.boolean().optional().describe("With pieceFolderId: include subfolders' pieces."),
};

export const audioMeasureSchema = z.object({
  ...audioAnalyzeTargets,
  ranges: z
    .array(z.object({ from: z.number().min(0), to: z.number().positive() }))
    .min(1)
    .max(8)
    .describe(
      "Composition seconds, [{ from, to }], 1-8 ranges (under 0.4 s has no LUFS) whose earliest start and latest end are at most 600 s apart. Measure the ranges you will act on (the bed under narration, the end card), not the whole piece.",
    ),
  per: z
    .enum(["mix", "clip"])
    .optional()
    .describe("'mix' (default): the mix as exported. 'clip': also each clip's own contribution in each range (its gain, envelope, fades and duck included): the one that answers 'which clip is too loud'. Up to 10 clips; pass clipIds for more."),
  clipIds: z.array(z.string()).max(50).optional().describe("With per 'clip': measure only these clips."),
});
export type AudioMeasureParams = z.infer<typeof audioMeasureSchema>;

export const audioReportSchema = z.object({
  ...audioAnalyzeTargets,
  from: z.number().min(0).describe("Start of the range, composition seconds. At most 600 s from `from` to `to`."),
  to: z.number().positive().describe("End of the range, composition seconds."),
  step: z.number().min(0.05).max(60).optional().describe("Seconds between printed points. Default: the range / 24, within 0.25-5; widened to keep at most about 120 points per clip."),
});
export type AudioReportParams = z.infer<typeof audioReportSchema>;

export const audioAlignSchema = z.object({
  pieceId: z.string().describe("The piece the reference clip is on."),
  fileId: z.string().describe("The recording to search INSIDE (the full song), any libi file."),
  referenceClipId: z.string().describe("The audio clip whose sound to find: what it plays (its file from its trimStart for its duration; at most the first 30 s are used) is searched for in `fileId`."),
  window: z
    .object({ from: z.number().min(0).optional(), to: z.number().positive().optional() })
    .optional()
    .describe("Seconds of `fileId` to search, when you know roughly where (a chorus repeats: a window picks the one you mean). At most the first 2400 s of the file are read."),
});
export type AudioAlignParams = z.infer<typeof audioAlignSchema>;

export type AudioDuckEnableParams = z.infer<typeof audioDuckEnableSchema>;
export type AudioDuckDisableParams = z.infer<typeof audioDuckDisableSchema>;
export type AudioDuckUpdateParams = z.infer<typeof audioDuckUpdateSchema>;

// ---------------------------------------------------------------------------
// Analysis (per-step, fileId-keyed)
// ---------------------------------------------------------------------------

import { videoSummarySchema, frameDescriptionSchema } from "@/lib/analysis/schemas";

const ANALYSIS_KIND_ENUM = z.enum(["transcript", "summary", "frames"]);

export function decodeJsonStringIfNeeded(v: unknown): unknown {
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
      '"summary" (default) omits each frame\'s full description (action search_frames has details); "full" returns every complete description.',
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
    "Keyframes to save. UPSERT SEMANTICS, matched by frameIndex: a frame whose index already exists is updated; a new index is inserted; frames NOT included in this batch are left untouched (never deleted). Safe to call repeatedly — process long videos in batches of 10–20 frames. To wipe all keyframes before re-extracting at a different density, call libi.analysis_save({ action: 'remove_step' }) (kind: 'frames') first.",
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
  retry: z.boolean().optional().describe("If true, re-process only chunks with status='failed' or 'not_started', plus 'ready' chunks that came back with no words. Default false."),
  chunkSeconds: z.number().int().positive().optional().describe("Chunk length in seconds. Default 600 (10 minutes)."),
  model: z.string().optional().describe("Whisper model (tiny|base|small|medium|large-v3). Omit for 'small' when installed, else the most accurate installed one; the result's `model` says which ran."),
});

export const analysisChunkAudioSchema = z.object({
  fileId: z.string().describe("ID of the video or audio file"),
  chunkSeconds: z.number().int().positive().optional().describe("Chunk length in seconds. Default 600."),
});

export const analysisSaveAudioChunkSchema = z.object({
  chunkId: z.string().describe("ID returned from libi.analysis_extract({ action: 'chunk_audio' })"),
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
  chunkId: z.string().describe("ID returned from libi.analysis_extract({ action: 'chunk_audio' })"),
  jsonPath: z.string().describe("Absolute path to a JSON file containing { text, words: [...], language_code?, language_probability? } (the shape of ElevenLabs' Speech-to-Text REST API; its hosted MCP returns flat text only, which is not saved here)."),
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
// Extension navigation (Agents → Libi MCP)
// ---------------------------------------------------------------------------

export const showExtensionSchema = z.object({
  extensionId: z.string().optional().describe("libi extension id to focus, e.g. 'libi-tracking'"),
  // Legacy spelling of `extensionId` (resolveExtensionId reads both): accepted, not advertised.
  mcpId: z.string().optional(),
});

export type ShowExtensionParams = z.infer<typeof showExtensionSchema>;

/** `libi.show({ target: "social_settings" })`: Social → Settings, at one connected account when named. */
export const showSocialSettingsSchema = z.object({
  accountId: z.string().optional(),
});
export type ShowSocialSettingsParams = z.infer<typeof showSocialSettingsSchema>;

// ---------------------------------------------------------------------------
// Providers — what the user connects to their OWN agent (lib/providers/catalog.ts)
// ---------------------------------------------------------------------------

export const suggestProviderSchema = z.object({
  kind: z
    .enum(["image", "video", "music", "voice", "sfx", "transcription", "social", "browser"])
    .describe("The capability you need and do not have. `browser`: a browser you can drive (upload a file to a site, e.g. TikTok Studio)."),
  reason: z
    .string()
    .optional()
    .describe("One short line on what the user asked for. Shown to them; never a key or a prompt."),
});
export type SuggestProviderParams = z.infer<typeof suggestProviderSchema>;

export const listProvidersSchema = z.object({});
export type ListProvidersParams = z.infer<typeof listProvidersSchema>;

export const retryMcpServerSchema = z.object({
  mcpId: z.string().min(1).describe("ID of the MCP server to re-probe (e.g. 'elevenlabs')"),
});
export type RetryMcpServerParams = z.infer<typeof retryMcpServerSchema>;

// ---------------------------------------------------------------------------
// Tier-2 bundled-MCP install flow tools (agent-driven install)
// ---------------------------------------------------------------------------

/**
 * `mcpId` stays the CANONICAL spelling; `extensionId` is accepted as an alias.
 *
 * "Both spellings are accepted" was only half true: `{ mcpId, extensionId }` parsed (zod strips the extra key),
 * but `{ extensionId }` ALONE failed with a bare `Required` and no hint about
 * which name to use. An agent reading this branch's own noun — every def is
 * `kind: "extension"`, the manual says "a libi **extension** id" — guesses
 * `extensionId` and gets a validation error it cannot act on.
 *
 * Canonical is `mcpId` and not `extensionId`, because five siblings (`update_dep_status` and the `diagnose`,
 * `recheck`, `restart`, `retry` actions of `libi.extension`), all four install
 * plans and `mcp/templates/instructions.md` spell it `mcpId`. (`libi.show` target `extension`
 * is the one exception: it is named for the extension, so `extensionId` is its
 * canonical key and `mcpId` its deprecated alias.) Renaming this ONE tool would manufacture the drift the
 * follow-up is about instead of removing it — the flow's very next call is
 * `libi.update_dep_status({ mcpId })`.
 *
 * NOT a `z.preprocess` around the object, deliberately: the MCP SDK's
 * `normalizeObjectSchema` returns `undefined` for a `ZodEffects`, so
 * `tools/list` would fall back to `EMPTY_OBJECT_JSON_SCHEMA` and this tool
 * would advertise NO parameters at all — the same silent schema loss the
 * zod-v3 rule in AGENTS.md exists for. Two plain optional fields plus
 * `resolveExtensionId()` in the tool keeps the advertised schema intact.
 */
export const getInstallPlanSchema = z.object({
  mcpId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "ID of the libi extension (e.g. 'whisper', 'local-music', 'libi-tracking'). Required.",
    ),
  // Alias of `mcpId` (resolveExtensionId reads both): accepted so either spelling
  // works, not advertised (mcp/tools/legacy-inputs.ts).
  extensionId: z.string().min(1).optional(),
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

// Fields of ComputeObjectTrackSchema — also exported as the raw MCP shape below.
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
        "Applies to libi.track compute (local engine).",
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
// Kept for `z.infer` type derivation and any server-side `.parse()`. Do NOT
// pass these to `server.registerTool({ inputSchema })` — see the note above.
export const ComputeObjectTrackSchema = z
  .object(baseTrackingFields)
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
  smoothing: smoothingRequired,
  offset: TrackedOffsetSchema.optional(),
  sizeMode: z.enum(["stabilized", "raw"]).optional().describe(
    "stabilized (default) damps box-size jitter (clamps outliers, median-smooths width/height) and holds the edge the offset points away from fixed while resizing; raw uses tracker sizes verbatim.",
  ),
  maxBoxScale: z.number().min(1).max(4).optional().describe(
    "Max factor a frame's box may exceed the track's median size before it is clamped (lower = stricter; sizeMode stabilized only). Default 1.75.",
  ),
  positionMode: z.enum(["stabilized", "raw"]).optional().describe(
    "stabilized (default) smooths the tracked box CENTER against tracker jitter; raw follows samples verbatim (deliberately bouncy).",
  ),
  acknowledgeQualityIssues: z
    .boolean()
    .optional()
    .describe(
      "Set true ONLY after inspecting summary.issues and deciding to attach anyway; without it a flagged track is refused.",
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
  smoothing: smoothingOptional,
  offset: TrackedOffsetSchema.optional(),
  sizeMode: z.enum(["stabilized", "raw"]).optional().describe(
    "stabilized (default) damps box-size jitter (clamps outliers, median-smooths width/height) and holds the edge the offset points away from fixed while resizing; raw uses tracker sizes verbatim.",
  ),
  maxBoxScale: z.number().min(1).max(4).optional().describe(
    "Max factor a frame's box may exceed the track's median size before it is clamped (lower = stricter; sizeMode stabilized only). Default 1.75.",
  ),
  positionMode: z.enum(["stabilized", "raw"]).optional().describe(
    "stabilized (default) smooths the tracked box CENTER against tracker jitter; raw follows samples verbatim (deliberately bouncy).",
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
    "Free-form identifier for the tracker that produced these samples (e.g. 'yoloe+botsort', 'external-mcp:my-tracker'). Stored as-is in the track row.",
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
    "Per-frame samples in pixel coordinates. The samples array shape mirrors libi's internal TrackSample type so it's identical to what libi.track compute produces.",
  ),
  anchors: z.array(anchorSchema).optional().describe(
    "Optional anchor reference list — what the external tracker used as input.",
  ),
});

export type ComputeObjectTrackParams = z.infer<typeof ComputeObjectTrackSchema>;
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
  fileId: z.string().min(1).describe("Video file to cut out (photos use the paid provider path — see the removing-and-replacing-backgrounds skill and its references/providers/<id>.md)"),
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
        .describe("[x, y, w, h] in frame pixels — take it from a libi.track({ action: 'ground_target' }) candidate, never hand-guess"),
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

/**
 * Verifying the tracking engine takes no target — there is only one engine.
 * The optional id exists so a call aimed at a DIFFERENT extension is refused
 * instead of silently answered.
 *
 * `libi.verify_install({ mcpId: "local-music" })` used to report
 * `missing: ["tracking-pyenv"]`. Nothing was wrong with local-music's
 * dependency wiring (`mcp/registry/bundled.ts` declares uv plus the virtual
 * `ace-step-model` dep, and nothing else) — the schema was `z.object({})`,
 * zod stripped the unknown key, and the tool answered with the TRACKING
 * engine's status under the caller's music-shaped question. An agent then
 * tells the user music needs a Python tracking sidecar. Declaring the key is
 * what lets `verifyInstall` see it and say no.
 */
export const VerifyInstallSchema = z.object({
  mcpId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional, and only ever 'libi-tracking' — this tool verifies the tracking engine and nothing else. Any other extension id is refused with a pointer to the right tool. Omit it.",
    ),
  // Alias of `mcpId` — accepted, not advertised (mcp/tools/legacy-inputs.ts).
  extensionId: z.string().min(1).optional(),
});
export type VerifyInstallParams = z.infer<typeof VerifyInstallSchema>;

export const installTrackingEngineSchema = z.object({
  force: z
    .boolean()
    .optional()
    .describe(
      "Re-run even though the engine looks installed; almost never needed (artifacts are sha-pinned, a plain re-call resumes). A running install is attached to, not restarted: cancel it with libi.job({ action: \"cancel\" }) first to start over.",
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
  pieceId: z.string().optional().describe("ID of the piece to query"),
  pieceIds: z.array(z.string()).min(1).max(24).optional().describe("A sweep: name, hasDraft, duration and renderDiagnostics of each."),
});
export type GetPieceStateParams = z.infer<typeof getPieceStateSchema>;

export const commitDraftSchema = z.object({
  pieceId: z.string().describe("ID of the piece whose draft should become the new snapshot"),
  summary: z.string().optional().describe("Short one-line description of what changed. If omitted, a default is used."),
  acknowledgeUnvalidated: z
    .boolean()
    .optional()
    .describe(
      "Override the validation gate: true ONLY when the user explicitly accepted committing un-validated generated clips.",
    ),
});
export type CommitDraftParams = z.infer<typeof commitDraftSchema>;

/**
 * `confirm` on discard / restore is the USER's yes, not a formality (Codex sent it unprompted on "Undo my last
 * change"). There is no approval card behind it in the auto modes, so the wording is the whole guard: the
 * property text and the refusal both tell the agent to ask first. Owner decision: no new gate on top.
 */
const USER_CONFIRM_TEXT =
  "Set true ONLY after the user said yes to this exact action in this conversation. Never set it on your own, never to try the call: ask the user first, say what will be lost, and wait for their answer.";
const userConfirmLiteral = (what: string) =>
  z.literal(true, {
    errorMap: () => ({
      message: `ask the user before ${what}: tell them what will be lost, and send confirm: true only after they said yes in this conversation (never set it yourself)`,
    }),
  });

export const discardDraftSchema = z.object({
  pieceId: z.string().describe("ID of the piece whose draft should be discarded"),
  confirm: userConfirmLiteral("discarding the draft").describe(USER_CONFIRM_TEXT),
});
export type DiscardDraftParams = z.infer<typeof discardDraftSchema>;

export const restoreSnapshotSchema = z.object({
  pieceId: z.string().describe("ID of the piece"),
  snapshotId: z.string().describe("ID of the snapshot to restore (from libi.get_piece_state recentSnapshots, or a `rec-` id from compare's `recoverable`)"),
  confirm: userConfirmLiteral("restoring a snapshot").describe(USER_CONFIRM_TEXT),
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
  smoothing: smoothingOptional,
  // Pre-attach follow-offset spot-check — the SAME shape/bounds as the
  // persisted overlay `offset` (fractions of the resolved box, ±10), so the
  // agent can vision-verify an offset placement BEFORE committing it via
  // libi.tracked_overlay add. Post-attach: the overlay's own offset wins.
  offset: TrackedOffsetSchema.optional(),
  // Pre-attach box-size-policy spot-check — PRE-ATTACH ONLY: post-attach the
  // overlay's own sizeMode/maxBoxScale win (the verify-render route overrides
  // with the persisted overlay's values). Defaults match libi.tracked_overlay add
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
      "Start a fresh download job instead of attaching to a running one or reusing a cached result; ask the user first.",
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
      "Start a fresh download job instead of attaching to a running one or reusing a cached result; ask the user first.",
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
      "Discard what is on disk and re-download (~8.3 GB), for corrupt/partial files or a version bump; ask the user first. A running download is attached to, not restarted: cancel its job first to start over.",
    ),
  /** Alias of `force`. Two knobs for one action is how a retry ended up
   *  creating a second job over the same directory; kept only so an agent that
   *  learned the old name still works — accepted, not advertised
   *  (mcp/tools/legacy-inputs.ts). */
  forceNew: z.boolean().optional(),
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
      "true bypasses the dedup and always starts a fresh job (default: an identical running or finished request is reported in the result's `note`).",
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
    .nullable()
    .optional()
    .describe("Parent folder id. Omit (or null) for a top-level folder."),
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
      "Seconds to sleep, 1-1800 (30 min max).",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Optional short reason, shown in progress notifications and logs.",
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
    .describe("Filename stem (no extension). Defaults to the piece's name. Sanitized + auto-numbered against the piece's other exports."),
  format: z
    .enum(["mp4", "webm"])
    .optional()
    .describe("Output container. Defaults to the user's export-defaults setting (MP4 unless changed)."),
  quality: z
    .enum(["source", "1080p", "1440p", "4k", "custom"])
    .optional()
    .describe("Resolution for videos and images. 'source' (default) keeps the composition's own size. 'custom' requires customWidth + customHeight."),
  graphicsQuality: z
    .enum(["1080p", "1440p", "4k"])
    .optional()
    .describe("Resolution text, code and 3D overlays render at. Default '4k' (sharpest). The output file takes the larger of the two when the piece has text/code/3D."),
  customWidth: z.number().int().positive().optional().describe("Custom output width in pixels (only when quality='custom')."),
  customHeight: z.number().int().positive().optional().describe("Custom output height (only when quality='custom')."),
  // Removed. Stays in the schema so zod does not strip it before the handler
  // can REFUSE it (DEST_FOLDER_REFUSAL); not advertised (mcp/tools/legacy-inputs.ts).
  destFolder: z.string().optional(),
  purpose: z
    .enum(["social", "personal"])
    .optional()
    .describe("REQUIRED when the piece has copyrighted music (refused without it: ask the user). 'social' leaves copyrighted songs out by default and, with no size named, fits the file to 1080×1920; 'personal' keeps them. To post prefer libi.post_piece, which exports per platform."),
  copyrightedAudio: z.enum(["exclude", "include"]).optional().describe("Override the purpose's default for copyrighted audio."),
  includeFileIds: z.array(z.string()).optional().describe("Copyrighted files to keep in on top of 'exclude'."),
  variants: z
    .array(
      z
        .object({
          format: z.enum(["mp4", "webm"]).optional(),
          quality: z.enum(["source", "1080p", "1440p", "4k", "custom"]).optional(),
          graphicsQuality: z.enum(["1080p", "1440p", "4k"]).optional(),
          customWidth: z.number().int().positive().optional(),
          customHeight: z.number().int().positive().optional(),
          filename: z.string().optional(),
          purpose: z.enum(["social", "personal"]).optional(),
          copyrightedAudio: z.enum(["exclude", "include"]).optional(),
          includeFileIds: z.array(z.string()).optional(),
        })
        .strict(),
    )
    .min(1)
    .max(10)
    .optional()
    .describe(
      "1–10 exports in ONE call, e.g. 9:16 and 16:9 cuts (quality 'custom' + customWidth/customHeight) or MP4 + WebM; an entry inherits the top-level format/quality/graphicsQuality/purpose/copyrightedAudio/includeFileIds it does not set. Returns at once with { queued: [{ exportId, name, format, width, height }], note }; check libi.list_exports. (A with-song and a without-song cut differ in copyrightedAudio.)",
    ),
};

export const listExportsSchema = z.object({
  pieceId: z.string().describe("The piece whose exports to list."),
  status: z
    .enum(["queued", "running", "done", "failed", "cancelled"])
    .optional()
    .describe("Only exports in this state. Omit for all of them."),
  show: z.boolean().optional().describe("Also open the piece's Exports tab for the user."),
});
export type ListExportsParams = z.infer<typeof listExportsSchema>;

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
// Onboarding navigation tools
// ---------------------------------------------------------------------------

export const startOnboardingSchema = z.object({});
export type StartOnboardingParams = z.infer<typeof startOnboardingSchema>;

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
      id: z.string().optional().describe("Stable card id (e.g. \"s1-hook\"): letters, digits, - and _, dots only between them. Auto-generated if omitted."),
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
    "Tier to approve. Keyframe/clip generation is agent-driven (generate, then attach the file); approving only advances the stage (clip approval places the scene on the timeline) and needs the previous tier approved.",
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

const GEN_FIELDS_DESC =
  "GenFieldDef[] for this endpoint: { key, type (text|number|boolean|url|enum|image|video|audio|svg|pdf), required?, options?, min?, max?, step?, multiple?, label?, description?, default? } (the provider reference shows how to normalize).";

export const saveModelSchemaCacheSchema = {
  apiUrl: z.string().describe("Full endpoint URL / fal endpoint id (cache key)."),
  model: z.string().describe("Model id (cache key)."),
  fields: z.array(genFieldDefSchema).describe(GEN_FIELDS_DESC),
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
    .describe("Append a role-tagged sketch slot (scaffolds a default render unit to refine in its unit file)."),
  removeSketch: z.object({ slotId: z.string() }).optional().describe("Remove a sketch slot (leaves the bound clip-gen param untouched)."),
  reorderSketches: z.object({ order: z.array(z.string()) }).optional().describe("Reorder sketch slots by id."),
  editSketch: z
    .object({
      slotId: z.string(),
      paramKey: z.string().optional().describe("Re-key the slot to the model's REAL clip-gen param (e.g. image_url / end_image_url from the cached schema); it MUST equal the key you set in clipGen via set_storyboard_generation."),
      role: z.enum(["start", "end", "reference"]).optional(),
      label: z.string().optional(),
    })
    .optional()
    .describe("Edit a sketch slot in place (re-key paramKey to a real model param, or change role/label), e.g. align the default start slot with the chosen model's keyframe param."),
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
  pieceId: z.string().min(1).optional().describe("The piece whose composition to render (or pieceIds)."),
  pieceIds: z
    .array(z.string().min(1))
    .min(2)
    .max(8)
    .optional()
    .describe("2–8 pieces rendered at the SAME atTimes into ONE labelled sheet (needs atTimes; at most 24 frames); `pieces` in the result maps each label to its piece."),
  atTimes: z
    .array(z.number().min(0))
    .min(1)
    .max(8)
    .optional()
    .describe("1–8 composition seconds, each before the piece's end (a later time is refused naming the duration and last valid time). A renderDiagnostics `time` passed back as given renders the frame that failed; each result names its `frame`. Omit to pass overlayId (renders its start / middle / end)."),
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
      "Also return ONE labelled JPEG grid of all the frames (`contactSheet` path); prefer it over opening N PNGs.",
    ),
  maxEdge: z
    .number()
    .int()
    .min(64)
    .max(4096)
    .optional()
    .describe("Longest edge in pixels of the sheet (default 1024) and of each returned PNG when set."),
  region: z
    .object({ x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() })
    .optional()
    .describe("Crop each frame to this rectangle, composition pixels (to read small text); a PNG per frame is returned as `path`."),
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

// ── Templates (spec §5) ──────────────────────────────────────────────────────
// The key regex and the count/length ceilings come from `lib/templates/scaffold.ts`,
// the contract `validateScaffold` enforces — re-typing them here is how a tool
// starts accepting a slot the scaffold then rejects.
const templateOrderSchema = z.enum(["trending", "most-used", "newest"]);
const templateScopeSchema = z.enum(["local", "public", "all"]);
const templateSlotKindSchema = z.enum(["text", "image", "video", "audio"]);

export const createTemplateFromPieceSchema = z.object({
  pieceId: z.string(),
  name: z.string().min(1).max(TEMPLATE_LIMITS.nameChars),
  description: z.string().max(TEMPLATE_LIMITS.descriptionChars),
  tags: z
    .array(z.string())
    .max(TEMPLATE_LIMITS.tags)
    .optional()
    .describe("Up to 10 tags, lowercase letters/digits/hyphens."),
  overlayIds: z.array(z.string()).optional().describe("Overlays to include. Default: every overlay in the piece."),
  slots: z
    .array(
      z.object({
        key: z.string().regex(TEMPLATE_KEY_RE).describe("^[a-z][a-z0-9-]{0,39}$"),
        kind: templateSlotKindSchema,
        label: z.string().min(1).max(80),
        hint: z.string().max(300).optional(),
        required: z.boolean().optional(),
        fromOverlayKey: z
          .string()
          .optional()
          .describe("The overlay (its id, or its slug key) or audio clip this slot replaces."),
      }),
    )
    .max(TEMPLATE_LIMITS.slots)
    .optional(),
});
export type CreateTemplateFromPieceParams = z.infer<typeof createTemplateFromPieceSchema>;

export const updateTemplateSchema = z.object({
  templateId: z.string(),
  name: z.string().min(1).max(TEMPLATE_LIMITS.nameChars).optional(),
  description: z.string().max(TEMPLATE_LIMITS.descriptionChars).optional(),
  tags: z.array(z.string()).max(TEMPLATE_LIMITS.tags).optional(),
  reextractFromPieceId: z
    .string()
    .optional()
    .describe("Re-capture overlays/clips/media from this piece; index.md is kept."),
});
export type UpdateTemplateParams = z.infer<typeof updateTemplateSchema>;

export const listTemplatesSchema = z.object({
  order: templateOrderSchema.optional(),
  scope: templateScopeSchema.optional(),
});
export type ListTemplatesParams = z.infer<typeof listTemplatesSchema>;

export const searchTemplatesSchema = z.object({
  query: z.string().max(200),
  tags: z.array(z.string()).max(TEMPLATE_LIMITS.tags).optional(),
  scope: templateScopeSchema.optional(),
  order: templateOrderSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type SearchTemplatesParams = z.infer<typeof searchTemplatesSchema>;

export const getTemplateSchema = z.object({ templateId: z.string() });
export type GetTemplateParams = z.infer<typeof getTemplateSchema>;

/**
 * One layer's overrides on a template apply: the fields `update_overlay` takes, minus the ids, the fields
 * another tool owns (a file is `slotValues`; `trim` and fonts are `update_overlay` afterwards) and the
 * tracked-only ones. Strict: an unknown field is refused, not dropped. The kind gate (a text-only field
 * on an image layer) is in lib/templates/layer-overrides.ts.
 */
export const layerOverrideSchema = updateOverlaySchema
  .omit({ pieceId: true, overlayId: true, fileId: true, fontFileId: true, trim: true, offset: true, scale: true, captionFromFileId: true, keyframes: true, include: true })
  .strict();
export const layerOverridesSchema = z.record(layerOverrideSchema);

export const applyTemplateSchema = z.object({
  templateId: z.string().optional(),
  cloudId: z
    .string()
    .optional()
    .describe(
      "A public catalog template's id (libi.template list/search, scope 'public'); installed first, then applied. Pass templateId OR cloudId, never both.",
    ),
  pieceId: z.string().optional().describe("Apply into this piece. Omit with newPiece to create one."),
  newPiece: z
    .object({ name: z.string().max(120).optional() })
    .optional()
    .describe("Create a new piece to apply into. Without a name it is called \"From template\" for a public or installed template (never the author's listing name), or the template's own name for a local one."),
  slotValues: z.record(z.string()).optional().describe("slot key → text, or a fileId of this piece, or an https URL."),
  mode: z.enum(["append", "replace"]).optional(),
  confirmReplace: z
    .boolean()
    .optional()
    .describe("Required true for mode 'replace' — it clears the piece's overlays and clips."),
  copy: z
    .number()
    .int()
    .min(1)
    .max(99)
    .optional()
    .describe(
      "Which copy of this apply this is (default 1). An identical call within 5 minutes of a success is answered from memory (replayed: true), so a retry never doubles anything; to apply again ON PURPOSE pass a different newPiece.name, or copy: 2, then 3, … (a mode 'replace' into an existing piece always applies).",
    ),
  fit: z
    .enum(["reflow", "none"])
    .optional()
    .describe(
      "Layers vs. a piece whose frame is not the template's. Default: 'reflow' when the frames differ (re-anchors each layer to its edge or centre, scales type and keyframed rects with it, keeps it in the safe area), nothing when they match. 'none' places layers at their authored pixels. A new piece takes the template's canvas, so there is nothing to reflow.",
    ),
  layerOverrides: layerOverridesSchema
    .optional()
    .describe("Per-layer overlay fields (update_overlay's), by the template's layer key, applied as the layer is placed after fit; null clears a field; wins over slotValues."),
  omitLayers: z.array(z.string()).max(100).optional().describe("Layer keys not to create."),
  startAt: z.number().min(0).optional().describe("Seconds to shift every layer and clip later by (default 0)."),
  navigate: z
    .boolean()
    .optional()
    .describe("Open the piece in the user's editor. Default: only when this call created the piece."),
});
export type ApplyTemplateParams = z.infer<typeof applyTemplateSchema>;

export const fetchTemplateMusicSchema = z.object({
  pieceId: z.string().describe("The piece the template was applied to."),
  assetId: z.string().describe("A pendingMusic entry's assetId (from libi.apply_template's result or libi.get_piece_state)."),
});
export type FetchTemplateMusicParams = z.infer<typeof fetchTemplateMusicSchema>;

export const publishTemplateSchema = z.object({
  templateId: z.string().min(1).describe("The local template to prepare for publishing (from libi.template list / create_template_from_piece)."),
  exampleVideo: z
    .union([
      // Strict: exactly one source. A second key is refused, not silently dropped.
      z.object({ fileId: z.string().min(1) }).strict().describe("An existing video file on a piece."),
      z.object({ path: z.string().min(1) }).strict().describe("An absolute path to an mp4/mov on this machine."),
      z.object({ exportPieceId: z.string().min(1) }).strict().describe("Export this piece first and use the result (runs for tens of seconds to minutes)."),
    ])
    .describe("The short example the catalog shows on the card, made NOW (exported first for exportPieceId, trimmed to 15 s, scaled to ≤ 1280 px, with a poster); the user reviews exactly that."),
  nickname: z.string().min(2).max(32).optional().describe("Optional, only when the user names one: replaces the creator's public nickname (a random default like \"Brave Otter 4821\") on every template this install published, once the user publishes."),
  // Accepted and ignored, never advertised (mcp/tools/legacy-inputs.ts): older
  // copies of the templates skill (still on users' machines) send it. It no
  // longer means anything — this tool never publishes; the user does, on the
  // Templates page.
  confirm: z.boolean().optional(),
});
export type PublishTemplateParams = z.infer<typeof publishTemplateSchema>;

export const deleteTemplateSchema = z.object({ templateId: z.string() });
export type DeleteTemplateParams = z.infer<typeof deleteTemplateSchema>;

export const showTemplatesSchema = z.object({ templateId: z.string().optional() });
export type ShowTemplatesParams = z.infer<typeof showTemplatesSchema>;

// ── Caption styles (agent-authored static looks) ─────────────────────────────
// A caption STYLE is a static look (color + optional stroke/shadow/background +
// font) the user picks from the Style tab. The agent can mint new ones from a
// user's example via `libi.caption_style` (create); they persist and show in the list.
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
    .describe(
      "CSS weight, 100-900 in steps of 100: 400 regular, 500, 600, 700 bold, 800 extra-bold, 900 black. Any of them is accepted (800 too); a font without that weight draws its nearest one.",
    ),
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

// ---------------------------------------------------------------------------
// Manual (tiered instructions)
// ---------------------------------------------------------------------------

/**
 * `libi.read_manual` is sectioned: the full manual is ~87 KB, which a client
 * spools to disk rather than reading. No `section` returns the index plus the
 * pre-first-edit essentials; a key returns one section; `"all"` the lot.
 */
export const readManualSchema = z.object({
  section: z
    .string()
    .optional()
    .describe(
      `Section key from the index, e.g. ${PROSE_EXAMPLE_SECTION_KEYS.map((k) => `"${k}"`).join(" or ")} . Several keys in one call: "a, b" (up to 5). Omit for the index plus the essentials before a first edit; "all" is the whole ~87 KB manual.`,
    ),
});
export type ReadManualParams = z.infer<typeof readManualSchema>;

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
      "Stop reporting progress after N ticks while still working (reproduces one opaque long unit, to inspect the ETA decay).",
    ),
};

// ---------------------------------------------------------------------------
// Social posting (`mcp/tools/social-tools.ts`). Draft-only by construction:
// `postPieceSchema` has no `publishNow`, no `scheduledFor` and no `when` — a
// schema that cannot express "publish" is what makes an accidental publish
// impossible, rather than a check the implementation has to remember.
// ---------------------------------------------------------------------------

export const socialStatusSchema = z.object({});
export type SocialStatusParams = z.infer<typeof socialStatusSchema>;

export const postPieceSchema = z.object({
  pieceId: z.string().describe("The piece to post."),
  targets: z
    .array(
      z.object({
        platform: z.enum(["instagram", "tiktok"]),
        accountId: z
          .string()
          .optional()
          .describe("Required only when that platform has several connected accounts (libi.social_status lists them)."),
        instagramType: z
          .enum(["reel", "feed", "story"])
          .optional()
          .describe("Instagram only. Defaults to the user's own setting."),
        music: z
          .object({
            mode: z.enum(["attach", "draft", "include", "strip"]),
            trackId: z.string().optional().describe("A candidate id from libi.social_music_search (mode 'attach')."),
            soundName: z.string().max(100).optional().describe("Instagram: the name of the Reel's own sound (generated/owned music)."),
          })
          .optional()
          .describe(
            "Override libi's music plan for this target. Omit to use the plan (see libi.social_music_search). 'include' keeps a copyrighted song in the video — only on the user's explicit say-so.",
          ),
      }),
    )
    .optional()
    .describe(
      "Omit = every connected Instagram and TikTok account (Instagram as the default type); accountId only when a platform has several accounts. Instagram and TikTok only: for Facebook, X or YouTube use the provider's own MCP tools.",
    ),
  caption: z
    .string()
    .max(2200)
    .optional()
    .describe("The caption. Omit to leave it empty for the user to fill in the Posting tab."),
  exportPath: z
    .string()
    .optional()
    .describe(
      "An existing export of this piece. Omit to reuse the piece's most recent export when it has one, and otherwise export now at the piece's own size.",
    ),
});
export type PostPieceParams = z.infer<typeof postPieceSchema>;

export const socialMusicSearchSchema = z.object({
  pieceId: z.string().describe("The piece whose music is being planned."),
  platform: z.enum(["instagram", "tiktok", "youtube", "facebook", "twitter"]).describe("twitter = X."),
  accountId: z.string().optional().describe("Required for instagram and tiktok (libi.social_status lists them)."),
  query: z.string().max(100).optional().describe("Instagram only: search words. TikTok has no search — its trending list is returned."),
});
export type SocialMusicSearchParams = z.infer<typeof socialMusicSearchSchema>;

export const socialLinkPostSchema = z.object({
  pieceId: z.string().describe("The piece the post was made from."),
  providerPostId: z.string().describe("The post id Zernio returned."),
  exportPath: z.string().optional().describe("The export the post carries, when you know it."),
});
export type SocialLinkPostParams = z.infer<typeof socialLinkPostSchema>;

/**
 * Only for an ad that is NOT a boosted post. An ad boosting one of the
 * piece's posts is found by the provider's own `effective_instagram_media_id`
 * filter and needs no link — linking one would store a row that answers a
 * question already answered.
 */
export const socialLinkAdSchema = z.object({
  pieceId: z.string().describe("The piece the ad's creative came from."),
  providerAdId: z.string().describe("The ad id Zernio returned (its `_id`)."),
  platformAdId: z
    .string()
    .optional()
    .describe("The ad network's own ad id (Meta's ad id), when you know it."),
});
export type SocialLinkAdParams = z.infer<typeof socialLinkAdSchema>;

/** The ops `libi.apply_ops` runs, named exactly as the allow-list (lib/agents/apply-ops-allowlist.ts) has them. */
const applyOpsOpNames = Object.entries(APPLY_OPS_ALLOWED)
  .map(([tool, a]) => `${tool.slice("libi.".length)}${a.actions ? ` (${a.actions.join("|")})` : ""}`)
  .join(", ");

export const applyOpsSchema = z.object({
  targets: z
    .object({
      pieceId: z.string().optional().describe("One piece."),
      pieceIds: z.array(z.string()).optional().describe("Several pieces, up to 50."),
      folderId: z.string().optional().describe("Every piece in this folder (libi.piece_folder action list shows the ids)."),
      recursive: z.boolean().optional().describe("With folderId: include subfolders' pieces too."),
    })
    .describe("Which pieces to edit: exactly one of pieceId, pieceIds, folderId."),
  ops: z
    .array(
      z
        .object({
          op: z.string().describe(`The tool to run, without \`libi.\`: ${applyOpsOpNames}. Anything else is refused.`),
          action: z.string().optional().describe("For a tool with actions: which one. Required for those, refused for the others."),
          as: z
            .string()
            .optional()
            .describe(
              "Name the id this op creates (a new overlay, clip, split tail or duplicate). Later ops give it as \"$name\" in any id field (clipId, overlayId, sidechainClipIds, …), resolved per piece.",
            ),
          perPiece: z
            .record(z.string(), z.record(z.string(), z.unknown()))
            .optional()
            .describe("{ pieceId: { field: value } }: arguments that replace this op's own for that piece (e.g. its own fileId)."),
        })
        .passthrough(),
    )
    .min(1)
    .max(100)
    .describe(
      "Run in order, per piece. Each op takes its tool's own arguments except pieceId, which targets sets. Every op is checked before anything is written. If an op fails for a piece, that piece is left untouched and the others carry on.",
    ),
  dryRun: z.boolean().optional().describe("Check and report what would change per piece; write nothing."),
});
export type ApplyOpsParams = z.infer<typeof applyOpsSchema>;
