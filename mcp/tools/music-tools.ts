import fs from "fs/promises";
import os from "os";
import { randomUUID } from "node:crypto";
import {
  listMusicStatus,
  isAceStepModelInstalled,
  estimateGenerationSeconds,
  ACESTEP_DOWNLOAD_SIZE_HUMAN,
  DEFAULT_DURATION_SECONDS,
  CONFIRM_THRESHOLD_SECONDS,
} from "@/lib/music/models";
import type { GenerationResult } from "@/lib/music/generate";
import {
  MUSIC_GENERATE_MIN_FREE_BYTES,
  describeMemoryShortfall,
} from "@/lib/music/generate";
import { getAvailableMemoryBytes } from "@/lib/system/available-memory";
import { storeFile } from "@/mcp/tools/file-tools";
import {
  runJobViaServer,
  LibiServerUnavailableError,
} from "@/mcp/jobs-client";
import type { ToolResult } from "./types";
import type {
  MusicListStylesParams,
  MusicDownloadModelParams,
  GenerateMusicParams,
} from "./schemas";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types";

export async function musicListStyles(
  _params: MusicListStylesParams,
): Promise<ToolResult> {
  return { success: true, data: listMusicStatus() };
}

export async function musicDownloadModel(
  params: MusicDownloadModelParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<ToolResult> {
  // `forceNew` is a deprecated alias — one action, one knob. Two names for
  // "start over" is how a retry ended up running a second downloader over the
  // same directory.
  const force = params.force === true || params.forceNew === true;
  if (!force && isAceStepModelInstalled()) {
    return { success: true, data: { status: "already_installed" } };
  }
  const clientKey = randomUUID();
  try {
    const resp = await runJobViaServer<{ alreadyInstalled: boolean }>(
      "music_model_download",
      // No params: "install the ACE-Step model" is one piece of work with one
      // output dir and therefore exactly one paramsHash. Force rides on the
      // enqueue OPTIONS, where it can't fork job identity.
      {},
      {
        extra,
        clientKey,
        forceNew: force,
        // The user asked to start over, so the bytes on disk are suspect.
        // A retry (which also sets forceNew, upstream) must never set this.
        discardOutput: force,
      },
    );

    switch (resp.status) {
      case "new": {
        const forced =
          "forced" in resp && resp.forced === true ? { forced: true } : {};
        return {
          success: true,
          data: {
            status: "installed",
            jobId: resp.jobId,
            clientKey: resp.clientKey,
            ...forced,
          },
        };
      }
      case "attached_running": {
        return {
          success: true,
          data: {
            status: "installed",
            jobId: resp.jobId,
            clientKey: resp.clientKey,
            attachedToRunning: true,
            existingJob: resp.existingJob,
            ...(force
              ? {
                  // A forced request that lands here was NOT honoured as a
                  // restart, and saying so is the point: restarting would have
                  // destroyed the running download's progress.
                  hint: "A download is already in progress — attached to it instead of restarting. To genuinely start over, call libi.cancel_job on this jobId first, then re-run with force.",
                }
              : {}),
          },
        };
      }
      case "matching_completed": {
        // The cached terminal job row is NOT authoritative — a
        // failed/cancelled prior job (or a completed one whose weights were
        // since removed) leaves no usable model. The on-disk weights are the
        // source of truth.
        const installed = isAceStepModelInstalled();
        return {
          success: true,
          data: {
            status: installed ? "installed" : "not_installed",
            matchedExisting: true,
            existingJob: resp.existingJob,
            ...(installed
              ? {}
              : {
                  hint: "A previous download left no usable model weights. Re-run libi.music_download_model({ force: true }).",
                }),
          },
        };
      }
    }
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return {
        success: false,
        error: "libi_server_unavailable",
        data: { hint: err.hint },
      };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function safeWavName(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `music-${slug || "track"}.wav`;
}

/** Persist a freshly generated wav to storage and return the tool's data
 *  payload. Used by every non-`matching_completed` branch.
 *
 *  After storing, the wav file is unlinked from disk — the bytes now live
 *  inside libi's storage layer keyed by file id. */
async function persistAndDelete(
  params: GenerateMusicParams,
  result: GenerationResult,
): Promise<{
  file: unknown;
  durationSeconds: number;
  channels: number;
  instrumental: boolean;
  seed: number;
}> {
  try {
    const buffer = await fs.readFile(result.wavPath);
    const record = await storeFile({
      pieceId: params.pieceId ?? null,
      filename: safeWavName(params.prompt),
      buffer,
      contentType: "audio/wav",
      name: safeWavName(params.prompt),
      description: `[Music] ${params.prompt.slice(0, 120)}`,
      mediaDuration: result.durationSeconds,
      hasAudio: true,
    });
    return {
      file: record,
      durationSeconds: result.durationSeconds,
      channels: result.channels,
      instrumental: result.instrumental,
      seed: result.seed,
    };
  } finally {
    await fs.rm(result.wavPath, { force: true }).catch(() => {});
  }
}

/** Translate generation errors into the existing structured ToolResult
 *  shapes (LibiServerUnavailableError, model_load_failed, generic). Kept
 *  separate so the two call sites (test-seam path, real-job path) match
 *  byte-for-byte. */
function mapGenerationError(err: unknown): ToolResult {
  if (err instanceof LibiServerUnavailableError) {
    return {
      success: false,
      error: "libi_server_unavailable",
      data: { hint: err.hint },
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/MODEL_LOAD_FAILED/.test(msg)) {
    return {
      success: false,
      data: {
        status: "model_load_failed",
        hint: 'Model files are corrupt/partial. Call libi.music_download_model({ force: true }), then retry.',
      },
    };
  }
  return { success: false, error: msg };
}

/** `genFn` is a test seam (mirrors the tts `synthFn` pattern): when
 *  provided it bypasses the install gate and the JobManager job. */
export async function generateMusic(
  params: GenerateMusicParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
  genFn?: (p: GenerateMusicParams) => Promise<GenerationResult>,
): Promise<ToolResult> {
  const duration = params.durationSeconds ?? DEFAULT_DURATION_SECONDS;

  if (!genFn && !isAceStepModelInstalled()) {
    return {
      success: false,
      data: {
        status: "needs_install",
        downloadSizeHuman: ACESTEP_DOWNLOAD_SIZE_HUMAN,
        hint: `Local music model weights not installed (${ACESTEP_DOWNLOAD_SIZE_HUMAN}). Tell the user the size, get approval, then call libi.get_install_plan({ mcpId: "local-music" }) and follow it; retry.`,
      },
    };
  }

  const estimatedSeconds = estimateGenerationSeconds(duration);
  if (!params.confirm && estimatedSeconds > CONFIRM_THRESHOLD_SECONDS) {
    return {
      success: false,
      data: {
        status: "confirm_duration",
        estimatedSeconds,
        hint: `Generating ~${duration}s of music will take about ${estimatedSeconds}s on this machine. Tell the user the estimate; re-call with confirm:true to proceed (the job is cancellable).`,
      },
    };
  }

  // Pre-flight RAM check — ACE-Step needs ~14 GB free to safely load the
  // 3.5B-param pipeline at bf16/fp16. Without this guard we'd let the
  // kernel OOM-kill the user's Mac during inference (we already shipped
  // that bug once during QA). Bypass with a test seam.
  if (!genFn) {
    // On darwin this includes inactive/speculative/purgeable pages — see
    // lib/system/available-memory.ts for why os.freemem() alone refuses
    // healthy macOS hosts.
    const freeBytes = getAvailableMemoryBytes();
    if (freeBytes < MUSIC_GENERATE_MIN_FREE_BYTES) {
      return {
        success: false,
        data: {
          status: "insufficient_memory",
          freeBytes,
          totalBytes: os.totalmem(),
          requiredBytes: MUSIC_GENERATE_MIN_FREE_BYTES,
          hint: describeMemoryShortfall(freeBytes, os.totalmem()),
        },
      };
    }
  }

  // Test-seam path: bypass the job + dedup entirely and persist directly.
  if (genFn) {
    let result: GenerationResult;
    try {
      result = await genFn(params);
    } catch (err) {
      return mapGenerationError(err);
    }
    return { success: true, data: await persistAndDelete(params, result) };
  }

  // Real path: enqueue (or attach) a `music_generate` job and surface the
  // 4-shape response to the agent. The CLAUDE.md heuristic (T24) tells the
  // agent how to react to `attachedToRunning` / `matchedExisting`.
  const clientKey = randomUUID();
  try {
    const resp = await runJobViaServer<GenerationResult>(
      "music_generate",
      {
        prompt: params.prompt,
        lyrics: params.lyrics,
        durationSeconds: duration,
        instrumental: params.instrumental,
        seed: params.seed,
      },
      {
        pieceId: params.pieceId ?? null,
        clientKey,
        forceNew: params.forceNew ?? false,
        extra,
      },
    );

    switch (resp.status) {
      case "new": {
        const stored = await persistAndDelete(params, resp.result);
        // `forced:true` is the same union arm as `new` — surface it so the
        // agent can tell the user we deliberately started a fresh run.
        const forced =
          "forced" in resp && resp.forced === true ? { forced: true } : {};
        return {
          success: true,
          data: {
            ...stored,
            jobId: resp.jobId,
            clientKey: resp.clientKey,
            ...forced,
          },
        };
      }
      case "attached_running": {
        // The SSE wait completed — we got the runner's result. The wav file
        // is on disk now exactly like the `new` case, so we still store it.
        // The `attachedToRunning` marker tells the agent to inform the user
        // we joined an in-flight run (mention elapsed time + ask if they
        // want a brand-new one with forceNew:true).
        const stored = await persistAndDelete(params, resp.result);
        return {
          success: true,
          data: {
            ...stored,
            jobId: resp.jobId,
            clientKey: resp.clientKey,
            attachedToRunning: true,
            existingJob: resp.existingJob,
          },
        };
      }
      case "matching_completed": {
        // The server returned a cached terminal row instead of running the
        // job — the wav tempfile from that prior run is long gone, so we
        // CANNOT store a file here. Surface the markers + cached metadata
        // so the agent can apply the CLAUDE.md dedup heuristic and decide
        // whether to re-run with forceNew:true.
        const cached =
          (resp.existingJob.result ?? {}) as Partial<GenerationResult>;
        return {
          success: true,
          data: {
            durationSeconds: cached.durationSeconds,
            channels: cached.channels,
            instrumental: cached.instrumental,
            seed: cached.seed,
            matchedExisting: true,
            existingJob: resp.existingJob,
          },
        };
      }
    }
  } catch (err) {
    return mapGenerationError(err);
  }
}
