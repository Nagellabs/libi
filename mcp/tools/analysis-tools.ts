import {
  getAnalysis,
  saveSummary,
  saveFrames,
  markStepFailed,
  removeStep,
  updateSummaryCustom,
  extractAudio,
  extractFrames,
  searchFrames,
  searchTranscript,
  transcribeAudio,
  chunkAudio,
  saveAudioChunk,
  saveAudioChunkFromFile,
} from "@/lib/analysis/manager";
import { summarizeAnalysisBundle } from "@/lib/analysis/lean-bundle";
import type { ToolResult } from "./types";
import type {
  AnalysisGetParams,
  AnalysisExtractAudioParams,
  AnalysisExtractFramesParams,
  AnalysisSaveFramesParams,
  AnalysisSaveSummaryParams,
  AnalysisMarkStepFailedParams,
  AnalysisRemoveStepParams,
  AnalysisSearchFramesParams,
  AnalysisSearchTranscriptParams,
  AnalysisUpdateSummaryCustomParams,
  AnalysisTranscribeAudioParams,
  AnalysisChunkAudioParams,
  AnalysisSaveAudioChunkParams,
  AnalysisSaveAudioChunkFromFileParams,
  AnalysisGetAudioChunksParams,
} from "./schemas";

// Read --------------------------------------------------------------

export async function analysisGet(params: AnalysisGetParams): Promise<ToolResult> {
  const bundle = await getAnalysis({ fileId: params.fileId });
  // F5: default to the lean summary — returning every keyframe's full structured
  // description overflows the agent's per-tool token limit on a long analysis
  // (~134 KB observed for 26 frames). The agent opts into the full payload with
  // frameDetail:"full" when it genuinely needs every description at once.
  const data =
    params.frameDetail === "full" ? bundle : summarizeAnalysisBundle(bundle);
  return { success: true, data: data as unknown as Record<string, unknown> };
}

// Material extraction (no DB writes) --------------------------------

export async function analysisExtractAudio(params: AnalysisExtractAudioParams): Promise<ToolResult> {
  try {
    const result = await extractAudio({ fileId: params.fileId, sampleRate: params.sampleRate });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function analysisExtractFrames(params: AnalysisExtractFramesParams): Promise<ToolResult> {
  try {
    const result = await extractFrames({
      fileId: params.fileId,
      count: params.count,
      timestamps: params.timestamps,
      width: params.width,
    });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Save tools --------------------------------------------------------

export async function analysisSaveSummary(params: AnalysisSaveSummaryParams): Promise<ToolResult> {
  try {
    const step = await saveSummary({ fileId: params.fileId, summary: params.summary });
    return { success: true, data: step as unknown as Record<string, unknown> };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function analysisSaveFrames(params: AnalysisSaveFramesParams): Promise<ToolResult> {
  try {
    const result = await saveFrames({
      fileId: params.fileId,
      frames: params.frames.map((f) => ({
        frameIndex: f.frameIndex,
        timestamp: f.timestamp,
        filePath: f.filePath,
        description: f.description ?? null,
        skipped: f.skipped,
        skipReason: f.skipReason ?? null,
        custom: f.custom ?? null,
      })),
    });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Status / lifecycle ------------------------------------------------

export async function analysisMarkStepFailed(params: AnalysisMarkStepFailedParams): Promise<ToolResult> {
  try {
    const step = await markStepFailed({
      fileId: params.fileId,
      kind: params.kind,
      errorMessage: params.errorMessage,
    });
    return { success: true, data: step as unknown as Record<string, unknown> };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function analysisRemoveStep(params: AnalysisRemoveStepParams): Promise<ToolResult> {
  try {
    const result = await removeStep({ fileId: params.fileId, kind: params.kind });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function analysisUpdateSummaryCustom(params: AnalysisUpdateSummaryCustomParams): Promise<ToolResult> {
  try {
    const step = await updateSummaryCustom({
      fileId: params.fileId,
      path: params.path,
      value: params.value,
    });
    return { success: true, data: step as unknown as Record<string, unknown> };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Search ------------------------------------------------------------

export async function analysisSearchFrames(params: AnalysisSearchFramesParams): Promise<ToolResult> {
  try {
    const matches = await searchFrames(params);
    return { success: true, data: { matches } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function analysisSearchTranscript(params: AnalysisSearchTranscriptParams): Promise<ToolResult> {
  try {
    const matches = await searchTranscript({
      fileId: params.fileId,
      query: params.query,
      limit: params.limit,
    });
    return { success: true, data: { matches } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Chunked transcript tools ------------------------------------------

export async function analysisTranscribeAudio(params: AnalysisTranscribeAudioParams): Promise<ToolResult> {
  try {
    const result = await transcribeAudio({
      fileId: params.fileId,
      retry: params.retry,
      chunkSeconds: params.chunkSeconds,
      model: params.model,
    });
    return { success: true, data: result as unknown as Record<string, unknown> };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function analysisChunkAudio(params: AnalysisChunkAudioParams): Promise<ToolResult> {
  try {
    const result = await chunkAudio({ fileId: params.fileId, chunkSeconds: params.chunkSeconds });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function analysisSaveAudioChunk(params: AnalysisSaveAudioChunkParams): Promise<ToolResult> {
  try {
    const result = await saveAudioChunk(params);
    return { success: true, data: result as unknown as Record<string, unknown> };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function analysisSaveAudioChunkFromFile(params: AnalysisSaveAudioChunkFromFileParams): Promise<ToolResult> {
  try {
    const result = await saveAudioChunkFromFile(params);
    return { success: true, data: result as unknown as Record<string, unknown> };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function analysisGetAudioChunks(params: AnalysisGetAudioChunksParams): Promise<ToolResult> {
  try {
    const bundle = await getAnalysis({ fileId: params.fileId });
    return {
      success: true,
      data: {
        chunks: bundle.audioChunks.map((c) => ({
          chunkId: c.id,
          chunkIndex: c.chunkIndex,
          status: c.status,
          startSeconds: c.startSeconds,
          endSeconds: c.endSeconds,
          errorMessage: c.errorMessage,
        })),
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

