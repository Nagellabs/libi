import fs from "fs/promises";
import { randomUUID } from "node:crypto";
import { listVoiceStatus, isKokoroModelInstalled } from "@/lib/tts/voices";
import {
  synthesizeSpeech as realSynthesize,
  type SynthesisResult,
} from "@/lib/tts/synthesize";
import { storeFile } from "@/mcp/tools/file-tools";
import {
  runJobViaServer,
  LibiServerUnavailableError,
} from "@/mcp/jobs-client";
import type { ToolResult } from "./types";
import type {
  TtsListVoicesParams,
  TtsDownloadModelParams,
  GenerateSpeechParams,
} from "./schemas";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types";

export async function ttsListVoices(
  _params: TtsListVoicesParams,
): Promise<ToolResult> {
  return { success: true, data: listVoiceStatus() };
}

export async function ttsDownloadModel(
  params: TtsDownloadModelParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<ToolResult> {
  if (isKokoroModelInstalled()) {
    return { success: true, data: { status: "already_installed" } };
  }
  const clientKey = randomUUID();
  try {
    const resp = await runJobViaServer<{ alreadyInstalled: boolean }>(
      "tts_model_download",
      {},
      {
        extra,
        clientKey,
        forceNew: params.forceNew === true,
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
          },
        };
      }
      case "matching_completed": {
        // The cached terminal job row is NOT authoritative — a
        // failed/cancelled prior job leaves no usable model. The on-disk
        // weights are the source of truth.
        const installed = isKokoroModelInstalled();
        return {
          success: true,
          data: {
            status: installed ? "installed" : "not_installed",
            matchedExisting: true,
            existingJob: resp.existingJob,
            ...(installed
              ? {}
              : {
                  hint: "A previous download left no usable model weights. Re-run libi.tts_download_model({ forceNew: true }).",
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

function safeWavName(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `speech-${slug || "audio"}.wav`;
}

/** `synthFn` is a test seam (mirrors the analysis `sttFn` pattern): when
 *  provided it bypasses the model-install gate and the real spawn. */
export async function generateSpeech(
  params: GenerateSpeechParams,
  _extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
  synthFn?: (opts: {
    text: string;
    voice?: string;
    speed?: number;
    withTimestamps?: boolean;
  }) => Promise<SynthesisResult>,
): Promise<ToolResult> {
  const synth = synthFn ?? realSynthesize;
  if (!synthFn && !isKokoroModelInstalled()) {
    return {
      success: false,
      data: {
        status: "needs_install",
        hint: `Local TTS model not installed. Call libi.get_install_plan({ mcpId: "local-tts" }) and follow the model-download step.`,
      },
    };
  }
  let result: SynthesisResult;
  try {
    result = await synth({
      text: params.text,
      voice: params.voice,
      speed: params.speed,
      withTimestamps: params.withTimestamps,
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const buffer = await fs.readFile(result.wavPath);
    const record = await storeFile({
      pieceId: params.pieceId ?? null,
      filename: safeWavName(params.text),
      buffer,
      contentType: "audio/wav",
      name: safeWavName(params.text),
      description: `[TTS ${result.voice}] ${params.text.slice(0, 120)}`,
      mediaDuration: result.durationSeconds,
      hasAudio: true,
    });
    return {
      success: true,
      data: {
        file: record,
        voice: result.voice,
        durationSeconds: result.durationSeconds,
        ...(params.withTimestamps
          ? { words: result.words, approximate: result.approximate }
          : {}),
      },
    };
  } finally {
    await fs.rm(result.wavPath, { force: true }).catch(() => {});
  }
}
