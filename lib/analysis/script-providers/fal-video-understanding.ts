import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fal } from "@fal-ai/client";
import { scriptAnalysisLogger } from "@/lib/logger";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { readFalApiKey } from "./fal-api-key";
import { fetchFalCost } from "@/lib/fal/billing";
import type { ScriptProvider, ScriptProviderInput, ScriptProviderResult } from "./types";

const QUEUE_URL = "https://queue.fal.run/fal-ai/video-understanding";
const FAL_STORAGE_URL = "https://rest.alpha.fal.ai";
const POLL_INTERVAL_MS = 5_000;
const MODEL_ID = "gemini-2.5-pro";
/** fal-ai/video-understanding list pricing: $0.01 per 5 seconds → $0.002/s.
 *  Source: https://fal.ai/models/fal-ai/video-understanding (May 2026).
 *  Used both for the at-generation estimate and (verbatim) in the UI tooltip
 *  that explains the estimation. Update both sites together. */
export const FAL_VIDEO_UNDERSTANDING_USD_PER_SECOND = 0.002;

/** fal-ai/video-understanding rejects any single prompt field longer than
 *  5000 characters with HTTP 422 ("String should have at most 5000
 *  characters") *before billing*. Surfaced via the `maxPromptChars` provider
 *  field so the runner can bound the retry prompt, and guarded again at submit
 *  as a fail-fast (a clear thrown error beats an opaque 422). */
export const FAL_VIDEO_UNDERSTANDING_PROMPT_MAX = 5000;

/** fal-ai/video-understanding's documented supported video container formats.
 *  Source: 422 error response — `Unsupported video format: .x. Supported formats: .mp4, .mpeg, .mpg, .mov, .webm`.
 *  Anything else gets remuxed to .mp4 (stream copy — no re-encode) before upload. */
const FAL_SUPPORTED_VIDEO_EXTS = new Set([
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mov",
  ".webm",
]);

const log = scriptAnalysisLogger.child({ provider: "fal-video-understanding" });

