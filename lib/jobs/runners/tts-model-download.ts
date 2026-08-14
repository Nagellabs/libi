import { z } from "zod/v3";
import fs from "fs";
import path from "path";
import { downloadModel } from "@/lib/tts/synthesize";
import { isKokoroModelInstalled, ttsModelsDir } from "@/lib/tts/voices";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

const KOKORO_INSTALL_TOKEN = "kokoro-v1.0-2026-05-19";

const paramsSchema = z.object({});

export type TtsModelDownloadParams = z.infer<typeof paramsSchema>;

export interface TtsModelDownloadResult {
  alreadyInstalled: boolean;
}

export const ttsModelDownloadRunner: JobRunner<
  TtsModelDownloadParams,
  TtsModelDownloadResult
> = {
  kind: "tts_model_download",
  mcpToolId: makeMcpToolId("libi", "libi.tts_download_model"),
  maxConcurrent: 1,
  paramsSchema,
  // The HF/GitHub download has no clean midpoint; restart on retry.
  resumable: false,
  // uv wheel fetch + ~110 MB model pull runs silent for minutes.
  noProgressTimeoutMs: null,
  async run(
    ctx: JobContext<TtsModelDownloadParams>,
  ): Promise<TtsModelDownloadResult> {
    if (isKokoroModelInstalled()) {
      ctx.reportProgress(1, 1, "model");
      return { alreadyInstalled: true };
    }
    ctx.reportProgress(0, 1, "MB");
    let lastTotalMb = 1;
    await downloadModel((bytesDone, bytesTotal) => {
      const mbDone = Math.floor(bytesDone / 1_000_000);
      const mbTotal = Math.max(1, Math.floor(bytesTotal / 1_000_000));
      lastTotalMb = mbTotal;
      ctx.reportProgress(mbDone, mbTotal, "MB");
    });
    if (ctx.shouldCancel()) throw new Error("cancelled");
    // VERIFY BEFORE DECLARING SUCCESS — same defect as music_model_download
    // (#59): a clean exit from the downloader is not evidence the ONNX weights
    // and voice pack are on disk, and writing the marker over an empty dir
    // makes the job report `completed` for a model that isn't there.
    if (!isKokoroModelInstalled()) {
      throw new Error(
        `Kokoro download finished but the model files are missing or empty under ` +
          `${ttsModelsDir()}. The model is NOT installed.`,
      );
    }
    fs.mkdirSync(ttsModelsDir(), { recursive: true });
    fs.writeFileSync(
      path.join(ttsModelsDir(), ".install-token"),
      KOKORO_INSTALL_TOKEN,
      "utf-8",
    );
    ctx.reportProgress(lastTotalMb, lastTotalMb, "MB");
    return { alreadyInstalled: false };
  },
};
