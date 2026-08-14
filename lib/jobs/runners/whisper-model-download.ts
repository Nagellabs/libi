import { z } from "zod/v3";
import fs from "fs";
import path from "path";
import { downloadModel } from "@/lib/whisper/transcribe";
import { isWhisperModelInstalled, whisperModelsDir } from "@/lib/whisper/models";
import { getLibiModelsDir } from "@/lib/libi-home";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

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
    ctx.reportProgress(0, 1, "files");
    let lastTotal = 1;
    await downloadModel(model, (done, total) => {
      if (total > 0) lastTotal = total;
      ctx.reportProgress(done, total > 0 ? total : 1, "files");
    });
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
    ctx.reportProgress(lastTotal, lastTotal, "files");
    return { model, alreadyInstalled: false };
  },
};
