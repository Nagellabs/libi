/** MCP server wrapping the shared Libi tool layer */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInAppSurface } from "@/lib/mcp/agent-surface";
import * as tools from "@/mcp/tools";
import type { ToolContext } from "@/mcp/tools/types";
import { LIBI_SKILL_VERSION } from "@/mcp/version";
import { registerTrackingTools } from "@/mcp/tracking-mcp/register-tracking-tools";
import { installArgCoercion } from "@/mcp/tools/coerce-args";
import {
  getCompositionSchema,
  updatePieceNameSchema,
  updatePieceDescriptionSchema,
  saveAssetSchema,
  audioAddClipSchema,
  audioUpdateClipSchema,
  audioRemoveClipSchema,
  audioUnlinkSchema,
  audioSplitSchema,
  audioRelinkOverlaySchema,
  splitClipSchema,
  deleteClipSchema,
  duplicateClipSchema,
  addOverlaySchema,
  generateCaptionsSchema,
  updateOverlaySchema,
  getOverlaysSchema,
  RemoveOverlaySchema,
  ReorderOverlaysSchema,
  addKeyframeSchema,
  deleteKeyframeSchema,
  setKeyframeEasingSchema,
  listKeyframesSchema,
  saveOverlayPresetSchema,
  listOverlayPresetsSchema,
  applyOverlayPresetSchema,
  deleteOverlayPresetSchema,
  createCaptionStyleSchema,
  listCaptionStylesSchema,
  deleteCaptionStyleSchema,
  listFilesSchema,
  duplicateFileSchema,
  assignFileSchema,
  updateFileNotesSchema,
  uploadFileSchema,
  UploadFileToFalSchema,
  UploadFontSchema,
  listFontsSchema,
  registerMcpServerSchema,
  updateMcpServerSchema,
  setMcpServerEnabledSchema,
  removeMcpServerSchema,
  listPiecesSchema,
  createPieceSchema,
  showPieceSchema,
  deletePieceSchema,
  showAssetSchema,
  showInChatSchema,
  showPreviewSchema,
  showStoryboardSchema,
  highlightPropertySchema,
  highlightEffectSchema,
  setComplexityModeSchema,
  listEffectsSchema,
  applyLayerEffectSchema,
  clearLayerEffectSchema,
  installEffectFromGitSchema,
  addEffectSchema,
  updateEffectSchema,
  removeEffectSchema,
  listEffectPackagesSchema,
  TrimVideoSchema,
  ExtractAudioSchema,
  GenerateThumbnailsSchema,
  ConcatVideosSchema,
  RegenerateProxySchema,
  DropProxiesSchema,
  deleteFileSchema,
  audioDuckEnableSchema,
  audioDuckDisableSchema,
  audioDuckUpdateSchema,
  analysisGetSchema,
  analysisExtractAudioSchema,
  analysisExtractFramesSchema,
  analysisSaveSummarySchema,
  analysisSaveFramesSchema,
  analysisMarkStepFailedSchema,
  analysisRemoveStepSchema,
  analysisUpdateSummaryCustomSchema,
  analysisSearchFramesSchema,
  analysisSearchTranscriptSchema,
  extraAnalysisModelInputSchema,
  analysisTranscribeAudioSchema,
  analysisChunkAudioSchema,
  analysisSaveAudioChunkSchema,
  analysisSaveAudioChunkFromFileSchema,
  analysisGetAudioChunksSchema,
  type AnalysisGetParams,
  type AnalysisExtractAudioParams,
  type AnalysisExtractFramesParams,
  type AnalysisSaveSummaryParams,
  type AnalysisSaveFramesParams,
  type AnalysisMarkStepFailedParams,
  type AnalysisRemoveStepParams,
  type AnalysisUpdateSummaryCustomParams,
  type AnalysisSearchFramesParams,
  type AnalysisSearchTranscriptParams,
  type ExtraAnalysisModelParams,
  type AnalysisTranscribeAudioParams,
  type AnalysisChunkAudioParams,
  type AnalysisSaveAudioChunkParams,
  type AnalysisSaveAudioChunkFromFileParams,
  type AnalysisGetAudioChunksParams,
  whisperListModelsSchema,
  whisperDownloadModelSchema,
  type WhisperListModelsParams,
  type WhisperDownloadModelParams,
  ttsListVoicesSchema,
  ttsDownloadModelSchema,
  generateSpeechSchema,
  type TtsListVoicesParams,
  type TtsDownloadModelParams,
  type GenerateSpeechParams,
  musicListStylesSchema,
  musicDownloadModelSchema,
  generateMusicSchema,
  type MusicListStylesParams,
  type MusicDownloadModelParams,
  type GenerateMusicParams,
  installTrackingEngineSchema,
  type InstallTrackingEngineParams,
  musicDetectBeatsSchema,
  musicProfileSchema,
  musicInstallAnalysisDepsSchema,
  type MusicDetectBeatsParams,
  type MusicProfileParams,
  type MusicInstallAnalysisDepsParams,
  listBundledMcpsSchema,
  showMcpSettingsSchema,
  retryMcpServerSchema,
  retrieveAssetsDimensionsSchema,
  updateCompositionDimensionsSchema,
  listSkillsSchema,
  addSkillSchema,
  updateSkillSchema,
  removeSkillSchema,
  setSkillEnabledSchema,
  listSkillPromptsSchema,
  addSkillPromptSchema,
  updateSkillPromptSchema,
  removeSkillPromptSchema,
  setSkillsEnabledByTagSchema,
  forkSkillSchema,
  diffSkillOverrideSchema,
  listMcpServersSchema,
  ListCharactersSchema,
  GetCharacterSchema,
  CreateCharacterSchema,
  UpdateCharacterSchema,
  DeleteCharacterSchema,
  LinkCharacterToAssetSchema,
  UnlinkCharacterFromAssetSchema,
  ListItemsSchema,
  GetItemSchema,
  CreateItemSchema,
  UpdateItemSchema,
  DeleteItemSchema,
  LinkItemToAssetSchema,
  UnlinkItemFromAssetSchema,
  GetJobStatusSchema,
  ListJobsSchema,
  CancelJobSchema,
  getInstallPlanSchema,
  updateDepStatusSchema,
  recheckMcpSchema,
  restartAcpSessionSchema,
  diagnoseMcpSchema,
  restartMcpServerSchema,
  getPieceStateSchema,
  commitDraftSchema,
  discardDraftSchema,
  restoreSnapshotSchema,
  compareStatesSchema,
  listAssetsSchema,
  createAssetFolderSchema,
  renameAssetFolderSchema,
  deleteAssetFolderSchema,
  moveAssetFolderSchema,
  moveAssetSchema,
  createFolderSchema,
  renameFolderSchema,
  moveFolderSchema,
  movePieceToFolderSchema,
  deleteFolderSchema,
  listFoldersSchema,
  showFolderSchema,
  duplicatePieceSchema,
  duplicateFolderSchema,
  exportVideoSchema,
  sleepSchema,
  updateMemoriesSchema,
  overrideInstructionsSchema,
  importRemoteFilesSchema,
  startOnboardingSchema,
  showApiConfigSchema,
  buildOnboardingPieceSchema,
  storyboardGetSchema,
  addStoryboardCardSchema,
  approveStoryboardStageSchema,
  attachStoryboardKeyframeSchema,
  attachStoryboardClipSchema,
  setStoryboardGenerationSchema,
  selectStoryboardTakeSchema,
  hideStoryboardTakeSchema,
  setStoryboardReferenceSchema,
  editStoryboardCardSchema,
  getModelSchemaCacheSchema,
  saveModelSchemaCacheSchema,
  invalidateModelSchemaCacheSchema,
  renderOverlayFramesSchema,
  type RenderOverlayFramesParams,
  type UpdateMemoriesParams,
  type OverrideInstructionsParams,
  devSlowJobSchema,
} from "@/mcp/tools/schemas";
import {
  createFolderTool,
  renameFolderTool,
  moveFolderTool,
  movePieceToFolderTool,
  deleteFolderTool,
  listFoldersTool,
  showFolderTool,
} from "@/mcp/tools/folder-tools";
import {
  duplicatePieceTool,
  duplicateFolderTool,
} from "@/mcp/tools/duplication-tools";
import { exportVideo } from "@/mcp/tools/export-tools";
import {
  getPieceStateTool,
  commitDraftTool,
  discardDraftTool,
  restoreSnapshotTool,
  compareStatesTool,
} from "@/mcp/tools/snapshot-tools";
import {
  listAssetsTool,
  createAssetFolderTool,
  renameAssetFolderTool,
  deleteAssetFolderTool,
  moveAssetFolderTool,
  moveAssetTool,
} from "@/mcp/tools/asset-folder-tools";
import {
  getInstallPlan,
  updateDepStatus,
  recheckMcp,
  restartAcpSession,
} from "@/mcp/bundled-mcps/install-tools";
import { diagnoseMcp } from "@/mcp/bundled-mcps/diagnose";
import { restartMcpServer } from "@/mcp/bundled-mcps/restart-mcp";
import {
  listSkills,
  addSkill,
  updateSkill,
  removeSkill,
  setSkillEnabled,
  listSkillPrompts,
  addSkillPrompt,
  updateSkillPrompt,
  removeSkillPrompt,
  setSkillsEnabledByTag,
  forkSkill,
  diffSkillOverride,
  listMcpServersTool,
} from "@/mcp/tools/skill-tools";
import {
  listCharacters,
  getCharacter,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  linkCharacterToAsset,
  unlinkCharacterFromAsset,
} from "@/mcp/tools/character-tools";
import {
  listItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  linkItemToAsset,
  unlinkItemFromAsset,
} from "@/mcp/tools/item-tools";
import { trimVideo, extractAudio, generateThumbnails, concatVideos } from "@/mcp/tools/ffmpeg-tools";
import { sleep } from "@/mcp/tools/sleep-tool";
import {
  analysisGet,
  analysisExtractAudio,
  analysisExtractFrames,
  analysisSaveSummary,
  analysisSaveFrames,
  analysisMarkStepFailed,
  analysisRemoveStep,
  analysisUpdateSummaryCustom,
  analysisSearchFrames,
  analysisSearchTranscript,
  extraAnalysisModel,
  analysisTranscribeAudio,
  analysisChunkAudio,
  analysisSaveAudioChunk,
  analysisSaveAudioChunkFromFile,
  analysisGetAudioChunks,
} from "@/mcp/tools/analysis-tools";
import { whisperListModels, whisperDownloadModel } from "@/mcp/tools/whisper-tools";
import { ttsListVoices, ttsDownloadModel, generateSpeech } from "@/mcp/tools/tts-tools";
import { musicListStyles, musicDownloadModel, generateMusic } from "@/mcp/tools/music-tools";
import { installTrackingEngine } from "@/mcp/tools/tracking-tools";
import {
  musicDetectBeats,
  musicProfile,
  musicInstallAnalysisDeps,
} from "@/mcp/tools/music-analysis-tools";
import { listBundledMcps, showMcpSettings } from "@/mcp/tools/mcp-status-tools";
import {
  startOnboarding,
  showApiConfig,
  buildOnboardingPiece,
} from "@/mcp/tools/onboarding-tools";
import { updateMemories, overrideInstructions } from "@/mcp/tools/instruction-tools";
import { retryMcpServer } from "@/mcp/tools/mcp-retry-tools";
import { retrieveAssetsDimensions, updateCompositionDimensions } from "@/mcp/tools/canvas-tools";
import { regenerateProxy, dropProxies } from "@/mcp/tools/proxy-tools";
import { getJobStatus, listJobs, cancelJob } from "@/mcp/tools/job-tools";
import { importRemoteFiles } from "@/mcp/tools/remote-tools";
import { runJobViaServer, legacyTripleFromRunJobResult } from "@/mcp/jobs-client";
import { isTestMode } from "@/lib/test-mode";
import { storyboardGet, addStoryboardCard, approveStoryboardStage, attachStoryboardKeyframe, attachStoryboardClip, setStoryboardGeneration, selectStoryboardTake, hideStoryboardTake, setStoryboardReference, editStoryboardCard } from "@/mcp/tools/storyboard-tools";
import { getModelSchemaCacheTool, saveModelSchemaCacheTool, invalidateModelSchemaCacheTool } from "@/mcp/tools/model-schema-tools";
import { notify } from "@/mcp/notify";
import { trackToolUsed, wrapRegisterToolWithTracking } from "@/mcp/analytics";
import { wrapRegisterToolWithContext } from "@/mcp/tool-call-context";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// Structural supertype of both loose `ToolResult` and generic
// `ToolResultOf<…>` — the sink only serializes, so it accepts either.
function makeContent(result: tools.AnyToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function makeError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}

function makeContext(pieceId: string, sessionId?: string): ToolContext {
  return { pieceId, sessionId };
}

