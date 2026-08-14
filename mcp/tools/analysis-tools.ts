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
  rowToStep,
} from "@/lib/analysis/manager";
import { summarizeAnalysisBundle } from "@/lib/analysis/lean-bundle";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { analysisSteps } from "@/lib/db/schema/sqlite";
import { LibiServerUnavailableError, runJobViaServer } from "@/mcp/jobs-client";
import { getScriptProvider, listScriptProviders } from "@/lib/analysis/script-providers/registry";
import { registerBuiltinScriptProviders } from "@/lib/analysis/script-providers/register";
import { parseScriptStep, buildScriptKind, buildCaptionSpecKind } from "@/lib/analysis/scripts";
import type { AnalysisStep } from "@/lib/analysis/types";

import { isTestMode } from "@/lib/test-mode";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types";
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
  ExtraAnalysisModelParams,
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
      provider: params.provider,
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

// Script generation (paid, provider-driven) -------------------------

export async function extraAnalysisModel(
  params: ExtraAnalysisModelParams,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<ToolResult> {
  try {
    // Idempotent safety net — ensures built-in providers (e.g. fal-video-understanding)
    // are registered even if the MCP process started before instrumentation ran.
    registerBuiltinScriptProviders();

    if (listScriptProviders().length === 0) {
      return {
        success: false,
        error:
          "No script providers are configured. Configure FAL_KEY in Settings → MCP Servers → fal-ai.",
      };
    }

    const provider = getScriptProvider(params.providerId);
    const modelId = params.modelId ?? provider.defaultModelId;
    const focus = params.focus;

    // Return cached result when present (unless the caller requested a fresh run).
    if (!params.regenerate) {
      const db = getDb();
      if (focus === "captions") {
        const kind = buildCaptionSpecKind(provider.id, modelId);
        const existing = db
          .select()
          .from(analysisSteps)
          .where(and(eq(analysisSteps.fileId, params.fileId), eq(analysisSteps.kind, kind)))
          .limit(1)
          .all();
        const row = existing[0];
        if (row && row.status === "ready" && row.content) {
          return {
            success: true,
            data: { captions: row.content, cached: true },
          };
        }
      } else {
        const kind = buildScriptKind(provider.id, modelId);
        const existing = db
          .select()
          .from(analysisSteps)
          .where(and(eq(analysisSteps.fileId, params.fileId), eq(analysisSteps.kind, kind)))
          .limit(1)
          .all();
        const row = existing[0];
        if (row && row.status === "ready") {
          const persisted = parseScriptStep(rowToStep(row));
          if (persisted) {
            return {
              success: true,
              data: { script: persisted.script as unknown as Record<string, unknown>, cached: true },
            };
          }
        }
      }
    }

    // Guard: provider must be configured (API key present, etc.).
    // In test mode the runner short-circuits to a deterministic placeholder
    // (no real provider call — see F6), so a configured API key isn't required;
    // skip the gate so keyless `LIBI_TEST_MODE=1` runs still work.
    if (!isTestMode()) {
      const isConfigured = await provider.isConfigured();
      if (!isConfigured) {
        return {
          success: false,
          error: `Script provider "${provider.id}" is not configured. Open Settings → MCP Servers to set its credentials.`,
        };
      }
    }

    const resp = await runJobViaServer(
      "extra_analysis_model",
      {
        fileId: params.fileId,
        pieceId: params.pieceId ?? null,
        providerId: provider.id,
        modelId,
        forceFresh: params.regenerate === true,
        focus,
      },
      {
        pieceId: params.pieceId,
        fileId: params.fileId,
        extra,
      },
    );

    // Unpack result — `matching_completed` carries it in existingJob.result.
    // Per CLAUDE.md "Long-running tool dedup", re-run silently if the existing job failed/cancelled.
    if (resp.status === "matching_completed") {
      if (resp.existingJob.status !== "completed") {
        return extraAnalysisModel({ ...params, regenerate: true }, extra);
      }
      if (focus === "captions") {
        const captionSpec = (resp.existingJob.result as { captionSpec?: unknown } | undefined)?.captionSpec;
        const jobId = resp.existingJob.jobId;
        return {
          success: true,
          data: { captions: captionSpec, jobId },
        };
      }
      const script = (resp.existingJob.result as { script?: unknown } | undefined)?.script;
      const jobId = resp.existingJob.jobId;
      return {
        success: true,
        data: { script: script as Record<string, unknown>, jobId },
      };
    }

    if (focus === "captions") {
      const captionSpec = (resp.result as { captionSpec?: unknown } | undefined)?.captionSpec;
      const jobId = resp.jobId;
      return {
        success: true,
        data: { captions: captionSpec, jobId },
      };
    }

    const script = (resp.result as { script?: unknown } | undefined)?.script;
    const jobId = resp.jobId;
    return {
      success: true,
      data: { script: script as Record<string, unknown>, jobId },
    };
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return {
        success: false,
        error: "libi_server_unavailable",
        data: { hint: err.hint },
      };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
