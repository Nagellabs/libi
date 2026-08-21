import { z } from "zod/v3";
import fs from "fs";
import path from "path";
import { downloadModel } from "@/lib/whisper/transcribe";
import {
  isWhisperModelInstalled,
  whisperModelBytes,
  whisperModelsDir,
} from "@/lib/whisper/models";
import { trackDirectoryBytes } from "@/lib/jobs/dir-download-progress";
import { getLibiModelsDir } from "@/lib/libi-home";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

/** Chat/Settings render `done`/`total` verbatim, so report MB rather than raw
 *  bytes — "312/480 MB" reads, "312438784/480000000 bytes" does not. Matches
 *  the unit `tts_model_download` and `music_model_download` already use. */
const BYTES_PER_MB = 1_000_000;

const paramsSchema = z.object({
  model: z.enum(["tiny", "base", "small", "medium", "large-v3"]),
});

export type WhisperModelDownloadParams = z.infer<typeof paramsSchema>;

export interface WhisperModelDownloadResult {
  model: string;
  alreadyInstalled: boolean;
}

export const whisperModelDownloadRunner: JobRunner<
  WhisperModelDownloadParams,
  WhisperModelDownloadResult
> = {
  kind: "whisper_model_download",
  mcpToolId: makeMcpToolId("libi", "libi.whisper_download_model"),
  maxConcurrent: 1,
  paramsSchema,
  // The HF download has no clean midpoint; restart on retry.
  resumable: false,
  // uv wheel fetch + multi-GB model pull runs silent for minutes.
  noProgressTimeoutMs: null,
  async run(
    ctx: JobContext<WhisperModelDownloadParams>,
  ): Promise<WhisperModelDownloadResult> {
    const { model } = ctx.params;
    if (isWhisperModelInstalled(model)) {
      ctx.reportProgress(1, 1, "model");
      return { model, alreadyInstalled: true };
    }
    // Watch the destination directory grow rather than counting files.
    //
    // faster-whisper's downloader reports one tick per COMPLETED file, and the
    // repo is a couple of tiny configs plus one large weights file — so the
    // file counter is worth nothing while the only file that takes time is in
    // flight. Measured on published 0.1.2 during the FULL QA run: the bar sat
    // at `0/1 files` with `etaMs: null` for the whole ~5 minute download of the
    // `small` model, while 466 MB quietly landed on disk. That is the exact
    // "it's been thinking forever" shape AGENTS.md warns about.
    //
    // `trackDirectoryBytes` already existed for this — it was written for
    // ACE-Step in 0.1.2 and simply never wired up here.
    const totalBytes = whisperModelBytes(model);
    const totalMb = Math.max(1, Math.floor(totalBytes / BYTES_PER_MB));
    ctx.reportProgress(0, totalMb, "MB");
    const progress = trackDirectoryBytes({
      dir: whisperModelsDir(),
      totalBytes,
      onBytes: (bytesDone) => {
        ctx.reportProgress(
          Math.min(Math.floor(bytesDone / BYTES_PER_MB), totalMb),
          totalMb,
          "MB",
        );
      },
    });
    try {
      // The file-count callback no longer drives the bar — mixing units in one
      // job corrupts the rolling ETA, which averages ms-per-unit. It still
      // earns its keep as a poke: a completed file is exactly when the on-disk
      // total jumps, so measure then rather than up to a poll interval later.
      await downloadModel(model, () => progress.poke());
    } finally {
      progress.stop();
    }
    if (ctx.shouldCancel()) throw new Error("cancelled");
    // VERIFY BEFORE DECLARING SUCCESS — same defect as music_model_download
    // (#59): `downloadModel` resolving only means `uv` exited 0, which is not
    // evidence the snapshot landed. Writing the marker on that assumption
    // produces a `completed` job with no model behind it, and the failure then
    // surfaces much later as an opaque transcription error.
    if (!isWhisperModelInstalled(model)) {
      throw new Error(
        `Whisper "${model}" download finished but no model files are present under ` +
          `${whisperModelsDir()}. The model is NOT installed.`,
      );
    }
    const whisperMarkerDir = path.join(getLibiModelsDir(), "whisper");
    fs.mkdirSync(whisperMarkerDir, { recursive: true });
    fs.writeFileSync(
      path.join(whisperMarkerDir, ".install-token"),
      "faster-whisper-tiny-2026-05-19",
      "utf-8",
    );
    ctx.reportProgress(totalMb, totalMb, "MB");
    return { model, alreadyInstalled: false };
  },
};
