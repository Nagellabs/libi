import { runJobViaServer, legacyTripleFromRunJobResult } from "@/mcp/jobs-client";

export interface GroundCandidate {
  index: number;
  bbox: number[];
  label: string;
  conf: number;
}

/**
 * Stage-0 grounding (set-of-marks): run the detector on ONE frame at a
 * timestamp and return NUMBERED candidate boxes so the agent can pick which
 * is the target instead of hand-guessing pixel coordinates.
 *
 * Mirrors `detectShotRanges` from `lib/tracking/shot-fanout.ts` but uses
 * `method: "ground"` and surfaces `candidates` instead of `shots`.
 */
export async function groundCandidates(
  fileUrl: string,
  time: number,
  classes: string[],
  pieceId: string,
  fileId: string,
  extra?: unknown,
): Promise<GroundCandidate[]> {
  const resp = await runJobViaServer<{ candidates?: GroundCandidate[] }>(
    "tracking",
    {
      fileId,
      pieceId,
      fileUrl,
      fps: 1,
      objectKind: "object",
      method: "ground",
      range: { start: time, end: time + 0.001 },
      classes,
      anchors: [{ fileId, time, bbox: [0, 0, 1, 1] }],
    },
    { extra: extra as never, resume: true, pieceId, fileId },
  );
  const r = legacyTripleFromRunJobResult(resp);
  return r.result.candidates ?? [];
}