function mimeFromExt(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mpeg" || ext === ".mpg") return "video/mpeg";
  if (ext === ".mkv") return "video/x-matroska";
  return "application/octet-stream";
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`fal HTTP ${resp.status} on ${url}: ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

async function cancelFalRequest(requestId: string, apiKey: string): Promise<void> {
  await fetch(`${QUEUE_URL}/requests/${requestId}/cancel`, {
    method: "PUT",
    headers: { Authorization: `Key ${apiKey}` },
  }).catch(() => {
    // best effort
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Remux a video container fal doesn't accept (e.g. .mkv from YouTube) into
 *  .mp4 via `ffmpeg -c copy` — stream copy, no re-encode, ~instant for any
 *  reasonable input. Returns the path to the temp .mp4 file; caller must
 *  unlink it. */
async function remuxToMp4(
  sourcePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const tmp = path.join(
    os.tmpdir(),
    `libi-script-analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`,
  );
  await runFfmpeg(
    ["-i", sourcePath, "-c", "copy", "-y", tmp],
    {
      op: "script_analysis_remux",
      signal,
      context: { source: sourcePath, target: tmp },
    },
  );
  return tmp;
}

/** Two-step fal CDN upload that preserves the filename (and therefore the
 *  extension) — `fal.storage.upload(blob)` does not, which causes the video-
 *  understanding endpoint to reject the file. Mirrors the pattern in
 *  `lib/tracking/sam2-fal-backend.ts`'s defaultFalClient.uploadFile. */
async function uploadToFalCdn(
  localPath: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const filename = path.basename(localPath);
  const contentType = mimeFromExt(localPath);

  const initRes = await fetch(
    `${FAL_STORAGE_URL}/storage/upload/initiate?storage_type=fal-cdn-v3`,
    {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file_name: filename, content_type: contentType }),
      signal,
    },
  );
  if (!initRes.ok) {
    const body = await initRes.text().catch(() => "");
    throw new Error(
      `fal storage initiate failed: ${initRes.status} ${body.slice(0, 300)}`,
    );
  }
  const { upload_url, file_url } = (await initRes.json()) as {
    upload_url: string;
    file_url: string;
  };

  const bytes = await fs.readFile(localPath);
  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
    },
    body: bytes,
    signal,
  });
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => "");
    throw new Error(
      `fal storage upload PUT failed: ${putRes.status} ${body.slice(0, 300)}`,
    );
  }

  return file_url;
}

export const falVideoUnderstandingProvider: ScriptProvider = {
  id: "fal-video-understanding",
  displayName: "Fal.ai Video Understanding (Gemini)",
  defaultModelId: MODEL_ID,
  maxPromptChars: FAL_VIDEO_UNDERSTANDING_PROMPT_MAX,

  estimateCostUsd({ durationSeconds }) {
    return Math.max(0, durationSeconds) * FAL_VIDEO_UNDERSTANDING_USD_PER_SECOND;
  },

  async fetchRealCostUsd({ requestId, generatedAt, signal }) {
    const apiKey = await readFalApiKey();
    if (!apiKey) {
      return {
        kind: "forbidden",
        message:
          "No fal.ai API key configured — set FAL_KEY on the fal-ai MCP server in Settings to enable cost lookup.",
      };
    }
    return fetchFalCost({ requestId, apiKey, generatedAt, signal });
  },

  async isConfigured() {
    const key = await readFalApiKey();
    return key !== null && key.length > 0;
  },

  async generate(input: ScriptProviderInput): Promise<ScriptProviderResult> {
    const apiKey = await readFalApiKey();
    if (!apiKey) {
      throw new Error(
        "fal-ai API key not configured (set FAL_KEY in Settings → MCP Servers → fal-ai)",
      );
    }

    fal.config({ credentials: apiKey });

    // Fail fast on an over-long prompt instead of wasting a round-trip on a
    // guaranteed HTTP 422. The runner already bounds the retry prompt via
    // `maxPromptChars`; this guard catches any other caller that doesn't.
    if (input.promptInstructions.length > FAL_VIDEO_UNDERSTANDING_PROMPT_MAX) {
      throw new Error(
        `prompt exceeds fal-ai/video-understanding ${FAL_VIDEO_UNDERSTANDING_PROMPT_MAX}-char limit ` +
          `(${input.promptInstructions.length} chars); bound it before calling`,
      );
    }

    // Normalize the upload format to one fal accepts. The video-understanding
    // endpoint only accepts the containers listed in FAL_SUPPORTED_VIDEO_EXTS;
    // anything else (.mkv from yt-dlp, .avi, .ts, etc.) gets remuxed to .mp4
    // via a stream-copy ffmpeg pass (no re-encode, lossless).
    const sourceExt = path.extname(input.localPath).toLowerCase();
    let uploadPath = input.localPath;
    let remuxedTempPath: string | null = null;

    try {
      if (!FAL_SUPPORTED_VIDEO_EXTS.has(sourceExt)) {
        input.onProgress?.(`remuxing ${sourceExt} to .mp4 for fal compatibility`);
        log.info(
          { op: "fal_remux_start", sourceExt, sourcePath: input.localPath },
          "remuxing unsupported video format to .mp4",
        );
        remuxedTempPath = await remuxToMp4(input.localPath, input.signal);
        uploadPath = remuxedTempPath;
        log.info(
          { op: "fal_remux_done", remuxedTempPath },
          "remux complete",
        );
      }

      input.onProgress?.("uploading video to fal CDN");
      const cdnUrl = await uploadToFalCdn(uploadPath, apiKey, input.signal);
      log.info(
        { op: "fal_upload_done", cdnUrl, uploadPath },
        "fal storage upload complete",
      );

      input.onProgress?.("submitting analysis job");
      const submit = await fetchJson(QUEUE_URL, {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          video_url: cdnUrl,
          prompt: input.promptInstructions,
          detailed_analysis: true,
        }),
        signal: input.signal,
      });

      const requestId = submit.request_id as string;
      if (!requestId) {
        throw new Error(`fal submit missing request_id: ${JSON.stringify(submit)}`);
      }
      log.info({ op: "fal_submitted", requestId }, "fal job submitted");

      while (true) {
        if (input.signal?.aborted) {
          await cancelFalRequest(requestId, apiKey);
          throw new Error("aborted");
        }

        const status = (await fetchJson(
          `${QUEUE_URL}/requests/${requestId}/status`,
          {
            headers: { Authorization: `Key ${apiKey}` },
            signal: input.signal,
          },
        )) as { status: string; error?: unknown };

        input.onProgress?.(`fal: ${status.status}`);
        log.debug(
          { op: "fal_poll", requestId, status: status.status },
          "fal poll tick",
        );

        if (status.status === "COMPLETED") break;
        if (status.status === "FAILED" || status.status === "ERROR") {
          throw new Error(`fal job failed: ${JSON.stringify(status)}`);
        }

        await sleep(POLL_INTERVAL_MS, input.signal);
      }

      const result = (await fetchJson(`${QUEUE_URL}/requests/${requestId}`, {
        headers: { Authorization: `Key ${apiKey}` },
        signal: input.signal,
      })) as { output?: unknown };

      const text =
        typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output);
      log.info(
        { op: "fal_completed", requestId, textLength: text.length },
        "fal job completed",
      );

      return {
        text,
        providerName: "fal-video-understanding",
        modelId: MODEL_ID,
        requestId,
      };
    } finally {
      if (remuxedTempPath) {
        try {
          fsSync.unlinkSync(remuxedTempPath);
          log.debug({ op: "fal_remux_cleanup", remuxedTempPath }, "removed remuxed temp file");
        } catch (err) {
          log.warn(
            { op: "fal_remux_cleanup_failed", remuxedTempPath, err: (err as Error).message },
            "failed to remove remuxed temp file",
          );
        }
      }
    }
  },
};
