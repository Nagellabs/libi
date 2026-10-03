import { inArray } from "drizzle-orm";
import { z } from "zod/v3";
import { CancelledError, type JobContext, type JobRunner } from "@/lib/jobs/types";
import { loadManifest } from "@/lib/composition/persistence";
import { manifestAsExported } from "@/lib/overlays/hidden";
import { getDb } from "@/lib/db/client";
import { files as filesTable } from "@/lib/db/schema";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { audioMixHash, measureAudio, type MeasureResult } from "@/lib/export/audio-measure";
import type { AudioClip } from "@/lib/engine/types";

/**
 * `audio_measure`: render a piece's mix through the export path over some ranges and read LUFS / RMS /
 * peak off it (`lib/export/audio-measure.ts`). A job because a mix with ducks and envelopes over minutes
 * of audio is more than the few seconds an inline tool call may take, and so a repeated question is
 * answered from the job table: `(kind, paramsHash)` dedupe returns the earlier result, and `mixHash` in
 * the params is what keeps that honest. It is the hash of the audio the mix would render, so any edit
 * to a clip, its file or a hidden layer is a different job. The runner re-derives it and refuses to
 * answer for audio that moved since the call was made.
 */
const rangeSchema = z.object({ from: z.number().min(0), to: z.number().positive() });

const paramsSchema = z.object({
  pieceId: z.string().min(1),
  ranges: z.array(rangeSchema).min(1).max(8),
  per: z.enum(["mix", "clip"]),
  clipIds: z.array(z.string()).max(50).optional(),
  /** `audioMixHash` of the piece's audio when the call was made: the cache key's content part. */
  mixHash: z.string().min(1),
});

export type AudioMeasureParams = z.infer<typeof paramsSchema>;
export type AudioMeasureResult = MeasureResult;

export const audioMeasureRunner: JobRunner<AudioMeasureParams, AudioMeasureResult> = {
  kind: "audio_measure",
  maxConcurrent: 2,
  paramsSchema,
  resumable: false,
  // ffmpeg reports per render; a long decode of a long file between ticks is still work.
  noProgressTimeoutMs: 180_000,
  mcpToolId: makeMcpToolId("libi", "libi.audio_analyze"),

  async run(ctx: JobContext<AudioMeasureParams>): Promise<AudioMeasureResult> {
    const { pieceId, ranges, per, clipIds, mixHash } = ctx.params;
    ctx.reportProgress(0, 1, "measure");
    const manifest = await loadManifest(pieceId);
    const exported = manifestAsExported(manifest);
    const audioClips = (exported.audioClips ?? []) as AudioClip[];
    const ids = [...new Set(audioClips.map((c) => c.fileId))];
    const rows = ids.length ? getDb().select().from(filesTable).where(inArray(filesTable.id, ids)).all() : [];
    if (audioMixHash(manifest, rows) !== mixHash) {
      throw new Error("the piece's audio changed while this measure was queued: call libi.audio_analyze again");
    }

    const ac = new AbortController();
    const poll = setInterval(() => { if (ctx.shouldCancel()) ac.abort(); }, 500);
    try {
      const result = await measureAudio({
        audioClips,
        files: rows,
        ranges,
        per,
        clipIds,
        signal: ac.signal,
        onProgress: (ratio) => ctx.reportProgress(Math.round(ratio * 1000), 1000, "measure"),
      });
      if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
      ctx.reportProgress(1, 1, "measure");
      return result;
    } catch (err) {
      if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);
      throw err;
    } finally {
      clearInterval(poll);
    }
  },
};
