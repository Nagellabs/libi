/**
 * `libi.audio_analyze` over several pieces in one call (measure, report). One piece's result is exactly what the
 * single-piece call returns; here each piece is asked the same question and the answers are GROUPED by piece with
 * the first as the reference: a piece whose numbers match it says `sameAsFirst` instead of repeating a block of
 * arrays, a piece that differs keeps its full result, and one `summary` line names who differs and where.
 *
 * Pure: results in, grouped result out. The tool (`audio-analyze-tools.ts`) does the I/O and the jobs.
 */
import type { MeasureResult, Levels } from "@/lib/export/audio-measure";
import type { ReportResult, ClipReport } from "@/lib/export/audio-report";

/** Two levels within this many dB are the same answer. A bed sits 12-20 LU under a voice: half a dB is noise. */
export const SAME_DB = 0.5;
/** Two clip edges within this many seconds are the same edge. */
const SAME_SEC = 0.05;

/** How many differing pieces / differences per piece the summary line names before it says "and N more". */
const SUMMARY_PIECES = 6;
const SUMMARY_DIFFS_PER_PIECE = 2;

export interface PieceOutcome<R> {
  pieceId: string;
  name: string;
  /** The single-piece call's result, or why it failed. */
  result: { ok: true; data: R; cached?: boolean } | { ok: false; error: string; message?: string };
}

export interface GroupedPiece {
  pieceId: string;
  name: string;
  [key: string]: unknown;
}

export interface GroupedAnalysis {
  pieces: GroupedPiece[];
  summary: string;
  /** The piece every other is compared against: the first one that answered. */
  reference: { pieceId: string; name: string } | null;
  /** True when every piece failed (there is nothing to group). */
  failedAll: boolean;
}

const num = (n: number | null): string => (n === null ? "none" : String(n));

/** One entry per place: `range 2 (19.5-23.5 s): lufs -14.2 vs -18, peakDb -6 vs -10` (this piece's number first, then the first piece's). */
function levelDiffs(where: string, a: Levels, b: Levels): string[] {
  const parts: string[] = [];
  for (const f of ["lufs", "shortTermMaxLufs", "rmsDb", "peakDb"] as const) {
    const x = a[f];
    const y = b[f];
    if (x === null && y === null) continue;
    if (x === null || y === null || Math.abs(x - y) > SAME_DB) parts.push(`${f} ${num(y)} vs ${num(x)}`);
  }
  if (a.silent !== b.silent) parts.push(`${b.silent ? "silent" : "not silent"} vs ${a.silent ? "silent" : "not silent"}`);
  return parts.length === 0 ? [] : [`${where}: ${parts.join(", ")}`];
}

/** What differs in a measure of `b` against the first piece's `a` (empty = the same answer). */
export function diffMeasure(a: MeasureResult, b: MeasureResult): string[] {
  const out: string[] = [];
  if (a.ranges.length !== b.ranges.length) return [`${b.ranges.length} ranges vs ${a.ranges.length}`];
  a.ranges.forEach((ra, i) => {
    const rb = b.ranges[i];
    const where = `range ${i + 1} (${ra.from}-${ra.to} s)`;
    out.push(...levelDiffs(where, ra, rb));
    const ca = ra.clips ?? [];
    const cb = rb.clips ?? [];
    if (ca.length !== cb.length) out.push(`${where} measures ${cb.length} clips vs ${ca.length}`);
    else ca.forEach((c, k) => out.push(...levelDiffs(`${where} clip ${k + 1}${c.label ? ` "${c.label}"` : ""}`, c, cb[k])));
  });
  if (b.note && b.note !== a.note) out.push(`note: ${b.note}`);
  return out;
}

const byEdges = (x: ClipReport, y: ClipReport): number => x.start - y.start || x.end - y.end;

function maxGap(a: number[] | undefined, b: number[] | undefined): { gap: number; at: number } | null {
  if (!a || !b) return a === b ? null : { gap: Infinity, at: 0 };
  if (a.length !== b.length) return { gap: Infinity, at: 0 };
  let gap = 0;
  let at = 0;
  a.forEach((v, i) => {
    const d = Math.abs(v - b[i]);
    if (d > gap) {
      gap = d;
      at = i;
    }
  });
  return { gap, at };
}

