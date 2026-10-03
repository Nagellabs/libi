/**
 * `libi.audio_analyze`: measure, report, align. The agent's "measure, don't guess" for audio
 * (docs-local/research/2026-10-03-dreams-session-analysis.md P3, P8, R4): it used to decode files in
 * numpy and ffmpeg to learn how loud a mix was, and could not tell why a bed was silent.
 *
 *  - measure   renders the mix through the EXPORT path over some ranges as the `audio_measure` JobManager
 *              job (nothing under mcp/ imports lib/jobs: it goes through the jobs client), cached by the
 *              hash of the audio it would render.
 *  - report    the per-clip effective gain curve over a range: bounded and quick, so inline.
 *
 * measure and report take `pieceIds` / `pieceFolderId` too: the same question on each piece in this one call, the
 * answers grouped by piece against the first (`audio-analyze-multi.ts`). Each piece goes through the single-piece path
 * (its own job and cache entry for a measure), two at a time.
 *  - align     where a clip's sound sits inside a longer file: bounded, inline.
 */
import { inArray } from "drizzle-orm";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types";
import { loadManifest } from "@/lib/composition/persistence";
import { manifestAsExported } from "@/lib/overlays/hidden";
import { getDb } from "@/lib/db/client";
import { files as filesTable } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { LibiServerUnavailableError, runJobViaServer } from "@/mcp/jobs-client";
import { audioMixHash, checkRanges, type MeasureResult } from "@/lib/export/audio-measure";
import { reportClipGain, type ReportResult } from "@/lib/export/audio-report";
import { alignInFile } from "@/lib/export/audio-align";
import { mcpLogger as logger } from "@/lib/logger";
import type { AudioClip } from "@/lib/engine/types";
import type { ToolResult } from "./types";
import { AUDIO_ANALYZE_MAX_PIECES, type AudioMeasureParams, type AudioReportParams, type AudioAlignParams } from "./schemas";
import { resolveManyPieces } from "./piece-targets";
import { diffMeasure, diffReport, groupAnalysis, type PieceOutcome } from "./audio-analyze-multi";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const ms = (n: number): number => Math.round(n * 1000) / 1000;

async function pieceAudio(pieceId: string) {
  const manifest = await loadManifest(pieceId);
  const clips = (manifestAsExported(manifest).audioClips ?? []) as AudioClip[];
  const ids = [...new Set(((manifest.audioClips ?? []) as AudioClip[]).map((c) => c.fileId))];
  const rows = ids.length ? getDb().select().from(filesTable).where(inArray(filesTable.id, ids)).all() : [];
  return { manifest, clips, rows };
}

type One<R> = { ok: true; data: R; cached?: boolean } | { ok: false; error: string; message?: string };

async function measureOne(pieceId: string, params: AudioMeasureParams, ranges: { from: number; to: number }[], extra?: Extra): Promise<One<MeasureResult>> {
  const { manifest, rows } = await pieceAudio(pieceId);
  const per = params.per ?? "mix";
  const clipIds = per === "clip" && params.clipIds?.length ? [...new Set(params.clipIds)].sort() : undefined;
  try {
    const resp = await runJobViaServer<MeasureResult>(
      "audio_measure",
      { pieceId, ranges, per, ...(clipIds ? { clipIds } : {}), mixHash: audioMixHash(manifest, rows) },
      { extra, pieceId, signal: extra?.signal },
    );
    if (resp.status === "matching_completed") {
      const job = resp.existingJob;
      if (job.status !== "completed" || !job.result) {
        return { ok: false, error: "measure_failed", message: job.error ?? `the measure ${job.status}` };
      }
      return { ok: true, data: job.result, cached: true };
    }
    return { ok: true, data: resp.result };
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) return { ok: false, error: "libi_server_unavailable", message: err.hint };
    if (err instanceof Error && err.name === "CancelledError") return { ok: false, error: "cancelled", message: "the measure was stopped" };
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ tag: "export", op: "audio_measure_failed", pieceId, err: message }, "audio measure failed");
    return { ok: false, error: "measure_failed", message };
  }
}

/** One piece's failure as the tool has always answered it: `libi_server_unavailable` carries `hint`, the rest `message`. */
function failure(r: Extract<One<unknown>, { ok: false }>): ToolResult {
  return { success: false, error: r.error, data: r.error === "libi_server_unavailable" ? { hint: r.message } : { message: r.message } };
}

/** Run `fn` over `items` with at most `limit` at once, results in the order of `items` (audio_measure runs two jobs at a time). */
async function pooled<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const MULTI_CONCURRENCY = 2;

function grouped(what: string, outcomes: PieceOutcome<unknown>[], diff: (a: never, b: never) => string[]): ToolResult {
  const g = groupAnalysis(outcomes, diff as (a: unknown, b: unknown) => string[], what);
  if (g.failedAll) return { success: false, error: `${what}_failed`, data: { pieces: g.pieces, summary: g.summary } };
  return { success: true, data: { pieces: g.pieces, summary: g.summary } };
}

