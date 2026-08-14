import type { IdentityCandidate, EngineSegmentOpts } from "@/lib/tracking/boxmot-runner";
import { runEngineSegment as realRun } from "@/lib/tracking/boxmot-runner";

export type { IdentityCandidate };

/**
 * Minimal opts required to call runEngineSegment in "candidates" mode.
 * Resolving fileId/pieceId → a local videoPath is the CALLER's responsibility
 * (Task 4's tool does `storage.localPath(pieceId, filename)` or downloads
 * http→temp, mirroring lib/jobs/runners/tracking.ts).
 */
export interface ListIdentityCandidatesOpts {
  videoPath: string;
  fps: number;
  range: { start: number; end: number };
  anchors: { time: number; bbox: [number, number, number, number] }[];
}

export async function listIdentityCandidates(
  opts: ListIdentityCandidatesOpts,
  deps: { runEngineSegment?: typeof realRun } = {},
): Promise<IdentityCandidate[]> {
  const run = deps.runEngineSegment ?? realRun;
  const engineOpts: EngineSegmentOpts = {
    videoPath: opts.videoPath,
    fps: opts.fps,
    range: opts.range,
    method: "candidates",
    classes: ["person"],
    anchors: opts.anchors,
  };
  const out = await run(engineOpts);
  const cands = out.candidateTracklets ?? [];
  // Highest appearance match first; nulls (ReID-off) keep sidecar order.
  return cands
    .slice()
    .sort((a, b) => (b.meanTargetSim ?? -1) - (a.meanTargetSim ?? -1));
}
