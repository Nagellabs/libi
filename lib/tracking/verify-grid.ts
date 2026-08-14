import type { Range } from "@/lib/tracking/summary";

export interface VerifyGridInput {
  clipDurationSec: number;
  fps: number;
  /** Times (s) of manual + derived anchors — excluded (correct by construction). */
  manualAnchorTimes: number[];
  /** Ranges flagged by summarizeTrack (issues[].range). */
  issueRanges: Range[];
  /** summary.lostRanges. */
  lostRanges: Range[];
  /** User-/agent-directed focus window, sampled densely. */
  focusRange: Range | null;
  /** Extra explicit times the agent asked for. */
  extraTimes: number[];
  /** Max frames to render (default 24). */
  cap?: number;
}

export interface VerifyGridResult {
  times: number[];
  truncated: boolean;
  coveredIssueRanges: Range[];
}

function denseRange(r: Range, stepSec: number): number[] {
  const out: number[] = [];
  for (let t = r.start; t <= r.end + 1e-9; t += stepSec) out.push(Math.round(t * 10) / 10);
  return out;
}

export function selectVerifyTimes(input: VerifyGridInput): VerifyGridResult {
  const cap = input.cap ?? 24;
  const clip = Math.max(0, input.clipDurationSec);
  const eps = Math.max(0.2, 1 / Math.max(1, input.fps));
  const anchors = input.manualAnchorTimes;
  const nearAnchor = (t: number) => anchors.some((a) => Math.abs(a - t) <= eps);

  const buckets: { t: number; p: number }[] = [];
  const push = (t: number, p: number) => {
    if (t < 0 || t > clip) return;
    buckets.push({ t: Math.round(t * 10) / 10, p });
  };

  for (const r of [...input.issueRanges, ...input.lostRanges]) {
    for (const t of denseRange(r, 1)) if (!nearAnchor(t)) push(t, 0);
  }
  if (input.focusRange) for (const t of denseRange(input.focusRange, 1)) push(t, 0);
  for (const t of input.extraTimes) push(t, 0);
  for (const t of denseRange({ start: Math.max(0, clip - 5), end: clip }, 1)) {
    if (!nearAnchor(t)) push(t, 1);
  }
  const coarseStep = Math.max(2, clip / 12);
  for (let t = 0; t <= clip + 1e-9; t += coarseStep) if (!nearAnchor(t)) push(t, 2);

  const byTime = new Map<number, number>();
  for (const b of buckets) {
    const cur = byTime.get(b.t);
    if (cur === undefined || b.p < cur) byTime.set(b.t, b.p);
  }
  const ranked = [...byTime.entries()]
    .map(([t, p]) => ({ t, p }))
    .sort((a, b) => (a.p - b.p) || (a.t - b.t));

  const truncated = ranked.length > cap;
  const kept = ranked.slice(0, cap).map((x) => x.t).sort((a, b) => a - b);

  const coveredIssueRanges = input.issueRanges.filter((r) =>
    kept.some((t) => t >= r.start - 1e-9 && t <= r.end + 1e-9),
  );

  return { times: kept, truncated, coveredIssueRanges };
}
