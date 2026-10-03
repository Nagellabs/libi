import { z } from "zod/v3";
import { notify } from "@/mcp/notify";
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
  analysisChunkAudio,
  analysisSaveAudioChunk,
  analysisSaveAudioChunkFromFile,
  analysisGetAudioChunks,
} from "@/mcp/tools/analysis-tools";
import {
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
  analysisChunkAudioSchema,
  analysisSaveAudioChunkSchema,
  analysisSaveAudioChunkFromFileSchema,
  analysisGetAudioChunksSchema,
  decodeJsonStringIfNeeded,
} from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

/** Tell the analysis tab a file's analysis changed (every write below does, on success). */
function refreshAnalysis(fileId: string | undefined, ok: boolean): void {
  if (ok && fileId) notify.refreshQuery({ queryKey: "analysis", fileId });
}

/**
 * zod reports one layer of a nested payload at a time (`description` is a string -> then its fields ->
 * then `setting.location` ...), so an agent without the video-analysis skill loops on invalid-argument
 * errors. These name the whole shape once. They are the REQUIRED fields only; the optional ones and the
 * enums are in the video-analysis skill's references/shapes.md and the manual's "Schemas (frame_v1,
 * video_v1)" block (`libi.read_manual({ section: "canvas-dimensions" })`).
 */
export const FRAME_SHAPE_SKELETON =
  '{ frameIndex: 0, timestamp: 0, filePath: "frame-0001.png", description: { schema_version: "frame_v1", frame_index: 0, timestamp: 0, scene: "one sentence", setting: { location: "where" }, people: [{ description: "who" }], objects: [{ name: "what" }] } }';
export const SUMMARY_SHAPE_SKELETON =
  '{ schema_version: "video_v1", overview: "2-3 sentences", duration: 12.5, subjects: [{ id: "person_1", description: "who", appearance_frame_indices: [0], appearance_timestamps: [0] }], sections: [{ start: 0, end: 5, description: "what", frame_indices: [0, 1] }], recurring_objects: [{ name: "what", count: 2 }] }';

/** Where the failing issue sits: the first path segment (`frames`, `summary`), or null for a top-level one. */
const touches = (issues: { path: (string | number)[] }[], root: string) => issues.some((i) => i.path[0] === root);

const framesInvalidHint = (issues: { path: (string | number)[] }[]) =>
  touches(issues, "frames")
    ? `Each frames entry is an OBJECT, \`description\` an OBJECT too (never a string). Minimal valid entry: ${FRAME_SHAPE_SKELETON}. people and objects are required lists (\`[]\` when empty). Optional fields: video-analysis skill, references/shapes.md.`
    : null;

const summaryInvalidHint = (issues: { path: (string | number)[] }[]) =>
  touches(issues, "summary")
    ? `\`summary\` is ONE OBJECT. Minimal valid value: ${SUMMARY_SHAPE_SKELETON}. subjects, sections and recurring_objects are required lists (\`[]\` when unknown). Optional fields: video-analysis skill, references/shapes.md.`
    : null;

const savedFileId = (result: { data?: unknown }) => (result.data as { fileId?: string } | undefined)?.fileId;