export function createLibiMcpServer(): McpServer {
  const server = new McpServer({
    name: "libi-video-studio",
    version: LIBI_SKILL_VERSION,
  });

  // Tolerate MCP clients (e.g. the Claude Code ACP adapter) that intermittently
  // send typed args as stringified JSON. Must run before any registerTool call.
  installArgCoercion(server);

  // Emit a `tool_used` analytics event for every libi.* tool call. Patched once
  // here so all subsequent server.registerTool(...) calls are instrumented.
  // Fire-and-forget; never blocks or fails a tool.
  {
    const orig = server.registerTool.bind(server);
    (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool =
      wrapRegisterToolWithTracking(orig as (...a: unknown[]) => unknown, trackToolUsed);
  }

  // Record { toolName, args } in an AsyncLocalStorage for the duration of
  // every tool handler so jobs-client can ship an exact tool hint with each
  // job enqueue (job↔chat-row correlation). Must wrap AFTER the analytics
  // wrapper so the context covers the real handler body.
  {
    const orig = server.registerTool.bind(server);
    (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool =
      wrapRegisterToolWithContext(orig as (...a: unknown[]) => unknown);
  }






  server.registerTool(
    "libi.get_composition",
    {
      description:
        "Retrieve the full composition: the manifest (sceneOrder, width, height, fps) and the data for all scenes in order.",
      inputSchema: getCompositionSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.getComposition(ctx);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_piece_name",
    {
      description:
        "Set the name (and optionally description) of the current piece. Respects the nameSetByUser flag — if the user has manually named the piece, the name will not be overwritten.",
      inputSchema: updatePieceNameSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.updatePieceName(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "piece", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_piece_description",
    {
      description: "Update only the description of the current piece.",
      inputSchema: updatePieceDescriptionSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.updatePieceDescription(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "piece", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.save_asset",
    {
      description:
        "Save a generated asset (audio, image, etc.) for the current piece. Stores the file and registers it in the database so it can be referenced in scene draw functions.",
      inputSchema: saveAssetSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.saveAsset(ctx, params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.get_version",
    {
      description: "Get the Libi MCP server version. Useful for checking if skill files are up to date.",
    },
    async () => {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          version: LIBI_SKILL_VERSION,
          name: "libi-video-studio",
        })}],
      };
    },
  );

  server.registerTool(
    "libi.audio_add_clip",
    {
      description:
        "Add an audio clip to the composition. Use kind='standalone' for music/VO/sfx files; use kind='inline' with linkedSceneId to bind audio to a video scene (the clip moves with the scene until unlinked). If the clip would run past the piece's current end and you didn't pass an explicit `duration`, ask the user whether to extend the piece or trim the clip BEFORE calling this — the tool refuses with `asset_longer_than_piece` until you pass `lengthPolicy: \"extend\" | \"trim\"` (or a `duration` that fits).",
      inputSchema: audioAddClipSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.audioAddClip(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.audio_update_clip",
    {
      description:
        "Patch fields on an audio clip: startTime, duration, trimStart, volume, enabled (the timeline speaker toggle), label.",
      inputSchema: audioUpdateClipSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.audioUpdateClip(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.audio_remove_clip",
    {
      description:
        "Remove an audio clip FROM THE TIMELINE (composition manifest only). The source file on disk is NOT deleted — it stays in resources, and the user can re-add it. For a linked (inline) clip the underlying video overlay keeps playing silently; call audio_relink_overlay later to bring the audio back. Use this when the user says 'remove audio from timeline' or 'mute the music section' or similar. To permanently delete the source file, use the file-delete path in the resources panel instead.",
      inputSchema: audioRemoveClipSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.audioRemoveClip(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.audio_unlink",
    {
      description:
        "Convert an inline clip (linked to a video scene) into a standalone clip so it can be moved, trimmed, or duplicated independently of the scene.",
      inputSchema: audioUnlinkSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.audioUnlink(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.audio_split",
    {
      description:
        "Split one clip into two at the given composition time. The new clip's id is returned in `data.tailId`.",
      inputSchema: audioSplitSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.audioSplit(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.split_clip",
    {
      description:
        "Cut (split) a timeline clip into two at a composition time. `targetId` is ANY timeline entity — a scene, an overlay, or an audio clip (auto-detected). `atTime` is in composition seconds and must lie strictly inside the clip. The new tail half's id is returned in `data.tailId`. This is the agent equivalent of the timeline 'Cut' gesture.",
      inputSchema: splitClipSchema,
    },
    async (params) => {
      try {
        const result = await tools.splitClipTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.delete_clip",
    {
      description:
        "Delete a timeline clip — a scene, overlay, or audio clip (auto-detected from `targetId`). Removes the clip from the timeline ONLY; the source file is never deleted. A video scene / video overlay's coupled inline audio is cascade-removed. By default the gap left behind stays open (correct when other layers, e.g. a background or captions, shouldn't be dragged along). Pass `ripple: true` to also close the gap: every overlay/audio clip that starts at or after the deleted clip's end time shifts left by its duration, timeline-wide (not lane-scoped); clips that already started before that point are left alone even if they span it. `ripple` is a no-op when deleting a SCENE — a scene delete already closes its own gap automatically (scene positions are sequential, and linked inline audio is re-synced to match), so there's no separate hole for `ripple` to close.",
      inputSchema: deleteClipSchema,
    },
    async (params) => {
      try {
        const result = await tools.deleteClipTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.duplicate_clip",
    {
      description:
        "Duplicate a timeline clip — a scene, overlay, or audio clip (auto-detected from `targetId`). The copy is placed immediately after the original. The new clip's id is returned in `data.newId`.",
      inputSchema: duplicateClipSchema,
    },
    async (params) => {
      try {
        const result = await tools.duplicateClipTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.audio_relink_overlay",
    {
      description:
        "Re-bind a standalone audio clip to a VIDEO OVERLAY as its inline audio, so the clip moves and trims with that overlay.",
      inputSchema: audioRelinkOverlaySchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.audioRelinkOverlay(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.audio_duck_enable",
    {
      description:
        "Enable sidechain ducking on a clip. The clip's volume dips when any sidechain clip plays loudly — typical use: music ducks under voiceover. Pass EVERY voice clip in `sidechainClipIds`: their levels are summed, so a piece with six VO lines ducks under all six without bouncing them into one file. Defaults: -30 dBFS threshold, 4:1 ratio, 50 ms attack, 250 ms release, -12 dB max reduction.",
      inputSchema: audioDuckEnableSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.audioDuckEnable(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.audio_duck_disable",
    {
      description: "Remove sidechain ducking from a clip.",
      inputSchema: audioDuckDisableSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.audioDuckDisable(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.audio_duck_update",
    {
      description:
        "Update ducking parameters on a clip that already has ducking enabled. Patch any subset of: sidechainClipIds, thresholdDb, ratio, attackMs, releaseMs, reductionDb. `sidechainClipIds` replaces the whole set of clips driving the duck.",
      inputSchema: audioDuckUpdateSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.audioDuckUpdate(ctx, params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.add_overlay",
    {
      description:
        "Add an overlay on top of the base scene. `kind` selects the type: \"text\" (content/font/color/align), \"image\" (fileId), \"video\" (fileId + optional trim), \"code\" (a Canvas2D draw function), or \"three\" (a three.js/WebGL scene + optional cameraPreset). All kinds take timing (startTime + duration in seconds), rect (position/size in composition pixels), z, and opacity. For \"code\" and \"three\", pass an optional `body` to seed the JS draw/scene function (a starter is scaffolded when omitted); the response returns `codeFilePath` — the per-overlay file you then EDIT DIRECTLY with your file tools (there is no string-update tool). For ANIMATED TEXT load `animated-text-overlays` and for 3D load `three-overlays` FIRST and copy a vetted template body. For \"video\": `duration` is required but does NOT bypass the length check — if `startTime + duration` runs past the piece's current end, ask the user to extend or trim BEFORE calling, then pass `lengthPolicy: \"extend\" | \"trim\"`, or the call is refused with `asset_longer_than_piece`.",
      inputSchema: addOverlaySchema,
    },
    async (params) => {
      try {
        const result = await tools.addOverlay(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.generate_captions",
    {
      description:
        "Build a timed caption track from a file's existing word-level transcript in ONE call. Reads the file's analysis transcript word timings, groups them into readable cues, and creates a set of styled text overlays that share a `caption.groupId` (one track). `style` selects a bundled caption style id (default \"clean\"); `anchor` places the line in a 3×3 grid (default \"bottom-center\"). Requires the audio-analysis/transcript step to have run first — returns `{ error: \"no_transcript\" }` if there are no spoken words.",
      inputSchema: generateCaptionsSchema,
    },
    async (params) => {
      try {
        const result = await tools.generateCaptions(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_overlay",
    {
      description:
        "Update an overlay's STRUCTURED fields only — timing (startTime/duration), rect, z-order, opacity, three cameraPreset, and for text overlays content/font/color/align. Only provided fields change. This NEVER edits code: for \"code\"/\"three\"/tracked-code overlays, edit the body file (`codeFilePath` from add_overlay / get_overlays) directly with your file tools.",
      inputSchema: updateOverlaySchema,
    },
    async (params) => {
      try {
        const result = await tools.updateOverlay(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.get_overlays",
    {
      description:
        "List the overlays on a piece. Returns each overlay's structured record; for code-bearing overlays (code/three/tracked-code) the large JS body is omitted and a `codeFilePath` is returned instead — read/edit that file directly with your file tools.",
      inputSchema: getOverlaysSchema,
    },
    async (params) => {
      try {
        return makeContent(await tools.getOverlays(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.get_job_status",
    {
      description:
        "Get the current status of a background job by id. Returns " +
        "{ status, progressDone/progressTotal/progressUnit, etaMs, error }. " +
        "Use to poll long-running operations (tracking, analysis, exports, ...).",
      inputSchema: GetJobStatusSchema,
    },
    async (params) => {
      try {
        return makeContent(await getJobStatus(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_jobs",
    {
      description:
        "List background jobs newest-first, WITHOUT needing a jobId. Filter by " +
        "`status` ('running' answers \"is anything still working?\") and/or `kind`. " +
        "Each row carries { jobId, kind, status, progress, percent, etaMs, " +
        "msSinceProgress, elapsedMs, error }. " +
        "**Call this before telling the user that nothing is happening.** A libi " +
        "job runs on the SERVER, not inside the tool call that started it, so it " +
        "keeps running when the tool call that launched it is interrupted, " +
        "declined, cancelled, or lost with the session — you simply stop hearing " +
        "about it, and you never receive its jobId. 'My tool call was declined' " +
        "is therefore NOT evidence that the work stopped; this tool is how you " +
        "check. " +
        "Reading a row: `etaMs: null` on a running job means the estimate is " +
        "unknown, NOT that it is nearly done. `msSinceProgress` is how long it " +
        "has been quiet — large values are normal mid-transfer for a big file " +
        "and are not by themselves evidence of a hang.",
      inputSchema: ListJobsSchema,
    },
    async (params) => {
      try {
        return makeContent(await listJobs(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.cancel_job",
    {
      description:
        "Request graceful cancellation of a running background job. Partial " +
        "results are preserved; subsequent compute_* calls with the same params " +
        "will resume from the cancellation point unless forceNew: true is set.",
      inputSchema: CancelJobSchema,
    },
    async (params) => {
      try {
        return makeContent(await cancelJob(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.remove_overlay",
    {
      description: "Remove an overlay (any kind) from the composition by id.",
      inputSchema: RemoveOverlaySchema,
    },
    async (params) => {
      try {
        const result = await tools.removeOverlayTool(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.reorder_overlays",
    {
      description:
        "Re-order overlays by supplying overlayIds in the desired z-order (first = bottom, last = top). Ids not listed keep their existing z; unknown ids are ignored.",
      inputSchema: ReorderOverlaysSchema,
    },
    async (params) => {
      try {
        const result = await tools.reorderOverlays(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.add_keyframe",
    {
      description:
        "Add (or replace) a keyframe on an overlay at `time` (SECONDS within the overlay window). Omit `properties` to snapshot ALL animatable properties (position/scale/rotation via rect+transform3d, plus opacity) at that time; or pass a subset — { opacity }, { position: {x,y} }, { scale }, { rotation } (degrees), { rect } or { transform3d } — to key just those. Optional `easing` (preset id or cubic-bezier(...)) sets the OUTGOING segment's curve. Tracked overlays accept OPACITY keyframes only (position/scale/rotation are driven by the motion track). Keyframes are the DEFAULT way to animate an overlay's transform/opacity — visible + editable on the timeline — rather than baking motion into a code overlay.",
      inputSchema: addKeyframeSchema,
    },
    async (params) => {
      try {
        const result = await tools.addKeyframe(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.delete_keyframe",
    {
      description:
        "Remove the keyframe at `time` (SECONDS) from an overlay across every track. A track left with fewer than 2 keyframes collapses back to a constant value; if no keyframes remain the property animation is cleared entirely.",
      inputSchema: deleteKeyframeSchema,
    },
    async (params) => {
      try {
        const result = await tools.deleteKeyframe(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.set_keyframe_easing",
    {
      description:
        "Set the easing curve of the segment LEAVING the keyframe at `time` (SECONDS). `easing` is a preset id (e.g. \"linear\", \"ease-in\", \"ease-out\", \"ease-in-out\", \"bounce-out\") or a cubic-bezier(a,b,c,d) literal.",
      inputSchema: setKeyframeEasingSchema,
    },
    async (params) => {
      try {
        const result = await tools.setKeyframeEasing(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_keyframes",
    {
      description:
        "List an overlay's keyframes. Returns { overlayId, duration, times (SECONDS), tracks: { rect?, opacity?, transform3d? } } where each track is an array of { time (SECONDS), easing? }. `times` is the unified sorted set of keyframe times across all tracks.",
      inputSchema: listKeyframesSchema,
    },
    async (params) => {
      try {
        return makeContent(await tools.listKeyframes(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.save_overlay_preset",
    {
      description:
        "Save an overlay's current look (style/animation/transform/effects) as a reusable named preset. Presets are unique by name. If a user preset of that name already exists, this returns `preset_name_exists` (with the existing `presetId` in `data`); pass `override:true` to replace it. A name that collides with a bundled look is reserved and returns `preset_name_reserved` — choose a different name.",
      inputSchema: saveOverlayPresetSchema,
    },
    async (params) => {
      try {
        return makeContent(await tools.saveOverlayPreset(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_overlay_presets",
    {
      description: "List saved overlay presets (bundled + user), optionally filtered by kind.",
      inputSchema: listOverlayPresetsSchema,
    },
    async (params) => {
      try {
        return makeContent(await tools.listOverlayPresets(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.apply_overlay_preset",
    {
      description: "Apply a saved preset's look onto an overlay.",
      inputSchema: applyOverlayPresetSchema,
    },
    async (params) => {
      try {
        const result = await tools.applyOverlayPreset(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.delete_overlay_preset",
    {
      description: "Delete a user-saved overlay preset.",
      inputSchema: deleteOverlayPresetSchema,
    },
    async (params) => {
      try {
        return makeContent(await tools.deleteOverlayPreset(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.create_caption_style",
    {
      description:
        "Create a NEW reusable caption STYLE (a static look: text color + optional stroke/shadow/background + font) from explicit fields — no overlay needed. Use this when the user describes or shows a look they want saved for reuse (e.g. 'make a punchy pink one with a thick black outline'). The style persists and appears in the Style tab's list for any caption. Names are unique per user: a taken name returns `style_name_exists` (pass `override:true` to replace); a name colliding with a bundled look returns `style_name_reserved`.",
      inputSchema: createCaptionStyleSchema,
    },
    async (params) => {
      try {
        const result = await tools.createCaptionStyle(params);
        if (result.success) notify.refreshQuery({ queryKey: "caption-styles" });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_caption_styles",
    {
      description:
        "List all caption styles (bundled curated looks + user-created ones) shown in the Style tab. Use before creating a style to avoid duplicate names.",
      inputSchema: listCaptionStylesSchema,
    },
    async () => {
      try {
        return makeContent(await tools.listCaptionStylesTool());
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.delete_caption_style",
    {
      description:
        "Delete a user-created caption style by id. Bundled curated styles cannot be deleted (returns `style_name_reserved`).",
      inputSchema: deleteCaptionStyleSchema,
    },
    async (params) => {
      try {
        const result = await tools.deleteCaptionStyle(params);
        if (result.success) notify.refreshQuery({ queryKey: "caption-styles" });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_files",
    {
      description:
        "List files. Use scope='piece' with pieceId to list piece files, scope='global' for unassigned files, scope='all' for everything. Supports case-insensitive search via query param.",
      inputSchema: listFilesSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId ?? "");
        const result = await tools.listFiles(ctx, params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.duplicate_file",
    {
      description:
        "Duplicate a file to another piece or to global. Creates an independent copy with a new ID — deleting the source won't affect the duplicate. Use this when you need the same asset in multiple pieces.",
      inputSchema: duplicateFileSchema,
    },
    async (params) => {
      try {
        const result = await tools.duplicateFile(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.assign_file",
    {
      description:
        "Move a file into a piece, or out of every piece by passing pieceId: null. " +
        "This MOVES the file — the original does not stay behind; use libi.duplicate_file " +
        "to copy instead. Files attached in chat or dropped on the terminal arrive " +
        "unassigned, so this is how you take one into the piece you are working on. " +
        "Overlays already accept unassigned files, so assigning is about where the asset " +
        "belongs, not about making it usable.",
      inputSchema: assignFileSchema,
    },
    async (params) => {
      try {
        const result = await tools.assignFile(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_file_notes",
    {
      description:
        "Append or replace agent-facing notes on a file (lineage, model, retry index, validation summary). Default mode appends a timestamped line; pass mode='replace' to overwrite.",
      inputSchema: updateFileNotesSchema,
    },
    async (params) => {
      try {
        const result = await tools.updateFileNotes(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.upload_file",
    {
      description:
        "Upload a file from the local filesystem into the current piece. Reads the file, infers its type, probes media metadata (if ffprobe is available), and stores it. Returns the file record with ID, name, type, dimensions, and duration. Use this to import user videos, images, audio, or documents.",
      inputSchema: uploadFileSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await tools.uploadFile(ctx, params);
        if (result.success) {
          if (params.pieceId) {
            notify.refreshQuery({ queryKey: "piece", pieceId: params.pieceId });
          } else {
            notify.refreshQuery({ queryKey: "files" });
          }
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.upload_font",
    {
      description:
        "Upload a custom font file (.ttf/.otf/.woff2) and return a fontFileId usable on text overlays. Reads the file from the local filesystem, infers its type from the extension, and stores it. Set the returned fontFileId on a text overlay (via libi.add_overlay / libi.update_overlay) to render that typeface in the preview and ffmpeg export.",
      inputSchema: UploadFontSchema.shape,
    },
    async (params) => {
      try {
        const result = await tools.uploadFont(params);
        if (result.success) {
          if (params.pieceId) {
            notify.refreshQuery({ queryKey: "piece", pieceId: params.pieceId });
          } else {
            notify.refreshQuery({ queryKey: "files" });
          }
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_fonts",
    {
      description:
        "List every font family that will actually render — the families it is SAFE to name in an overlay's `font` field. Naming anything else does not error: the canvas silently substitutes a fallback face, and a whole piece can ship in the wrong typeface with no signal anywhere that it happened. Returns three groups: `bundled` (libi's own families with their available weights — identical on every platform, always available, and the ones to prefer), `system` (this machine's installed fonts, capped at 40 and sorted — NOT portable, since macOS/Windows/Linux and even different machines ship different sets, so a piece that leans on one may fall back silently elsewhere; see `systemTruncated` and `note`), and `uploaded` (fonts uploaded via libi.upload_font, scoped to `pieceId` plus global uploads). Call this before picking a font rather than guessing a family name.",
      inputSchema: listFontsSchema.shape,
    },
    async (params) => {
      try {
        const result = await tools.listFonts(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.upload_file_to_fal",
    {
      description:
        "Upload a LOCAL libi file to fal.ai storage and return a fal CDN URL, for use as an image_urls/audio_urls reference in fal generation. The FAL key is handled server-side — never extract or pass it yourself. Result is cached (falUploadedUrl) so repeat calls are free.",
      inputSchema: UploadFileToFalSchema,
    },
    async (params) => {
      try {
        const result = await tools.uploadFileToFal(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.register_mcp_server",
    {
      description:
        "Register a new external MCP server so it becomes available in future agent sessions. Use this when the user asks you to add an MCP tool. Install any required npm packages first (e.g., via npx), then call this tool to wire up the server config. The server will be available after the next session starts. Ask the user whether the server should require approval before use.",
      inputSchema: registerMcpServerSchema,
    },
    async (params) => {
      try {
        const result = await tools.registerMcpServer(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_mcp_server",
    {
      description:
        "Edit an existing MCP server's configuration. Use when the user asks you to change credentials, command, args, env vars, or any other config field. PATCH semantics — only fields you pass are updated. Bundled MCPs accept ONLY envVars and requireApproval; every other field is read-only. The type (stdio/http) cannot be changed for any row. When updating envVars, ASK the user for the value — never invent secret values.",
      inputSchema: updateMcpServerSchema,
    },
    async (params) => {
      try {
        const result = await tools.updateMcpServer(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.set_mcp_server_enabled",
    {
      description:
        "Enable or disable an MCP server. Works on bundled and custom servers. Disabled servers are not surfaced to agents but their definition is preserved.",
      inputSchema: setMcpServerEnabledSchema,
    },
    async (params) => {
      try {
        const result = await tools.setMcpServerEnabled(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.remove_mcp_server",
    {
      description:
        "Permanently remove a custom MCP server. Bundled servers cannot be removed — use libi.set_mcp_server_enabled to disable them.",
      inputSchema: removeMcpServerSchema,
    },
    async (params) => {
      try {
        const result = await tools.removeMcpServer(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_pieces",
    {
      description:
        "List available pieces with optional search. Returns the currently-open piece separately in `openedPiece`, and matching pieces in `pieces`.",
      inputSchema: listPiecesSchema,
    },
    async (params) => {
      try {
        const result = await tools.listPieces(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.create_piece",
    {
      description:
        "Create a new piece. Returns the full piece record (id, name, description, dates) so you can immediately use the pieceId with other tools.",
      inputSchema: createPieceSchema,
    },
    async (params) => {
      try {
        const result = await tools.createPiece(params);
        if (result.success && (result.data as { id?: string } | undefined)?.id) {
          const newPieceId = (result.data as { id: string }).id;
          notify.refreshQuery({ queryKey: "pieces" });
          notify.refreshQuery({ queryKey: "piece", pieceId: newPieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.delete_piece",
    {
      description:
        "Permanently delete a piece and ALL of its data — every file (originals, " +
        "proxies, filmstrips), overlays, scenes, audio, analysis, tracks, and " +
        "snapshots. This is IRREVERSIBLE and cannot be undone. Before calling, you " +
        "MUST confirm with the user by name (use `list_pieces` first to resolve the " +
        "correct `pieceId` and show the user what will be deleted). Returns " +
        "`{ error: 'piece_not_found' }` if the piece does not exist.",
      inputSchema: deletePieceSchema,
    },
    async (params) => {
      try {
        const result = await tools.deletePiece(params);
        if (result.success) {
          // Invalidate the pieces list + this piece's caches on all SSE clients.
          // The MCP process runs separately from the Next server, so the helper's
          // in-process navigationEmitter emits don't reach clients — we must fire
          // the HTTP notify callbacks here (as create_piece does). The opened-piece
          // pointer was already cleared server-side inside deletePiece; a client
          // sitting on the deleted piece re-fetches its (now 404) composition and
          // falls back to the empty "no piece open" state.
          notify.refreshQuery({ queryKey: "pieces" });
          notify.refreshQuery({ queryKey: "piece", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.show_piece",
    {
      description:
        "Navigate the editor to display a piece. Use this after creating a new piece to show it to the user. Returns `piece_not_found` if the piece does not exist (e.g. it was deleted) — in that case the editor did NOT navigate, so do not tell the user the piece is on screen; list pieces or rebuild instead.",
      inputSchema: showPieceSchema,
    },
    async (params) => {
      try {
        const result = await tools.showPiece(params);
        // Only after the piece is proven to exist — see navigation-tools.ts.
        if (result.success) {
          notify.navigate({ target: "piece", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.show_asset",
    {
      description:
        "Navigate the editor to display an asset in the Assets tab. Returns `piece_not_found`, `file_not_found`, or `file_not_in_piece` (the file belongs to another piece — data.ownerPieceId names it). On any of these the editor did NOT navigate, so do not tell the user the asset is on screen.",
      inputSchema: showAssetSchema,
    },
    async (params) => {
      try {
        const result = await tools.showAsset(params);
        // Only after piece AND file are proven — see navigation-tools.ts.
        if (result.success) {
          notify.navigate({
            target: "asset",
            pieceId: params.pieceId,
            fileId: params.fileId,
          });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  // Surface-gated: registered ONLY for the in-app ACP chat (where an inline
  // media card can render). Terminal / BYO-CLI agents never see this tool, so
  // they cannot call it — they use libi.show_asset + the printed URL instead.
  // Gating is centralized in lib/mcp/agent-surface.ts (isInAppSurface reads the
  // LIBI_AGENT_SURFACE flag injected onto the libi entry on the ACP channel
  // only). To add another in-app-only tool, wrap its registerTool in the same
  // `if (isInAppSurface())` guard.
  if (isInAppSurface()) {
    server.registerTool(
      "libi.show_in_chat",
      {
        description:
          "Render an asset (image, video, or audio) INLINE IN THE CHAT so the user sees it without leaving the conversation. Call this for a SALIENT result — a rendered sketch, the selected/best take, a final generated image or audio — not for every intermediate retry. Pass the file's id; add an optional short caption. (In-app chat only.)",
        inputSchema: showInChatSchema,
      },
      async (params) => {
        try {
          return makeContent(await tools.showInChat(params));
        } catch (err) {
          return makeError(err);
        }
      },
    );
  }

  server.registerTool(
    "libi.trim_video",
    {
      title: "Trim Video",
      description:
        "Trim a video file to a time range and store the result as a new file on the piece. Uses ffmpeg stream-copy when possible (near-instant). Call after the user asks to shorten a clip or cut the beginning/end.",
      inputSchema: TrimVideoSchema.shape,
    },
    async (args) => {
      try {
        const parsed = TrimVideoSchema.parse(args);
        const result = await trimVideo(parsed);
        if (result.success) {
          notify.refreshQuery({ queryKey: "piece", pieceId: parsed.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.extract_audio",
    {
      title: "Extract Audio",
      description:
        "Extract the audio stream of a video file to a standalone audio file stored on the piece. Outputs MP3 by DEFAULT — already fal-safe, since Seedance reference-to-video @Audio1 accepts MP3/WAV only, so a plain call is correct for a voice reference. Pass format:'wav' for lossless PCM, or format:'copy' to stream-copy the source codec (fast/lossless .m4a, but NOT usable as an @Audio1 reference — fal rejects AAC). Pass startSeconds/endSeconds to extract just a segment (e.g. a clean ≤15s main-speaker voice sample). Call when the user wants to use a video's audio as a soundtrack, isolate the voiceover, carry a creator's voice into AI inserts, or clean up.",
      inputSchema: ExtractAudioSchema.shape,
    },
    async (args) => {
      try {
        const parsed = ExtractAudioSchema.parse(args);
        const result = await extractAudio(parsed);
        if (result.success) {
          notify.refreshQuery({ queryKey: "piece", pieceId: parsed.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.generate_thumbnails",
    {
      title: "Generate Thumbnails",
      description:
        "Generate N evenly-spaced JPEG thumbnails from a video file, storing each as an image file on the piece. Use when the user wants to preview a clip's content, pick a cover, or build a storyboard.",
      inputSchema: GenerateThumbnailsSchema.shape,
    },
    async (args) => {
      try {
        const parsed = GenerateThumbnailsSchema.parse(args);
        const result = await generateThumbnails(parsed);
        if (result.success) {
          notify.refreshQuery({ queryKey: "piece", pieceId: parsed.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.concat_videos",
    {
      title: "Concatenate Videos",
      description:
        "Concatenate two or more video files into a single output, stored as a new file on the piece. Stream-copies when compatible; otherwise re-encodes to H.264/AAC. Use when the user wants to combine clips in sequence.",
      inputSchema: ConcatVideosSchema.shape,
    },
    async (args) => {
      try {
        const parsed = ConcatVideosSchema.parse(args);
        const result = await concatVideos(parsed);
        if (result.success) {
          notify.refreshQuery({ queryKey: "piece", pieceId: parsed.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.regenerate_proxy",
    {
      title: "Regenerate Proxy",
      description:
        "Force regeneration of a video file's preview proxy. Use when the user complains about preview quality or suspects the proxy is out of sync.",
      inputSchema: RegenerateProxySchema.shape,
    },
    async (args) => {
      try {
        const parsed = RegenerateProxySchema.parse(args);
        const result = await regenerateProxy(parsed);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.drop_proxies",
    {
      title: "Drop Proxies",
      description:
        "Delete preview proxies for every video on the piece to free disk space. Proxies regenerate on next edit session.",
      inputSchema: DropProxiesSchema.shape,
    },
    async (args) => {
      try {
        const parsed = DropProxiesSchema.parse(args);
        const result = await dropProxies(parsed);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.delete_file",
    {
      description:
        "PERMANENTLY DELETE a source file from disk. This is the ONLY destructive path in the system — the file is unrecoverable, and every scene, audio clip, and overlay referencing it is also removed. Use ONLY when the user explicitly says 'delete the file' or equivalent. If the user says 'remove the audio', 'take out the scene', or anything ambiguous, prefer libi.audio_remove_clip or libi.delete_scene (those keep the file intact). Always confirm with the user before calling. The `confirm: true` field is a hard requirement to prevent accidental fire.",
      inputSchema: deleteFileSchema,
    },
    async (params) => {
      try {
        // Defense-in-depth: schema enforces confirm=true, but also check at
        // the runtime boundary in case anything bypassed Zod validation.
        if (params.confirm !== true) {
          return makeContent({ success: false, error: "delete_file requires confirm: true" });
        }

        // Look up the file's piece BEFORE delete so we know which composition
        // query to invalidate after the cascade. Files with pieceId === null
        // are global — only invalidate the files list.
        const db = getDb();
        const [file] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
        const pieceIdForRefresh = file?.pieceId ?? null;

        const result = await tools.deleteFileTool({ pieceId: pieceIdForRefresh ?? "" }, params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "files" });
          // Cascaded scenes / clips need the open editor to refetch its
          // composition. Skip when the file was global (no piece).
          if (pieceIdForRefresh) {
            notify.refreshQuery({ queryKey: "composition", pieceId: pieceIdForRefresh });
          }
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.show_preview",
    {
      description:
        "Switch the editor to the Preview tab (canvas player + timeline) for a piece. Use when the timeline should be the focus — e.g. after creating a piece, or when the user asks to see the video for a piece whose timeline isn't on screen. Do NOT call after every scene tool; if the user is actively on Assets, leave them there unless the scene change is the whole point of the turn. Returns `piece_not_found` if the piece does not exist — the editor did NOT navigate, so do not claim it did.",
      inputSchema: showPreviewSchema,
    },
    async (params) => {
      try {
        const result = await tools.showPreview(params);
        // Only after the piece is proven to exist — see navigation-tools.ts.
        if (result.success) {
          notify.navigate({ target: "preview", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.show_storyboard",
    {
      description:
        "Switch the editor to the Storyboard tab for a piece. Call this after you create or update the storyboard (author/revise schematics, attach a keyframe/clip, or advance the ladder) so the user sees the board you just changed. Mirrors libi.show_preview but targets the Storyboard tab. Returns `piece_not_found` if the piece does not exist — the editor did NOT navigate, so do not claim it did.",
      inputSchema: showStoryboardSchema,
    },
    async (params) => {
      try {
        const result = await tools.showStoryboard(params);
        // Only after the piece is proven to exist — see navigation-tools.ts.
        if (result.success) {
          notify.navigate({ target: "storyboard", pieceId: params.pieceId });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.highlight_property",
    {
      description:
        "Guided edit: flash a specific inspector field for an overlay so the user sees exactly which control to change. Pass the overlay id and a known property key (e.g. 'background.color', 'content', 'reveal.mode'); the editor selects the overlay, bumps the complexity mode if the field is gated, and flashes the control with an optional note. On failure it returns a structured error: `unknown_property` (key is not a known inspector field for any kind — data.validKeys lists them all, data.validKeysByKind groups them), `property_not_applicable` (key exists but not for THIS overlay's kind, data.kind — retry with one of data.validKeys), `overlay_not_found`, or `piece_not_found`. On a mismatch, pass one of data.validKeys instead of guessing.",
      inputSchema: highlightPropertySchema,
    },
    async (params) => {
      try {
        const result = await tools.highlightProperty(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.highlight_effect",
    {
      description:
        "Guided edit: flash an effect for the user — a catalog effect (opens the effects panel to that family/phase and flashes the thumbnail) or an effect already applied to a layer's slot. Use when the user asks how to add an effect, or says an applied effect looks off. Unknown effectId returns the valid id list.",
      inputSchema: highlightEffectSchema,
    },
    async (params) => {
      try {
        return makeContent(await tools.highlightEffect(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.set_complexity_mode",
    {
      description:
        "Switch a SPECIFIC overlay's inspector tab (transform / style / text) — pass pieceId + overlayId. Tabs are per-overlay intent groups (transform = placement/size/rotation/timing; style = look; text = content + typography), so this only affects the named overlay. Use to reveal the tab that holds the controls you're about to guide the user through. (highlight_property already auto-reveals a field's tab, so you usually don't need this before highlighting.) Non-text overlays only have the transform tab.",
      inputSchema: setComplexityModeSchema,
    },
    async (params) => {
      try {
        const result = await tools.setComplexityMode(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_effects",
    {
      description:
        "List built-in animation effects with their supported layer kinds, phases (in/out/loop), and params. Filter by kind/phase/family. AUTHORITATIVE, always-current set — prefer over memorized names.",
      inputSchema: listEffectsSchema,
    },
    async (params) => {
      try {
        return makeContent(await tools.listEffectsTool(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.apply_layer_effect",
    {
      description:
        "Apply an animation effect to a layer's in/out/loop slot. layerId may be an overlay, base scene, or audio clip. Unknown effectId / unsupported phase or kind returns a structured error with the valid set. Discover ids via libi.list_effects.",
      inputSchema: applyLayerEffectSchema,
    },
    async (params) => {
      try {
        return makeContent(await tools.applyLayerEffect(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.clear_layer_effect",
    {
      description: "Remove the effect on a layer's in/out/loop slot.",
      inputSchema: clearLayerEffectSchema,
    },
    async (params) => {
      try {
        return makeContent(await tools.clearLayerEffect(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.install_effect_from_git",
    {
      description:
        "Install a custom animation effect package from a git repo (must contain manifest.json + animate.js). The animate body is sandbox-validated before persisting; a poison package is never installed. On success the effect id is available to libi.apply_layer_effect. Validation failures return the compile error in data.hint.",
      inputSchema: installEffectFromGitSchema,
    },
    async (params) => {
      try {
        const result = await tools.installEffectFromGitTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "effects-custom" });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.add_effect",
    {
      description:
        "Author a custom animation effect from a manifest + an animate.js body — a PURE (progress, params) → TransformDelta function (math helpers only; no canvas/ctx/IO). The manifest + body are validated before any write; a failing validation persists nothing and returns the error in data.hint. After success, apply via libi.apply_layer_effect by the new id.",
      inputSchema: addEffectSchema,
    },
    async (params) => {
      try {
        const result = await tools.addEffectTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "effects-custom" });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_effect",
    {
      description:
        "Patch an existing custom effect package's animate.js source and/or manifest fields. The merged package is re-validated; a bad patch leaves the prior package intact (error in data.hint).",
      inputSchema: updateEffectSchema,
    },
    async (params) => {
      try {
        const result = await tools.updateEffectTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "effects-custom" });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.remove_effect",
    {
      description: "Delete a custom effect package by id.",
      inputSchema: removeEffectSchema,
    },
    async (params) => {
      try {
        const result = await tools.removeEffectTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "effects-custom" });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_effect_packages",
    {
      description:
        "List on-disk custom effect packages with their validity (id, name, valid, error?). Use to see what customs are installed and whether any failed to compile.",
      inputSchema: listEffectPackagesSchema,
    },
    async () => {
      try {
        return makeContent(await tools.listEffectPackagesTool());
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.analysis_get",
    {
      title: "Analysis: get",
      description: "Returns all analysis steps and keyframes for a file. Empty arrays when no analysis exists.",
      inputSchema: analysisGetSchema.shape,
    },
    async (args: AnalysisGetParams) => {
      const result = await analysisGet(args);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_extract_audio",
    {
      title: "Analysis: extract audio",
      description: "STOP — before any audio analysis you MUST invoke the `audio-analysis` skill via the Skill tool and follow it (chunking, save, retry). Reading the SKILL.md via Read/grep is NOT a substitute for invoking the Skill tool. Extract the audio track from a video into a 16 kHz mono WAV. Writes audio.wav under the file's analysis dir and returns its path. Does NOT write to the DB.",
      inputSchema: analysisExtractAudioSchema.shape,
    },
    async (args: AnalysisExtractAudioParams) => {
      const result = await analysisExtractAudio(args);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_extract_frames",
    {
      title: "Analysis: extract frames",
      description: "STOP — before any video analysis you MUST invoke the `video-analysis` skill via the Skill tool and follow it (it sets the keyframe density rule: count ≈ ceil(durationSec/3) for clips < 5 min, else /10 — NOT a flat 8). Reading the SKILL.md via Read/grep is NOT a substitute for invoking the Skill tool. Extract N evenly-spaced (or explicit-timestamp) keyframes as PNGs. Returns an array of { frameIndex, timestamp, filePath, absolutePath }. Does NOT write to the DB — call analysis_save_frames after describing each frame.",
      inputSchema: analysisExtractFramesSchema.shape,
    },
    async (args: AnalysisExtractFramesParams) => {
      const result = await analysisExtractFrames(args);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_save_summary",
    {
      title: "Analysis: save summary",
      description: "Upsert the summary step for a file with a structured VideoSummary (video_v1). Sets status=ready. Pass `summary` as a JSON OBJECT.",
      inputSchema: analysisSaveSummarySchema.shape,
    },
    async (args: AnalysisSaveSummaryParams) => {
      const result = await analysisSaveSummary(args);
      if (result.success) notify.refreshQuery({ queryKey: "analysis", fileId: args.fileId });
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_transcribe_audio",
    {
      title: "Analysis: transcribe audio",
      description: "Run the full transcript pipeline server-side: extract audio, chunk if needed (10-min default), transcribe per chunk, save each chunk row, auto-aggregate. Provider defaults to local Whisper (free); pass provider:'elevenlabs' for diarization/audio-events or on explicit request, and model to pick a Whisper size. May return status:'needs_install' on first Whisper use — then run libi.get_install_plan({ mcpId:'whisper' }). Returns a small status payload — words array stays in DB. retry:true re-processes only failed chunks.",
      inputSchema: analysisTranscribeAudioSchema.shape,
    },
    async (args: AnalysisTranscribeAudioParams) => {
      const result = await analysisTranscribeAudio(args);
      if (result.success) notify.refreshQuery({ queryKey: "analysis", fileId: args.fileId });
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.whisper_list_models",
    {
      title: "Whisper: list models",
      description: "List local Whisper model sizes (tiny|base|small|medium|large-v3) with approx size, install state, and the default. Read-only. Use to suggest a larger model when transcript accuracy is poor.",
      inputSchema: whisperListModelsSchema.shape,
    },
    async (args: WhisperListModelsParams) => {
      const result = await whisperListModels(args);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.whisper_download_model",
    {
      title: "Whisper: download model",
      description:
        "Download a Whisper model into ~/.libi/models/whisper/ (background job, progress streamed). Idempotent. Confirm with the user before downloading medium (~1.5 GB) or large-v3 (~3 GB). " +
        "Dedup signals — when the tool returns `attachedToRunning:true`, the server attached this call to a still-running download job with matching parameters and BLOCKED until it finished, so the model IS now on disk; inform the user we continued an existing download (mention elapsed time from `existingJob.startedAt`) and ASK if they prefer a separate fresh run (retry with `forceNew:true`). " +
        "This download runs on the SERVER. If this tool call is interrupted, declined, or cancelled, the download KEEPS GOING — you just stop hearing about it and never get its jobId. Never tell the user nothing was downloaded on the strength of a declined call: check `libi.list_jobs({ status: \"running\" })` first, and use it (not the terminal) to answer \"how far along is it?\". " +
        "When the tool returns `matchedExisting:true`, the model is already downloaded on disk — no action needed; you can proceed. The cached result implies the model is ready. Use `forceNew:true` only if you suspect the model is corrupted or needs re-downloading.",
      inputSchema: whisperDownloadModelSchema.shape,
    },
    async (args: WhisperDownloadModelParams, extra) => {
      const result = await whisperDownloadModel(args, extra);
      return makeContent(result);
    },
  );

  // DEV-ONLY: deterministic slow job for chat tool-call UI verification.
  // Registered only outside production builds so it never ships to end users.
  if (isTestMode() || process.env.NODE_ENV !== "production") {
    server.registerTool(
      "libi.dev_slow_job",
      {
        description:
          "DEV ONLY: run a deterministic slow background job that ticks once per second. Used to verify chat tool-call UI (progress, stop, ETA). Call with different `seconds` values in parallel to exercise concurrent same-name tools. Pass `quietAfter` to make it go silent partway — reproduces a job stuck inside one opaque unit, for checking that the ETA decays and is withdrawn rather than freezing.",
        inputSchema: devSlowJobSchema,
      },
      async (params, extra) => {
        try {
          const resp = await runJobViaServer<{ ticks: number }>(
            "dev_slow",
            {
              seconds: params.seconds,
              ...(params.label ? { label: params.label } : {}),
              ...(params.quietAfter !== undefined
                ? { quietAfter: params.quietAfter }
                : {}),
            },
            { extra, forceNew: true },
          );
          const ran = legacyTripleFromRunJobResult(resp);
          return makeContent({
            success: true,
            data: { jobId: ran.jobId, ...ran.result },
          });
        } catch (err) {
          return makeError(err);
        }
      },
    );
  }

  server.registerTool(
    "libi.tts_list_voices",
    {
      title: "Local TTS: list voices",
      description:
        "List local Kokoro TTS voices with language + gender, the default voice, and whether the model is installed. Read-only. Use to pick or suggest a voice.",
      inputSchema: ttsListVoicesSchema.shape,
    },
    async (args: TtsListVoicesParams) => {
      const result = await ttsListVoices(args);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.tts_download_model",
    {
      title: "Local TTS: download model",
      description:
        "Download the Kokoro model (~110 MB) into ~/.libi/models/tts/ (background job, progress streamed). Idempotent. No API key, free, on-device. " +
        "Dedup signals — when the tool returns `attachedToRunning:true`, the server attached this call to a still-running download job with matching parameters and BLOCKED until it finished, so the model IS now on disk; inform the user we continued an existing download (mention elapsed time from `existingJob.startedAt`) and ASK if they prefer a separate fresh run (retry with `forceNew:true`). " +
        "This download runs on the SERVER. If this tool call is interrupted, declined, or cancelled, the download KEEPS GOING — you just stop hearing about it and never get its jobId. Never tell the user nothing was downloaded on the strength of a declined call: check `libi.list_jobs({ status: \"running\" })` first, and use it (not the terminal) to answer \"how far along is it?\". " +
        "When the tool returns `matchedExisting:true`, the model is already downloaded on disk — no action needed; you can proceed. Use `forceNew:true` only if you suspect the model is corrupted or needs re-downloading.",
      inputSchema: ttsDownloadModelSchema.shape,
    },
    async (args: TtsDownloadModelParams, extra) => {
      const result = await ttsDownloadModel(args, extra);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.generate_speech",
    {
      title: "Generate speech (local TTS)",
      description:
        "Synthesize narration/voiceover locally with Kokoro and store it as an audio file on the piece. Free, no API key — the DEFAULT speech provider. Returns the stored file; pass withTimestamps:true for approximate per-word timings (caption/timeline alignment). On first use may return status:\"needs_install\" — then run libi.get_install_plan({ mcpId: \"local-tts\" }). Use ElevenLabs only on explicit request or for voice cloning.",
      inputSchema: generateSpeechSchema.shape,
    },
    async (args: GenerateSpeechParams, extra) => {
      const result = await generateSpeech(args, extra);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.music_list_styles",
    {
      title: "Local music: list styles",
      description:
        "List local ACE-Step music style hints, whether the model is installed, the download size, and the default/max duration. Read-only. Use to pick/suggest a style and to tell the user the download size before installing.",
      inputSchema: musicListStylesSchema.shape,
    },
    async (args: MusicListStylesParams) => {
      const result = await musicListStyles(args);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.music_download_model",
    {
      title: "Local music: download model",
      description:
        "Download the ACE-Step model (~8.3 GB) into ~/.libi/models/ace-step/ (background job, progress streamed). Idempotent. Pass force:true to re-download corrupt/partial files or a bumped version. Free, on-device. Tell the user the size first. " +
        "Dedup signals — when the tool returns `attachedToRunning:true`, the server attached this call to a still-running download job with matching parameters and BLOCKED until it finished, so the model IS now on disk; inform the user we continued an existing download (mention elapsed time from `existingJob.startedAt`) and ASK if they prefer a separate fresh run (retry with `forceNew:true`). " +
        "This download runs on the SERVER. If this tool call is interrupted, declined, or cancelled, the download KEEPS GOING — you just stop hearing about it and never get its jobId. Never tell the user nothing was downloaded on the strength of a declined call: check `libi.list_jobs({ status: \"running\" })` first, and use it (not the terminal) to answer \"how far along is it?\". " +
        "When the tool returns `matchedExisting:true`, the model is already downloaded on disk — no action needed; you can proceed. Use `forceNew:true` only if you suspect the model is corrupted or needs re-downloading.",
      inputSchema: musicDownloadModelSchema.shape,
    },
    async (args: MusicDownloadModelParams, extra) => {
      const result = await musicDownloadModel(args, extra);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.generate_music",
    {
      title: "Generate music (local)",
      description:
        "Generate music locally with ACE-Step and store it as an audio file on the piece. Free, no API key — the DEFAULT music provider. Pass `lyrics` for vocals, `instrumental:true` for a bed. May return status:\"needs_install\" (then run the local-music install plan after telling the user the ~8.3 GB size), status:\"confirm_duration\" (tell the user the ETA, re-call with confirm:true), or status:\"model_load_failed\" (call music_download_model({force:true}) then retry). Use paid/licensed music only on explicit request. Dedup signals — when the tool returns `attachedToRunning:true`, the server attached this call to a still-running job with matching parameters and BLOCKED until it finished, so a fresh audio file IS available in this response; inform the user we continued an existing run (mention elapsed time from `existingJob.startedAt`) and ASK if they prefer a separate fresh run (retry with `forceNew:true`). When the tool returns `matchedExisting:true`, the server found a cached prior result — NO new audio file is returned in this branch (the cached wavPath from the prior run is no longer guaranteed on disk). To actually obtain audio, call again with `forceNew:true`. Apply the dedup heuristic from CLAUDE.md: different piece → silently retry with `forceNew:true`; >7 days old → silently retry with `forceNew:true`; same piece + recent + successful → ASK the user whether to reuse the prior result or regenerate (if regenerate, retry with `forceNew:true`).",
      inputSchema: generateMusicSchema.shape,
    },
    async (args: GenerateMusicParams, extra) => {
      const result = await generateMusic(args, extra);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.music_detect_beats",
    {
      title: "Detect beats in audio",
      description:
        "Run local librosa to extract tempo, beat times, and onsets from an audio file. " +
        "Use the returned beatTimes[] in a canvas scene's draw function (the draw scope " +
        "exposes nearestBeat() and beatPulse() helpers). 5-min cap per call.",
      inputSchema: musicDetectBeatsSchema.shape,
    },
    async (args: MusicDetectBeatsParams, extra) => {
      const result = await musicDetectBeats(args, extra);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.music_profile",
    {
      title: "Profile audio (tempo, key, energy, prompt)",
      description:
        "Run local librosa to extract a music profile: tempo, key, energy, brightness, " +
        "percussiveness, descriptors, and a suggestedPrompt string ready to feed back into " +
        "ANY music generator (libi.generate_music, elevenlabs.compose_music, fal-ai music). " +
        "Use to 'make similar music' from a reference track.",
      inputSchema: musicProfileSchema.shape,
    },
    async (args: MusicProfileParams, extra) => {
      const result = await musicProfile(args, extra);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.music_install_analysis_deps",
    {
      title: "Install local music analysis deps",
      description:
        "One-shot uv prefetch of the librosa env. Called from the local-music install plan, " +
        "Section B. Idempotent: re-runs return immediately if the marker already matches.",
      inputSchema: musicInstallAnalysisDepsSchema.shape,
    },
    async (args: MusicInstallAnalysisDepsParams, extra) => {
      const result = await musicInstallAnalysisDeps(args, extra);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_chunk_audio",
    {
      title: "Analysis: chunk audio (BYO STT)",
      description: "Plan and extract per-chunk audio WAVs (no transcription). Returns array of { chunkId, chunkIndex, audioPath, startSeconds, endSeconds }. Use this when bringing your own STT provider — call your STT per chunk path, then save_audio_chunk or save_audio_chunk_from_file for each result.",
      inputSchema: analysisChunkAudioSchema.shape,
    },
    async (args: AnalysisChunkAudioParams) => {
      const result = await analysisChunkAudio(args);
      if (result.success) notify.refreshQuery({ queryKey: "analysis", fileId: args.fileId });
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_save_audio_chunk",
    {
      title: "Analysis: save audio chunk (inline)",
      description: "Save the transcript for one audio chunk inline. Pass { chunkId, text, words, language?, languageProbability? }. Server offsets timestamps to source audio. When all chunks for the file are ready, the transcript step auto-aggregates.",
      inputSchema: analysisSaveAudioChunkSchema.shape,
    },
    async (args: AnalysisSaveAudioChunkParams) => {
      const result = await analysisSaveAudioChunk(args);
      if (result.success) {
        const fileId = (result.data as { fileId?: string }).fileId;
        if (fileId) notify.refreshQuery({ queryKey: "analysis", fileId });
      }
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_save_audio_chunk_from_file",
    {
      title: "Analysis: save audio chunk (from JSON file)",
      description: "Save the transcript for one audio chunk by reading a JSON file. Pass { chunkId, jsonPath } where jsonPath is absolute and the file contains { text, words: [...], language_code?, language_probability? } (same shape as ElevenLabs). Server reads + validates + saves. Bypasses tool-arg size limits — use this when the chunk transcript is large.",
      inputSchema: analysisSaveAudioChunkFromFileSchema.shape,
    },
    async (args: AnalysisSaveAudioChunkFromFileParams) => {
      const result = await analysisSaveAudioChunkFromFile(args);
      if (result.success) {
        const fileId = (result.data as { fileId?: string }).fileId;
        if (fileId) notify.refreshQuery({ queryKey: "analysis", fileId });
      }
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_get_audio_chunks",
    {
      title: "Analysis: get audio chunks (status)",
      description: "Return per-chunk status (and error messages, if any) for a file's transcript chunks. Read-only. Useful for diagnosing partial transcribe failures.",
      inputSchema: analysisGetAudioChunksSchema.shape,
    },
    async (args: AnalysisGetAudioChunksParams) => {
      const result = await analysisGetAudioChunks(args);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_save_frames",
    {
      title: "Analysis: save frames",
      description: "Atomic batch save of the frames step. REPLACE SEMANTICS: every existing keyframe for the file is deleted and replaced by this batch. Each entry: { frameIndex, timestamp, filePath, description?, skipped?, skipReason?, custom? }.",
      inputSchema: analysisSaveFramesSchema.shape,
    },
    async (args: AnalysisSaveFramesParams) => {
      const result = await analysisSaveFrames(args);
      if (result.success) notify.refreshQuery({ queryKey: "analysis", fileId: args.fileId });
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_mark_step_failed",
    {
      title: "Analysis: mark step failed",
      description: "Record that a specific analysis step (transcript / summary / frames) cannot be completed. Sets status=failed with the given error message. The user sees this in the analysis tab and can ask you to retry.",
      inputSchema: analysisMarkStepFailedSchema.shape,
    },
    async (args: AnalysisMarkStepFailedParams) => {
      const result = await analysisMarkStepFailed(args);
      if (result.success) notify.refreshQuery({ queryKey: "analysis", fileId: args.fileId });
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_remove_step",
    {
      title: "Analysis: remove step",
      description: "Delete an analysis step row (and any cascaded keyframes if kind=frames). Use to fully clear and redo a step.",
      inputSchema: analysisRemoveStepSchema.shape,
    },
    async (args: AnalysisRemoveStepParams) => {
      const result = await analysisRemoveStep(args);
      if (result.success) notify.refreshQuery({ queryKey: "analysis", fileId: args.fileId });
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_update_summary_custom",
    {
      title: "Analysis: update summary custom",
      description: "Merge a value into the summary step's `custom` JSON bag.",
      inputSchema: analysisUpdateSummaryCustomSchema.shape,
    },
    async (args: AnalysisUpdateSummaryCustomParams) => {
      const result = await analysisUpdateSummaryCustom(args);
      if (result.success) notify.refreshQuery({ queryKey: "analysis", fileId: args.fileId });
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_search_frames",
    {
      title: "Analysis: search frames",
      description: "Search keyframes by structured fields in their FrameDescription (subject, objects, text, tags, shot, time range).",
      inputSchema: analysisSearchFramesSchema.shape,
    },
    async (args: AnalysisSearchFramesParams) => {
      const result = await analysisSearchFrames(args);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.analysis_search_transcript",
    {
      title: "Analysis: search transcript",
      description: "Substring search over transcript words. Returns ±2-word context windows around each hit with start/end timestamps.",
      inputSchema: analysisSearchTranscriptSchema.shape,
    },
    async (args: AnalysisSearchTranscriptParams) => {
      const result = await analysisSearchTranscript(args);
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.extra_analysis_model",
    {
      title: "Analysis: generate script",
      description: "PAID. Runs a provider-driven (fal.ai → Gemini 2.5 Pro by default) full-video analysis and returns a structured production script (shots, music, sound design) — designed for feeding back into a text-to-video model to recreate the video. Default flow is the free agent-driven `analysis_*` tool family; use this when the user explicitly asks to recreate / remake / reproduce a video. Returns the script directly; the agent should read it back to the user.",
      inputSchema: extraAnalysisModelInputSchema.shape,
    },
    async (args: ExtraAnalysisModelParams, extra) => {
      const result = await extraAnalysisModel(args, extra);
      if (result.success) notify.refreshQuery({ queryKey: "analysis", fileId: args.fileId });
      return makeContent(result);
    },
  );

  server.registerTool(
    "libi.update_memories",
    {
      description:
        "Update the user's memories file (~/.libi/memories.md) — cross-session preferences injected into every agent session under '## Memories'. mode 'append' (default) adds ONE new memory at the end; mode 'replace' rewrites the whole file (pass the FULL new content). Saving regenerates agent workspace files and TERMINATES ALL RUNNING SESSIONS. ALWAYS ask the user for explicit consent before calling.",
      inputSchema: updateMemoriesSchema.shape,
    },
    async (params: UpdateMemoriesParams) => {
      try {
        return makeContent(await updateMemories(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.override_instructions",
    {
      description:
        "DISCOURAGED — prefer libi.update_memories for behavior changes. Replaces the BASE agent instructions with a user-owned editable copy (like forking a bundled skill). Use ONLY when a specific base behavior actively conflicts with what the user wants and a memory cannot win against it. Requires explicit user consent. Pass the FULL new instructions document (markdown), not a diff. Saving regenerates workspaces and TERMINATES ALL RUNNING SESSIONS. The user can revert from the Instructions page.",
      inputSchema: overrideInstructionsSchema.shape,
    },
    async (params: OverrideInstructionsParams) => {
      try {
        return makeContent(await overrideInstructions(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_bundled_mcps",
    {
      description:
        "This is libi's view of what was registered, not your live tool surface. Your actually-available tools are authoritative — use this to diagnose mismatches or to ask the user to fix a missing MCP.\n\nReturns each bundled MCP server's installStatus (installed | needs_config | failed | not_required | checking | pending), required env-var names, and the names of env vars that ARE currently configured (never values). Use this to detect missing API keys before relying on a server's tools.",
      inputSchema: listBundledMcpsSchema,
    },
    async (params) => {
      try {
        return makeContent(await listBundledMcps(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.show_mcp_settings",
    {
      description:
        "Navigate the user to the MCPs & Skills page (MCP Servers tab), optionally focusing a specific bundled server card by id (e.g. 'elevenlabs'). Use this after telling the user that an MCP needs configuration, so they can click and set the API key without hunting through menus.",
      inputSchema: showMcpSettingsSchema,
    },
    async (params) => {
      try {
        return makeContent(await showMcpSettings(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.start_onboarding",
    {
      description:
        "Re-open the onboarding panel (agent setup + the guided demo). Use only if the user asks to see onboarding again.",
      inputSchema: startOnboardingSchema,
    },
    async (params) => {
      try {
        return makeContent(await startOnboarding(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.show_api_config",
    {
      description:
        "Open the inline API-key config panel for a bundled MCP (right of the chat). Call this the moment a tool fails with mcp_missing_key, or libi.list_bundled_mcps shows a needed MCP as needs_config, then tell the user which key to paste. Never read or echo the key value.",
      inputSchema: showApiConfigSchema,
    },
    async (params) => {
      try {
        return makeContent(await showApiConfig(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.retry_mcp_server",
    {
      title: "Retry MCP server",
      description:
        "Re-probe an external MCP server and refresh its serverStatus. Use when list_bundled_mcps reports serverStatus !== 'up'. Note: a successfully-recovered server only becomes available in NEW chat sessions.",
      inputSchema: retryMcpServerSchema,
    },
    async (params) => {
      try {
        return makeContent(await retryMcpServer(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.retrieve_assets_dimensions",
    {
      title: "Retrieve assets dimensions",
      description:
        "Return width/height/aspect of every video overlay and image overlay in the composition, plus the current composition dimensions (width, height, aspect, isVertical). This is how you learn the piece's ASPECT RATIO. Call it BEFORE generating any AI video or image whose aspect must match the piece, before making canvas-aspect decisions, and before calling libi.update_composition_dimensions.",
      inputSchema: retrieveAssetsDimensionsSchema,
    },
    async (params) => {
      try {
        return makeContent(await retrieveAssetsDimensions(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_composition_dimensions",
    {
      title: "Update composition dimensions",
      description:
        "Set the canvas width and height for a piece. Affects preview and export. Returns warnings for overlays whose rects fall outside the new bounds — the agent should adjust those overlays separately. Decide the right dimensions based on the user's intent and the assets in play (use libi.retrieve_assets_dimensions first).",
      inputSchema: updateCompositionDimensionsSchema,
    },
    async (params) => {
      try {
        return makeContent(await updateCompositionDimensions(params));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_skills",
    {
      description:
        "This is libi's view of registered skills, not your live skill surface. Your actually-available skills are authoritative — use this to diagnose mismatches or to ask the user to fix a missing skill.\n\nLists all skills (bundled + user) with enabled state. User rows that override a bundled skill carry `overridesBundled: true` and `bundledUpdatedSinceFork`: true means the bundled original has changed since the user forked it (their copy is missing those updates), false means it hasn't, \"unknown\" means the fork predates staleness tracking. When the user asks about a skill whose `bundledUpdatedSinceFork` is true, disclose that the bundled version has been updated and offer to show the differences (libi.diff_skill_override), revert to the bundled version (libi.remove_skill on the override), or merge the upstream changes into their copy (libi.update_skill).",
      inputSchema: listSkillsSchema.shape,
    },
    async (params, extra) => {
      try {
        const sessionIdFromMeta = (extra?._meta as { sessionId?: string } | undefined)?.sessionId;
        const sessionId = sessionIdFromMeta ?? extra?.sessionId ?? "";
        return await listSkills(makeContext("", sessionId), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.add_skill",
    {
      description:
        "Install a user skill. The `body` must be a complete SKILL.md with YAML frontmatter; the frontmatter `name` MUST match the `name` parameter (kebab-case). Writes both the DB row and ~/.libi/skills/<name>/SKILL.md.",
      inputSchema: addSkillSchema.shape,
    },
    async (params, extra) => {
      try {
        const sessionIdFromMeta = (extra?._meta as { sessionId?: string } | undefined)?.sessionId;
        const sessionId = sessionIdFromMeta ?? extra?.sessionId ?? "";
        return await addSkill(makeContext("", sessionId), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_skill",
    {
      description:
        "Author or update a skill's SKILL.md body in place.\n\nBehavior:\n  - User skills: updates the user row.\n  - Bundled skills with no override: creates a new \"override\" row that shadows the bundled body.\n  - Bundled skills with an existing override: updates the override row.\n\nThe `body` must include YAML frontmatter whose `name` matches the param `name` exactly.\n\nAfter the change is saved, the current ACP session is reloaded so the new body is picked up. The in-flight prompt is cancelled — end your turn and ask the user to re-send their request.",
      inputSchema: updateSkillSchema.shape,
    },
    async (params, extra) => {
      try {
        const sessionIdFromMeta = (extra?._meta as { sessionId?: string } | undefined)?.sessionId;
        const sessionId = sessionIdFromMeta ?? extra?.sessionId ?? "";
        return await updateSkill(makeContext("", sessionId), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.remove_skill",
    {
      description:
        "Delete a user skill, or delete an override (which restores the bundled skill). Bundled skills cannot be deleted; use libi.set_skill_enabled to disable them, or libi.update_skill to override them. After the change, the current session reloads — end your turn.",
      inputSchema: removeSkillSchema.shape,
    },
    async (params, extra) => {
      try {
        const sessionIdFromMeta = (extra?._meta as { sessionId?: string } | undefined)?.sessionId;
        const sessionId = sessionIdFromMeta ?? extra?.sessionId ?? "";
        return await removeSkill(makeContext("", sessionId), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.set_skill_enabled",
    {
      description:
        "Toggle a skill's enabled state. Disabled skills are not surfaced to agents but their definition is preserved.",
      inputSchema: setSkillEnabledSchema.shape,
    },
    async (params, extra) => {
      try {
        const sessionIdFromMeta = (extra?._meta as { sessionId?: string } | undefined)?.sessionId;
        const sessionId = sessionIdFromMeta ?? extra?.sessionId ?? "";
        return await setSkillEnabled(makeContext("", sessionId), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_skill_prompts",
    {
      description:
        "List the prompt files (prompts/*.md) inside a skill's folder. Works for bundled and user skills.",
      inputSchema: listSkillPromptsSchema.shape,
    },
    async (params) => {
      try {
        return await listSkillPrompts(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.add_skill_prompt",
    {
      description:
        "Add a prompt file at prompts/<name>.md inside a USER skill so the SKILL.md can reference it (e.g. `see prompts/<name>.md`). Splits a large skill into reusable, on-demand fragments. Bundled skills are read-only — fork first with libi.fork_skill.",
      inputSchema: addSkillPromptSchema.shape,
    },
    async (params) => {
      try {
        return await addSkillPrompt(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_skill_prompt",
    {
      description: "Replace the contents of an existing prompts/<name>.md on a USER skill.",
      inputSchema: updateSkillPromptSchema.shape,
    },
    async (params) => {
      try {
        return await updateSkillPrompt(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.remove_skill_prompt",
    {
      description: "Delete prompts/<name>.md from a USER skill.",
      inputSchema: removeSkillPromptSchema.shape,
    },
    async (params) => {
      try {
        return await removeSkillPrompt(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.set_skills_enabled_by_tag",
    {
      description:
        "Enable or disable every skill carrying ANY of the given tags in one call. Use to flip a whole group, e.g. disable all `ugc` skills.",
      inputSchema: setSkillsEnabledByTagSchema.shape,
    },
    async (params) => {
      try {
        return await setSkillsEnabledByTag(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.fork_skill",
    {
      description:
        "Fork a bundled skill into an editable user copy of the same name (SKILL.md + all prompts). The user copy shadows the bundled one; delete it to revert. Use before editing a bundled skill or its prompts.",
      inputSchema: forkSkillSchema.shape,
    },
    async (params) => {
      try {
        return await forkSkill(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.diff_skill_override",
    {
      description:
        "Compare a user-overridden (forked) skill against its bundled original. Returns whether the bundled skill changed since the fork (upstreamChanged: true | false | \"unknown\"), which files changed (changedFiles: relative paths, or null if the fork predates base snapshots), and three SKILL.md versions: base (bundled at fork time), currentBundled (bundled now), userCopy (the user's fork). Use this when bundledUpdatedSinceFork is true in libi.list_skills to explain the upstream changes to the user and to propose: keep the fork, revert (libi.remove_skill on the override), or merge the upstream changes into the user copy (libi.update_skill).",
      inputSchema: diffSkillOverrideSchema.shape,
    },
    async (params) => {
      try {
        return await diffSkillOverride(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_mcp_servers",
    {
      description:
        "This is libi's view of what was registered, not your live tool surface. Your actually-available tools are authoritative — use this to diagnose mismatches or to ask the user to fix a missing MCP.\n\nReturns enabled MCP servers — id, name, description, type, installStatus, bundled. Never includes secrets (env-var values, headers). Use this to discover capabilities (e.g. AI image/video/audio MCPs) before deciding how to fulfill a request.",
      inputSchema: listMcpServersSchema.shape,
    },
    async (params) => {
      try {
        return await listMcpServersTool(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  // ─── Character catalog ────────────────────────────────────────────
  server.registerTool(
    "libi.list_characters",
    {
      description:
        "List globally cataloged characters. Optional `query` performs case-insensitive substring match on name. Use this BEFORE creating a new character to disambiguate. If multiple matches return, present them to the user with their `representativeImageUrl` for confirmation.",
      inputSchema: ListCharactersSchema.shape,
    },
    async (params) => {
      try {
        return await listCharacters(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.get_character",
    {
      description: "Fetch a single character with its linked asset IDs.",
      inputSchema: GetCharacterSchema.shape,
    },
    async (params) => {
      try {
        return await getCharacter(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.create_character",
    {
      description:
        "Catalog a new character globally. Pass `fromAsset: { fileId, bbox, frameTime? }` to crop a representative image from a source asset (frameTime required for videos). After creation, render the representative image inline to the user (markdown: `![name](representativeImageUrl)`) and ask if the name and crop are correct.",
      inputSchema: CreateCharacterSchema.shape,
    },
    async (params) => {
      try {
        return await createCharacter(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_character",
    {
      description:
        "Update a character's name, description, or representative image.",
      inputSchema: UpdateCharacterSchema.shape,
    },
    async (params) => {
      try {
        return await updateCharacter(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.delete_character",
    {
      description:
        "Remove a character from the catalog. Mappings to assets are cascade-removed; assets themselves are kept unless `deleteAssets: true` is passed (which requires explicit user confirmation before invoking).",
      inputSchema: DeleteCharacterSchema.shape,
    },
    async (params) => {
      try {
        return await deleteCharacter(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.link_character_to_asset",
    {
      description:
        "Associate an existing character with an asset that contains them. Idempotent.",
      inputSchema: LinkCharacterToAssetSchema.shape,
    },
    async (params) => {
      try {
        return await linkCharacterToAsset(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.unlink_character_from_asset",
    {
      description:
        "Remove the association between a character and an asset.",
      inputSchema: UnlinkCharacterFromAssetSchema.shape,
    },
    async (params) => {
      try {
        return await unlinkCharacterFromAsset(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );


  // ─── Item catalog ────────────────────────────────────────────────
  server.registerTool(
    "libi.list_items",
    {
      description:
        "List globally cataloged items. Optional `query` performs case-insensitive substring match on name. Use this BEFORE creating a new item to disambiguate. If multiple matches return, present them to the user with their `representativeImageUrl` for confirmation.",
      inputSchema: ListItemsSchema.shape,
    },
    async (params) => {
      try {
        return await listItems(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.get_item",
    {
      description: "Fetch a single item with its linked asset IDs.",
      inputSchema: GetItemSchema.shape,
    },
    async (params) => {
      try {
        return await getItem(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.create_item",
    {
      description:
        "Catalog a new item globally. Pass `fromAsset: { fileId, bbox, frameTime? }` to crop a representative image from a source asset (frameTime required for videos). After creation, render the representative image inline to the user (markdown: `![name](representativeImageUrl)`) and ask if the name and crop are correct.",
      inputSchema: CreateItemSchema.shape,
    },
    async (params) => {
      try {
        return await createItem(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_item",
    {
      description:
        "Update an item's name, description, or representative image.",
      inputSchema: UpdateItemSchema.shape,
    },
    async (params) => {
      try {
        return await updateItem(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.delete_item",
    {
      description:
        "Remove an item from the catalog. Mappings to assets are cascade-removed; assets themselves are kept unless `deleteAssets: true` is passed (which requires explicit user confirmation before invoking).",
      inputSchema: DeleteItemSchema.shape,
    },
    async (params) => {
      try {
        return await deleteItem(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.link_item_to_asset",
    {
      description:
        "Associate an existing item with an asset that contains it. Idempotent.",
      inputSchema: LinkItemToAssetSchema.shape,
    },
    async (params) => {
      try {
        return await linkItemToAsset(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.unlink_item_from_asset",
    {
      description: "Remove the association between an item and an asset.",
      inputSchema: UnlinkItemFromAssetSchema.shape,
    },
    async (params) => {
      try {
        return await unlinkItemFromAsset(makeContext(""), params);
      } catch (err) {
        return makeError(err);
      }
    },
  );


  // ─── Tier-2 bundled-MCP install flow ─────────────────────────
  server.registerTool(
    "libi.get_install_plan",
    {
      description:
        "Get the markdown install plan for a bundled MCP. The plan tells you, step by step, what to download, install, and verify. Read the plan, then follow it using your Bash/Read/Write tools. After each step call libi.update_dep_status.",
      inputSchema: getInstallPlanSchema.shape,
    },
    async (args) => {
      try {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(await getInstallPlan(args)) },
          ],
        };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.update_dep_status",
    {
      description:
        "Record install progress for a bundled MCP. Call after each install step (status='installing'), on success ('installed'), or on failure ('failed' with error message). Optional env={KEY:VALUE} merges secrets (API keys) into the MCP's spawn env.",
      inputSchema: updateDepStatusSchema.shape,
    },
    async (args) => {
      try {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(await updateDepStatus(args)) },
          ],
        };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.recheck_mcp",
    {
      description:
        "Probe a bundled MCP server's startup handshake. Returns up/down + tools list. Call this after install steps complete to verify the server actually boots.",
      inputSchema: recheckMcpSchema.shape,
    },
    async (args) => {
      try {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(await recheckMcp(args)) },
          ],
        };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.restart_acp_session",
    {
      description:
        "Reload the entire ACP session — all bundled MCPs come down and back up. Use this only when you don't have a specific MCP to target; otherwise prefer `libi.restart_mcp_server` which has the same effect today but is named more clearly and future-proof if claude-agent-acp ever supports per-MCP restart. Call this after installing a bundled MCP and after `update_dep_status` with status='installed'. Then end your turn and tell the user: 'Installed — please open a new chat and re-send your request to use the new tools.' (claude-agent-acp loads MCP servers at session-creation time, so the current session can't see them until a new chat is started.)",
      inputSchema: restartAcpSessionSchema.shape,
    },
    async (args, extra) => {
      try {
        // The ACP session ID is propagated via the MCP request `_meta` field
        // by claude-agent-acp. `_meta` is z.loose() in the SDK, so unknown
        // fields like `sessionId` flow through; fall back to the transport
        // sessionId (also surfaced on `extra`) when not present.
        const sessionIdFromMeta = (extra?._meta as { sessionId?: string } | undefined)
          ?.sessionId;
        const sessionId = sessionIdFromMeta ?? extra?.sessionId ?? "";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(await restartAcpSession(args, { sessionId })),
            },
          ],
        };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.diagnose_mcp",
    {
      description:
        "Snapshot of a bundled MCP's state when something looks broken: install/server status, spawn config (env keys, no values), whether the MCP is in your current session, per-MCP auxiliary checks (binary present, API key set), and plain-English hints. Call this FIRST when an MCP appears not to work — it's much faster than guessing.",
      inputSchema: diagnoseMcpSchema.shape,
    },
    async (args) => {
      try {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(await diagnoseMcp(args)) },
          ],
        };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.restart_mcp_server",
    {
      description:
        "Restart a specific bundled MCP server. Use after fixing an issue diagnose_mcp surfaced (e.g. installed a missing binary, set an API key). Returns immediately; the restart happens server-side. Per current claude-agent-acp limitations, all bundled MCPs restart together — the tool tells you to ask the user to open a new chat (or re-send) so the new session picks up the rebuilt MCP list.",
      inputSchema: restartMcpServerSchema.shape,
    },
    async (args, extra) => {
      try {
        const sessionIdFromMeta = (extra?._meta as { sessionId?: string } | undefined)
          ?.sessionId;
        const sessionId = sessionIdFromMeta ?? extra?.sessionId ?? "";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(await restartMcpServer(args, { sessionId })),
            },
          ],
        };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  // ─── Snapshot / Draft tools ──────────────────────────────────────
  server.registerTool(
    "libi.get_piece_state",
    {
      title: "Get piece state",
      description:
        "Returns whether the piece has uncommitted draft changes, when the current snapshot was committed, and the last 10 prior snapshots in the safety-net history.",
      inputSchema: getPieceStateSchema.shape,
    },
    async (params) => {
      try {
        const result = await getPieceStateTool(getPieceStateSchema.parse(params));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.commit_draft",
    {
      title: "Commit draft to snapshot",
      description:
        "Promotes the current draft of a piece to be the new committed snapshot. The previous snapshot is moved to history (last 10 retained). Use after a meaningful chunk of work the user is happy with. VERIFY-GATE: refuses (error \"unvalidated_generated_clips\") when AI-generated video clips on the timeline have no completed analysis — validate each via the Stage 4.5 flow (extract frames → vision-read → save_frames → save_summary) first, or pass acknowledgeUnvalidated:true only if the user explicitly accepts committing un-validated clips.",
      inputSchema: commitDraftSchema.shape,
    },
    async (params) => {
      try {
        const result = await commitDraftTool(commitDraftSchema.parse(params));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.discard_draft",
    {
      title: "Discard draft",
      description:
        "Drops the draft and returns the piece to the snapshot state. Destructive — requires confirm:true.",
      inputSchema: discardDraftSchema.shape,
    },
    async (params) => {
      try {
        const result = await discardDraftTool(discardDraftSchema.parse(params));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.restore_snapshot",
    {
      title: "Restore a previous snapshot",
      description:
        "Promotes one of the prior snapshots (from getPieceState.recentSnapshots) to become the current snapshot. The current snapshot is archived to history. Destructive — requires confirm:true.",
      inputSchema: restoreSnapshotSchema.shape,
    },
    async (params) => {
      try {
        const result = await restoreSnapshotTool(restoreSnapshotSchema.parse(params));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.compare_states",
    {
      title: "Compare snapshot to draft",
      description:
        "Returns a structured diff (scenes, overlays, audio clips: added/removed/changed counts) between the committed snapshot and the current draft.",
      inputSchema: compareStatesSchema.shape,
    },
    async (params) => {
      try {
        const result = await compareStatesTool(compareStatesSchema.parse(params));
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        return makeError(err);
      }
    },
  );

  // ─── Asset Folder tools ──────────────────────────────────────────
  server.registerTool(
    "libi.list_assets",
    {
      title: "List assets",
      description:
        "List asset folders + assets at one level of a piece (or the global pool when pieceId is null). Omit folderId for the scope root.",
      inputSchema: listAssetsSchema.shape,
    },
    async (params) => {
      try {
        const result = await listAssetsTool(listAssetsSchema.parse(params));
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );
  server.registerTool(
    "libi.create_asset_folder",
    {
      title: "Create asset folder",
      description:
        "Create an asset folder to group files within a piece (or globally). Nestable. Omit parentFolderId for top-level.",
      inputSchema: createAssetFolderSchema.shape,
    },
    async (params) => {
      try {
        const result = await createAssetFolderTool(createAssetFolderSchema.parse(params));
        if (result.success) {
          notify.refreshQuery({
            queryKey: "asset-folders",
            pieceId: params.pieceId ?? undefined,
          });
        }
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );
  server.registerTool(
    "libi.rename_asset_folder",
    {
      title: "Rename asset folder",
      description: "Rename an asset folder.",
      inputSchema: renameAssetFolderSchema.shape,
    },
    async (params) => {
      try {
        const result = await renameAssetFolderTool(renameAssetFolderSchema.parse(params));
        if (result.success) {
          notify.refreshQuery({ queryKey: "asset-folders" });
        }
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );
  server.registerTool(
    "libi.delete_asset_folder",
    {
      title: "Delete asset folder",
      description:
        "Delete an asset folder. mode 'orphan' (default) moves contents to the parent then deletes the folder. mode 'cascade' deletes the folder AND every asset + subfolder inside it — destructive, requires confirm:true.",
      inputSchema: deleteAssetFolderSchema.shape,
    },
    async (params) => {
      try {
        const result = await deleteAssetFolderTool(deleteAssetFolderSchema.parse(params));
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );
  server.registerTool(
    "libi.move_asset_folder",
    {
      title: "Move asset folder",
      description:
        "Move an asset folder under a new parent. parentFolderId null = top level. Rejects cycles.",
      inputSchema: moveAssetFolderSchema.shape,
    },
    async (params) => {
      try {
        const result = await moveAssetFolderTool(moveAssetFolderSchema.parse(params));
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );
  server.registerTool(
    "libi.move_asset",
    {
      title: "Move asset",
      description:
        "Move an asset (file) into a folder. folderId null = scope root. The folder must match the file's scope.",
      inputSchema: moveAssetSchema.shape,
    },
    async (params) => {
      try {
        const result = await moveAssetTool(moveAssetSchema.parse(params));
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.create_folder",
    {
      description:
        "Create a folder to organize pieces. Folders can be nested. Omit parentFolderId for a top-level folder.",
      inputSchema: createFolderSchema,
    },
    async (params) => {
      try {
        const result = await createFolderTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "folders" });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.rename_folder",
    { description: "Rename a folder.", inputSchema: renameFolderSchema },
    async (params) => {
      try {
        const result = await renameFolderTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "folders" });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.move_folder",
    {
      description:
        "Move a folder under a new parent folder. Pass parentFolderId null to move it to the top level. Rejects moves that would create a cycle.",
      inputSchema: moveFolderSchema,
    },
    async (params) => {
      try {
        const result = await moveFolderTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "folders" });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.move_piece_to_folder",
    {
      description:
        "Move a piece into a folder. Pass folderId null to move it back to the root (no folder).",
      inputSchema: movePieceToFolderSchema,
    },
    async (params) => {
      try {
        const result = await movePieceToFolderTool(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "folders" });
          notify.refreshQuery({ queryKey: "pieces" });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.delete_folder",
    {
      description:
        "Delete a folder. mode 'orphan' moves contained pieces and sub-folders up to the parent then deletes the folder. mode 'cascade' deletes the folder AND every piece and sub-folder inside it — this is destructive and requires confirm:true.",
      inputSchema: deleteFolderSchema,
    },
    async (params) => {
      try {
        const result = await deleteFolderTool(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "folders" });
          notify.refreshQuery({ queryKey: "pieces" });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.list_folders",
    {
      description:
        "List all folders with their parent and piece counts. Returns a flat array; build the tree from parentFolderId.",
      inputSchema: listFoldersSchema,
    },
    async () => {
      try {
        return makeContent(await listFoldersTool());
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.show_folder",
    {
      description:
        "Reveal a folder in the resources panel (expands its ancestors and scrolls to it).",
      inputSchema: showFolderSchema,
    },
    async (params) => {
      try {
        const result = await showFolderTool(params);
        if (result.success) notify.navigate({ target: "folder", id: params.folderId });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.duplicate_piece",
    {
      description:
        "Create an independent copy of a piece. Returns a jobId immediately — the copy runs in the background. Poll libi.get_job_status({ jobId }) until status is 'completed' before editing the copy. The copy is fully independent: changes to either piece do not affect the other.",
      inputSchema: duplicatePieceSchema,
    },
    async (params) => {
      try {
        const result = await duplicatePieceTool(params);
        if (result.success) notify.refreshQuery({ queryKey: "pieces" });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.duplicate_folder",
    {
      description:
        "Create an independent copy of a folder and all its pieces. Returns jobIds (one per piece) immediately — each piece copy runs in the background. Poll libi.get_job_status for each jobId until all are 'completed' before editing the copies.",
      inputSchema: duplicateFolderSchema,
    },
    async (params) => {
      try {
        const result = await duplicateFolderTool(params);
        if (result.success) {
          notify.refreshQuery({ queryKey: "folders" });
          notify.refreshQuery({ queryKey: "pieces" });
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.export_video",
    {
      description:
        "Export the piece's composition to a video file on disk. Output goes to the user's configured export folder (Settings → Export) unless `destFolder` is provided. Returns the absolute file path. Progress streams through `notifications/progress` so the chat UI shows a live tool call. ALWAYS confirm with the user before exporting — it produces a final file and runs for tens of seconds to minutes. Best quality at 'source' (preserves native dimensions); use '1080p'/'1440p'/'4k' only when the user requests a specific delivery spec. Upscaling from a lower-res source is allowed but produces a larger file without added detail.",
      inputSchema: exportVideoSchema,
    },
    async (params, extra) => {
      try {
        const result = await exportVideo(params, extra);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.sleep",
    {
      description:
        "Sleep for N seconds inside the MCP server. Use BETWEEN long-running polls — e.g. after submitting a fal-ai job, sleep 20 s before calling check_job again. AbortSignal-aware: agent can cancel mid-sleep. Emits progress notifications every 5 s. PREFERRED over Terminal 'sleep' (which can hit tool-call timeouts) or self-scheduling wakeups (which can fail to re-fire). seconds: 1-1800. Optional reason surfaces in logs + progress messages.",
      inputSchema: sleepSchema,
    },
    async (params, extra) => {
      try {
        const result = await sleep(params, {
          signal: extra?.signal,
          sendNotification: extra?.sendNotification,
          progressToken: extra?._meta?.progressToken as string | number | undefined,
        });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.import_remote_files",
    {
      description:
        "Download one or more PUBLIC http(s) files (e.g. demo assets) in the background. autoUpload (default true) registers each as a piece file; false downloads to a temp path only. Returns per-url results in `items`; each item has status 'ok' (with fileId/localPath) or 'error' (with a message) — one bad URL does not fail the rest, so inspect each item's status.",
      inputSchema: importRemoteFilesSchema,
    },
    async (params, extra) => {
      try {
        return makeContent(await importRemoteFiles(params, extra));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.build_onboarding_piece",
    {
      description:
        "Build libi's own 52-second explainer piece — the first-run demo. Downloads ~15 MB of pre-made media from libi's public asset bucket, verifies each file, and assembles the full composition. Returns the pieceId plus a `description` of what was built — runtime, beats, layer counts, how the audio is mixed — derived from the definition; relay that rather than describing the film from memory. Reports progress; a second call for the same version returns the piece already built unless force is set. ONBOARDING ONLY — never for a user's own project.",
      inputSchema: buildOnboardingPieceSchema,
    },
    async (params, extra) => {
      try {
        return makeContent(await buildOnboardingPiece(params, extra));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.storyboard_get",
    {
      description:
        "Fetch the piece's storyboard (cards in play order) plus the ABSOLUTE on-disk paths of each card's files. Edit those files directly (card.json + the render unit) to change the storyboard — the server watches them and updates the UI. Use the approve tool for paid stage transitions.",
      inputSchema: storyboardGetSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        return makeContent(await storyboardGet(params, ctx));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.add_storyboard_card",
    {
      description:
        "Create a storyboard card — the bootstrap/append entry point. Use this to START a storyboard on a piece that has none (it initializes the manifest on the first call) and to add scenes. Only `card.title` is required; everything else defaults, and a block-driven Tier-1 render unit is written so a schematic renders immediately. After creating cards, REFINE them by editing the returned card.json / render-unit files directly (the server watches + re-renders). Set `overview`/`budgetUsd` on the first card. This is a structural CREATE; paid stage transitions still go through approve_storyboard_stage.",
      inputSchema: addStoryboardCardSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await addStoryboardCard(params, ctx);
        if (result.success) notify.refreshQuery({ queryKey: "storyboard", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.edit_storyboard_card",
    {
      description:
        "Edit an EXISTING storyboard card. Primary use: manage role-tagged SKETCH slots — `addSketch` appends a start/end/reference sketch bound to the clip-gen param it conditions (scaffolds a default render unit you then refine by editing the returned unit file), `removeSketch` drops one, `reorderSketches` reorders. Also edits scalar `fields` (title, description, promptFragment, durationSec, role, voiceover, camera). Reference IMAGES/VIDEOS, audio, and settings stay on `set_storyboard_generation` / `set_storyboard_reference`. Structural drawing edits stay file-based (edit the unit file).",
      inputSchema: editStoryboardCardSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await editStoryboardCard(params, ctx);
        if (result.success) notify.refreshQuery({ queryKey: "storyboard", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.approve_storyboard_stage",
    {
      description:
        "Approve a storyboard card's tier (schematic | keyframe | clip), advancing the ladder. keyframe/clip are PAID and gated on the previous tier. This is the ONLY storyboard mutation that is a tool call; structural edits are done by editing files directly.",
      inputSchema: approveStoryboardStageSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await approveStoryboardStage(params, ctx);
        if (result.success) {
          notify.refreshQuery({ queryKey: "storyboard", pieceId: params.pieceId });
          // Approving the clip stage places/updates a video OVERLAY in the
          // composition — invalidate the composition so the timeline/preview
          // reflects it (saveManifest only emits piece-state/pieces).
          if (params.stage === "clip") {
            notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
          }
        }
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.attach_storyboard_keyframe",
    {
      description:
        "Attach a generated Tier-2 keyframe image (by libi file id) to a storyboard card, recording its cost and advancing the card to the keyframe stage. The agent generates the image (gpt-image-2, conditioned on the card's schematic + character ref) and uploads it FIRST, then calls this.",
      inputSchema: attachStoryboardKeyframeSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await attachStoryboardKeyframe(params, ctx);
        if (result.success) notify.refreshQuery({ queryKey: "storyboard", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.attach_storyboard_clip",
    {
      description:
        "Attach a generated Tier-3 clip video (by libi file id) to a storyboard card as a new versioned take (v1, v2, …) in the card's clips list, recording its cost. The agent generates the clip and uploads it FIRST, then calls this. Use libi.select_storyboard_take to choose which take is placed on the timeline; stage advancement is separate via libi.approve_storyboard_stage.",
      inputSchema: attachStoryboardClipSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await attachStoryboardClip(params, ctx);
        if (result.success) notify.refreshQuery({ queryKey: "storyboard", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.set_storyboard_generation",
    {
      description:
        "Set a card's keyframe or clip generation spec. GATED: requires a fresh model-schema cache for (apiUrl, model) — returns schema_cache_missing in data if absent/stale. Validates params against that schema and returns schema_validation_failed with per-issue detail if they don't conform. Only a conforming spec is saved.",
      inputSchema: setStoryboardGenerationSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await setStoryboardGeneration(params, ctx);
        if (result.success) notify.refreshQuery({ queryKey: "storyboard", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.select_storyboard_take",
    {
      description:
        "Choose which generated take is placed on the timeline for a card. Re-places the scene.",
      inputSchema: selectStoryboardTakeSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await selectStoryboardTake(params, ctx);
        if (result.success) notify.refreshQuery({ queryKey: "storyboard", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.hide_storyboard_take",
    {
      description:
        "Soft-hide a generated take (removed from display, file retained). If it was selected, the newest remaining take is reselected.",
      inputSchema: hideStoryboardTakeSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await hideStoryboardTake(params, ctx);
        if (result.success) notify.refreshQuery({ queryKey: "storyboard", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.set_storyboard_reference",
    {
      description:
        "Link a generation param (e.g. reference_video) to another card's selected take for continuity. Resolves live — when the source take changes, this updates.",
      inputSchema: setStoryboardReferenceSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext(params.pieceId);
        const result = await setStoryboardReference(params, ctx);
        if (result.success) notify.refreshQuery({ queryKey: "storyboard", pieceId: params.pieceId });
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.get_model_schema_cache",
    {
      description:
        "Read the cached parameter schema for a generation endpoint (key: apiUrl+model). Returns {exists, stale, fetchedAt, schema}. Call BEFORE generating; if missing or stale, fetch the endpoint's API schema and save it via libi.save_model_schema_cache.",
      inputSchema: getModelSchemaCacheSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext("");
        return makeContent(await getModelSchemaCacheTool(params, ctx));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.save_model_schema_cache",
    {
      description:
        "Cache an endpoint's normalized parameter schema (GenFieldDef[]) keyed by apiUrl+model, stamped now. Upserts. Populate this before set_storyboard_generation.",
      inputSchema: saveModelSchemaCacheSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext("");
        return makeContent(await saveModelSchemaCacheTool(params, ctx));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.invalidate_model_schema_cache",
    {
      description:
        "Drop a cached endpoint schema. Call this when a generation fails because the cached schema was wrong, then re-fetch.",
      inputSchema: invalidateModelSchemaCacheSchema,
    },
    async (params) => {
      try {
        const ctx = makeContext("");
        return makeContent(await invalidateModelSchemaCacheTool(params, ctx));
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.render_overlay_frames",
    {
      description:
        "Render a few REAL composition frames (base video + all overlays, including WebGL 3D `three` overlays) to PNG files on disk, to VERIFY what an overlay actually looks like. Returns `frames: [{ time, path, overflow: { touchesEdge, edges } }]` plus `unresolvedFonts: string[]` (ALWAYS present, even when empty). PRIMARY CHECK: each `path` is a PNG on disk — OPEN IT WITH YOUR READ TOOL to SEE the rendered frame, then compare against the source/intent and fix the overlay (size/position/blank) if wrong. Pass `contactSheet: true` to ALSO get one labelled JPEG grid (`contactSheet` path) of every requested time — look at that ONE image instead of opening N PNGs; this is the cheap way to make looking a habit, so prefer it whenever you request more than one time. `unresolvedFonts` lists any font family, among the text overlays actually on screen at your requested times, that will NOT render as itself — it is falling back to a different face SILENTLY, at a different width, with nothing else telling you. A non-empty `unresolvedFonts` means: stop, call `libi.list_fonts`, and fix the `font` on the affected overlay before judging anything else about the frame. `overflow` is a SECONDARY HINT and is base-dependent: over a dark/canvas base it reliably flags an overlay clipping the edge, but OVER A FULL-FRAME VIDEO it reflects the VIDEO reaching the edges, not your overlay — so when there's a video base, do NOT shrink an overlay just because `touchesEdge` is true; judge overlay overflow by LOOKING at the frame. Pass `atTimes` (1–8 composition timestamps in seconds) or `overlayId` (renders that overlay's start/middle/end). Use this after adding or updating a 3D/caption overlay, in a build → render → look → fix loop.",
      inputSchema: renderOverlayFramesSchema,
    },
    async (params: RenderOverlayFramesParams) => {
      try {
        const result = await tools.renderOverlayFrames(params);
        return makeContent(result);
      } catch (err) {
        return makeError(err);
      }
    },
  );

  server.registerTool(
    "libi.install_tracking_engine",
    {
      title: "Install the local tracking engine",
      description:
        "Install the libi-tracking engine (uv Python env + ONNX models) as a background job with streamed progress. This is a REAL install: ~2 GB of downloads, typically 10–20 minutes — tell the user the cost and get their OK first (libi.get_install_plan, mcpId 'libi-tracking', holds the full disclosure). Free — no API key, everything runs on-device. Idempotent and resumable: artifacts are sha-pinned, so a re-call after a failure repairs/resumes rather than starting over, and `force:true` is almost never needed. " +
        "On success the NEXT step is libi.verify_install — it runs the engine self-test and persists the dependency row the tracking tools gate on; only then retry the original tracking call. " +
        "Dedup signals — `attachedToRunning:true` means the server attached this call to a still-running install and BLOCKED until it finished (the engine IS now on disk; mention elapsed time from `existingJob.startedAt`). `matchedExisting:true` means a cached prior job matched; trust the `status` field, which re-checks the disk. " +
        "This install runs on the SERVER: if this call is interrupted, declined, or cancelled, the install KEEPS GOING — check `libi.list_jobs({ status: \"running\" })` before telling the user nothing was installed.",
      inputSchema: installTrackingEngineSchema.shape,
    },
    async (args: InstallTrackingEngineParams, extra) => {
      const result = await installTrackingEngine(args, extra);
      return makeContent(result);
    },
  );

  // The 13 tracking tools (compute_object_track, add_tracked_overlay,
  // ground_target, … verify_install) are registered on the always-on core
  // libi MCP so the agent ALWAYS has them — a separately-spawned tier-2
  // MCP could race claude-agent-acp's session-creation MCP load and leave
  // the agent with zero tracking tools (the dogfood failure this fixes).
  // Single shared registration → the standalone `libi serve-mcp-tracking`
  // surface (mcp/tracking-mcp/server.ts) can never drift. The heavy Python
  // engine stays lazy/tier-2 (tools return tracking_engine_not_installed
  // until provisioned); only the tool surface is always-on.
  registerTrackingTools(server);

  return server;
}
