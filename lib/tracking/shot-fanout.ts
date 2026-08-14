import { runJobViaServer, legacyTripleFromRunJobResult } from "@/mcp/jobs-client";

/**
 * Detect the clip's shot ranges by running the tracking sidecar in
 * shot-detection-only mode (`method: "shots"`). Returns `[]` when no shots are
 * reported — callers fall back to treating the whole clip as a single shot.
 */
export async function detectShotRanges(
  fileUrl: string,
  fps: number,
  pieceId: string,
  fileId: string,
  extra?: unknown,
): Promise<{ start: number; end: number }[]> {
  const resp = await runJobViaServer<{ shots?: { start: number; end: number }[] }>(
    "tracking",
    {
      fileId,
      pieceId,
      fileUrl,
      fps,
      objectKind: "object",
      method: "shots",
      range: { start: 0, end: Number.MAX_SAFE_INTEGER },
      classes: ["person"],
      anchors: [{ fileId, time: 0, bbox: [0, 0, 1, 1] }],
    },
    { extra: extra as never, resume: true, pieceId, fileId },
  );
  const r = legacyTripleFromRunJobResult(resp);
  return r.result.shots ?? [];
}