export async function audioMeasure(params: AudioMeasureParams, extra?: Extra): Promise<ToolResult> {
  const ranges = params.ranges.map((r) => ({ from: ms(r.from), to: ms(r.to) }));
  const bad = checkRanges(ranges);
  if (bad) return { success: false, error: "invalid_ranges", data: { message: bad } };
  const targets = resolveManyPieces(params, { max: AUDIO_ANALYZE_MAX_PIECES });
  if (!targets.ok) return { success: false, error: "invalid_targets", data: { message: targets.error } };

  if (!targets.many) {
    const one = await measureOne(targets.pieces[0].id, params, ranges, extra);
    if (!one.ok) return failure(one);
    return { success: true, data: { ...one.data, ...(one.cached ? { cached: true } : {}) } };
  }
  const outcomes = await pooled(targets.pieces, MULTI_CONCURRENCY, async (p): Promise<PieceOutcome<MeasureResult>> => ({
    pieceId: p.id,
    name: p.name,
    result: await measureOne(p.id, params, ranges, extra),
  }));
  return grouped("measure", outcomes, diffMeasure);
}

async function reportOne(pieceId: string, params: AudioReportParams): Promise<One<ReportResult>> {
  const { manifest, rows } = await pieceAudio(pieceId);
  try {
    return { ok: true, data: await reportClipGain({ manifest, files: rows, from: params.from, to: params.to, step: params.step }) };
  } catch (err) {
    return { ok: false, error: "invalid_range", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function audioReport(params: AudioReportParams): Promise<ToolResult> {
  const targets = resolveManyPieces(params, { max: AUDIO_ANALYZE_MAX_PIECES });
  if (!targets.ok) return { success: false, error: "invalid_targets", data: { message: targets.error } };

  if (!targets.many) {
    const one = await reportOne(targets.pieces[0].id, params);
    return one.ok ? { success: true, data: { ...one.data } } : failure(one);
  }
  const outcomes = await pooled(targets.pieces, MULTI_CONCURRENCY, async (p): Promise<PieceOutcome<ReportResult>> => ({
    pieceId: p.id,
    name: p.name,
    result: await reportOne(p.id, params),
  }));
  return grouped("report", outcomes, diffReport);
}

export async function audioAlign(params: AudioAlignParams, extra?: Extra): Promise<ToolResult> {
  const manifest = await loadManifest(params.pieceId);
  const clip = ((manifest.audioClips ?? []) as AudioClip[]).find((c) => c.id === params.referenceClipId);
  if (!clip) return { success: false, error: "clip_not_found", data: { message: `Audio clip ${params.referenceClipId} is not on this piece. Its id is in libi.get_composition's audio list.` } };
  const rows = getDb().select().from(filesTable).where(inArray(filesTable.id, [...new Set([clip.fileId, params.fileId])])).all();
  const refFile = rows.find((f) => f.id === clip.fileId);
  const target = rows.find((f) => f.id === params.fileId);
  if (!refFile) return { success: false, error: "file_not_found", data: { message: `The reference clip's file (${clip.fileId}) is gone.` } };
  if (!target) return { success: false, error: "file_not_found", data: { message: `File ${params.fileId} was not found.` } };
  const storage = await getStorage();
  const from = params.window?.from;
  const to = params.window?.to;
  if (from !== undefined && to !== undefined && to <= from) return { success: false, error: "invalid_window", data: { message: "window.to must be greater than window.from." } };

  const out = await alignInFile({
    reference: { path: storage.localPath(refFile.pieceId, refFile.filename), trimStart: clip.trimStart ?? 0, duration: clip.duration },
    target: { path: storage.localPath(target.pieceId, target.filename) },
    window: { from, to },
    signal: extra?.signal,
  }).catch((err: unknown) => ({ ok: false as const, reason: "decode_failed" as const, message: err instanceof Error ? err.message : String(err) }));
  if (!out.ok) {
    const message =
      out.reason === "reference_longer_than_window" ? "The reference clip is longer than the part of the file searched: widen the window."
      : out.reason === "reference_too_short" ? "The reference clip plays under half a second of audio: too short to find."
      : out.reason === "reference_silent" ? "The reference clip's audio is silent: nothing to find."
      : `Could not read the audio: ${"message" in out ? out.message : "decode failed"}`;
    return { success: false, error: out.reason === "decode_failed" ? "decode_failed" : "cannot_align", data: { message } };
  }
  const r = out.result;
  const low = r.confidence < 0.35;
  return {
    success: true,
    data: {
      offsetSec: ms(r.offsetSec),
      endsAtSec: ms(r.endsAtSec),
      confidence: Math.round(r.confidence * 100) / 100,
      score: Math.round(r.score * 100) / 100,
      referenceSec: Math.round(r.referenceSec * 100) / 100,
      ...(r.alternatives.length ? { alternatives: r.alternatives.map((a) => ({ offsetSec: ms(a.offsetSec), score: Math.round(a.score * 100) / 100 })) } : {}),
      note: low
        ? "LOW confidence: the match does not stand out (a repeated section, a different recording, or a heavy mix over it). Do not use this offset unchecked; narrow `window` to the part you mean, or compare with `alternatives`."
        : "offsetSec is where the clip's first sample sits in the file; endsAtSec is where it ends there (the continuation point). Play the file from there with libi.audio_add_clip({ trimStart }).",
    },
  };
}