/** What differs in a report of `b` against the first piece's `a` (empty = the same answer). */
export function diffReport(a: ReportResult, b: ReportResult): string[] {
  const out: string[] = [];
  const ca = [...a.clips].sort(byEdges);
  const cb = [...b.clips].sort(byEdges);
  if (ca.length !== cb.length) out.push(`${cb.length} clips sound in the range vs ${ca.length}`);
  else {
    ca.forEach((x, i) => {
      const y = cb[i];
      const who = `clip ${i + 1}${x.label ? ` "${x.label}"` : ""}`;
      if (Math.abs(x.start - y.start) > SAME_SEC || Math.abs(x.end - y.end) > SAME_SEC) out.push(`${who} plays ${y.start}-${y.end} s vs ${x.start}-${x.end} s`);
      for (const f of ["gainDb", "duckDb", "outDb"] as const) {
        const g = maxGap(x[f], y[f]);
        if (g && g.gap > SAME_DB) {
          out.push(
            Number.isFinite(g.gap)
              ? `${who} ${f} differs by up to ${Math.round(g.gap * 10) / 10} dB at ${y.t[g.at]} s`
              : `${who} ${f} is sampled differently`,
          );
        }
      }
      if ((x.quiet?.length ?? 0) !== (y.quiet?.length ?? 0)) out.push(`${who} has ${y.quiet?.length ?? 0} quiet span(s) vs ${x.quiet?.length ?? 0}`);
      if ((x.duck?.status ?? "") !== (y.duck?.status ?? "")) out.push(`${who} duck: ${y.duck?.status ?? "none"} vs ${x.duck?.status ?? "none"}`);
    });
  }
  const sa = a.silentClips?.length ?? 0;
  const sb = b.silentClips?.length ?? 0;
  if (sa !== sb) out.push(`${sb} silent clip(s) vs ${sa}`);
  return out;
}

const label = (index: number, name: string): string => `piece ${index + 1}${name ? ` "${name}"` : ""}`;

/**
 * Group the per-piece outcomes. `diff(first, other)` lists what differs; an empty list collapses that piece to
 * `sameAsFirst`. A failed piece keeps its own error and never becomes the reference.
 */
export function groupAnalysis<R>(
  outcomes: PieceOutcome<R>[],
  diff: (first: R, other: R) => string[],
  what: string,
): GroupedAnalysis {
  const refIndex = outcomes.findIndex((o) => o.result.ok);
  if (refIndex < 0) {
    return {
      pieces: outcomes.map((o) => ({ pieceId: o.pieceId, name: o.name, error: !o.result.ok ? o.result.error : "", ...(!o.result.ok && o.result.message ? { message: o.result.message } : {}) })),
      summary: `${what} failed on every piece: ${outcomes.map((o, i) => `${label(i, o.name)}: ${!o.result.ok ? (o.result.message ?? o.result.error) : ""}`).join("; ")}`,
      reference: null,
      failedAll: true,
    };
  }
  const first = outcomes[refIndex];
  const firstData = (first.result as { ok: true; data: R }).data;

  const same: number[] = [];
  const differing: { index: number; diffs: string[] }[] = [];
  const failed: { index: number; text: string }[] = [];

  const pieces: GroupedPiece[] = outcomes.map((o, i) => {
    if (!o.result.ok) {
      failed.push({ index: i, text: o.result.message ?? o.result.error });
      return { pieceId: o.pieceId, name: o.name, error: o.result.error, ...(o.result.message ? { message: o.result.message } : {}) };
    }
    const cached = o.result.cached ? { cached: true } : {};
    if (i === refIndex) return { pieceId: o.pieceId, name: o.name, reference: true, ...(o.result.data as object), ...cached };
    const diffs = diff(firstData, o.result.data);
    if (diffs.length === 0) {
      same.push(i);
      return { pieceId: o.pieceId, name: o.name, sameAsFirst: true, ...cached };
    }
    differing.push({ index: i, diffs });
    return { pieceId: o.pieceId, name: o.name, differsFromFirst: diffs, ...(o.result.data as object), ...cached };
  });

  const refName = label(refIndex, first.name);
  const parts: string[] = [];
  if (differing.length === 0 && failed.length === 0) {
    parts.push(`${what} on ${outcomes.length} pieces: all match ${refName} within ${SAME_DB} dB.`);
  } else {
    parts.push(`${what} on ${outcomes.length} pieces: ${same.length + 1} match ${refName} within ${SAME_DB} dB.`);
    if (differing.length > 0) {
      const shown = differing.slice(0, SUMMARY_PIECES).map((d) => {
        const more = d.diffs.length > SUMMARY_DIFFS_PER_PIECE ? `, +${d.diffs.length - SUMMARY_DIFFS_PER_PIECE} more` : "";
        return `${label(d.index, outcomes[d.index].name)}: ${d.diffs.slice(0, SUMMARY_DIFFS_PER_PIECE).join("; ")}${more}`;
      });
      parts.push(`Differ: ${shown.join(" | ")}${differing.length > SUMMARY_PIECES ? ` | and ${differing.length - SUMMARY_PIECES} more` : ""}.`);
    }
    if (failed.length > 0) parts.push(`Failed: ${failed.map((f) => `${label(f.index, outcomes[f.index].name)}: ${f.text}`).join("; ")}.`);
  }
  return { pieces, summary: parts.join(" "), reference: { pieceId: first.pieceId, name: first.name }, failedAll: false };
}
