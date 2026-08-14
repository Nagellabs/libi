import {
  isMusicAnalysisInstalled,
  installMusicAnalysisDeps as realInstall,
} from "@/lib/music/analyze-install";
import {
  detectBeats as realDetectBeats,
  profile as realProfile,
  type BeatsResult,
  type MusicAnalyzeOptions,
  type ProfileResult,
} from "@/lib/music/analyze";
import { getFileLocalPath } from "@/mcp/tools/file-tools";
import type { ToolResult } from "./types";
import type {
  MusicDetectBeatsParams,
  MusicProfileParams,
  MusicInstallAnalysisDepsParams,
} from "./schemas";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types";

const NEEDS_INSTALL_HINT =
  "Local music analysis env (librosa) is not installed yet. Call libi.get_install_plan({ mcpId: 'local-music' }) and follow Section B.";

export async function musicDetectBeats(
  params: MusicDetectBeatsParams,
  _extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
  analyzeFn?: (o: MusicAnalyzeOptions) => Promise<BeatsResult>,
): Promise<ToolResult> {
  if (!isMusicAnalysisInstalled() && !analyzeFn) {
    return { success: false, data: { status: "needs_install", hint: NEEDS_INSTALL_HINT } };
  }
  const inPath = await getFileLocalPath(params.fileId);
  if (!inPath) {
    return {
      success: false,
      data: { status: "file_not_found", hint: `No file on disk for id ${params.fileId}.` },
    };
  }
  try {
    const fn = analyzeFn ?? realDetectBeats;
    const result = await fn({
      inPath,
      minBpm: params.minBpm,
      maxBpm: params.maxBpm,
      startSec: params.startSec,
      endSec: params.endSec,
    });
    return { success: true, data: { status: "ready", ...result } };
  } catch (err) {
    return classifyAnalyzeError(err);
  }
}

export async function musicProfile(
  params: MusicProfileParams,
  _extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
  analyzeFn?: (o: MusicAnalyzeOptions) => Promise<ProfileResult>,
): Promise<ToolResult> {
  if (!isMusicAnalysisInstalled() && !analyzeFn) {
    return { success: false, data: { status: "needs_install", hint: NEEDS_INSTALL_HINT } };
  }
  const inPath = await getFileLocalPath(params.fileId);
  if (!inPath) {
    return {
      success: false,
      data: { status: "file_not_found", hint: `No file on disk for id ${params.fileId}.` },
    };
  }
  try {
    const fn = analyzeFn ?? realProfile;
    const result = await fn({
      inPath,
      includeBeats: params.includeBeats,
      bandEnvelopes: params.bandEnvelopes,
      envelopeHz: params.envelopeHz,
      startSec: params.startSec,
      endSec: params.endSec,
    });
    return { success: true, data: { status: "ready", ...result } };
  } catch (err) {
    return classifyAnalyzeError(err);
  }
}

export async function musicInstallAnalysisDeps(
  _params: MusicInstallAnalysisDepsParams,
  _extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
  installer?: () => Promise<void>,
): Promise<ToolResult> {
  try {
    await (installer ?? realInstall)();
    return {
      success: true,
      data: {
        status: "installed",
        hint: "librosa env warmed; analyze tools are ready.",
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      data: { status: "install_failed", hint: msg },
    };
  }
}

function classifyAnalyzeError(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (/audio_empty/.test(msg))
    return { success: false, data: { status: "audio_empty", hint: msg } };
  if (/insufficient_memory/.test(msg))
    return { success: false, data: { status: "insufficient_memory", hint: msg } };
  if (/file_not_found/.test(msg))
    return { success: false, data: { status: "file_not_found", hint: msg } };
  return { success: false, data: { status: "internal_error", hint: msg } };
}
