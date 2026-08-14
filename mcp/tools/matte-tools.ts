import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import type { RemoveBackgroundParams } from "@/mcp/tools/schemas";
import {
  runJobViaServer,
  legacyTripleFromRunJobResult,
  LibiServerUnavailableError,
} from "@/mcp/jobs-client";
import { CancelledError } from "@/lib/jobs/types";
import {
  trackingEngineInstalled,
  trackingNotInstalledError,
} from "@/lib/tracking/not-installed";
import { mcpLogger as logger } from "@/lib/logger";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types";
import type { ToolResultOf as ToolResult } from "./types";

interface RemoveBackgroundData {
  cutoutFileId: string;
  frameCount: number;
  framerate: number;
  engine: "local";
  jobId?: string;
}

const FAL_REDIRECT_HINT =
  "The fal engine is agent-driven — this tool never spends money for you. " +
  "Follow the removing-and-replacing-backgrounds skill: disclose the price " +
  "(fal get_pricing) and get user approval, push the source with " +
  "libi.upload_file_to_fal({ fileId }), run bria/video/background-removal " +
  "(video, { video_url }) or fal-ai/birefnet (image, { image_url }) on the " +
  "fal-ai MCP, then import the transparent result with libi.import_remote_files " +
  "and append a libi.update_file_notes lineage line.";

/**
 * libi.remove_background — produce an alpha cutout asset (subject isolated,
 * background transparent) from a VIDEO file via the local MatAnyone engine.
 *
 * Local engine only: enqueues the `matte_gen` JobManager job over the HTTP
 * jobs client (mcp/** never imports lib/jobs runners). `engine:"fal"` and
 * image inputs return structured redirects to the agent-driven fal path.
 */
export async function removeBackground(
  params: RemoveBackgroundParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<ToolResult<RemoveBackgroundData, { hint: string } | { jobId: string } | Record<string, unknown>>> {
  const engine = params.engine ?? "local";
  const subject = params.subject ?? { kind: "auto" as const };

  // Cross-field validation lives HERE (the inputSchema is a plain z.object).
  if (subject.kind === "box" && !subject.box) {
    return {
      success: false,
      error: "subject_box_required",
      data: {
        hint:
          "subject.kind 'box' needs subject.box [x, y, w, h] — get it from a " +
          "libi.ground_target candidate; never hand-guess pixel coordinates.",
      },
    };
  }

  if (engine === "fal") {
    return {
      success: false,
      error: "fal_engine_is_agent_driven",
      data: { hint: FAL_REDIRECT_HINT },
    };
  }

  const db = getDb();
  const fileRows = await db
    .select()
    .from(files)
    .where(eq(files.id, params.fileId))
    .limit(1);
  const file = fileRows[0];
  if (!file) {
    return { success: false, error: `file not found: ${params.fileId}` };
  }
  if (file.type === "image") {
    return {
      success: false,
      error: "local_image_matting_not_supported",
      data: {
        hint:
          "v1 local matting is video-only (MatAnyone). For photos use the fal " +
          "path — fal-ai/birefnet with { image_url } — per the " +
          "removing-and-replacing-backgrounds skill. " + FAL_REDIRECT_HINT,
      },
    };
  }
  if (file.type !== "video") {
    return {
      success: false,
      error: `file is not a video or image: ${file.id} (type: ${file.type})`,
    };
  }

  if (!trackingEngineInstalled()) {
    const notInstalled = trackingNotInstalledError();
    return {
      success: false,
      error: "dependency_not_ready",
      data: {
        ...notInstalled.data,
        hint:
          "The local matte engine rides the libi-tracking Python env. Recover " +
          "with libi.verify_install (ok:true → retry this call); otherwise " +
          "libi.get_install_plan (id 'libi-tracking'), run the install, " +
          "verify, then retry — or offer the paid fal path.",
      },
    };
  }

  try {
    const resp = await runJobViaServer<RemoveBackgroundData>(
      "matte_gen",
      {
        fileId: params.fileId,
        engine: "local",
        subject:
          subject.kind === "box"
            ? { kind: "box" as const, box: subject.box }
            : { kind: "auto" as const },
        ...(params.range ? { range: params.range } : {}),
      },
      {
        extra,
        pieceId: file.pieceId,
        fileId: file.id,
        ...(params.forceNew !== undefined ? { forceNew: params.forceNew } : {}),
      },
    );
    const { jobId, result } = legacyTripleFromRunJobResult(resp);
    logger.info(
      { tag: "matte", op: "remove_background_done", fileId: file.id, jobId, cutoutFileId: result.cutoutFileId },
      "remove_background complete",
    );
    return { success: true, data: { ...result, jobId } };
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return { success: false, error: "libi_server_unavailable", data: { hint: err.hint } };
    }
    if (err instanceof CancelledError) {
      return { success: false, error: "cancelled", data: { jobId: err.jobId } };
    }
    // The runner throws the not-installed contract as stringified JSON —
    // surface it structurally so the agent can run the install plan.
    const message = err instanceof Error ? err.message : String(err);
    try {
      const parsed = JSON.parse(message) as { error?: string; data?: Record<string, unknown> };
      if (parsed.error === "tracking_engine_not_installed") {
        return { success: false, error: parsed.error, data: parsed.data ?? {} };
      }
    } catch {
      /* not JSON — fall through */
    }
    return { success: false, error: message };
  }
}