export const analysisSaveTool: ActionToolDef = {
  name: "libi.analysis_save",
  description:
    "Write a file's analysis into libi: keyframe descriptions, the video summary (and its custom bag), a transcript chunk, a failed-step record, or clear a step to redo it. Load the video-analysis or audio-analysis skill first. Actions: frames, summary, summary_custom, audio_chunk, audio_chunk_from_file, step_failed, remove_step.",
  // The nested shapes are far larger than the rest of the tool (~5 KB of JSON schema): advertise them loosely and
  // let each action's own schema validate in full (same refusals, issues name the exact field). The video-analysis
  // skill's references/shapes.md documents both.
  widen: {
    frames: z.array(z.record(z.unknown())),
    summary: z.preprocess(decodeJsonStringIfNeeded, z.record(z.unknown())),
    words: z.array(z.record(z.unknown())),
  },
  props: {
    frames:
      "[{ frameIndex, timestamp, filePath, description? (frame_v1 OBJECT; required unless skipped), skipped?, skipReason?, custom? }]; UPSERT by frameIndex, so save long videos in batches of 10-20. Minimal entry: " +
      FRAME_SHAPE_SKELETON +
      ". A failed call returns this skeleton. Full shape: video-analysis skill references/shapes.md, or libi.read_manual({ section: \"canvas-dimensions\" }) (Schemas).",
    summary:
      "The video_v1 VideoSummary as an OBJECT, not a JSON string. Minimal value: " +
      SUMMARY_SHAPE_SKELETON +
      ". Full shape: video-analysis skill references/shapes.md, or libi.read_manual({ section: \"canvas-dimensions\" }) (Schemas).",
    chunkId: "From libi.analysis_extract action chunk_audio.",
    words: "Word timings [{ text, start, end, type?, speaker_id? }], chunk-relative seconds.",
    kind: "transcript | summary | frames.",
    jsonPath: "Absolute path to a JSON file { text, words: [...], language_code?, language_probability? } (ElevenLabs Speech-to-Text REST shape).",
  },
  actions: {
    frames: action({
      describe:
        "batch-save the frames step (an empty batch only marks it ready); to re-extract at another density, remove_step kind 'frames' first",
      schema: analysisSaveFramesSchema,
      invalidHint: framesInvalidHint,
      run: async (params) => {
        const result = await analysisSaveFrames(params);
        refreshAnalysis(params.fileId, result.success);
        return result;
      },
    }),
    summary: action({
      describe: "upsert the summary step (video_v1); sets status=ready",
      schema: analysisSaveSummarySchema,
      invalidHint: summaryInvalidHint,
      run: async (params) => {
        const result = await analysisSaveSummary(params);
        refreshAnalysis(params.fileId, result.success);
        return result;
      },
    }),
    summary_custom: action({
      describe: "set `value` under key `path` in the summary's `custom` bag",
      schema: analysisUpdateSummaryCustomSchema,
      run: async (params) => {
        const result = await analysisUpdateSummaryCustom(params);
        refreshAnalysis(params.fileId, result.success);
        return result;
      },
    }),
    audio_chunk: action({
      describe:
        "save one chunk's transcript inline; chunk-relative timestamps are offset to the source audio, and the transcript auto-aggregates when all chunks are ready",
      schema: analysisSaveAudioChunkSchema,
      run: async (params) => {
        const result = await analysisSaveAudioChunk(params);
        refreshAnalysis(savedFileId(result), result.success);
        return result;
      },
    }),
    audio_chunk_from_file: action({
      describe:
        "save one chunk's transcript from a JSON file (`jsonPath`); use it when the transcript is large",
      schema: analysisSaveAudioChunkFromFileSchema,
      run: async (params) => {
        const result = await analysisSaveAudioChunkFromFile(params);
        refreshAnalysis(savedFileId(result), result.success);
        return result;
      },
    }),
    step_failed: action({
      describe:
        "record that a step cannot be completed (status=failed; `errorMessage` shows in the analysis tab, where the user can ask you to retry)",
      schema: analysisMarkStepFailedSchema,
      run: async (params) => {
        const result = await analysisMarkStepFailed(params);
        refreshAnalysis(params.fileId, result.success);
        return result;
      },
    }),
    remove_step: action({
      describe: "clear a step (and its keyframes for frames) to redo it",
      schema: analysisRemoveStepSchema,
      run: async (params) => {
        const result = await analysisRemoveStep(params);
        refreshAnalysis(params.fileId, result.success);
        return result;
      },
    }),
  },
};

export const analysisQueryTool: ActionToolDef = {
  name: "libi.analysis_query",
  description:
    "Read a file's saved analysis: all steps and keyframes, transcript chunk status, or search frames or the transcript (\"every frame where X appears\", \"where does she say Y\"). Read-only. Actions: get, audio_chunks, search_frames, search_transcript.",
  actions: {
    get: action({
      describe:
        "all steps and keyframes for a file; `frameDetail` 'summary' (default) omits full frame descriptions (search_frames has details)",
      schema: analysisGetSchema,
      run: (params) => analysisGet(params),
    }),
    audio_chunks: action({
      describe: "per-chunk transcript status and errors (diagnose a partial transcribe)",
      schema: analysisGetAudioChunksSchema,
      run: (params) => analysisGetAudioChunks(params),
    }),
    search_frames: action({
      describe:
        "filter keyframes by subject, objects, text_contains, tags, time_range, shot",
      schema: analysisSearchFramesSchema,
      run: (params) => analysisSearchFrames(params),
    }),
    search_transcript: action({
      describe: "substring search over transcript words: ±2-word windows with timestamps",
      schema: analysisSearchTranscriptSchema,
      run: (params) => analysisSearchTranscript(params),
    }),
  },
};

export const analysisExtractTool: ActionToolDef = {
  name: "libi.analysis_extract",
  description:
    "Pull raw material out of a video or audio file for analysis: keyframe PNGs to look at, the 16 kHz audio track, or per-chunk audio WAVs for your own speech-to-text. Nothing is saved to the analysis store (use libi.analysis_save). Actions: frames, audio, chunk_audio.",
  actions: {
    frames: action({
      describe:
        "STOP: load the `video-analysis` skill first (it sets the keyframe density: about ceil(durationSec/3) under 5 min, else /10, NOT a flat 8). Extract N evenly-spaced (or explicit-`timestamps`) keyframe PNGs: [{ frameIndex, timestamp, filePath, absolutePath }]. Saves nothing: describe each frame, then libi.analysis_save frames",
      schema: analysisExtractFramesSchema,
      run: (params) => analysisExtractFrames(params),
    }),
    audio: action({
      describe:
        "STOP: load the `audio-analysis` skill first (chunking, save, retry). Extract a video's audio into a 16 kHz mono WAV (audio.wav under the file's analysis dir; returns its path). Saves nothing",
      schema: analysisExtractAudioSchema,
      run: (params) => analysisExtractAudio(params),
    }),
    chunk_audio: action({
      describe:
        "extract per-chunk audio WAVs without transcribing: [{ chunkId, chunkIndex, audioPath, startSeconds, endSeconds }]. For your own STT: transcribe each, then libi.analysis_save audio_chunk / audio_chunk_from_file",
      schema: analysisChunkAudioSchema,
      run: async (params) => {
        const result = await analysisChunkAudio(params);
        refreshAnalysis(params.fileId, result.success);
        return result;
      },
    }),
  },
};
