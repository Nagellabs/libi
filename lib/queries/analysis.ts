import { useQuery } from "@tanstack/react-query";
import type {
  AnalysisBundle,
  AnalysisStep,
  AnalysisStepKind,
  AnalysisKeyframe,
  FrameDescription,
  VideoSummary,
  TranscriptMetadata,
  TranscriptSentence,
} from "@/lib/analysis/types";
import type { SearchFramesParams, SearchFramesMatch } from "@/lib/analysis/manager";
import { transcriptMetadataSchema, wordsToSentences } from "@/lib/analysis/schemas";

export const analysisKeys = {
  byFile: (fileId: string) => ["analysis", "file", fileId] as const,
};

async function fetchAnalysis(fileId: string): Promise<AnalysisBundle> {
  const res = await fetch(`/api/files/by-id/${fileId}/analysis`);
  if (!res.ok) throw new Error(`analysis fetch failed: ${res.status}`);
  return res.json();
}

export interface AnalysisQueryView {
  steps: AnalysisStep[];
  keyframes: AnalysisKeyframe[];
  staleKeyframeIds: string[];
  byKind: Partial<Record<AnalysisStepKind, AnalysisStep>>;
  summary: VideoSummary | null;
  transcript: AnalysisStep | null;
  framesWithDesc: Array<{ keyframe: AnalysisKeyframe; description: FrameDescription | null }>;
  transcriptMeta: TranscriptMetadata | null;
  transcriptSentences: TranscriptSentence[] | null;
}

export function projectAnalysis(raw: AnalysisBundle): AnalysisQueryView {
  const byKind: Partial<Record<AnalysisStepKind, AnalysisStep>> = {};
  for (const step of raw.steps) byKind[step.kind] = step;

  let summary: VideoSummary | null = null;
  if (byKind.summary?.content) {
    try {
      summary = JSON.parse(byKind.summary.content) as VideoSummary;
    } catch {
      summary = null;
    }
  }

  const transcript = byKind.transcript ?? null;

  let transcriptMeta: TranscriptMetadata | null = null;
  let transcriptSentences: TranscriptSentence[] | null = null;
  if (transcript?.metadata) {
    try {
      const parsed = JSON.parse(transcript.metadata);
      const result = transcriptMetadataSchema.safeParse(parsed);
      if (result.success) {
        transcriptMeta = result.data;
        transcriptSentences = wordsToSentences(result.data.words);
      }
    } catch {
      // malformed JSON — leave both null
    }
  }

  const framesWithDesc = raw.keyframes.map((keyframe) => {
    let description: FrameDescription | null = null;
    if (!keyframe.skipped && keyframe.description) {
      try {
        description = JSON.parse(keyframe.description) as FrameDescription;
      } catch {
        description = null;
      }
    }
    return { keyframe, description };
  });

  return {
    steps: raw.steps,
    keyframes: raw.keyframes,
    staleKeyframeIds: raw.staleKeyframeIds,
    byKind,
    summary,
    transcript,
    framesWithDesc,
    transcriptMeta,
    transcriptSentences,
  };
}

export function useVideoAnalysis(fileId: string | null) {
  return useQuery({
    queryKey: fileId ? analysisKeys.byFile(fileId) : ["analysis", "noop"],
    queryFn: () => fetchAnalysis(fileId!),
    enabled: !!fileId,
    select: projectAnalysis,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// useSearchFrames — now keyed on fileId
// ──────────────────────────────────────────────────────────────────────────────

async function fetchSearchFrames(
  fileId: string,
  params: SearchFramesParams,
): Promise<{ matches: SearchFramesMatch[] }> {
  const res = await fetch(`/api/files/by-id/${fileId}/analysis/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`search frames failed: ${res.status}`);
  return res.json();
}

export function useSearchFrames(
  fileId: string,
  params: Omit<SearchFramesParams, "fileId">,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: ["analysis-search", fileId, JSON.stringify(params)],
    queryFn: () => fetchSearchFrames(fileId, { ...params, fileId }),
    enabled: !!fileId && enabled,
  });
}

