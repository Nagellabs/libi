import { randomUUID } from "node:crypto";
import {
  listWhisperModelStatus,
  DEFAULT_WHISPER_MODEL,
  isWhisperModelInstalled,
} from "@/lib/whisper/models";
import {
  runJobViaServer,
  LibiServerUnavailableError,
} from "@/mcp/jobs-client";
import type { ToolResult } from "./types";
import type {
  WhisperListModelsParams,
  WhisperDownloadModelParams,
} from "./schemas";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types";

export async function whisperListModels(
  _params: WhisperListModelsParams,
): Promise<ToolResult> {
  return {
    success: true,
    data: {
      default: DEFAULT_WHISPER_MODEL,
      models: listWhisperModelStatus(),
    },
  };
}

export async function whisperDownloadModel(
  params: WhisperDownloadModelParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<ToolResult> {
  if (isWhisperModelInstalled(params.model)) {
    return {
      success: true,
      data: { status: "already_installed", model: params.model },
    };
  }
  const clientKey = randomUUID();
  try {
    const resp = await runJobViaServer<{
      model: string;
      alreadyInstalled: boolean;
    }>(
      "whisper_model_download",
      { model: params.model },
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
            model: params.model,
            jobId: resp.jobId,
            clientKey: resp.clientKey,
            ...forced,
          },
        };
      }
      case "attached_running": {
        // Server attached this call to a still-running matching download and
        // blocked until it completed — the model IS now on disk. Surface the
        // dedup markers so the agent can tell the user we joined an in-flight run.
        return {
          success: true,
          data: {
            status: "installed",
            model: params.model,
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
        const installed = isWhisperModelInstalled(params.model);
        return {
          success: true,
          data: {
            status: installed ? "installed" : "not_installed",
            model: params.model,
            matchedExisting: true,
            existingJob: resp.existingJob,
            ...(installed
              ? {}
              : {
                  hint: `A previous download left no usable model weights. Re-run libi.whisper_download_model({ model: "${params.model}", forceNew: true }).`,
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
